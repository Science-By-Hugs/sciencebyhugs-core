-- Vendor pricing & profit (2026-10-27).
-- Vendor costs and per-sale cost snapshots live in tables that customers and the
-- public storefront can NEVER read (RLS on, no policies, no grants to anon /
-- authenticated). Only trusted server code (service role) reads or writes them.
-- products / order_items are customer-readable, so costs must not be stored there.

-- 1. Current vendor cost per product -------------------------------------------
create table if not exists public.product_costs (
  product_id  uuid primary key references public.products(id) on delete cascade,
  vendor_cost numeric(12,2) not null check (vendor_cost >= 0),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.product_costs enable row level security;
revoke all on table public.product_costs from anon, authenticated, public;
grant all on table public.product_costs to service_role;

-- 2. Cost captured at the moment of sale -----------------------------------------
create table if not exists public.order_item_costs (
  order_item_id uuid primary key references public.order_items(id) on delete cascade,
  order_id      uuid not null references public.orders(id) on delete cascade,
  product_id    uuid references public.products(id) on delete set null,
  unit_cost     numeric(12,2),          -- null = no vendor cost was on file
  quantity      integer not null,
  line_cost     numeric(12,2),
  captured_at   timestamptz not null default now()
);
create index if not exists order_item_costs_order_id_idx on public.order_item_costs(order_id);
alter table public.order_item_costs enable row level security;
revoke all on table public.order_item_costs from anon, authenticated, public;
grant all on table public.order_item_costs to service_role;

-- 3. Snapshot trigger. Must NEVER block checkout: any failure is swallowed. -------
create or replace function public.capture_order_item_cost()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  begin
    insert into public.order_item_costs(order_item_id, order_id, product_id, unit_cost, quantity, line_cost)
    select new.id, new.order_id, new.product_id, pc.vendor_cost, new.quantity,
           case when pc.vendor_cost is null then null else round(pc.vendor_cost * new.quantity, 2) end
    from (select 1) one
    left join public.product_costs pc on pc.product_id = new.product_id
    on conflict (order_item_id) do nothing;
  exception when others then
    raise warning 'capture_order_item_cost skipped for order item %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.capture_order_item_cost() from public, anon, authenticated;

drop trigger if exists order_items_capture_cost on public.order_items;
create trigger order_items_capture_cost
  after insert on public.order_items
  for each row execute function public.capture_order_item_cost();

-- 4. Profit report for Core Finance (service role only) ---------------------------
-- Sales = order line totals (before order-level discounts). Discounts are reported
-- separately. Margin = profit / net sales; markup = profit / vendor cost.
create or replace function public.core_profit_report(p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with paid as (
  select o.id, o.paid_at, coalesce(o.discount_total, 0) as discount_total
  from public.orders o
  where o.payment_status = 'paid'
    and (p_from is null or o.paid_at >= p_from)
    and (p_to is null or o.paid_at < p_to)
),
lines as (
  select oi.id, oi.order_id, oi.product_id, oi.product_name, oi.product_code, oi.quantity,
         oi.line_total, c.unit_cost, c.line_cost, p.paid_at
  from public.order_items oi
  join paid p on p.id = oi.order_id
  left join public.order_item_costs c on c.order_item_id = oi.id
),
totals as (
  select
    coalesce(sum(line_total), 0) as sales,
    coalesce(sum(line_cost), 0) as cost,
    coalesce(sum(line_total) filter (where line_cost is not null), 0) as costed_sales,
    coalesce(sum(line_total) filter (where line_cost is null), 0) as uncosted_sales,
    count(*) filter (where line_cost is null) as uncosted_lines,
    count(*) as lines
  from lines
),
discounts as (select coalesce(sum(discount_total), 0) as discounts, count(*) as orders from paid),
by_product as (
  select coalesce(product_id::text, product_name) as k,
         max(product_name) as name, max(product_code) as product_code,
         sum(quantity) as units, sum(line_total) as sales,
         sum(line_cost) as cost,
         sum(line_total) filter (where line_cost is not null) as costed_sales,
         count(*) filter (where line_cost is null) as uncosted_lines
  from lines group by 1
),
by_month as (
  select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month,
         sum(line_total) as sales, sum(line_cost) as cost,
         sum(line_total) filter (where line_cost is not null) as costed_sales,
         count(*) filter (where line_cost is null) as uncosted_lines
  from lines group by 1
),
catalog as (
  select p.id, p.name, p.product_code, p.price, pc.vendor_cost,
         p.active and lower(coalesce(p.storefront_status, '')) = 'available' as selling
  from public.products p
  left join public.product_costs pc on pc.product_id = p.id
  where lower(coalesce(p.storefront_status, '')) <> 'archived'
)
select jsonb_build_object(
  'from', p_from, 'to', p_to,
  'totals', (select jsonb_build_object(
      'orders', d.orders, 'lines', t.lines,
      'sales', t.sales, 'discounts', d.discounts, 'net_sales', t.sales - d.discounts,
      'vendor_cost', t.cost,
      'costed_sales', t.costed_sales, 'uncosted_sales', t.uncosted_sales, 'uncosted_lines', t.uncosted_lines,
      'gross_profit', t.costed_sales - t.cost,
      'margin_pct', case when t.costed_sales > 0 then round((t.costed_sales - t.cost) / t.costed_sales * 100, 1) end,
      'markup_pct', case when t.cost > 0 then round((t.costed_sales - t.cost) / t.cost * 100, 1) end)
    from totals t, discounts d),
  'by_product', coalesce((select jsonb_agg(jsonb_build_object(
      'name', name, 'product_code', product_code, 'units', units, 'sales', sales,
      'vendor_cost', cost, 'profit', case when cost is not null then costed_sales - cost end,
      'margin_pct', case when costed_sales > 0 and cost is not null then round((costed_sales - cost) / costed_sales * 100, 1) end,
      'markup_pct', case when cost > 0 then round((costed_sales - cost) / cost * 100, 1) end,
      'uncosted_lines', uncosted_lines) order by sales desc) from by_product), '[]'::jsonb),
  'by_month', coalesce((select jsonb_agg(jsonb_build_object(
      'month', month, 'sales', sales, 'vendor_cost', cost,
      'profit', case when cost is not null then costed_sales - cost end,
      'margin_pct', case when costed_sales > 0 and cost is not null then round((costed_sales - cost) / costed_sales * 100, 1) end,
      'uncosted_lines', uncosted_lines) order by month desc) from by_month), '[]'::jsonb),
  'catalog', jsonb_build_object(
      'products', (select count(*) from catalog),
      'with_cost', (select count(*) from catalog where vendor_cost is not null),
      'selling_without_cost', (select count(*) from catalog where selling and vendor_cost is null),
      'avg_margin_pct', (select round(avg((price - vendor_cost) / nullif(price, 0) * 100), 1) from catalog where vendor_cost is not null and price > 0),
      'below_cost', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'product_code', product_code,
          'price', price, 'vendor_cost', vendor_cost) order by name)
        from catalog where vendor_cost is not null and price < vendor_cost), '[]'::jsonb)),
  'generated_at', now()
);
$$;
revoke all on function public.core_profit_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.core_profit_report(timestamptz, timestamptz) to service_role;

