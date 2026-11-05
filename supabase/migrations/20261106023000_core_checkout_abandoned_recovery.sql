-- Core ↔ Nexus 5B acceptance: conservative recovery for abandoned physical holds.
-- Existing live reservations/deductions remain OFF; recovery is a THIRD
-- separate feature flag and is explicitly disabled by this migration.
-- NO historical order, payment, unit or inventory movement changes.
UPDATE public.internal_runtime_config
SET value = value || '{"recovery_enabled":false}'::jsonb
WHERE key='inventory_checkout';

-- Existing service-only cancellation logic gains one safe terminal status
-- for an unpaid order abandoned before a payment session is registered.
CREATE OR REPLACE FUNCTION public.core_checkout_release_inventory(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  ord public.orders%rowtype;
  allocation record;
  released integer:=0;
BEGIN
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'Order ID is required'; END IF;
  SELECT * INTO ord FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF ord.payment_status='paid' OR EXISTS(
    SELECT 1 FROM public.inventory_order_allocations
    WHERE order_id=p_order_id AND status='committed'
  ) THEN RAISE EXCEPTION 'Paid/committed stock cannot be automatically restocked'; END IF;
  IF lower(ord.status) NOT IN ('cancelled','canceled','checkout_error','checkout_expired')
     AND lower(ord.payment_status) NOT IN ('failed','voided','cancelled','canceled') THEN
    RAISE EXCEPTION 'Release requires a failed or cancelled unpaid order';
  END IF;
  PERFORM 1 FROM public.inventory_lots l
    WHERE EXISTS(SELECT 1 FROM public.inventory_order_allocations a
      JOIN public.inventory_units u ON u.id=a.unit_id
      WHERE a.order_id=p_order_id AND a.status='held' AND u.lot_id=l.id)
    ORDER BY l.id FOR UPDATE;
  FOR allocation IN
    SELECT a.id,u.id AS unit_id,u.state FROM public.inventory_order_allocations a
    JOIN public.inventory_units u ON u.id=a.unit_id
    WHERE a.order_id=p_order_id AND a.status='held'
    ORDER BY u.id FOR UPDATE OF a,u
  LOOP
    IF allocation.state<>'reserved' THEN
      RAISE EXCEPTION 'Reservation state mismatch; manual review required';
    END IF;
    UPDATE public.inventory_units SET state='available'
      WHERE id=allocation.unit_id AND state='reserved';
    UPDATE public.inventory_order_allocations
      SET status='released',released_at=now() WHERE id=allocation.id;
    released:=released+1;
  END LOOP;
  RETURN jsonb_build_object('released',released);
END;
$function$;
REVOKE ALL ON FUNCTION public.core_checkout_release_inventory(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_checkout_release_inventory(uuid) TO service_role;

-- Trigger handles order cancellation even if initiated from Core rather than
-- the Nexus payment handler. Because flags start disabled, there are no
-- reservations to release until a future explicit go-live.

-- Reuse the existing release trigger and broaden its terminal status check.
CREATE OR REPLACE FUNCTION private.core_checkout_release_on_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF new.payment_status<>'paid' AND
    (lower(new.status) IN ('cancelled','canceled','checkout_error','checkout_expired') OR
     lower(new.payment_status) IN ('failed','voided','cancelled','canceled')) AND
    EXISTS (SELECT 1 FROM public.inventory_order_allocations
            WHERE order_id=new.id AND status='held')
  THEN
    PERFORM public.core_checkout_release_inventory(new.id);
  END IF;
  RETURN new;
END;
$function$;
REVOKE ALL ON FUNCTION private.core_checkout_release_on_cancel()
  FROM PUBLIC,anon,authenticated;

-- Safety against a checkout expiry racing a wallet create or manual payment:
-- a payment INSERT/UPDATE locks its parent order. The recovery worker also
-- locks that row first. Thus it cannot expire a checkout while a payment
-- session is being inserted, nor can a late provider session be registered
-- after expiry. A late unrecorded external order cannot be shown to a buyer.
CREATE OR REPLACE FUNCTION private.core_checkout_block_expired_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_status text;
BEGIN
  SELECT o.status INTO v_status FROM public.orders o
    WHERE o.id=new.order_id FOR UPDATE;
  IF v_status='checkout_expired' THEN
    RAISE EXCEPTION 'Checkout expired. Start a new order.'
      USING ERRCODE='23514';
  END IF;
  RETURN new;
END;
$function$;
REVOKE ALL ON FUNCTION private.core_checkout_block_expired_payment()
  FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS core_checkout_block_expired_payment ON public.payments;
CREATE TRIGGER core_checkout_block_expired_payment
BEFORE INSERT OR UPDATE OF order_id,status,provider_order_id ON public.payments
FOR EACH ROW EXECUTE FUNCTION private.core_checkout_block_expired_payment();

-- Private, aggregate operational health; no customer, supplier, QR, or lot
-- identifiers returned. Only server-held service-role RPC calls are allowed.
CREATE OR REPLACE FUNCTION public.core_checkout_recovery_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE cfg jsonb;
BEGIN
  SELECT value INTO cfg FROM public.internal_runtime_config
    WHERE key='inventory_checkout';
  RETURN jsonb_build_object(
    'reservation_enabled',coalesce((cfg->>'reservation_enabled')::boolean,false),
    'deduction_enabled',coalesce((cfg->>'deduction_enabled')::boolean,false),
    'recovery_enabled',coalesce((cfg->>'recovery_enabled')::boolean,false),
    'held_units',(SELECT count(*) FROM public.inventory_order_allocations
      WHERE status='held'),
    'committed_units',(SELECT count(*) FROM public.inventory_order_allocations
      WHERE status='committed'),
    'stale_without_payment',(SELECT count(DISTINCT o.id)
      FROM public.orders o JOIN public.inventory_order_allocations a
        ON a.order_id=o.id AND a.status='held'
      WHERE o.status='submitted' AND o.payment_status='pending'
        AND o.created_at < now()-interval '90 minutes'
        AND a.reserved_at < now()-interval '90 minutes'
        AND NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.order_id=o.id)),
    'requires_provider_review',(SELECT count(DISTINCT o.id)
      FROM public.orders o JOIN public.inventory_order_allocations a
        ON a.order_id=o.id AND a.status='held'
      WHERE o.payment_status<>'paid'
        AND a.reserved_at < now()-interval '90 minutes'
        AND EXISTS(SELECT 1 FROM public.payments p WHERE p.order_id=o.id)),
    'paid_with_hold',(SELECT count(DISTINCT o.id)
      FROM public.orders o JOIN public.inventory_order_allocations a
        ON a.order_id=o.id AND a.status='held'
      WHERE o.payment_status='paid')
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.core_checkout_recovery_health()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_checkout_recovery_health() TO service_role;

-- This worker deliberately EXCLUDES all checkouts with ANY payment record,
-- regardless of provider or status. Pending provider sessions MUST receive
-- independent payment-provider verification or owner review before release.
--
-- A recovery pass is separately gated, limited to <= 25 orders and >= 90m
-- old holds; it preserves paid/committed stock and cannot touch old orders
-- predating the explicit activation timestamp.
CREATE OR REPLACE FUNCTION public.core_checkout_recover_abandoned(
  p_limit integer DEFAULT 25, p_age_minutes integer DEFAULT 90)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  cfg jsonb;
  activation timestamptz;
  cutoff timestamptz;
  entry record;
  hold_count integer;
  expired_orders integer := 0;
  released_units integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR
    p_age_minutes IS NULL OR p_age_minutes NOT BETWEEN 90 AND 10080 THEN
    RAISE EXCEPTION 'Invalid bounded recovery parameters';
  END IF;
  SELECT value INTO cfg FROM public.internal_runtime_config
    WHERE key='inventory_checkout' FOR SHARE;
  IF NOT coalesce((cfg->>'reservation_enabled')::boolean,false) OR
     NOT coalesce((cfg->>'recovery_enabled')::boolean,false) THEN
    RETURN jsonb_build_object('enabled',false,'expired_orders',0,'released_units',0);
  END IF;
  activation:=nullif(cfg->>'activated_at','')::timestamptz;
  IF activation IS NULL THEN
    RAISE EXCEPTION 'Recovery requires an activation timestamp';
  END IF;
  cutoff:=now()-make_interval(mins=>p_age_minutes);
  FOR entry IN
    SELECT o.id FROM public.orders o
      WHERE o.status='submitted' AND o.payment_status='pending'
        AND o.created_at>=activation AND o.created_at<cutoff
        AND coalesce(o.admin_notes,'') LIKE 'Nexus Pay Now checkout%'
        AND EXISTS(SELECT 1 FROM public.inventory_order_allocations a
                   WHERE a.order_id=o.id AND a.status='held')
        AND NOT EXISTS(SELECT 1 FROM public.inventory_order_allocations a
                   WHERE a.order_id=o.id AND a.status='held'
                     AND a.reserved_at>=cutoff)
        AND NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.order_id=o.id)
      ORDER BY o.created_at,o.id LIMIT p_limit
      FOR UPDATE OF o SKIP LOCKED
  LOOP
    -- Payment INSERT/UPDATE obtains the same parent-order row lock via
    -- private.core_checkout_block_expired_payment. Re-evaluate under lock.
    IF EXISTS(SELECT 1 FROM public.payments p WHERE p.order_id=entry.id) THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO hold_count FROM public.inventory_order_allocations
      WHERE order_id=entry.id AND status='held';
    IF hold_count=0 THEN CONTINUE; END IF;
    -- Existing order cancellation trigger releases all exact held units;
    -- if it fails, the entire transaction rolls back, never a partial release.
    UPDATE public.orders SET status='checkout_expired',
      updated_at=now() WHERE id=entry.id
      AND status='submitted' AND payment_status='pending';
    IF NOT FOUND THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.inventory_order_allocations
              WHERE order_id=entry.id AND status='held') THEN
      RAISE EXCEPTION 'Recovery did not release all held units';
    END IF;
    expired_orders:=expired_orders+1;
    released_units:=released_units+hold_count;
  END LOOP;
  RETURN jsonb_build_object('enabled',true,'expired_orders',expired_orders,
    'released_units',released_units);
END;
$function$;
REVOKE ALL ON FUNCTION public.core_checkout_recover_abandoned(integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_checkout_recover_abandoned(integer,integer)
  TO service_role;

DO $verify$
BEGIN
  IF (SELECT coalesce((value->>'reservation_enabled')::boolean,false)
      FROM public.internal_runtime_config WHERE key='inventory_checkout') OR
     (SELECT coalesce((value->>'deduction_enabled')::boolean,false)
      FROM public.internal_runtime_config WHERE key='inventory_checkout') OR
     (SELECT coalesce((value->>'recovery_enabled')::boolean,false)
      FROM public.internal_runtime_config WHERE key='inventory_checkout') THEN
    RAISE EXCEPTION 'Phase 5B recovery must deploy with all flags disabled';
  END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_order_allocations WHERE status='held') THEN
    RAISE EXCEPTION 'Unexpected historical checkout holds';
  END IF;
  IF has_function_privilege('anon',
       'public.core_checkout_recover_abandoned(integer,integer)','EXECUTE') OR
     has_function_privilege('authenticated',
       'public.core_checkout_recovery_health()','EXECUTE') THEN
    RAISE EXCEPTION 'Recovery privileges exposed to browser';
  END IF;
END $verify$;
