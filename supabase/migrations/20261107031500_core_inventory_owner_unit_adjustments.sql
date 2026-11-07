-- Owner-initiated audited changes to existing tracked physical units.
-- Stock increases continue to use purchase receipts: no synthetic units or
-- overwritten quantity totals. Never change held, allocated or shipped units.
CREATE TABLE IF NOT EXISTS public.inventory_owner_adjustments (
  request_id uuid PRIMARY KEY,
  lot_id uuid NOT NULL REFERENCES public.inventory_lots(id) ON DELETE RESTRICT,
  unit_ids uuid[] NOT NULL,
  action text NOT NULL CHECK(action IN ('damage','quarantine','restore_damaged','restore_quarantined')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 500),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.inventory_owner_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_owner_adjustments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.inventory_owner_adjustments TO service_role;

CREATE OR REPLACE FUNCTION public.core_inventory_change_unit_states(
  p_lot_id uuid,p_unit_ids uuid[],p_action text,p_reason text,
  p_request_id uuid,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_old text;
  v_new text;
  v_unit record;
  v_previous public.inventory_owner_adjustments%rowtype;
  v_ids uuid[];
  v_count integer := 0;
  v_delta integer;
BEGIN
  IF p_lot_id IS NULL OR p_request_id IS NULL OR p_actor_id IS NULL
     OR p_action IS NULL OR p_action NOT IN ('damage','quarantine','restore_damaged','restore_quarantined')
     OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 8 AND 500
     OR p_unit_ids IS NULL OR cardinality(p_unit_ids) NOT BETWEEN 1 AND 100
     OR EXISTS(SELECT 1 FROM unnest(p_unit_ids) AS item(unit_id) WHERE item.unit_id IS NULL)
  THEN RAISE EXCEPTION 'Invalid tracked stock adjustment'; END IF;
  v_ids:=ARRAY(SELECT DISTINCT item.unit_id FROM unnest(p_unit_ids) AS item(unit_id) ORDER BY item.unit_id);
  IF cardinality(v_ids)<>cardinality(p_unit_ids) THEN
    RAISE EXCEPTION 'Duplicate unit IDs are not allowed';
  END IF;
  SELECT * INTO v_previous FROM public.inventory_owner_adjustments WHERE request_id=p_request_id;
  IF FOUND THEN
    IF v_previous.lot_id<>p_lot_id OR v_previous.unit_ids<>v_ids OR
       v_previous.action<>p_action OR v_previous.reason<>btrim(p_reason) OR
       v_previous.actor_id<>p_actor_id THEN
      RAISE EXCEPTION 'Adjustment request ID reused with different details';
    END IF;
    RETURN jsonb_build_object('action',p_action,'changed_units',cardinality(v_ids),'already_saved',true);
  END IF;
  -- Checkout reserve/commit locks lots before units. Maintain that order.
  PERFORM 1 FROM public.inventory_lots WHERE id=p_lot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tracked lot not found'; END IF;
  -- Retry may have been committed during the lock wait.
  SELECT * INTO v_previous FROM public.inventory_owner_adjustments WHERE request_id=p_request_id;
  IF FOUND THEN
    IF v_previous.lot_id<>p_lot_id OR v_previous.unit_ids<>v_ids OR
       v_previous.action<>p_action OR v_previous.reason<>btrim(p_reason) OR
       v_previous.actor_id<>p_actor_id THEN
      RAISE EXCEPTION 'Adjustment request ID reused with different details';
    END IF;
    RETURN jsonb_build_object('action',p_action,'changed_units',cardinality(v_ids),'already_saved',true);
  END IF;
  v_old:=CASE WHEN p_action IN ('damage','quarantine') THEN 'available'
      WHEN p_action='restore_damaged' THEN 'damaged' ELSE 'quarantined' END;
  v_new:=CASE WHEN p_action='damage' THEN 'damaged'
      WHEN p_action='quarantine' THEN 'quarantined' ELSE 'available' END;
  v_delta:=CASE WHEN v_old='available' THEN -1 ELSE 1 END;
  FOR v_unit IN
    SELECT id,product_id,lot_id,state FROM public.inventory_units
    WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE
  LOOP
    IF v_unit.lot_id<>p_lot_id OR v_unit.state<>v_old THEN
      RAISE EXCEPTION 'Unit state changed or unit belongs to another lot; refresh first';
    END IF;
    IF EXISTS(SELECT 1 FROM public.inventory_order_allocations a
              WHERE a.unit_id=v_unit.id AND a.status IN ('held','committed')) THEN
      RAISE EXCEPTION 'Reserved or paid units cannot be manually adjusted';
    END IF;
    UPDATE public.inventory_units SET state=v_new WHERE id=v_unit.id AND state=v_old;
    INSERT INTO public.inventory_movements(
      unit_id,product_id,lot_id,quantity_delta,reason,event_key,actor_id
    ) VALUES(
      v_unit.id,v_unit.product_id,v_unit.lot_id,v_delta,
      CASE WHEN p_action='damage' THEN 'damaged' ELSE 'adjustment' END,
      'owner_adjust:'||p_request_id::text||':unit:'||v_unit.id::text,p_actor_id
    );
    v_count:=v_count+1;
  END LOOP;
  IF v_count<>cardinality(v_ids) THEN
    RAISE EXCEPTION 'Tracked unit IDs not found; refresh before adjusting';
  END IF;
  INSERT INTO public.inventory_owner_adjustments(
    request_id,lot_id,unit_ids,action,reason,actor_id
  ) VALUES(p_request_id,p_lot_id,v_ids,p_action,btrim(p_reason),p_actor_id);
  RETURN jsonb_build_object('action',p_action,'changed_units',v_count,'already_saved',false);
END;
$function$;

REVOKE ALL ON FUNCTION public.core_inventory_change_unit_states(uuid,uuid[],text,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_inventory_change_unit_states(uuid,uuid[],text,text,uuid,uuid)
  TO service_role;
