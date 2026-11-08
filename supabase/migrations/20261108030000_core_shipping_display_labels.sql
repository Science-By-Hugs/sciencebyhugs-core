-- Human-readable Core-only shipping labels. Internal checkout group keys never change.
-- API gateway verifies owner/admin JWT and supplies the actor identity.
-- This function is service-role-only and cannot edit shippingRates or the waiver.
CREATE OR REPLACE FUNCTION public.core_catalog_set_shipping_display_label(
  p_source text, p_display_label text,
  p_actor_id uuid, p_actor_email text, p_actor_role text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_config jsonb;
  v_rates jsonb;
  v_labels jsonb;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Core administrator access required';
  END IF;
  IF p_source IS NULL OR length(btrim(p_source)) NOT BETWEEN 1 AND 120
     OR p_source <> btrim(p_source) THEN
    RAISE EXCEPTION 'Valid shipping source required';
  END IF;
  IF p_display_label IS NOT NULL AND
     (length(p_display_label) > 120 OR p_display_label <> btrim(p_display_label)) THEN
    RAISE EXCEPTION 'Display name must be 120 characters or fewer';
  END IF;

  SELECT value INTO v_config
  FROM public.internal_runtime_config WHERE key = 'checkout' FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_config) <> 'object' THEN
    RAISE EXCEPTION 'Checkout configuration unavailable';
  END IF;
  v_rates := COALESCE(v_config->'shippingRates', '{}'::jsonb);
  IF jsonb_typeof(v_rates) <> 'object' OR NOT (v_rates ? p_source) THEN
    RAISE EXCEPTION 'Unknown shipping source';
  END IF;
  v_labels := COALESCE(v_config->'shippingDisplayLabels', '{}'::jsonb);
  IF jsonb_typeof(v_labels) <> 'object' THEN
    RAISE EXCEPTION 'Shipping labels configuration is malformed';
  END IF;

  v_before := v_labels->p_source;
  IF p_display_label IS NULL OR p_display_label = '' THEN
    v_labels := v_labels - p_source;
  ELSE
    v_labels := jsonb_set(v_labels, ARRAY[p_source], to_jsonb(p_display_label), true);
  END IF;
  v_after := v_labels->p_source;

  UPDATE public.internal_runtime_config
  SET value = jsonb_set(v_config, '{shippingDisplayLabels}', v_labels, true),
      updated_at = now()
  WHERE key = 'checkout';

  INSERT INTO public.core_audit_events (
    actor_user_id, actor_email, actor_role, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) VALUES (
    p_actor_id, p_actor_email, p_actor_role,
    'catalog.shipping_display_label.set', 'shipping_source', p_source,
    jsonb_build_object('display_label', v_before),
    jsonb_build_object('display_label', v_after),
    jsonb_build_object('source','core','checkout_key_unchanged',true)
  );

  RETURN jsonb_build_object('shippingDisplayLabels', v_labels);
END;
$function$;

REVOKE ALL ON FUNCTION public.core_catalog_set_shipping_display_label(text,text,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.core_catalog_set_shipping_display_label(text,text,uuid,text,text)
  TO service_role;

-- No modifications to checkout.shippingRates, foundingMemberFreeShippingSource,
-- products.shipping_from, customer orders, or existing alias values.
