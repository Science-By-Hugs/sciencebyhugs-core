\set ON_ERROR_STOP on
-- Full guarded-delete integration in an isolated PostgreSQL 16 test database.
-- Every row, role and function in this test transaction is rolled back.
BEGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid primary key, email text, raw_app_meta_data jsonb
);
CREATE TABLE public.discount_codes (
  id uuid primary key, code text not null unique, kind text not null,
  permanent boolean not null default false, active boolean not null default true,
  used_at timestamptz, used_order_id uuid, used_by_profile_id uuid
);
CREATE TABLE public.orders (
  id uuid primary key, discount_code_id uuid REFERENCES public.discount_codes(id) ON DELETE SET NULL,
  discount_code text
);
CREATE TABLE public.invoices (
  id uuid primary key, discount_code_id uuid REFERENCES public.discount_codes(id) ON DELETE SET NULL,
  discount_code text
);
CREATE TABLE public.core_audit_events (
  id bigserial primary key,
  actor_user_id uuid not null, actor_email text, actor_role text not null,
  action text not null, entity_type text not null, entity_id text not null,
  before_data jsonb, after_data jsonb, metadata jsonb,
  constraint audit_guard check (coalesce(before_data->>'code','') <> 'AUDITFAIL')
);
-- function is deployed with exactly the same migration used in production.
\i supabase/migrations/20261108014000_core_safe_unused_discount_delete.sql
\i supabase/migrations/20261108022500_core_discount_delete_auth_role_access.sql

GRANT USAGE ON SCHEMA auth TO service_role;
-- Deliberately no grant on auth.users: service_role cannot read it on Supabase.
-- The restricted SECURITY DEFINER function verifies actor roles as postgres.
GRANT SELECT,UPDATE,DELETE ON public.discount_codes TO service_role;
GRANT SELECT ON public.orders,public.invoices TO service_role;
GRANT INSERT,SELECT ON public.core_audit_events TO service_role;
GRANT USAGE ON SEQUENCE public.core_audit_events_id_seq TO service_role;

INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES
('00000000-0000-0000-0000-000000000001','owner@example.test','{"role":"owner"}'),
('00000000-0000-0000-0000-000000000002','viewer@example.test','{"role":"viewer"}'),
('00000000-0000-0000-0000-000000000003','admin@example.test','{"role":"admin"}');
INSERT INTO public.discount_codes(id,code,kind,permanent,active,used_at,used_by_profile_id,used_order_id)
VALUES
('00000000-0000-0000-1000-000000000001','UNUSED001','custom',false,false,null,null,null),
('00000000-0000-0000-1000-000000000002','ACTIVE001','custom',false,true,null,null,null),
('00000000-0000-0000-1000-000000000003','BUILTIN','group_buy',true,false,null,null,null),
('00000000-0000-0000-1000-000000000004','USEDAT','custom',false,false,now(),null,null),
('00000000-0000-0000-1000-000000000005','USEDBY','custom',false,false,null,'00000000-0000-0000-2000-000000000001',null),
('00000000-0000-0000-1000-000000000006','USEDORDER','custom',false,false,null,null,'00000000-0000-0000-3000-000000000001'),
('00000000-0000-0000-1000-000000000007','ORDERID','custom',false,false,null,null,null),
('00000000-0000-0000-1000-000000000008','ORDERTEXT','custom',false,false,null,null,null),
('00000000-0000-0000-1000-000000000009','INVOICEID','custom',false,false,null,null,null),
('00000000-0000-0000-1000-000000000010','INVOICETEXT','custom',false,false,null,null,null),
('00000000-0000-0000-1000-000000000011','AUDITFAIL','custom',false,false,null,null,null),
('00000000-0000-0000-1000-000000000012','PROTECTEDKIND','new_customer',false,false,null,null,null),
('00000000-0000-0000-1000-000000000013','ADMINOK','referral_bonus',false,false,null,null,null);
INSERT INTO public.orders (id,discount_code_id,discount_code) VALUES
('00000000-0000-0000-4000-000000000001','00000000-0000-0000-1000-000000000007',null),
('00000000-0000-0000-4000-000000000002',null,'  ordertext  ');
INSERT INTO public.invoices (id,discount_code_id,discount_code) VALUES
('00000000-0000-0000-5000-000000000001','00000000-0000-0000-1000-000000000009',null),
('00000000-0000-0000-5000-000000000002',null,' invoicetext ');

