-- Core ↔ Nexus Phase 5B. Staged, *disabled* stock reservations and verified-payment
-- consumption. Never backfill historical orders, payments, receipts, or units.
-- These three RPCs must only be called using server-held service_role credentials.
-- An activation timestamp prevents already-created orders being claimed.
--
-- Manual activation (NOT part of this migration) is an independent later release gate:
-- UPDATE public.internal_runtime_config
-- SET value='{"reservation_enabled":true,"deduction_enabled":true,
--   "activated_at":"<future UTC timestamp>"}'::jsonb
-- WHERE key='inventory_checkout';
-- Do not enable until physical audits, fulfillment, expiry recovery, cross-account
-- authorization and real-device checkout acceptance tests have been completed.

INSERT INTO public.internal_runtime_config(key,value)
VALUES ('inventory_checkout',
  '{"reservation_enabled":false,"deduction_enabled":false,"activated_at":null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.inventory_units DROP CONSTRAINT inventory_units_state_check;
ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_state_check
 CHECK (state IN ('available','reserved','allocated','shipped','damaged',
                 'quarantined','returned','missing'));

ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_reason_check;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_reason_check
 CHECK (reason IN ('received','damaged','dispatched','allocated','returned','adjustment'));

CREATE TABLE public.inventory_order_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.inventory_units(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('held','committed','released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  released_at timestamptz,
  UNIQUE(order_item_id,unit_id)
);
CREATE UNIQUE INDEX inventory_order_allocations_active_unit_idx
  ON public.inventory_order_allocations(unit_id)
  WHERE status IN ('held','committed');
CREATE INDEX inventory_order_allocations_order_idx
  ON public.inventory_order_allocations(order_id,status);

ALTER TABLE public.inventory_order_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_order_allocations FROM PUBLIC,anon,authenticated;
GRANT ALL ON TABLE public.inventory_order_allocations TO service_role;

-- This is read-only metadata for *internal* services. It is deliberately
-- not exposed by nexus-catalog or any browser-facing inventory endpoint.
CREATE OR REPLACE FUNCTION public.core_checkout_inventory_flags()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT value FROM public.internal_runtime_config
    WHERE key='inventory_checkout'),
    '{"reservation_enabled":false,"deduction_enabled":false,"activated_at":null}'::jsonb)
$function$;
REVOKE ALL ON FUNCTION public.core_checkout_inventory_flags() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_checkout_inventory_flags() TO service_role;