-- 5. CSV import learns vendor_cost (key "vendor_cost" in create fields / update patch).
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
  v_product_patch jsonb;
  v_before public.products%rowtype;
  v_after public.products%rowtype;
  v_old_cost numeric;
  v_new_cost numeric;
  v_before_audit jsonb;
  v_after_audit jsonb;
  v_now timestamptz := now();
  v_role text := coalesce(nullif(trim(p_actor_role), ''), 'admin');
  v_created int := 0;
  v_updated int := 0;
  v_taken_off int := 0;
  v_import_id uuid := gen_random_uuid();
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_plan->'creates', '[]'::jsonb)) loop
    v_patch := v_item->'fields';
    insert into public.products (
      name, price, product_code, sku, research_name, category_id, description, purity, quantity,
      lot_number, coa_url, image_url, product_type, shipping_from, active, storefront_status,
      featured, core_hidden, source, sync_source, created_at, updated_at
    ) values (
      v_patch->>'name', (v_patch->>'price')::numeric, v_patch->>'product_code', v_patch->>'sku',
      v_patch->>'research_name', nullif(v_patch->>'category_id', '')::uuid, v_patch->>'description',
      v_patch->>'purity', v_patch->>'quantity', v_patch->>'lot_number', v_patch->>'coa_url',
      v_patch->>'image_url', v_patch->>'product_type', v_patch->>'shipping_from',
      coalesce((v_patch->>'active')::boolean, false), coalesce(v_patch->>'storefront_status', 'Inactive'),
      coalesce((v_patch->>'featured')::boolean, false), coalesce((v_patch->>'core_hidden')::boolean, false),
      'core_manual', 'core_csv_import', v_now, v_now
    ) returning * into v_after;

    if v_patch ? 'vendor_cost' and v_patch->>'vendor_cost' is not null then
      insert into public.product_costs(product_id, vendor_cost, updated_at, updated_by)
      values (v_after.id, (v_patch->>'vendor_cost')::numeric, v_now, p_actor_user_id);
    end if;

    insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
    values (p_actor_user_id, p_actor_email, v_role, 'catalog.product.create', 'product', v_after.id::text,
      null, (to_jsonb(v_after) - 'metadata') || jsonb_build_object('vendor_cost', v_patch->'vendor_cost'),
      jsonb_build_object('source', 'core_csv_import', 'import_id', v_import_id, 'row', v_item->'row', 'product_name', v_after.name));
    v_created := v_created + 1;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_plan->'updates', '[]'::jsonb)) loop
    v_patch := v_item->'patch';
    v_product_patch := v_patch - 'vendor_cost';
    select * into v_before from public.products where id = (v_item->>'id')::uuid for update;
    if v_before.id is null then
      raise exception 'IMPORT_STALE: product % no longer exists', v_item->>'id';
    end if;
    if v_before.updated_at <> (v_item->>'expected_updated_at')::timestamptz then
      raise exception 'IMPORT_STALE: % was changed after the preview', v_before.name;
    end if;
    select vendor_cost into v_old_cost from public.product_costs where product_id = v_before.id;

    update public.products p set
      name              = case when v_product_patch ? 'name' then v_product_patch->>'name' else p.name end,
      price             = case when v_product_patch ? 'price' then (v_product_patch->>'price')::numeric else p.price end,
      product_code      = case when v_product_patch ? 'product_code' then v_product_patch->>'product_code' else p.product_code end,
      sku               = case when v_product_patch ? 'sku' then v_product_patch->>'sku' else p.sku end,
      research_name     = case when v_product_patch ? 'research_name' then v_product_patch->>'research_name' else p.research_name end,
      category_id       = case when v_product_patch ? 'category_id' then nullif(v_product_patch->>'category_id', '')::uuid else p.category_id end,
      description       = case when v_product_patch ? 'description' then v_product_patch->>'description' else p.description end,
      purity            = case when v_product_patch ? 'purity' then v_product_patch->>'purity' else p.purity end,
      quantity          = case when v_product_patch ? 'quantity' then v_product_patch->>'quantity' else p.quantity end,
      lot_number        = case when v_product_patch ? 'lot_number' then v_product_patch->>'lot_number' else p.lot_number end,
      coa_url           = case when v_product_patch ? 'coa_url' then v_product_patch->>'coa_url' else p.coa_url end,
      image_url         = case when v_product_patch ? 'image_url' then v_product_patch->>'image_url' else p.image_url end,
      product_type      = case when v_product_patch ? 'product_type' then v_product_patch->>'product_type' else p.product_type end,
      shipping_from     = case when v_product_patch ? 'shipping_from' then v_product_patch->>'shipping_from' else p.shipping_from end,
      active            = case when v_product_patch ? 'active' then (v_product_patch->>'active')::boolean else p.active end,
      storefront_status = case when v_product_patch ? 'storefront_status' then v_product_patch->>'storefront_status' else p.storefront_status end,
      featured          = case when v_product_patch ? 'featured' then (v_product_patch->>'featured')::boolean else p.featured end,
      core_hidden       = case when v_product_patch ? 'core_hidden' then (v_product_patch->>'core_hidden')::boolean else p.core_hidden end,
      sync_source       = 'core_csv_import',
      updated_at        = v_now
    where p.id = v_before.id
    returning * into v_after;

    v_before_audit := coalesce((select jsonb_object_agg(k, to_jsonb(v_before)->k) from jsonb_object_keys(v_product_patch) k), '{}'::jsonb);
    v_after_audit  := coalesce((select jsonb_object_agg(k, to_jsonb(v_after)->k) from jsonb_object_keys(v_product_patch) k), '{}'::jsonb);

    if v_patch ? 'vendor_cost' and v_patch->>'vendor_cost' is not null then
      v_new_cost := (v_patch->>'vendor_cost')::numeric;
      insert into public.product_costs(product_id, vendor_cost, updated_at, updated_by)
      values (v_before.id, v_new_cost, v_now, p_actor_user_id)
      on conflict (product_id) do update set vendor_cost = excluded.vendor_cost, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
      v_before_audit := v_before_audit || jsonb_build_object('vendor_cost', v_old_cost);
      v_after_audit  := v_after_audit || jsonb_build_object('vendor_cost', v_new_cost);
    end if;

    insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id, before_data, after_data, metadata)
    values (p_actor_user_id, p_actor_email, v_role, 'catalog.product.update', 'product', v_before.id::text,
      v_before_audit, v_after_audit,
      jsonb_build_object('source', 'core_csv_import', 'import_id', v_import_id, 'row', v_item->'row', 'product_name', v_before.name));
    v_updated := v_updated + 1;
  end loop;

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

-- Rollback:
--   drop trigger if exists order_items_capture_cost on public.order_items;
--   drop function if exists public.capture_order_item_cost();
--   drop function if exists public.core_profit_report(timestamptz, timestamptz);
--   drop table if exists public.order_item_costs; drop table if exists public.product_costs;
--   (re-apply 20261028043000_core_catalog_csv_import.sql for the previous import function)