DO $privileges$
BEGIN
  IF has_table_privilege('service_role','auth.users','SELECT') THEN
    RAISE EXCEPTION 'The test must simulate hosted service_role having no Auth user SELECT';
  END IF;
  IF NOT (select p.prosecdef from pg_proc p
          where p.oid='public.core_delete_unused_discount_code(uuid,text,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'Delete RPC must be a narrowly granted security definer to read Auth user roles';
  END IF;
  IF has_function_privilege('anon','public.core_delete_unused_discount_code(uuid,text,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.core_delete_unused_discount_code(uuid,text,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.core_delete_unused_discount_code(uuid,text,uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'Delete RPC grants must be restricted to service_role'; END IF;
END $privileges$;

SET LOCAL ROLE service_role;
DO $tests$
DECLARE
  actor uuid := '00000000-0000-0000-0000-000000000001';
  admin_actor uuid := '00000000-0000-0000-0000-000000000003';
  other_actor uuid := '00000000-0000-0000-0000-000000000002';
  result jsonb;
  d record;
BEGIN
  -- Type-to-confirm and live authorization are mandatory before any delete.
  result:=public.core_delete_unused_discount_code('00000000-0000-0000-1000-000000000001','wrong',actor);
  IF result->>'success' <> 'false' THEN RAISE EXCEPTION 'Confirmation must be exact'; END IF;
  result:=public.core_delete_unused_discount_code('00000000-0000-0000-1000-000000000001','UNUSED001',other_actor);
  IF result->>'success' <> 'false' THEN RAISE EXCEPTION 'Only owner/admin roles may delete'; END IF;
  -- Active, built-in, used and any historical order/invoice reference all block.
  FOR d IN SELECT * FROM (VALUES
    ('00000000-0000-0000-1000-000000000002'::uuid,'ACTIVE001'),
    ('00000000-0000-0000-1000-000000000003'::uuid,'BUILTIN'),
    ('00000000-0000-0000-1000-000000000004'::uuid,'USEDAT'),
    ('00000000-0000-0000-1000-000000000005'::uuid,'USEDBY'),
    ('00000000-0000-0000-1000-000000000006'::uuid,'USEDORDER'),
    ('00000000-0000-0000-1000-000000000007'::uuid,'ORDERID'),
    ('00000000-0000-0000-1000-000000000008'::uuid,'ORDERTEXT'),
    ('00000000-0000-0000-1000-000000000009'::uuid,'INVOICEID'),
    ('00000000-0000-0000-1000-000000000010'::uuid,'INVOICETEXT'),
    ('00000000-0000-0000-1000-000000000012'::uuid,'PROTECTEDKIND')
  ) AS guarded(id,code)
  LOOP
    result:=public.core_delete_unused_discount_code(d.id,d.code,actor);
    IF result->>'success' <> 'false' THEN
      RAISE EXCEPTION 'Protected code % was deleted',d.code;
    END IF;
  END LOOP;
  -- Audit failure raises and must atomically undo the deletion.
  BEGIN
    PERFORM public.core_delete_unused_discount_code(
      '00000000-0000-0000-1000-000000000011','AUDITFAIL',actor);
    RAISE EXCEPTION 'Expected audit check to reject deletion';
  EXCEPTION WHEN check_violation THEN
    NULL; -- the subtransaction was automatically rolled back
  END;
  IF NOT EXISTS (SELECT 1 FROM public.discount_codes WHERE code='AUDITFAIL') THEN
    RAISE EXCEPTION 'Audit failure lost the original code';
  END IF;
  -- Success: code gone, audit retained, orders/invoices untouched.
  result:=public.core_delete_unused_discount_code(
    '00000000-0000-0000-1000-000000000001','UNUSED001',actor);
  IF result->>'success' <> 'true' THEN RAISE EXCEPTION 'Expected successful deletion: %',result; END IF;
  IF EXISTS (SELECT 1 FROM public.discount_codes WHERE code='UNUSED001') THEN
    RAISE EXCEPTION 'Deleted code remains';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.core_audit_events
    WHERE action='admin.discount_code.delete' AND actor_role='owner'
      AND before_data->>'code'='UNUSED001' AND after_data->>'deleted'='true'
  ) THEN RAISE EXCEPTION 'Successful deletion missing audit snapshot'; END IF;

  result:=public.core_delete_unused_discount_code(
    '00000000-0000-0000-1000-000000000013','ADMINOK',admin_actor);
  IF result->>'success' <> 'true' THEN RAISE EXCEPTION 'Admin role must be allowed'; END IF;
  IF (SELECT count(*) FROM public.orders)<>2 OR (SELECT count(*) FROM public.invoices)<>2 THEN
    RAISE EXCEPTION 'Historical order or invoice records were changed';
  END IF;
  IF (SELECT count(*) FROM public.discount_codes) <> 11 THEN
    RAISE EXCEPTION 'Unexpected number of deleted codes';
  END IF;
END $tests$;

RESET ROLE;
ROLLBACK;
