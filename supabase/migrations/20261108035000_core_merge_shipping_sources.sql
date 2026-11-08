-- Core shipping-source consolidation for the manual Core -> Nexus catalog.
-- Moves ALL product mappings, matching shipping-rate config, and founding-member
-- waiver together with an audit record; no customer order history is rewritten.
-- Deliberately limited to merging into an EXISTING source with the SAME rate:
-- the destination is already known to in-flight checkout calculations.
CREATE OR REPLACE FUNCTION public.core_catalog_merge_shipping_source(
  p_old_source text,
  p_new_source text,
  p_confirm_old_source text,
  p_expected_rate numeric,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_actor_email text;
  v_actor_role text;
  v_checkout jsonb;
  v_rates jsonb;
  v_old_rate numeric;
  v_target_rate numeric;
  v_products jsonb;
  v_product_count integer;
  v_founder_before text;
  v_waiver_moved boolean;
  v_updated_checkout jsonb;
BEGIN
  -- Edge auth must have resolved the real JWT user before calling this RPC.
  -- Verify the actor's protected app metadata once more inside PostgreSQL.
  SELECT u.email,lower(coalesce(u.raw_app_meta_data->>'role',''))
  INTO v_actor_email,v_actor_role
  FROM auth.users u WHERE u.id=p_actor_id;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Core owner/admin access is required';
  END IF;
  IF p_old_source IS NULL OR p_new_source IS NULL
    OR length(btrim(p_old_source)) NOT BETWEEN 1 AND 120
    OR length(btrim(p_new_source)) NOT BETWEEN 1 AND 120
    OR p_old_source <> btrim(p_old_source)
    OR p_new_source <> btrim(p_new_source)
    OR lower(p_old_source)=lower(p_new_source)
    OR p_confirm_old_source IS DISTINCT FROM p_old_source THEN
    RAISE EXCEPTION 'Enter two different shipping sources and type the old source exactly';
  END IF;

  -- Prevent lost updates if another operator is editing shipping rates.
  SELECT value INTO v_checkout
  FROM public.internal_runtime_config WHERE key='checkout' FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_checkout) <> 'object' THEN
    RAISE EXCEPTION 'Checkout configuration is missing';
  END IF;
  v_rates:=v_checkout->'shippingRates';
  IF v_rates IS NULL OR jsonb_typeof(v_rates) <> 'object' THEN
    RAISE EXCEPTION 'Shipping rates are not configured';
  END IF;
  IF NOT v_rates ? p_old_source THEN
    RAISE EXCEPTION 'The original shipping source no longer exists';
  END IF;
  IF NOT v_rates ? p_new_source THEN
    RAISE EXCEPTION 'Add the destination source at the same rate first, then merge';
  END IF;
  -- Strict name matching prevents confusing case-only duplicates.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_rates) AS k(source)
             WHERE lower(k.source)=lower(p_new_source) AND k.source<>p_new_source) THEN
    RAISE EXCEPTION 'A shipping source with different capitalization already exists';
  END IF;
  v_old_rate:=(v_rates->>p_old_source)::numeric;
  v_target_rate:=(v_rates->>p_new_source)::numeric;
  IF v_old_rate IS DISTINCT FROM p_expected_rate THEN
    RAISE EXCEPTION 'Shipping rates changed since you opened Core. Refresh and try again';
  END IF;
  IF v_old_rate IS DISTINCT FROM v_target_rate THEN
    RAISE EXCEPTION 'Both sources must have the same rate; otherwise existing shipping charges could change';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'product_code',p.product_code,'name',p.name,'active',p.active)
    ORDER BY p.product_code),'[]'::jsonb)
  INTO v_products
  FROM public.products p
  WHERE p.shipping_from=p_old_source;

  UPDATE public.products
  SET shipping_from=p_new_source,updated_at=now()
  WHERE shipping_from=p_old_source;
  GET DIAGNOSTICS v_product_count=ROW_COUNT;

  v_founder_before:=coalesce(v_checkout->>'foundingMemberFreeShippingSource','');
  v_waiver_moved:=lower(btrim(v_founder_before))=lower(p_old_source);
  v_updated_checkout:=jsonb_set(v_checkout,'{shippingRates}',v_rates-p_old_source,true);
  IF v_waiver_moved THEN
    v_updated_checkout:=jsonb_set(
      v_updated_checkout,'{foundingMemberFreeShippingSource}',to_jsonb(p_new_source),true
    );
  END IF;
  UPDATE public.internal_runtime_config
  SET value=v_updated_checkout,updated_at=now()
  WHERE key='checkout';

  -- Atomic: audit failure also rolls back product mappings and checkout config.
  INSERT INTO public.core_audit_events(
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,
    before_data,after_data,metadata
  ) VALUES (
    p_actor_id,v_actor_email,v_actor_role,
    'catalog.shipping_source.merge','shipping_source',p_old_source,
    jsonb_build_object('source',p_old_source,'rate',v_old_rate,
      'foundingMemberFreeShippingSource',v_founder_before,'products',v_products),
    jsonb_build_object('source',p_new_source,'rate',v_target_rate,
      'foundingMemberFreeShippingSource',v_updated_checkout->>'foundingMemberFreeShippingSource',
      'moved_product_count',v_product_count),
    jsonb_build_object('source','core','from',p_old_source,'to',p_new_source,
      'waiver_moved',v_waiver_moved)
  );

  RETURN jsonb_build_object(
    'success',true,'oldSource',p_old_source,'newSource',p_new_source,
    'rate',v_target_rate,'movedProducts',v_product_count,
    'foundingWaiverMoved',v_waiver_moved,
    'shippingRates',v_updated_checkout->'shippingRates'
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.core_catalog_merge_shipping_source(text,text,text,numeric,uuid)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_catalog_merge_shipping_source(text,text,text,numeric,uuid)
TO service_role;
