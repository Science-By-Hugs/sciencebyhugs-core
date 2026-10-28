-- Google exit (2026-10-27): Core "Delete" archives products with order history and
-- hard-deletes products that were never ordered. Applied to production 2026-10-27.
create or replace function public.core_remove_catalog_product(
  p_product_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_product public.products%rowtype;
  v_ordered boolean;
  v_now timestamptz := now();
begin
  select * into v_product from public.products where id = p_product_id for update;
  if v_product.id is null then
    return jsonb_build_object('success', false, 'error', 'Product not found.');
  end if;

  select exists(select 1 from public.order_items where product_id = v_product.id) into v_ordered;

  if v_ordered then
    update public.products
      set active = false, storefront_status = 'Archived', featured = false, updated_at = v_now
      where id = v_product.id;

    insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
    values (p_actor_user_id, p_actor_email, coalesce(nullif(trim(p_actor_role), ''), 'admin'),
      'catalog.product.archive', 'product', v_product.id::text,
      jsonb_build_object('active', v_product.active, 'storefront_status', v_product.storefront_status, 'featured', v_product.featured),
      jsonb_build_object('active', false, 'storefront_status', 'Archived', 'featured', false),
      jsonb_build_object('source', 'core', 'reason', 'product has order history', 'product_name', v_product.name));

    return jsonb_build_object('success', true, 'mode', 'archived', 'productId', v_product.id, 'productName', v_product.name);
  end if;

  insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
  values (p_actor_user_id, p_actor_email, coalesce(nullif(trim(p_actor_role), ''), 'admin'),
    'catalog.product.delete', 'product', v_product.id::text,
    to_jsonb(v_product) - 'metadata', null,
    jsonb_build_object('source', 'core', 'reason', 'never ordered'));

  delete from public.products where id = v_product.id;

  return jsonb_build_object('success', true, 'mode', 'deleted', 'productId', v_product.id, 'productName', v_product.name);
end;
$$;

revoke all on function public.core_remove_catalog_product(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.core_remove_catalog_product(uuid, uuid, text, text) to service_role;

-- Rollback: drop function if exists public.core_remove_catalog_product(uuid, uuid, text, text);
