\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_app_meta_data jsonb);
CREATE TABLE public.inventory_vendors(id uuid PRIMARY KEY,name text);
CREATE TABLE public.inventory_purchase_orders(id uuid PRIMARY KEY,vendor_id uuid);
CREATE TABLE public.core_finance_expenses(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date date NOT NULL,
  category text NOT NULL CONSTRAINT core_finance_expenses_category_check CHECK (category IN
    ('inventory_purchase','vendor_shipping','processing_fee','software','marketing',
     'packaging','supplies','operations','other')),
  vendor_id uuid,
  purchase_order_id uuid,
  payee text NOT NULL,
  amount numeric NOT NULL,
  payment_method text NOT NULL,
  reference_number text,notes text,status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  created_by uuid NOT NULL,updated_by uuid NOT NULL
);
CREATE TABLE public.core_audit_events(
  actor_user_id uuid,actor_email text,actor_role text,action text,entity_type text,
  entity_id text,before_data jsonb,after_data jsonb,metadata jsonb
);
\i supabase/migrations/20261108045000_core_fulfillment_shipping_expenses.sql
INSERT INTO auth.users VALUES
('00000000-0000-0000-0000-000000000001','owner@test.invalid','{"role":"owner"}'),
('00000000-0000-0000-0000-000000000002','viewer@test.invalid','{"role":"viewer"}');
DO $test$
DECLARE v jsonb; n int;
BEGIN
 IF has_function_privilege('anon','public.core_manage_finance_expense(text,jsonb,timestamptz,uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.core_manage_finance_expense(text,jsonb,timestamptz,uuid,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.core_manage_finance_expense(text,jsonb,timestamptz,uuid,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Expense RPC privilege boundary invalid'; END IF;
 v:=public.core_manage_finance_expense('create','{
  "expense_date":"2026-11-07",
  "category":"fulfillment_shipping",
  "vendor_id":null,
  "purchase_order_id":null,
  "payee":"Courier",
  "amount":"4.25",
  "payment_method":"cash",
  "reference_number":"delivery-123",
  "notes":"Documented outbound delivery",
  "status":"paid"
 }'::jsonb,NULL,'00000000-0000-0000-0000-000000000001',NULL);
 IF v->>'category'<>'fulfillment_shipping' OR (v->>'amount')::numeric<>4.25
 THEN RAISE EXCEPTION 'Outbound category was not recorded correctly'; END IF;
 SELECT count(*) INTO n FROM public.core_audit_events WHERE action='finance.expense.create';
 IF n<>1 THEN RAISE EXCEPTION 'Outbound expense missing audited create event'; END IF;
 BEGIN
  PERFORM public.core_manage_finance_expense('create','{
   "expense_date":"2026-11-07","category":"fulfillment_shipping",
   "payee":"Unapproved","amount":"5","payment_method":"cash","status":"paid"
  }'::jsonb,NULL,'00000000-0000-0000-0000-000000000002',NULL);
  RAISE EXCEPTION 'Unauthorized actor accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='Unauthorized actor accepted' THEN RAISE; END IF;
 END;
END $test$;
ROLLBACK;
