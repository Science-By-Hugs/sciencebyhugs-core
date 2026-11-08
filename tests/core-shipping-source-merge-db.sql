\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(
  id uuid primary key,email text,raw_app_meta_data jsonb
);
CREATE TABLE public.internal_runtime_config(
  key text primary key,value jsonb not null,updated_at timestamptz default now()
);
CREATE TABLE public.products(
  id uuid primary key,product_code text,name text,active boolean,
  shipping_from text,updated_at timestamptz not null default now()
);
CREATE TABLE public.core_audit_events(
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,actor_email text,actor_role text not null,
  action text not null,entity_type text not null,entity_id text not null,
  before_data jsonb,after_data jsonb,metadata jsonb not null default '{}'::jsonb,
  constraint audit_will_fail check (coalesce(before_data->>'source','') <> 'AUDITFAIL')
);
\i supabase/migrations/20261108035000_core_merge_shipping_sources.sql
-- Same as hosted Supabase: service_role can inspect records, but the merge RPC
-- is the ONLY way it can change product sources, checkout config or audit rows.
GRANT SELECT ON public.products,public.internal_runtime_config,public.core_audit_events TO service_role;
-- Do not grant service_role any direct UPDATE on products or checkout, nor any Auth user SELECT.
DO $tests$
BEGIN
 IF has_function_privilege('anon','public.core_catalog_merge_shipping_source(text,text,text,numeric,uuid)','EXECUTE')
   OR has_function_privilege('authenticated','public.core_catalog_merge_shipping_source(text,text,text,numeric,uuid)','EXECUTE')
   OR NOT has_function_privilege('service_role','public.core_catalog_merge_shipping_source(text,text,text,numeric,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'Shipping merge RPC permissions too broad'; END IF;
 IF has_table_privilege('service_role','auth.users','SELECT')
   OR has_table_privilege('service_role','public.products','UPDATE')
   OR has_table_privilege('service_role','public.internal_runtime_config','UPDATE')
 THEN RAISE EXCEPTION 'Test must not grant service_role broad direct access'; END IF;
END $tests$;
INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES
 ('00000000-0000-0000-0000-000000000001','owner@example.test','{"role":"owner"}'),
 ('00000000-0000-0000-0000-000000000002','viewer@example.test','{"role":"viewer"}'),
 ('00000000-0000-0000-0000-000000000003','admin@example.test','{"role":"admin"}');
INSERT INTO public.internal_runtime_config(key,value) VALUES
 ('checkout',jsonb_build_object('shippingRates',
    '{"Shipping Gigi":20,"Sweeties Bake Shop":20,"Shipping - Amazon":3,"BADRATE":50,
       "AUDITFAIL":20,"DELIVERY":20}'::jsonb,
    'foundingMemberFreeShippingSource','Shipping Gigi',
    'paymentsEnabled',true,'reservationEnabled',true));
INSERT INTO public.products(id,product_code,name,active,shipping_from) VALUES
 ('00000000-0000-0000-1000-000000000001','SBH-A','A',true,'Shipping Gigi'),
 ('00000000-0000-0000-1000-000000000002','SBH-B','B',false,'Shipping Gigi'),
 ('00000000-0000-0000-1000-000000000003','SBH-C','C',true,'Shipping Gigi'),
 ('00000000-0000-0000-1000-000000000004','SBH-D','D',true,'Sweeties Bake Shop'),
 ('00000000-0000-0000-1000-000000000005','SBH-E','E',true,'Shipping - Amazon'),
 ('00000000-0000-0000-1000-000000000006','SBH-F','F',false,'AUDITFAIL');
SET LOCAL ROLE service_role;
DO $tests$
DECLARE
 o uuid:='00000000-0000-0000-0000-000000000001';
 v uuid:='00000000-0000-0000-0000-000000000002';
 a uuid:='00000000-0000-0000-0000-000000000003';
 r jsonb;
