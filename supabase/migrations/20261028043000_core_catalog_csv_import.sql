-- Core catalog CSV import (2026-10-27).
-- Applies a validated import plan in ONE transaction: any stale row or error rolls
-- back the whole import. The plan is built and validated by core-catalog-control;
-- this function only executes it and writes the audit trail.
--
-- p_plan = {
--   "creates":  [{ "row": 2, "fields": { "name": "...", "price": 49.99, ... } }],
--   "updates":  [{ "row": 3, "id": "<uuid>", "expected_updated_at": "<ts>", "patch": { "price": 59 } }],
--   "takeoffs": [{ "id": "<uuid>", "expected_updated_at": "<ts>" }],
--   "file_name": "catalog.csv"
-- }
-- Allowed field keys: name, price, product_code, sku, research_name, category_id,
-- description, purity, quantity, lot_number, coa_url, image_url, product_type,
-- shipping_from, active, storefront_status, featured, core_hidden.

create or replace function public.core_apply_catalog_import(
  p_plan jsonb,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item jsonb;
  v_patch jsonb;
  v_before public.products%rowtype;
  v_after public.products%rowtype;
  v_now timestamptz := now();
  v_role text := coalesce(nullif(trim(p_actor_role), ''), 'admin');
  v_created int := 0;
  v_updated int := 0;
  v_taken_off int := 0;
  v_import_id uuid := gen_random_uuid();
begin
  -- Creates
  for v_item in select * from jsonb_array_elements(coalesce(p_plan->'creates', '[]'::jsonb)) loop
    v_patch := v_item->'fields';
    insert into public.products (
      name, price, product_code, sku, research_name, category_id, description, purity, quantity,
      lot_number, coa_url, image_url, product_type, shipping_from, active, storefront_status,
      featured, core_hidden, source, sync_source, created_at, updated_at
    ) values (
      v_patch->>'name',
      (v_patch->>'price')::numeric,
      v_patch->>'product_code',
      v_patch->>'sku',
      v_patch->>'research_name',
      nullif(v_patch->>'category_id', '')::uuid,
      v_patch->>'description',
      v_patch->>'purity',
      v_patch->>'quantity',
      v_patch->>'lot_number',
      v_patch->>'coa_url',
      v_patch->>'image_url',
      v_patch->>'product_type',
      v_patch->>'shipping_from',
      coalesce((v_patch->>'active')::boolean, false),
      coalesce(v_patch->>'storefront_status', 'Inactive'),
      coalesce((v_patch->>'featured')::boolean, false),
      coalesce((v_patch->>'core_hidden')::boolean, false),
      'core_manual', 'core_csv_import', v_now, v_now
    ) returning * into v_after;

    insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
    values (p_actor_user_id, p_actor_email, v_role, 'catalog.product.create', 'product', v_after.id::text,
      null, to_jsonb(v_after) - 'metadata',
      jsonb_build_object('source', 'core_csv_import', 'import_id', v_import_id, 'row', v_item->'row', 'product_name', v_after.name));
    v_created := v_created + 1;
  end loop;

  -- Updates (only keys present in the patch change; stale rows abort everything)
  for v_item in select * from jsonb_array_elements(coalesce(p_plan->'updates', '[]'::jsonb)) loop
    v_patch := v_item->'patch';
    select * into v_before from public.products where id = (v_item->>'id')::uuid for update;
    if v_before.id is null then
      raise exception 'IMPORT_STALE: product % no longer exists', v_item->>'id';
    end if;
    if v_before.updated_at <> (v_item->>'expected_updated_at')::timestamptz then
      raise exception 'IMPORT_STALE: % was changed after the preview', v_before.name;
    end if;

    update public.products p set
      name              = case when v_patch ? 'name' then v_patch->>'name' else p.name end,
      price             = case when v_patch ? 'price' then (v_patch->>'price')::numeric else p.price end,
      product_code      = case when v_patch ? 'product_code' then v_patch->>'product_code' else p.product_code end,
      sku               = case when v_patch ? 'sku' then v_patch->>'sku' else p.sku end,
      research_name     = case when v_patch ? 'research_name' then v_patch->>'research_name' else p.research_name end,
      category_id       = case when v_patch ? 'category_id' then nullif(v_patch->>'category_id', '')::uuid else p.category_id end,
      description       = case when v_patch ? 'description' then v_patch->>'description' else p.description end,
      purity            = case when v_patch ? 'purity' then v_patch->>'purity' else p.purity end,
      quantity          = case when v_patch ? 'quantity' then v_patch->>'quantity' else p.quantity end,
      lot_number        = case when v_patch ? 'lot_number' then v_patch->>'lot_number' else p.lot_number end,
      coa_url           = case when v_patch ? 'coa_url' then v_patch->>'coa_url' else p.coa_url end,
      image_url         = case when v_patch ? 'image_url' then v_patch->>'image_url' else p.image_url end,
      product_type      = case when v_patch ? 'product_type' then v_patch->>'product_type' else p.product_type end,
      shipping_from     = case when v_patch ? 'shipping_from' then v_patch->>'shipping_from' else p.shipping_from end,
      active            = case when v_patch ? 'active' then (v_patch->>'active')::boolean else p.active end,
      storefront_status = case when v_patch ? 'storefront_status' then v_patch->>'storefront_status' else p.storefront_status end,
      featured          = case when v_patch ? 'featured' then (v_patch->>'featured')::boolean else p.featured end,
      core_hidden       = case when v_patch ? 'core_hidden' then (v_patch->>'core_hidden')::boolean else p.core_hidden end,
      sync_source       = 'core_csv_import',
      updated_at        = v_now
    where p.id = v_before.id
    returning * into v_after;

    insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
    values (p_actor_user_id, p_actor_email, v_role, 'catalog.product.update', 'product', v_before.id::text,
      (select jsonb_object_agg(k, to_jsonb(v_before)->k) from jsonb_object_keys(v_patch) k),
      (select jsonb_object_agg(k, to_jsonb(v_after)->k) from jsonb_object_keys(v_patch) k),
      jsonb_build_object('source', 'core_csv_import', 'import_id', v_import_id, 'row', v_item->'row', 'product_name', v_before.name));
    v_updated := v_updated + 1;
  end loop;

  -- Take off sale: products selling in Core but absent from the CSV
  for v_item in select * from jsonb_array_elements(coalesce(p_plan->'takeoffs', '[]'::jsonb)) loop
    select * into v_before from public.products where id = (v_item->>'id')::uuid for update;
    if v_before.id is null then
      raise exception 'IMPORT_STALE: product % no longer exists', v_item->>'id';
    end if;
    if v_before.updated_at <> (v_item->>'expected_updated_at')::timestamptz then
      raise exception 'IMPORT_STALE: % was changed after the preview', v_before.name;
    end if;

    update public.products
      set active = false, storefront_status = 'Inactive', featured = false,
          sync_source = 'core_csv_import', updated_at = v_now
      where id = v_before.id;

    insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
    values (p_actor_user_id, p_actor_email, v_role, 'catalog.product.unavailable', 'product', v_before.id::text,
      jsonb_build_object('active', v_before.active, 'storefront_status', v_before.storefront_status, 'featured', v_before.featured),
      jsonb_build_object('active', false, 'storefront_status', 'Inactive', 'featured', false),
      jsonb_build_object('source', 'core_csv_import', 'import_id', v_import_id, 'reason', 'not in imported CSV', 'product_name', v_before.name));
    v_taken_off := v_taken_off + 1;
  end loop;

  insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
  values (p_actor_user_id, p_actor_email, v_role, 'catalog.import', 'catalog_import', v_import_id::text, null,
    jsonb_build_object('created', v_created, 'updated', v_updated, 'taken_off_sale', v_taken_off),
    jsonb_build_object('source', 'core_csv_import', 'file_name', p_plan->>'file_name'));

  return jsonb_build_object('success', true, 'importId', v_import_id,
    'created', v_created, 'updated', v_updated, 'takenOffSale', v_taken_off);
end;
$$;

revoke all on function public.core_apply_catalog_import(jsonb, uuid, text, text) from public, anon, authenticated;
grant execute on function public.core_apply_catalog_import(jsonb, uuid, text, text) to service_role;

-- Rollback: drop function if exists public.core_apply_catalog_import(jsonb, uuid, text, text);
