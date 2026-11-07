-- Narrow, atomic owner/admin shipping-rate edits.
-- Existing service_role can SELECT internal_runtime_config but must NOT get a
-- blanket UPDATE privilege over checkout/payment/inventory settings.
CREATE OR REPLACE FUNCTION public.core_catalog_change_shipping_rate(
  p_source text, p_rate numeric, p_delete boolean,
  p_actor_id uuid, p_actor_email text, p_actor_role text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_config jsonb;
  v_rates jsonb;
  v_before jsonb;
  v_after jsonb;
  v_used bigint;
BEGIN
  IF p_actor_id IS NULL OR p_actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Core administrator access required';
  END IF;
  IF p_source IS NULL OR length(btrim(p_source)) NOT BETWEEN 1 AND 120
     OR p_source <> btrim(p_source) THEN
    RAISE EXCEPTION 'Shipping source name must be 1–120 characters';
  END IF;
  IF p_delete IS DISTINCT FROM true AND
     (p_rate IS NULL OR p_rate < 0 OR p_rate > 100000 OR trunc(p_rate, 2) <> p_rate) THEN
    RAISE EXCEPTION 'Shipping rate must be 0–100000 with at most two decimals';
  END IF;

  -- Lock the existing checkout config row so concurrent rate changes are not lost.
  SELECT value INTO v_config
  FROM public.internal_runtime_config WHERE key='checkout' FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_config) <> 'object' THEN
    RAISE EXCEPTION 'Checkout configuration unavailable';
  END IF;
  v_rates := COALESCE(v_config->'shippingRates','{}'::jsonb);
  IF jsonb_typeof(v_rates) <> 'object' THEN
    RAISE EXCEPTION 'Shipping configuration is malformed';
  END IF;
  v_before := v_rates->p_source;
  IF p_delete THEN
    IF v_before IS NULL THEN RAISE EXCEPTION 'Shipping source not found'; END IF;
    SELECT count(*) INTO v_used FROM public.products
    WHERE shipping_from=p_source AND active=true;
    IF v_used > 0 THEN
      RAISE EXCEPTION '% active product(s) still ship from "%". Move them first.', v_used, p_source;
    END IF;
    v_rates := v_rates - p_source;
  ELSE
    v_rates := jsonb_set(v_rates, ARRAY[p_source], to_jsonb(p_rate), true);
  END IF;
  v_after := v_rates->p_source;
  UPDATE public.internal_runtime_config
  SET value=jsonb_set(v_config,'{shippingRates}',v_rates,true),updated_at=now()
  WHERE key='checkout';

  INSERT INTO public.core_audit_events(
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,
    before_data,after_data,metadata
  ) VALUES (
    p_actor_id,p_actor_email,p_actor_role,
    CASE WHEN p_delete THEN 'catalog.shipping_rate.delete' ELSE 'catalog.shipping_rate.set' END,
    'shipping_rate',p_source,
    jsonb_build_object('rate',v_before),
    jsonb_build_object('rate',v_after),
    jsonb_build_object('source','core')
  );
  RETURN jsonb_build_object('shippingRates',v_rates);
END;
$function$;

REVOKE ALL ON FUNCTION public.core_catalog_change_shipping_rate(text,numeric,boolean,uuid,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_catalog_change_shipping_rate(text,numeric,boolean,uuid,text,text)
  TO service_role;

-- No changes to existing rates. No GRANT UPDATE on internal_runtime_config.