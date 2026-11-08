\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_app_meta_data jsonb);
CREATE TABLE public.orders(
  id uuid PRIMARY KEY,payment_status text NOT NULL,created_at timestamptz NOT NULL,
  paid_at timestamptz,discount_total numeric DEFAULT 0
);
CREATE TABLE public.order_items(
  id uuid PRIMARY KEY,order_id uuid REFERENCES public.orders(id),product_id uuid,
  product_name text,product_code text,quantity int NOT NULL,line_total numeric NOT NULL
);
CREATE TABLE public.order_item_costs(
  order_item_id uuid PRIMARY KEY,order_id uuid,unit_cost numeric,quantity int,
  line_cost numeric
);
CREATE TABLE public.products(
  id uuid PRIMARY KEY,name text,product_code text,price numeric,active boolean,storefront_status text
);
CREATE TABLE public.product_costs(product_id uuid PRIMARY KEY,vendor_cost numeric);
CREATE TABLE public.core_audit_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,actor_email text,actor_role text,
  action text,entity_type text,entity_id text,before_data jsonb,after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
\i supabase/migrations/20261108043000_core_financial_reconciliation.sql
\i supabase/migrations/20261108044000_core_profit_report_evidence_overlays.sql
INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES
('00000000-0000-0000-0000-000000000001','owner@example.test','{"role":"owner"}'),
('00000000-0000-0000-0000-000000000002','viewer@example.test','{"role":"viewer"}');
INSERT INTO public.orders(id,payment_status,created_at,paid_at) VALUES
('00000000-0000-0000-1000-000000000001','paid','2026-10-10T10:00:00Z',NULL);
INSERT INTO public.order_items(id,order_id,product_name,quantity,line_total) VALUES
('00000000-0000-0000-2000-000000000001','00000000-0000-0000-1000-000000000001','Test Product',2,40);
DO $t$
DECLARE r jsonb;
BEGIN
 IF has_function_privilege('anon','public.core_finance_record_evidence(text,uuid,numeric,timestamptz,text,text,timestamptz,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.core_finance_record_evidence(text,uuid,numeric,timestamptz,text,text,timestamptz,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.core_finance_record_evidence(text,uuid,numeric,timestamptz,text,text,timestamptz,uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Evidence RPC permissions unsafe';
 END IF;
 IF has_table_privilege('anon','public.core_finance_cost_evidence','SELECT')
 OR has_table_privilege('authenticated','public.core_finance_paid_date_evidence','SELECT')
 OR has_table_privilege('service_role','public.core_finance_cost_evidence','INSERT') THEN
  RAISE EXCEPTION 'Evidence table privileges unsafe';
 END IF;
 -- Never infer a date from order creation.
 r:=public.core_profit_report('2026-10-11T00:00:00Z','2026-10-12T00:00:00Z');
 IF (r->'totals'->>'lines')::int<>0 THEN RAISE EXCEPTION 'Missing date should not be invented'; END IF;
 -- Malformed reference and unprivileged actor rejected.
 BEGIN
  PERFORM public.core_finance_record_evidence('historical_cost',
    '00000000-0000-0000-2000-000000000001',10,NULL,'short','',NULL,
    '00000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'Short evidence reference accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='Short evidence reference accepted' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.core_finance_record_evidence('historical_cost',
    '00000000-0000-0000-2000-000000000001',10,NULL,'INVOICE-123','',NULL,
    '00000000-0000-0000-0000-000000000002');
  RAISE EXCEPTION 'Viewer accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='Viewer accepted' THEN RAISE; END IF;
 END;
 r:=public.core_finance_record_evidence('historical_cost',
    '00000000-0000-0000-2000-000000000001',10,NULL,'INVOICE-123','Vendor invoice',NULL,
    '00000000-0000-0000-0000-000000000001');
 IF (r->>'line_cost')::numeric<>20 THEN RAISE EXCEPTION 'Reconciled COGS incorrect'; END IF;
 IF EXISTS (SELECT 1 FROM public.order_item_costs) THEN RAISE EXCEPTION 'Native cost table was modified'; END IF;
 r:=public.core_profit_report(NULL,NULL);
 IF (r->'totals'->>'gross_profit')::numeric<>20
    OR (r->'totals'->>'reconciled_cost_lines')::int<>1
    OR (r->'totals'->>'uncosted_lines')::int<>0 THEN
  RAISE EXCEPTION 'Evidence cost not in profit report %',r->'totals';
 END IF;
 r:=public.core_finance_record_evidence('payment_date',
    '00000000-0000-0000-1000-000000000001',NULL,'2026-10-11T12:00:00Z',
    'CAPTURE-123','Verified capture',NULL,
    '00000000-0000-0000-0000-000000000001');
 IF (r->>'effective_paid_at') IS NULL THEN RAISE EXCEPTION 'Missing evidence date'; END IF;
 IF (SELECT paid_at FROM public.orders WHERE id='00000000-0000-0000-1000-000000000001') IS NOT NULL
 THEN RAISE EXCEPTION 'Original order date overwritten'; END IF;
 r:=public.core_profit_report('2026-10-11T00:00:00Z','2026-10-12T00:00:00Z');
 IF (r->'totals'->>'lines')::int<>1
    OR (r->'totals'->>'reconciled_paid_dates')::int<>1 THEN
   RAISE EXCEPTION 'Evidence-backed month report incorrect';
 END IF;
 IF (SELECT count(*) FROM public.core_audit_events WHERE action LIKE 'finance.reconcile.%')<>2
 THEN RAISE EXCEPTION 'Evidence audit incomplete'; END IF;
END $t$;
ROLLBACK;
