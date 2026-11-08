\set ON_ERROR_STOP on
BEGIN;
-- The scenario is deliberately synthetic and rolled back in GitHub CI.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.orders(
 id uuid PRIMARY KEY,payment_status text NOT NULL,status text,
 paid_at timestamptz,subtotal numeric,discount_total numeric,
 shipping_total numeric,shipping_discount_total numeric,
 processing_fee_total numeric,tax_total numeric,total numeric
);
CREATE TABLE public.core_finance_paid_date_evidence(
 order_id uuid PRIMARY KEY,effective_paid_at timestamptz
);
CREATE TABLE public.order_items(
 id uuid PRIMARY KEY,order_id uuid,product_name text,quantity int,line_total numeric
);
CREATE TABLE public.order_item_costs(order_item_id uuid PRIMARY KEY,line_cost numeric);
CREATE TABLE public.core_finance_cost_evidence(order_item_id uuid PRIMARY KEY,line_cost numeric);
CREATE TABLE public.core_finance_expenses(
 id uuid PRIMARY KEY,expense_date date,category text,status text,amount numeric
);
CREATE TABLE public.inventory_purchase_orders(
 id uuid PRIMARY KEY,ordered_at timestamptz,status text,
 shipping_actual numeric,fees_actual numeric
);
CREATE TABLE public.inventory_purchase_lines(
 id uuid PRIMARY KEY,purchase_order_id uuid,packs_ordered int,pack_price_snapshot numeric
);
\i supabase/migrations/20261108050000_core_monthly_profit_loss.sql
INSERT INTO public.orders VALUES
('00000000-0000-0000-1000-000000000001','paid','delivered','2026-10-01T06:30:00Z',100,10,12,0,3,8,113),
('00000000-0000-0000-1000-000000000002','paid','delivered',NULL,50,0,5,0,2,4,61),
('00000000-0000-0000-1000-000000000003','paid','delivered',NULL,10,0,0,0,0,2,12);
INSERT INTO public.core_finance_paid_date_evidence VALUES
('00000000-0000-0000-1000-000000000002','2026-10-10T17:00:00Z');
INSERT INTO public.order_items VALUES
('00000000-0000-0000-2000-000000000001','00000000-0000-0000-1000-000000000001','Item A',1,100),
('00000000-0000-0000-2000-000000000002','00000000-0000-0000-1000-000000000002','Item B',1,50),
('00000000-0000-0000-2000-000000000003','00000000-0000-0000-1000-000000000003','Item C',1,10);
INSERT INTO public.order_item_costs VALUES
('00000000-0000-0000-2000-000000000001',40);
INSERT INTO public.core_finance_expenses VALUES
('00000000-0000-0000-3000-000000000001','2026-10-10','processing_fee','paid',5),
('00000000-0000-0000-3000-000000000002','2026-10-10','fulfillment_shipping','paid',7),
('00000000-0000-0000-3000-000000000003','2026-10-10','marketing','paid',8),
('00000000-0000-0000-3000-000000000004','2026-10-10','inventory_purchase','paid',100),
('00000000-0000-0000-3000-000000000005','2026-10-10','vendor_shipping','paid',11),
('00000000-0000-0000-3000-000000000006','2026-10-10','software','planned',20),
('00000000-0000-0000-3000-000000000007','2026-10-10','processing_fee','voided',9);
INSERT INTO public.inventory_purchase_orders VALUES
('00000000-0000-0000-4000-000000000001','2026-10-11T12:00:00Z','received',15,4);
INSERT INTO public.inventory_purchase_lines VALUES
('00000000-0000-0000-5000-000000000001','00000000-0000-0000-4000-000000000001',2,100);

DO $test$
DECLARE
 r jsonb; sep jsonb; oct jsonb;
BEGIN
 IF has_function_privilege('anon','public.core_monthly_profit_loss(integer)','EXECUTE')
  OR has_function_privilege('authenticated','public.core_monthly_profit_loss(integer)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.core_monthly_profit_loss(integer)','EXECUTE') THEN
  RAISE EXCEPTION 'Financial report permissions are incorrect';
 END IF;
 r:=public.core_monthly_profit_loss(2026);
 IF jsonb_array_length(r->'months')<>12 THEN RAISE EXCEPTION 'Expected 12 months'; END IF;
 IF r->>'timezone'<>'America/Los_Angeles' THEN RAISE EXCEPTION 'Incorrect business timezone'; END IF;
 SELECT value INTO sep FROM jsonb_array_elements(r->'months') value WHERE value->>'month'='2026-09';
 SELECT value INTO oct FROM jsonb_array_elements(r->'months') value WHERE value->>'month'='2026-10';
 IF (sep->>'paid_orders')::int<>1 OR (sep->>'revenue_ex_tax')::numeric<>105 OR
    (sep->>'paid_order_total')::numeric<>113 OR (sep->>'tax_collected')::numeric<>8 OR
    (sep->>'recorded_cogs')::numeric<>40 OR (sep->>'recorded_operating_result')::numeric<>65 THEN
   RAISE EXCEPTION 'September tax exclusion, checkout revenue or PST boundary wrong: %',sep;
 END IF;
 IF (oct->>'paid_orders')::int<>1 OR (oct->>'revenue_ex_tax')::numeric<>57 OR
    (oct->>'processor_expenses')::numeric<>5 OR (oct->>'outbound_shipping_expenses')::numeric<>7 OR
    (oct->>'other_operating_expenses')::numeric<>8 OR
    (oct->>'buyer_processing_fees')::numeric<>2 OR
    (oct->>'excluded_inventory_cash')::numeric<>111 OR
    (oct->>'planned_expenses')::numeric<>20 OR
    (oct->>'po_commitments')::numeric<>219 OR (oct->>'missing_cost_lines')::int<>1 THEN
    RAISE EXCEPTION 'October P&L cost classes or PO commitments wrong: %',oct;
 END IF;
 IF oct->'recorded_operating_result'<>'null'::jsonb THEN
   RAISE EXCEPTION 'Profit must be withheld while COGS missing: %',oct;
 END IF;
 IF (r->'undated'->>'paid_orders')::int<>1 OR (r->'undated'->>'order_total')::numeric<>12 THEN
   RAISE EXCEPTION 'Undated order must not be allocated to a month: %',r->'undated';
 END IF;
END $test$;

-- Evidence overlays apply only to missing native COGS; no original rows are changed.
INSERT INTO public.core_finance_cost_evidence VALUES
('00000000-0000-0000-2000-000000000001',1000),
('00000000-0000-0000-2000-000000000002',25);
DO $test$
DECLARE r jsonb; sep jsonb; oct jsonb;
BEGIN
 r:=public.core_monthly_profit_loss(2026);
 SELECT value INTO sep FROM jsonb_array_elements(r->'months') value WHERE value->>'month'='2026-09';
 SELECT value INTO oct FROM jsonb_array_elements(r->'months') value WHERE value->>'month'='2026-10';
 IF (sep->>'recorded_cogs')::numeric<>40 OR (sep->>'original_cost_lines')::int<>1
  THEN RAISE EXCEPTION 'Original cost did not take precedence'; END IF;
 IF (oct->>'evidenced_cost_lines')::int<>1 OR (oct->>'missing_cost_lines')::int<>0 OR
   (oct->>'recorded_cogs')::numeric<>25 OR
   (oct->>'recorded_operating_result')::numeric<>12 THEN
   RAISE EXCEPTION 'Evidence-backed P&L unexpectedly incorrect: %',oct;
 END IF;
END $test$;
ROLLBACK;
