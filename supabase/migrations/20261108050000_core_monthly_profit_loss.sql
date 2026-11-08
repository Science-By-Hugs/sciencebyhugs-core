-- Core Monthly P&L: operational report, not accrual accounting or reconciled net income.
-- READ-ONLY: paid orders, original/evidence-backed sale COGS and manually marked paid expenses.
-- Inventory POs, inventory_purchase and inbound vendor_shipping are never deducted
-- as period expenses; buyer-paid checkout fees are revenue, not processor expense.
CREATE OR REPLACE FUNCTION public.core_monthly_profit_loss(p_year integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $fn$
WITH requested AS (
 SELECT COALESCE(p_year, EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Los_Angeles'))::int) AS yr
),
paid AS (
 SELECT o.id, o.subtotal, o.discount_total, o.shipping_total,
   o.shipping_discount_total, o.processing_fee_total, o.tax_total, o.total,
   coalesce(o.paid_at,pd.effective_paid_at) AS effective_paid_at,
   CASE WHEN coalesce(o.paid_at,pd.effective_paid_at) IS NULL THEN NULL
   ELSE to_char(coalesce(o.paid_at,pd.effective_paid_at) AT TIME ZONE 'America/Los_Angeles','YYYY-MM') END AS month
 FROM public.orders o
 LEFT JOIN public.core_finance_paid_date_evidence pd ON pd.order_id=o.id
 WHERE o.payment_status='paid' AND coalesce(o.status,'')<>'checkout_pending'
),
cost_lines AS (
 SELECT oi.order_id, oi.line_total,
   CASE WHEN c.line_cost IS NOT NULL THEN c.line_cost ELSE ce.line_cost END AS actual_cost,
   (c.line_cost IS NOT NULL) AS original_cost,
   (c.line_cost IS NULL AND ce.line_cost IS NOT NULL) AS evidenced_cost
 FROM public.order_items oi
 JOIN paid p ON p.id=oi.order_id
 LEFT JOIN public.order_item_costs c ON c.order_item_id=oi.id
 LEFT JOIN public.core_finance_cost_evidence ce ON ce.order_item_id=oi.id
),
cost_by_order AS (
 SELECT order_id, count(*)::int AS item_lines,
   count(*) FILTER (WHERE original_cost)::int AS original_lines,
   count(*) FILTER (WHERE evidenced_cost)::int AS evidenced_lines,
   count(*) FILTER (WHERE actual_cost IS NULL)::int AS missing_lines,
   coalesce(sum(line_total) FILTER (WHERE actual_cost IS NULL),0) AS uncosted_sales,
   coalesce(sum(actual_cost),0) AS recorded_cogs,
   coalesce(sum(line_total),0) AS item_sales
 FROM cost_lines GROUP BY order_id
),
order_month AS (
 SELECT p.month,
   count(*)::int AS paid_orders,
   coalesce(sum(p.total),0)::numeric(16,2) AS paid_order_total,
   coalesce(sum(p.subtotal),0)::numeric(16,2) AS product_gross,
   coalesce(sum(p.discount_total),0)::numeric(16,2) AS product_discounts,
   coalesce(sum(p.shipping_total - p.shipping_discount_total),0)::numeric(16,2) AS customer_shipping,
   coalesce(sum(p.processing_fee_total),0)::numeric(16,2) AS buyer_processing_fees,
   coalesce(sum(p.tax_total),0)::numeric(16,2) AS tax_collected,
   coalesce(sum(c.recorded_cogs),0)::numeric(16,2) AS recorded_cogs,
   coalesce(sum(c.item_lines),0)::int AS item_lines,
   coalesce(sum(c.original_lines),0)::int AS original_cost_lines,
   coalesce(sum(c.evidenced_lines),0)::int AS evidenced_cost_lines,
   coalesce(sum(c.missing_lines),0)::int AS missing_cost_lines,
   coalesce(sum(c.uncosted_sales),0)::numeric(16,2) AS uncosted_sales,
   count(*) FILTER (WHERE coalesce(c.item_lines,0)=0 AND coalesce(p.subtotal,0)<>0)::int AS orders_without_items,
   count(*) FILTER (WHERE abs(coalesce(c.item_sales,0)-coalesce(p.subtotal,0))>0.01)::int AS mismatched_product_subtotals,
   count(*) FILTER (WHERE abs(coalesce(p.total,0) - (
      coalesce(p.subtotal,0)-coalesce(p.discount_total,0)+
      coalesce(p.shipping_total,0)-coalesce(p.shipping_discount_total,0)+
      coalesce(p.processing_fee_total,0)+coalesce(p.tax_total,0)))>0.01)::int AS mismatched_order_totals
 FROM paid p
 LEFT JOIN cost_by_order c ON c.order_id=p.id
 WHERE p.month IS NOT NULL GROUP BY p.month
),
expense_month AS (
 SELECT to_char(e.expense_date,'YYYY-MM') AS month,
   coalesce(sum(e.amount) FILTER (WHERE e.status='paid' AND e.category='processing_fee'),0)::numeric(16,2) AS processor_expenses,
   coalesce(sum(e.amount) FILTER (WHERE e.status='paid' AND e.category='fulfillment_shipping'),0)::numeric(16,2) AS outbound_shipping_expenses,
   coalesce(sum(e.amount) FILTER (WHERE e.status='paid' AND e.category IN ('software','marketing','packaging','supplies','operations','other')),0)::numeric(16,2) AS other_operating_expenses,
   coalesce(sum(e.amount) FILTER (WHERE e.status='paid' AND e.category IN ('inventory_purchase','vendor_shipping')),0)::numeric(16,2) AS excluded_inventory_cash,
   coalesce(sum(e.amount) FILTER (WHERE e.status='planned'),0)::numeric(16,2) AS planned_expenses,
   count(*) FILTER (WHERE e.status='paid')::int AS paid_expense_records
 FROM public.core_finance_expenses e
 WHERE e.status IN ('paid','planned')
 GROUP BY to_char(e.expense_date,'YYYY-MM')
),
po_lines AS (
 SELECT l.purchase_order_id,coalesce(sum(l.packs_ordered*l.pack_price_snapshot),0) AS merchandise
 FROM public.inventory_purchase_lines l GROUP BY l.purchase_order_id
),
po_month AS (
 SELECT to_char(po.ordered_at AT TIME ZONE 'America/Los_Angeles','YYYY-MM') AS month,
   count(*)::int AS purchase_orders,
   coalesce(sum(coalesce(pl.merchandise,0)+coalesce(po.shipping_actual,0)+coalesce(po.fees_actual,0)),0)::numeric(16,2) AS po_commitments
 FROM public.inventory_purchase_orders po
 LEFT JOIN po_lines pl ON pl.purchase_order_id=po.id
 WHERE coalesce(po.status,'')<>'cancelled' AND po.ordered_at IS NOT NULL
 GROUP BY to_char(po.ordered_at AT TIME ZONE 'America/Los_Angeles','YYYY-MM')
),
calendar AS (
 SELECT to_char(make_date((SELECT yr FROM requested), months.m,1),'YYYY-MM') AS month
 FROM generate_series(1,12) AS months(m)
),
combined AS (
 SELECT calendar.month,
   coalesce(o.paid_orders,0) AS paid_orders,
   coalesce(o.paid_order_total,0) AS paid_order_total,
   coalesce(o.product_gross,0) AS product_gross,
   coalesce(o.product_discounts,0) AS product_discounts,
   coalesce(o.customer_shipping,0) AS customer_shipping,
   coalesce(o.buyer_processing_fees,0) AS buyer_processing_fees,
   coalesce(o.tax_collected,0) AS tax_collected,
   (coalesce(o.product_gross,0)-coalesce(o.product_discounts,0)+
     coalesce(o.customer_shipping,0)+coalesce(o.buyer_processing_fees,0))::numeric(16,2) AS revenue_ex_tax,
   coalesce(o.recorded_cogs,0) AS recorded_cogs,
   coalesce(o.item_lines,0) AS item_lines,
   coalesce(o.original_cost_lines,0) AS original_cost_lines,
   coalesce(o.evidenced_cost_lines,0) AS evidenced_cost_lines,
   coalesce(o.missing_cost_lines,0) AS missing_cost_lines,
   coalesce(o.uncosted_sales,0) AS uncosted_sales,
   coalesce(o.orders_without_items,0) AS orders_without_items,
   coalesce(o.mismatched_product_subtotals,0) AS mismatched_product_subtotals,
   coalesce(o.mismatched_order_totals,0) AS mismatched_order_totals,
   coalesce(e.processor_expenses,0) AS processor_expenses,
   coalesce(e.outbound_shipping_expenses,0) AS outbound_shipping_expenses,
   coalesce(e.other_operating_expenses,0) AS other_operating_expenses,
   coalesce(e.excluded_inventory_cash,0) AS excluded_inventory_cash,
   coalesce(e.planned_expenses,0) AS planned_expenses,
   coalesce(e.paid_expense_records,0) AS paid_expense_records,
   coalesce(po.purchase_orders,0) AS purchase_orders,
   coalesce(po.po_commitments,0) AS po_commitments
 FROM calendar
 LEFT JOIN order_month o ON o.month=calendar.month
 LEFT JOIN expense_month e ON e.month=calendar.month
 LEFT JOIN po_month po ON po.month=calendar.month
),
display_month AS (
 SELECT c.*,
   (c.processor_expenses+c.outbound_shipping_expenses+c.other_operating_expenses)::numeric(16,2)
       AS recorded_operating_expenses,
   CASE WHEN c.missing_cost_lines>0 OR c.orders_without_items>0
         OR c.mismatched_product_subtotals>0 OR c.mismatched_order_totals>0
       THEN NULL::numeric
       WHEN c.paid_orders=0 THEN NULL::numeric
       ELSE (c.revenue_ex_tax-c.recorded_cogs-c.processor_expenses-
        c.outbound_shipping_expenses-c.other_operating_expenses)::numeric(16,2)
   END AS recorded_operating_result,
   CASE WHEN c.paid_orders=0 THEN 'no_sales'
     WHEN c.missing_cost_lines>0 OR c.orders_without_items>0
       OR c.mismatched_product_subtotals>0 OR c.mismatched_order_totals>0 THEN 'incomplete'
     ELSE 'costs_recorded' END AS coverage_status
 FROM combined c
),
years AS (
 SELECT extract(year from effective_paid_at AT TIME ZONE 'America/Los_Angeles')::int AS y
 FROM paid WHERE effective_paid_at IS NOT NULL
 UNION SELECT extract(year from expense_date)::int FROM public.core_finance_expenses WHERE status<>'voided'
 UNION SELECT extract(year from ordered_at AT TIME ZONE 'America/Los_Angeles')::int
  FROM public.inventory_purchase_orders WHERE ordered_at IS NOT NULL
 UNION SELECT extract(year from now() AT TIME ZONE 'America/Los_Angeles')::int
)
SELECT jsonb_build_object(
 'year',(SELECT yr FROM requested),
 'timezone','America/Los_Angeles',
 'years',coalesce((SELECT jsonb_agg(y ORDER BY y DESC) FROM years WHERE y BETWEEN 2020 AND 2100),'[]'::jsonb),
 'months',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.month DESC) FROM display_month d),'[]'::jsonb),
 'undated',jsonb_build_object(
    'paid_orders',(SELECT count(*) FROM paid WHERE effective_paid_at IS NULL),
    'order_total',(SELECT coalesce(sum(total),0) FROM paid WHERE effective_paid_at IS NULL)),
 'definitions',jsonb_build_object(
    'revenue','Orders marked paid, excluding sales tax. Includes customer shipping and checkout processing surcharges.',
    'cogs','Native sale-time cost first; audited historical evidence only where original missing.',
    'operating_expenses','Only manual expenses marked paid: processor costs, outbound delivery and other operating categories.',
    'excluded','Inventory merchandise purchases, inbound vendor shipping and POs are never added to period expenses.',
    'result','Only displayed when sold-product costs and order totals reconcile. Not bank cash, tax income, or certified net profit.'
 ),
 'generated_at',now()
);
$fn$;
REVOKE ALL ON FUNCTION public.core_monthly_profit_loss(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_monthly_profit_loss(integer) TO service_role;
