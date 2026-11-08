-- Core owner/admin management of existing membership plans.
-- Does not assign a plan to customers or change checkout/payment rules.
-- Atomic audit + optimistic concurrency; callable only by service role after
-- the Core Edge Function validates an authenticated owner/admin JWT.
CREATE OR REPLACE FUNCTION public.core_manage_membership(
  p_action text,
  p_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_benefits jsonb,
  p_sort_order integer,
  p_active boolean,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_actor_email text,
  p_actor_role text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_before public.memberships%ROWTYPE;
  v_after public.memberships%ROWTYPE;
  v_benefit jsonb;
  v_name text := btrim(COALESCE(p_name, ''));
  v_slug text := btrim(COALESCE(p_slug, ''));
BEGIN
  IF p_actor_id IS NULL OR p_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Core administrator access required';
  END IF;
  IF p_action NOT IN ('create','update') THEN
    RAISE EXCEPTION 'Unsupported membership operation';
  END IF;
  IF length(v_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Membership name must be 2–120 characters';
  END IF;
  IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(v_slug) > 120 THEN
    RAISE EXCEPTION 'Slug must be lowercase letters, numbers and hyphens';
  END IF;
  IF length(COALESCE(p_description,'')) > 2000 THEN
    RAISE EXCEPTION 'Description must be 2000 characters or fewer';
  END IF;
  IF p_sort_order IS NULL OR p_sort_order NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Display order must be between 0 and 10000';
  END IF;
  IF p_active IS NULL THEN RAISE EXCEPTION 'Active status required'; END IF;
  IF jsonb_typeof(p_benefits) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_benefits) > 20 THEN
    RAISE EXCEPTION 'Benefits must be an array of at most 20 items';
  END IF;
  FOR v_benefit IN SELECT value FROM jsonb_array_elements(p_benefits)
  LOOP
    IF jsonb_typeof(v_benefit) <> 'string'
      OR length(btrim(v_benefit #>> '{}')) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Each benefit must be nonempty text up to 200 characters';
    END IF;
  END LOOP;

  IF p_action = 'create' THEN
    IF p_id IS NOT NULL THEN RAISE EXCEPTION 'New plan must not have an ID'; END IF;
    INSERT INTO public.memberships (name,slug,description,benefits,sort_order,active)
    VALUES (v_name,v_slug,NULLIF(btrim(p_description),''),p_benefits,p_sort_order,p_active)
    RETURNING * INTO v_after;
  ELSE
    IF p_id IS NULL OR p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'Membership ID and current version required';
    END IF;
    SELECT * INTO v_before FROM public.memberships WHERE id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Membership not found'; END IF;
    IF v_before.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Membership changed elsewhere; refresh before saving';
    END IF;
    -- Slugs act as stable tier identifiers. Checkout currently recognises
    -- the Founding Member by *exact name*, so lock that name pending
    -- deliberate migration to a stable checkout tier identifier.
    IF v_slug <> v_before.slug THEN
      RAISE EXCEPTION 'Existing membership slug cannot be renamed';
    END IF;
    IF v_before.slug = 'founding-member' AND v_name <> 'Founding Member' THEN
      RAISE EXCEPTION 'Founding Member name is protected by checkout rules';
    END IF;
    UPDATE public.memberships
    SET name=v_name,description=NULLIF(btrim(p_description),''),
      benefits=p_benefits,sort_order=p_sort_order,active=p_active,updated_at=now()
    WHERE id=p_id
    RETURNING * INTO v_after;
  END IF;

  INSERT INTO public.core_audit_events(
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,
    before_data,after_data,metadata
  ) VALUES (
    p_actor_id,p_actor_email,p_actor_role,
    'membership.' || p_action,'membership',v_after.id::text,
    CASE WHEN p_action='create' THEN NULL ELSE to_jsonb(v_before) END,
    to_jsonb(v_after),jsonb_build_object('source','core','customer_assignments_changed',false)
  );
  RETURN to_jsonb(v_after);
END;
$function$;

REVOKE ALL ON FUNCTION public.core_manage_membership(text,uuid,text,text,text,jsonb,integer,boolean,timestamptz,uuid,text,text)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_manage_membership(text,uuid,text,text,text,jsonb,integer,boolean,timestamptz,uuid,text,text)
TO service_role;
