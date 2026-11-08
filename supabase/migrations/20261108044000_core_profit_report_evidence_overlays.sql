-- Evidence-backed overlays affect Core reporting only; historical orders and cost snapshots remain unchanged.
CREATE OR REPLACE FUNCTION public.core_profit_report(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
with paid as (
  select o.id, coalesce(o.paid_at,pd.effective_paid_at) as paid_at,
         (o.paid_at is null and pd.effective_paid_at is not null) as reconciled_paid_date,
         coalesce(o.discount_total, 0) as discount_total
  from public.orders o
  left join public.core_finance_paid_date_evidence pd on pd.order_id=o.id
  where o.payment_status = 'paid'
    and (p_from is null or coalesce(o.paid_at,pd.effective_paid_at) >= p_from)
    and (p_to is null or coalesce(o.paid_at,pd.effective_paid_at) < p_to)
),
lines as (
  select oi.id, oi.order_id, oi.product_id, oi.product_name, oi.product_code, oi.quantity,
         oi.line_total, coalesce(c.unit_cost,ce.unit_cost) as unit_cost,
         coalesce(c.line_cost,ce.line_cost) as line_cost, p.paid_at,
         (c.line_cost is null and ce.order_item_id is not null) as reconciled_cost
  from public.order_items oi
  join paid p on p.id = oi.order_id
  left join public.order_item_costs c on c.order_item_id = oi.id
  left join public.core_finance_cost_evidence ce on ce.order_item_id = oi.id
),
totals as (
  select
    coalesce(sum(line_total), 0) as sales,
    coalesce(sum(line_cost), 0) as cost,
    coalesce(sum(line_total) filter (where line_cost is not null), 0) as costed_sales,
    coalesce(sum(line_total) filter (where line_cost is null), 0) as uncosted_sales,
    count(*) filter (where line_cost is null) as uncosted_lines,
    count(*) as lines,
    count(*) filter (where reconciled_cost) as reconciled_cost_lines
  from lines
),
discounts as (select coalesce(sum(discount_total), 0) as discounts,
  count(*) as orders,
  count(*) filter (where reconciled_paid_date) as reconciled_paid_dates from paid),
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
      'reconciled_cost_lines',t.reconciled_cost_lines,
      'reconciled_paid_dates',d.reconciled_paid_dates,
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
$function$