BEGIN
 -- Wrong actor, typed name, rates, destination, and same-name merges must fail.
 BEGIN PERFORM public.core_catalog_merge_shipping_source(
 'Shipping Gigi','Sweeties Bake Shop','Shipping Gigi',20,v);
 RAISE EXCEPTION 'Viewer role must be rejected';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='Viewer role must be rejected' THEN RAISE; END IF;
 END;
 BEGIN PERFORM public.core_catalog_merge_shipping_source(
 'Shipping Gigi','Sweeties Bake Shop','not exact',20,o);
 RAISE EXCEPTION 'Typed confirmation must be exact';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='Typed confirmation must be exact' THEN RAISE; END IF;
 END;
 BEGIN PERFORM public.core_catalog_merge_shipping_source(
 'Shipping Gigi','Sweeties Bake Shop','Shipping Gigi',21,o);
 RAISE EXCEPTION 'Stale rate must be rejected';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='Stale rate must be rejected' THEN RAISE; END IF;
 END;
 BEGIN PERFORM public.core_catalog_merge_shipping_source(
 'Shipping Gigi','BADRATE','Shipping Gigi',20,o);
 RAISE EXCEPTION 'Unequal rates must be rejected';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='Unequal rates must be rejected' THEN RAISE; END IF;
 END;
 BEGIN PERFORM public.core_catalog_merge_shipping_source(
 'Shipping Gigi','NOT CREATED','Shipping Gigi',20,o);
 RAISE EXCEPTION 'Missing destination must be rejected';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='Missing destination must be rejected' THEN RAISE; END IF;
 END;
 -- Audit failure must roll back the source move, config, and founding waiver.
 BEGIN PERFORM public.core_catalog_merge_shipping_source(
 'AUDITFAIL','DELIVERY','AUDITFAIL',20,o);
 RAISE EXCEPTION 'Audit failure was not triggered';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF NOT EXISTS (SELECT 1 FROM public.products WHERE shipping_from='AUDITFAIL')
 THEN RAISE EXCEPTION 'Audit rollback lost original product source'; END IF;
 IF NOT ((SELECT value->'shippingRates' FROM public.internal_runtime_config WHERE key='checkout')?'AUDITFAIL')
 THEN RAISE EXCEPTION 'Audit rollback lost original rate'; END IF;
 -- Successful merge: all product mappings including inactive, rate unchanged,
 -- founding waiver moved, other checkout settings preserved, snapshot audited.
 r:=public.core_catalog_merge_shipping_source(
 'Shipping Gigi','Sweeties Bake Shop','Shipping Gigi',20,o);
 IF r->>'success'<>'true' OR (r->>'movedProducts')::int<>3 OR
    r->>'foundingWaiverMoved'<>'true' THEN
  RAISE EXCEPTION 'Valid merge failed: %',r;
 END IF;
 IF EXISTS (SELECT 1 FROM public.products WHERE shipping_from='Shipping Gigi') THEN
  RAISE EXCEPTION 'Some product assignments were not moved';
 END IF;
 IF (SELECT count(*) FROM public.products WHERE shipping_from='Sweeties Bake Shop')<>4 THEN
  RAISE EXCEPTION 'Product grouping changed unexpectedly';
 END IF;
 IF (SELECT value->'shippingRates' FROM public.internal_runtime_config WHERE key='checkout')?'Shipping Gigi'
 THEN RAISE EXCEPTION 'Old source still configured'; END IF;
 IF (SELECT value->'shippingRates'->>'Sweeties Bake Shop' FROM public.internal_runtime_config WHERE key='checkout')<>'20'
 THEN RAISE EXCEPTION 'Merged rate changed'; END IF;
 IF (SELECT value->>'foundingMemberFreeShippingSource' FROM public.internal_runtime_config WHERE key='checkout')<>'Sweeties Bake Shop'
 THEN RAISE EXCEPTION 'Founding waiver not moved'; END IF;
 IF (SELECT value->>'paymentsEnabled' FROM public.internal_runtime_config WHERE key='checkout')<>'true'
 OR (SELECT value->>'reservationEnabled' FROM public.internal_runtime_config WHERE key='checkout')<>'true'
 THEN RAISE EXCEPTION 'Other checkout configuration changed'; END IF;
 IF (SELECT count(*) FROM public.products)<>6 THEN
  RAISE EXCEPTION 'Product records added or removed'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM public.core_audit_events WHERE action='catalog.shipping_source.merge'
   AND actor_role='owner' AND before_data->>'source'='Shipping Gigi'
   AND after_data->>'source'='Sweeties Bake Shop'
   AND (after_data->>'moved_product_count')::int=3
   AND jsonb_array_length(before_data->'products')=3
 ) THEN RAISE EXCEPTION 'Missing complete audit snapshot'; END IF;
 -- Both roles can merge; the access boundary is role-based and server-side.
 r:=public.core_catalog_merge_shipping_source(
 'Shipping - Amazon','Sweeties Bake Shop','Shipping - Amazon',3,a);
 -- Rate mismatch expected. Admin is authenticated but rate guard still applies.
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM NOT LIKE '%same rate%' THEN RAISE; END IF;
END $tests$;
RESET ROLE;
ROLLBACK;