CREATE OR REPLACE FUNCTION public.core_checkout_reserve_inventory(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  cfg jsonb;
  activation timestamptz;
  ord public.orders%rowtype;
  item record;
  picked record;
  total_reserved integer := 0;
  item_count integer := 0;
  expected integer;
  existing integer;
  local_reserved integer;
BEGIN
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'Order ID is required'; END IF;
  SELECT value INTO cfg FROM public.internal_runtime_config
    WHERE key='inventory_checkout' FOR SHARE;
  IF COALESCE((cfg->>'reservation_enabled')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('enabled',false,'reserved',0);
  END IF;
  activation := NULLIF(cfg->>'activated_at','')::timestamptz;
  IF activation IS NULL THEN
    RAISE EXCEPTION 'Inventory activation timestamp is required';
  END IF;

  SELECT * INTO ord FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF ord.created_at < activation THEN
    RETURN jsonb_build_object('enabled',true,'historical',true,'reserved',0);
  END IF;
  IF ord.status<>'submitted' OR ord.payment_status<>'pending' OR
     coalesce(ord.admin_notes,'') NOT LIKE 'Nexus Pay Now checkout%' THEN
    RAISE EXCEPTION 'Order is not a pending Nexus Pay Now checkout';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.order_items WHERE order_id=p_order_id) THEN
    RAISE EXCEPTION 'Order items are missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.order_items
            WHERE order_id=p_order_id AND
              (product_id IS NULL OR quantity NOT BETWEEN 1 AND 99)) THEN
    RAISE EXCEPTION 'Unmapped or invalid order item; manual review required';
  END IF;

  -- Retry safety: if an order already holds its full eligible physical stock,
  -- return idempotently. A partially held or previously released order may
  -- never silently reserve extra or new units.
  SELECT count(*) INTO existing FROM public.inventory_order_allocations
    WHERE order_id=p_order_id;
  IF existing>0 THEN
    IF EXISTS (
      SELECT 1 FROM public.inventory_order_allocations a
       WHERE a.order_id=p_order_id AND a.status<>'held'
    ) OR EXISTS (
      SELECT 1 FROM public.order_items i
      JOIN public.inventory_product_settings s ON s.product_id=i.product_id
      WHERE i.order_id=p_order_id AND s.supply_mode='physical'
      AND (SELECT count(*) FROM public.inventory_order_allocations a
           WHERE a.order_item_id=i.id AND a.status='held')<>i.quantity
    ) THEN
      RAISE EXCEPTION 'Existing reservation is inconsistent; manual review required';
    END IF;
    RETURN jsonb_build_object('enabled',true,'already_reserved',true,'reserved',existing);
  END IF;

  FOR item IN
    SELECT i.id AS item_id,i.product_id,i.quantity,s.supply_mode
    FROM public.order_items i
    LEFT JOIN public.inventory_product_settings s ON s.product_id=i.product_id
    WHERE i.order_id=p_order_id
    ORDER BY i.product_id,i.id
  LOOP
    IF item.supply_mode IS DISTINCT FROM 'physical' THEN CONTINUE; END IF;
    item_count := item_count+1;
    -- Serialize per product, including multiple order lines with the same ID.
    PERFORM 1 FROM public.products p WHERE p.id=item.product_id FOR UPDATE;
    -- Match stock-count reconciliation's lock ordering: lot first, unit next.
    PERFORM 1 FROM public.inventory_lots l WHERE l.product_id=item.product_id
      ORDER BY l.id FOR UPDATE;
    local_reserved:=0;
    FOR picked IN
      SELECT u.id,u.lot_id,u.product_id
      FROM public.inventory_units u
      JOIN public.inventory_lots l ON l.id=u.lot_id
      WHERE u.product_id=item.product_id AND u.state='available'
        AND (l.expiry_date IS NULL OR l.expiry_date>=current_date)
      ORDER BY l.expiry_date NULLS LAST,u.created_at,u.id
      LIMIT item.quantity FOR UPDATE OF u SKIP LOCKED
    LOOP
      UPDATE public.inventory_units SET state='reserved'
        WHERE id=picked.id AND state='available';
      IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent inventory change'; END IF;
      INSERT INTO public.inventory_order_allocations(
        order_id,order_item_id,unit_id,status)
      VALUES(p_order_id,item.item_id,picked.id,'held');
      local_reserved:=local_reserved+1;
    END LOOP;
    IF local_reserved<>item.quantity THEN
      RAISE EXCEPTION 'Insufficient verified physical inventory for checkout';
    END IF;
    total_reserved:=total_reserved+local_reserved;
  END LOOP;
  RETURN jsonb_build_object('enabled',true,'reserved',total_reserved,
    'physical_lines',item_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.core_checkout_reserve_inventory(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_checkout_reserve_inventory(uuid) TO service_role;

-- Commit only after payment is verified by the provider / authorized staff.
-- The provider capture receipt is required for wallet/Card; manual Zelle
-- confirmation requires a verified payment record. Repeated callbacks are safe.
CREATE OR REPLACE FUNCTION public.core_checkout_commit_inventory(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  cfg jsonb;
  activation timestamptz;
  ord public.orders%rowtype;
  allocation record;
  held integer;
  committed integer;
BEGIN
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'Order ID is required'; END IF;
  SELECT value INTO cfg FROM public.internal_runtime_config
    WHERE key='inventory_checkout' FOR SHARE;
  IF COALESCE((cfg->>'deduction_enabled')::boolean,false) IS NOT TRUE THEN
    RETURN jsonb_build_object('enabled',false,'committed',0);
  END IF;
  IF COALESCE((cfg->>'reservation_enabled')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Deductions require reservations enabled';
  END IF;
  activation:=NULLIF(cfg->>'activated_at','')::timestamptz;
  IF activation IS NULL THEN RAISE EXCEPTION 'Activation timestamp is required'; END IF;
  SELECT * INTO ord FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF ord.created_at<activation THEN
    RETURN jsonb_build_object('enabled',true,'historical',true,'committed',0);
  END IF;
  IF ord.payment_status<>'paid' THEN RAISE EXCEPTION 'Payment is not yet confirmed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payments p WHERE p.order_id=ord.id
      AND p.status='verified' AND p.paid_at IS NOT NULL
      AND p.amount=ord.total
      AND p.provider=ord.payment_method
      AND p.customer_id IS NOT DISTINCT FROM ord.customer_id
      AND (ord.payment_method NOT IN ('PayPal','Venmo','Apple Pay','Card')
           OR nullif(p.provider_capture_id,'') IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Payment provider verification or amount is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_items i
    WHERE i.order_id=p_order_id AND (i.product_id IS NULL OR i.quantity<=0)
  ) THEN RAISE EXCEPTION 'Unmapped order item; manual review required'; END IF;

  SELECT count(*) INTO committed FROM public.inventory_order_allocations
    WHERE order_id=p_order_id AND status='committed';
  SELECT count(*) INTO held FROM public.inventory_order_allocations
    WHERE order_id=p_order_id AND status='held';
  IF committed>0 AND held=0 AND NOT EXISTS (
    SELECT 1 FROM public.inventory_order_allocations a
    WHERE a.order_id=p_order_id AND a.status='released'
  ) THEN
    RETURN jsonb_build_object('enabled',true,'already_committed',true,
      'committed',committed);
  END IF;
  IF committed>0 OR EXISTS (
    SELECT 1 FROM public.inventory_order_allocations a
     WHERE a.order_id=p_order_id AND a.status='released'
  ) THEN RAISE EXCEPTION 'Mixed or released reservations need manual review'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_items i
    JOIN public.inventory_product_settings s ON s.product_id=i.product_id
    WHERE i.order_id=p_order_id AND s.supply_mode='physical'
      AND (SELECT count(*) FROM public.inventory_order_allocations a
        WHERE a.order_item_id=i.id AND a.status='held')<>i.quantity
  ) THEN
    RAISE EXCEPTION 'Paid order is missing exact physical reservations';
  END IF;

  -- Serialize with inventory physical-count audits, one lot at a time.
  PERFORM 1 FROM public.inventory_lots l
    WHERE EXISTS (SELECT 1 FROM public.inventory_order_allocations a
      JOIN public.inventory_units u ON u.id=a.unit_id
      WHERE a.order_id=p_order_id AND a.status='held' AND u.lot_id=l.id)
    ORDER BY l.id FOR UPDATE;
  FOR allocation IN
    SELECT a.id,u.id AS unit_id,u.lot_id,u.product_id,u.state
    FROM public.inventory_order_allocations a
    JOIN public.inventory_units u ON u.id=a.unit_id
    WHERE a.order_id=p_order_id AND a.status='held'
    ORDER BY u.id FOR UPDATE OF a,u
  LOOP
    IF allocation.state<>'reserved' THEN
      RAISE EXCEPTION 'Tracked unit is no longer reserved';
    END IF;
    UPDATE public.inventory_units SET state='allocated'
      WHERE id=allocation.unit_id AND state='reserved';
    INSERT INTO public.inventory_movements(
      unit_id,product_id,lot_id,quantity_delta,reason,event_key,actor_id
    ) VALUES(allocation.unit_id,allocation.product_id,allocation.lot_id,-1,
      'allocated','paid_order:'||p_order_id::text||':unit:'||allocation.unit_id::text,null);
    UPDATE public.inventory_order_allocations
      SET status='committed',committed_at=now() WHERE id=allocation.id;
  END LOOP;
  RETURN jsonb_build_object('enabled',true,'committed',held);
END;
$function$;
REVOKE ALL ON FUNCTION public.core_checkout_commit_inventory(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_checkout_commit_inventory(uuid) TO service_role;

-- Unpaid/failed/cancelled orders release holds only. A paid/committed
-- order must never be silently restocked after a refund or cancellation.
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
  IF lower(ord.status) NOT IN ('cancelled','canceled','checkout_error')
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
CREATE OR REPLACE FUNCTION private.core_checkout_release_on_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF new.payment_status<>'paid' AND
    (lower(new.status) IN ('cancelled','canceled','checkout_error') OR
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
DROP TRIGGER IF EXISTS core_checkout_release_on_cancel ON public.orders;
CREATE TRIGGER core_checkout_release_on_cancel
AFTER UPDATE OF status,payment_status ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.core_checkout_release_on_cancel();

-- Guardrails for service-only mutation. These must fail the migration if
-- a new table or function has inherited managed-role public grants.
DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM public.inventory_order_allocations) THEN
    RAISE EXCEPTION 'Migration must not generate historical allocations';
  END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_units WHERE state='allocated') THEN
    RAISE EXCEPTION 'Migration must not allocate existing inventory';
  END IF;
  IF (SELECT coalesce((value->>'reservation_enabled')::boolean,false)
      FROM public.internal_runtime_config WHERE key='inventory_checkout') OR
     (SELECT coalesce((value->>'deduction_enabled')::boolean,false)
      FROM public.internal_runtime_config WHERE key='inventory_checkout') THEN
    RAISE EXCEPTION 'Deployment requires both inventory flags disabled';
  END IF;
  IF has_table_privilege('anon','public.inventory_order_allocations','SELECT') OR
     has_table_privilege('authenticated','public.inventory_order_allocations','SELECT') OR
     has_table_privilege('authenticated','public.inventory_order_allocations','UPDATE') OR
     has_function_privilege('authenticated','public.core_checkout_reserve_inventory(uuid)','EXECUTE') OR
     has_function_privilege('anon','public.core_checkout_commit_inventory(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Inventory allocation permission leak';
  END IF;
END;
$verify$;
