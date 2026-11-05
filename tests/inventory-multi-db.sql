\set ON_ERROR_STOP on
begin;
create role anon;
create role authenticated;
create role service_role;
create schema private;
create table public.products(id uuid primary key, name text not null);

\i supabase/migrations/20261105180000_core_inventory_foundation.sql

insert into public.products(id,name) values
 ('22222222-2222-4222-8222-222222222221','RETATRUTIDE 20MG'),
 ('22222222-2222-4222-8222-222222222222','GHK-CU 50MG');
insert into public.inventory_vendors(id,code,name) values
 ('11111111-1111-4111-8111-111111111111','EM','Emlin');
insert into public.inventory_vendor_offers(id,vendor_id,product_id,units_per_pack,price_per_pack)
values
 ('aaaa1111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222221',10,126),
 ('aaaa2222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',10,28);

-- Create an old-style PO before altering constraints.
select public.core_inventory_create_purchase(
 'aaaa1111-1111-4111-8111-111111111111',1,50,20,
 'a1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);
select public.core_inventory_receive_purchase(
 (select id from public.inventory_purchase_orders
  where request_id='a1111111-1111-4111-8111-111111111111'),
 10,0,'RT-20',null,
 'a2222222-2222-4222-8222-222222222222',
 '99999999-9999-4999-8999-999999999999'
);

\i supabase/migrations/20261105210000_core_inventory_multi_product_orders.sql

do $$
begin
 if (select count(*) from public.inventory_purchase_orders where multi_line=false and status='received')<>1 then
   raise exception 'Legacy purchase order status was changed'; end if;
 if (select count(*) from public.inventory_units where state='available')<>10 then
   raise exception 'Legacy received unit count was changed'; end if;
 if (select landed_unit_cost from public.inventory_lots limit 1)<>19.6000 then
   raise exception 'Legacy landed cost changed'; end if;
 if (select count(*) from public.inventory_receipts where purchase_line_id is not null)<>1 then
   raise exception 'Legacy receipt line linkage was not backfilled'; end if;
end $$;

-- One vendor order: two different kits, shipping $20 ONCE, fees $4 ONCE.
select public.core_inventory_create_multi_purchase(
 '11111111-1111-4111-8111-111111111111',
 '[{"offerId":"aaaa1111-1111-4111-8111-111111111111","packs":1},
   {"offerId":"aaaa2222-2222-4222-8222-222222222222","packs":1}]'::jsonb,
 20,4,'per_kit',
 'b1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);

do $$
begin
 if (select count(*) from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111')<>2 then
   raise exception 'Multi-product PO does not have two lines'; end if;
 if (select sum(l.shipping_allocated) from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111')<>20 then
   raise exception 'Shipping allocated more than once'; end if;
 if (select sum(l.fees_allocated) from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111')<>4 then
   raise exception 'Fees allocated more than once'; end if;
 if exists(select 1 from public.inventory_purchase_lines l
   join public.inventory_purchase_orders po on po.id=l.purchase_order_id
   where po.request_id='b1111111-1111-4111-8111-111111111111'
     and (l.shipping_allocated<>10 or l.fees_allocated<>2)) then
   raise exception 'Equal-per-kit allocation is wrong'; end if;
end $$;

-- Receive part of one line: 4 usable, 1 damaged. Remaining stays outstanding.
select public.core_inventory_receive_multi_line(
 (select l.id from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111'
    and l.product_id='22222222-2222-4222-8222-222222222221'),
 4,1,'BATCH-A',null,
 'c1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);
-- Exact same request is idempotent.
select public.core_inventory_receive_multi_line(
 (select l.id from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111'
    and l.product_id='22222222-2222-4222-8222-222222222221'),
 4,1,'BATCH-A',null,
 'c1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);
do $$
begin
 if (select count(*) from public.inventory_receipts where request_id=
   'c1111111-1111-4111-8111-111111111111')<>1 then
   raise exception 'Idempotent receipt created a duplicate'; end if;
 if (select status from public.inventory_purchase_orders where request_id=
   'b1111111-1111-4111-8111-111111111111')<>'partially_received' then
   raise exception 'PO should be partially received'; end if;
 if (select count(*) from public.inventory_lots where supplier_lot='BATCH-A' and cost_finalized=false)<>1 then
   raise exception 'Partial landed cost should not be final'; end if;
end $$;

-- Complete the first line in a second batch with a different supplier lot.
select public.core_inventory_receive_multi_line(
 (select l.id from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111'
    and l.product_id='22222222-2222-4222-8222-222222222221'),
 5,0,'BATCH-B',null,
 'c2222222-2222-4222-8222-222222222222',
 '99999999-9999-4999-8999-999999999999'
);
do $$
begin
 if exists(select 1 from public.inventory_lots
   where supplier_lot in ('BATCH-A','BATCH-B')
     and (not cost_finalized or landed_unit_cost<>15.3333)) then
   raise exception 'Two Reta batches should share finalized cost 138 / 9'; end if;
end $$;

-- Receive the other line in full.
select public.core_inventory_receive_multi_line(
 (select l.id from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='b1111111-1111-4111-8111-111111111111'
    and l.product_id='22222222-2222-4222-8222-222222222222'),
 10,0,'BATCH-C',null,
 'c3333333-3333-4333-8333-333333333333',
 '99999999-9999-4999-8999-999999999999'
);
do $$
begin
 if (select status from public.inventory_purchase_orders where request_id=
   'b1111111-1111-4111-8111-111111111111')<>'received' then
   raise exception 'Multi-product PO should be received'; end if;
 if (select landed_unit_cost from public.inventory_lots where supplier_lot='BATCH-C')<>4.0000 then
   raise exception 'GHK final unit cost should be (28+10+2)/10'; end if;
 if (select count(*) from public.inventory_units where state='available')<>29 then
   raise exception 'Unexpected usable inventory count'; end if;
 if (select count(*) from public.inventory_units where state='damaged')<>1 then
   raise exception 'Unexpected damaged inventory count'; end if;
 if (select count(distinct scan_token) from public.inventory_units)<>
   (select count(*) from public.inventory_units) then
   raise exception 'Duplicate unit QR tokens'; end if;
end $$;

-- Allocation option: proportional to supplier product prices.
select public.core_inventory_create_multi_purchase(
 '11111111-1111-4111-8111-111111111111',
 '[{"offerId":"aaaa1111-1111-4111-8111-111111111111","packs":1},
   {"offerId":"aaaa2222-2222-4222-8222-222222222222","packs":1}]'::jsonb,
 77,0,'by_cost',
 'd1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);
do $$
begin
 if (select shipping_allocated from public.inventory_purchase_lines l
   join public.inventory_purchase_orders po on po.id=l.purchase_order_id
   where po.request_id='d1111111-1111-4111-8111-111111111111'
     and l.product_id='22222222-2222-4222-8222-222222222221')<>63 then
   raise exception 'Cost-weighted shipping calculation failed'; end if;
end $$;

-- Manual allocation option and exact fee totals.
select public.core_inventory_create_multi_purchase(
 '11111111-1111-4111-8111-111111111111',
 '[{"offerId":"aaaa1111-1111-4111-8111-111111111111","packs":1,"shipping":4,"fees":2},
   {"offerId":"aaaa2222-2222-4222-8222-222222222222","packs":1,"shipping":6,"fees":3}]'::jsonb,
 10,5,'manual',
 'd2222222-2222-4222-8222-222222222222',
 '99999999-9999-4999-8999-999999999999'
);
do $$
begin
 if (select sum(shipping_allocated) from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='d2222222-2222-4222-8222-222222222222')<>10 then
   raise exception 'Manual shipping does not reconcile'; end if;
 if (select sum(fees_allocated) from public.inventory_purchase_lines l
  join public.inventory_purchase_orders po on po.id=l.purchase_order_id
  where po.request_id='d2222222-2222-4222-8222-222222222222')<>5 then
   raise exception 'Manual fees do not reconcile'; end if;
end $$;

do $$
begin
 if has_function_privilege('anon',
   'public.core_inventory_create_multi_purchase(uuid,jsonb,numeric,numeric,text,uuid,uuid)', 'EXECUTE') then
   raise exception 'Anonymous role can execute inventory purchasing function'; end if;
 if has_function_privilege('authenticated',
   'public.core_inventory_receive_multi_line(uuid,integer,integer,text,date,uuid,uuid)', 'EXECUTE') then
   raise exception 'Signed-in users should not execute service-only function'; end if;
 if not has_function_privilege('service_role',
   'public.core_inventory_create_multi_purchase(uuid,jsonb,numeric,numeric,text,uuid,uuid)', 'EXECUTE') then
   raise exception 'Service role cannot execute inventory purchasing function'; end if;
end $$;


-- Phase 4 stock count verification runs against the SAME temporary DB
-- and rolls back, never touching production.
\i supabase/migrations/20261105233000_core_inventory_lot_reconciliation.sql

do $audit$
begin
 if (select count(*) from public.inventory_stock_counts)<>0 then
   raise exception 'Migration should not invent counts for historical lots'; end if;
 if (select count(*) from public.inventory_units where state='available')<>29 then
   raise exception 'Existing stock counts were modified by migration'; end if;
 if (select count(*) from public.inventory_movements)<>30 then
   raise exception 'Existing movement history was modified by migration'; end if;
end $audit$;

-- Matching count: audit only, no stock mutation.
select public.core_inventory_count_lot(
 (select id from public.inventory_lots where supplier_lot='RT-20'),
 10,0,'Verified all ten vials',
 'e1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);
do $audit$
begin
 if (select status from public.inventory_stock_counts
   where request_id='e1111111-1111-4111-8111-111111111111')<>'matched' then
   raise exception 'Matching count was not recorded as matched'; end if;
 if (select count(*) from public.inventory_movements)<>30 then
   raise exception 'Matching count must not create stock movements'; end if;
end $audit$;

-- Shortage count: still records evidence, does not automatically mark units.
select public.core_inventory_count_lot(
 (select id from public.inventory_lots where supplier_lot='RT-20'),
 8,0,'Two exact units unavailable, pending investigation',
 'e2222222-2222-4222-8222-222222222222',
 '99999999-9999-4999-8999-999999999999'
);
-- Retry with the exact same request key must not create duplicate records.
select public.core_inventory_count_lot(
 (select id from public.inventory_lots where supplier_lot='RT-20'),
 8,0,'Two exact units unavailable, pending investigation',
 'e2222222-2222-4222-8222-222222222222',
 '99999999-9999-4999-8999-999999999999'
);
do $audit$
declare rejected boolean:=false;
begin
 if (select count(*) from public.inventory_stock_counts
   where request_id='e2222222-2222-4222-8222-222222222222')<>1 then
   raise exception 'Count retry duplicated record'; end if;
 if (select count(*) from public.inventory_units where state='available')<>29 then
   raise exception 'Saving a discrepancy must not change inventory'; end if;
 begin
   perform public.core_inventory_resolve_lot_count(
     (select id from public.inventory_stock_counts
       where request_id='e2222222-2222-4222-8222-222222222222'),
     (select array_agg(id) from public.inventory_units
       where lot_id=(select id from public.inventory_lots where supplier_lot='RT-20')
        and ordinal=10),
     '99999999-9999-4999-8999-999999999999'
   );
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'Insufficient exact missing units were allowed'; end if;
end $audit$;

-- Explicitly approve original tracked units 09 and 10 as missing.
select public.core_inventory_resolve_lot_count(
 (select id from public.inventory_stock_counts
  where request_id='e2222222-2222-4222-8222-222222222222'),
 (select array_agg(id order by ordinal)
  from public.inventory_units
  where lot_id=(select id from public.inventory_lots where supplier_lot='RT-20')
    and ordinal in (9,10)),
 '99999999-9999-4999-8999-999999999999'
);
do $audit$
begin
 if (select count(*) from public.inventory_units where state='available')<>27 then
   raise exception 'Shortage reconciliation did not subtract exactly two available units'; end if;
 if (select count(*) from public.inventory_units where state='missing')<>2 then
   raise exception 'Shortage did not mark exactly the selected units missing'; end if;
 if (select count(*) from public.inventory_movements)<>32 then
   raise exception 'Each adjusted unit requires exactly one immutable ledger event'; end if;
 if (select status from public.inventory_stock_counts
   where request_id='e2222222-2222-4222-8222-222222222222')<>'resolved' then
   raise exception 'Audit did not finalize'; end if;
 if (select landed_unit_cost from public.inventory_lots where supplier_lot='RT-20')<>19.6000 then
   raise exception 'Reconciliation modified original landed costs'; end if;
 if (select accepted_units from public.inventory_lots where supplier_lot='RT-20')<>10 then
   raise exception 'Reconciliation modified original receipt quantities'; end if;
end $audit$;

-- Retry should not create another ledger event.
select public.core_inventory_resolve_lot_count(
 (select id from public.inventory_stock_counts
  where request_id='e2222222-2222-4222-8222-222222222222'),
 (select array_agg(id order by ordinal)
  from public.inventory_units
  where lot_id=(select id from public.inventory_lots where supplier_lot='RT-20')
    and ordinal in (9,10)),
 '99999999-9999-4999-8999-999999999999'
);
do $audit$
begin
 if (select count(*) from public.inventory_movements)<>32 then
   raise exception 'Retry created duplicate movement'; end if;
end $audit$;

-- A surplus stays pending, cannot mint fictional unit IDs.
select public.core_inventory_count_lot(
 (select id from public.inventory_lots where supplier_lot='BATCH-C'),
 11,0,'Counted one unverified extra unit',
 'e3333333-3333-4333-8333-333333333333',
 '99999999-9999-4999-8999-999999999999'
);
do $audit$
declare rejected boolean:=false;
begin
 begin
   perform public.core_inventory_resolve_lot_count(
     (select id from public.inventory_stock_counts
       where request_id='e3333333-3333-4333-8333-333333333333'),
     '{}'::uuid[],'99999999-9999-4999-8999-999999999999');
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'Unverified surplus was allowed to create inventory'; end if;
 if (select count(*) from public.inventory_units)<>30 then
   raise exception 'Surplus audit changed tracked unit count'; end if;
end $audit$;

do $audit$
begin
 if has_function_privilege('anon',
  'public.core_inventory_count_lot(uuid,integer,integer,text,uuid,uuid)','EXECUTE') then
   raise exception 'Anonymous role may not submit inventory counts'; end if;
 if has_function_privilege('authenticated',
  'public.core_inventory_resolve_lot_count(uuid,uuid[],uuid)','EXECUTE') then
   raise exception 'Customer identity may not reconcile inventory'; end if;
 if not has_function_privilege('service_role',
  'public.core_inventory_resolve_lot_count(uuid,uuid[],uuid)','EXECUTE') then
   raise exception 'Service role cannot reconcile inventory'; end if;
end $audit$;


-- Phase 5B runs against synthetic future orders in the same rolled-back
-- ephemeral Postgres database. All production flags start disabled.
create table public.orders (
 id uuid primary key,
 status text not null,
 payment_status text not null,
 payment_method text,
 customer_id uuid,
 total numeric not null default 0,
 admin_notes text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.order_items(
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders(id),
 product_id uuid references public.products(id),
 quantity integer not null
);
create table public.payments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid references public.orders(id),
 status text not null,
 paid_at timestamptz,
 amount numeric not null,
 provider text,
 customer_id uuid,
 provider_capture_id text,
 provider_order_id text
);
create table public.internal_runtime_config(
 key text primary key,value jsonb not null
);

insert into public.inventory_product_settings(product_id,supply_mode)
values('22222222-2222-4222-8222-222222222221','physical'),
      ('22222222-2222-4222-8222-222222222222','vendor');
insert into public.orders(id,status,payment_status,payment_method,total,admin_notes,created_at)
values
 ('a0000000-0000-4000-8000-000000000001','submitted','pending','Apple Pay',10,'Nexus Pay Now checkout',now()),
 ('a0000000-0000-4000-8000-000000000002','submitted','pending','PayPal',20,'Nexus Pay Now checkout',now()),
 ('a0000000-0000-4000-8000-000000000003','submitted','pending','Zelle',15,'Nexus Pay Now checkout',now()),
 ('a0000000-0000-4000-8000-000000000004','submitted','pending','PayPal',20,'Nexus Pay Now checkout',now()-interval '1 day'),
 ('a0000000-0000-4000-8000-000000000005','submitted','pending','Apple Pay',20,'Nexus Pay Now checkout',now());
insert into public.order_items(id,order_id,product_id,quantity)
values
 ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222221',3),
 ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222221',2),
 ('b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000003','22222222-2222-4222-8222-222222222222',3),
 ('b0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000004','22222222-2222-4222-8222-222222222221',1),
 ('b0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000005','22222222-2222-4222-8222-222222222221',99);

\i supabase/migrations/20261106014500_core_nexus_inventory_reservations.sql

do $phase5$
begin
 if (select count(*) from public.inventory_units where state='available')<>27
  or (select count(*) from public.inventory_order_allocations)<>0
  or (select count(*) from public.inventory_movements)<>32 then
   raise exception 'Disabled migration modified historical inventory';
 end if;
 if (public.core_checkout_reserve_inventory(
  'a0000000-0000-4000-8000-000000000001')->>'enabled')::boolean then
   raise exception 'Disabled reservation function changed state'; end if;
 if (select count(*) from public.inventory_units where state='reserved')<>0 then
   raise exception 'Disabled reservation created a hold'; end if;
 if has_function_privilege('anon','public.core_checkout_reserve_inventory(uuid)','EXECUTE') OR
    has_function_privilege('authenticated','public.core_checkout_commit_inventory(uuid)','EXECUTE') OR
    has_table_privilege('authenticated','public.inventory_order_allocations','SELECT') THEN
   raise exception 'Browser roles can access inventory allocation internals'; end if;
end $phase5$;

-- SIMULATED activation in a transaction that is fully rolled back.
-- Production remains disabled; this is ephemeral CI-only test data.
update public.internal_runtime_config
set value=jsonb_build_object('reservation_enabled',true,
 'deduction_enabled',true,'activated_at',(now()-interval '1 minute')::text)
where key='inventory_checkout';

-- Historical order and supplier-sourced products never consume physical units.
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000004');
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000003');
do $phase5$
begin
 if (select count(*) from public.inventory_order_allocations)<>0 then
  raise exception 'Historical or vendor order allocated physical inventory'; end if;
end $phase5$;

select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000001');
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000001');
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000002');
do $phase5$
begin
 if (select count(*) from public.inventory_order_allocations where status='held')<>5 then
  raise exception 'Unit holds were duplicated, skipped or miscounted'; end if;
 if (select count(*) from public.inventory_units where state='reserved')<>5
  or (select count(*) from public.inventory_units where state='available')<>22 then
   raise exception 'Physical availability did not decrease by exact reserved units'; end if;
 if (select count(*) from public.inventory_movements)<>32 then
  raise exception 'Pending payment must not create a sale ledger movement'; end if;
end $phase5$;

-- Insufficient order is atomic. One failed reservation cannot leak holds.
do $phase5$
declare rejected boolean:=false;
begin
 begin
  perform public.core_checkout_reserve_inventory(
   'a0000000-0000-4000-8000-000000000005');
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'Oversell was permitted'; end if;
 if (select count(*) from public.inventory_order_allocations)<>5 then
  raise exception 'A failed cart left partial reservations'; end if;
end $phase5$;

-- Paid status without a matching provider capture must NOT deduct stock.
update public.orders set payment_status='paid'
 where id='a0000000-0000-4000-8000-000000000001';
do $phase5$
declare rejected boolean:=false;
begin
 begin
   perform public.core_checkout_commit_inventory('a0000000-0000-4000-8000-000000000001');
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'Unverified payment caused stock deduction'; end if;
end $phase5$;
insert into public.payments(order_id,status,paid_at,amount,provider,provider_capture_id)
 values('a0000000-0000-4000-8000-000000000001','verified',now(),10,'Apple Pay','TEST-CAPTURE');
select public.core_checkout_commit_inventory('a0000000-0000-4000-8000-000000000001');
select public.core_checkout_commit_inventory('a0000000-0000-4000-8000-000000000001');
do $phase5$
begin
 if (select count(*) from public.inventory_order_allocations where status='committed')<>3
 or (select count(*) from public.inventory_units where state='allocated')<>3
 or (select count(*) from public.inventory_movements where reason='allocated')<>3
 or (select sum(quantity_delta) from public.inventory_movements where reason='allocated')<>-3 then
  raise exception 'Verified payment did not deduct exactly once'; end if;
end $phase5$;

-- Cancellation of an unpaid order invokes a safe automatic release trigger.
update public.orders set status='cancelled'
 where id='a0000000-0000-4000-8000-000000000002';
do $phase5$
begin
 if (select count(*) from public.inventory_order_allocations where status='released')<>2
 or (select count(*) from public.inventory_units where state='reserved')<>0
 or (select count(*) from public.inventory_units where state='available')<>24 then
  raise exception 'Cancellation did not restore exactly the two unpaid held units'; end if;
end $phase5$;

-- Paid orders must never auto-restock on cancellation, return or refund.
update public.orders set status='cancelled'
 where id='a0000000-0000-4000-8000-000000000001';
do $phase5$
declare rejected boolean:=false;
begin
 begin
  perform public.core_checkout_release_inventory('a0000000-0000-4000-8000-000000000001');
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'A paid order was incorrectly restocked'; end if;
 if (select count(*) from public.inventory_units where state='allocated')<>3 then
  raise exception 'Committed stock changed after order cancellation'; end if;
end $phase5$;

-- Disabling both flags prevents any future checkout attempt using the feature.
update public.internal_runtime_config
set value='{"reservation_enabled":false,"deduction_enabled":false,"activated_at":null}'::jsonb
where key='inventory_checkout';
do $phase5$
begin
 if (public.core_checkout_reserve_inventory(
  'a0000000-0000-4000-8000-000000000005')->>'enabled')::boolean then
  raise exception 'Feature flag did not disable new reservations'; end if;
end $phase5$;


-- Phase 5B recovery safety acceptance. Synthetic rows only, entire CI DB
-- transaction rolls back. No production paid order or stock is mutated.
\i supabase/migrations/20261106023000_core_checkout_abandoned_recovery.sql

do $recovery$
begin
 if (public.core_checkout_recover_abandoned()->>'enabled')::boolean then
   raise exception 'Recovery must stay disabled in production by default'; end if;
 if (select coalesce((value->>'recovery_enabled')::boolean,false)
     from public.internal_runtime_config where key='inventory_checkout') then
   raise exception 'Migration unexpectedly activated recovery'; end if;
 if has_function_privilege('anon',
     'public.core_checkout_recover_abandoned(integer,integer)','EXECUTE') OR
    has_function_privilege('authenticated',
     'public.core_checkout_recovery_health()','EXECUTE') then
   raise exception 'Customer roles can operate or inspect recovery'; end if;
end $recovery$;

insert into public.orders(id,status,payment_status,payment_method,total,admin_notes,created_at)
values
 ('a0000000-0000-4000-8000-000000000006','submitted','pending','Apple Pay',20,'Nexus Pay Now checkout',now()-interval '4 hours'),
 ('a0000000-0000-4000-8000-000000000007','submitted','pending','PayPal',10,'Nexus Pay Now checkout',now()-interval '4 hours'),
 ('a0000000-0000-4000-8000-000000000008','submitted','pending','Zelle',10,'Nexus Pay Now checkout',now());
insert into public.order_items(order_id,product_id,quantity) values
 ('a0000000-0000-4000-8000-000000000006','22222222-2222-4222-8222-222222222221',2),
 ('a0000000-0000-4000-8000-000000000007','22222222-2222-4222-8222-222222222221',1),
 ('a0000000-0000-4000-8000-000000000008','22222222-2222-4222-8222-222222222221',1);

update public.internal_runtime_config set value=jsonb_build_object(
 'reservation_enabled',true,'deduction_enabled',true,'recovery_enabled',false,
 'activated_at',(now()-interval '6 hours')::text)
where key='inventory_checkout';
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000006');
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000007');
select public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000008');
-- Simulate time passing for only the two older checkouts, without waiting.
update public.inventory_order_allocations
set reserved_at=now()-interval '2 hours'
where order_id in ('a0000000-0000-4000-8000-000000000006',
                   'a0000000-0000-4000-8000-000000000007');
-- This separate payment session might still complete: NEVER auto-release it.
insert into public.payments(order_id,status,provider,amount,provider_order_id)
values('a0000000-0000-4000-8000-000000000007','paypal_created',
       'PayPal',10,'SYNTH-PAYPAL-AUTH');

do $recovery$
declare r jsonb;
begin
 r:=public.core_checkout_recover_abandoned(25,90);
 if (r->>'enabled')::boolean then
   raise exception 'Recovery ran despite separate recovery flag OFF'; end if;
 if (select count(*) from public.inventory_order_allocations
      where status='held' and order_id='a0000000-0000-4000-8000-000000000006')<>2 then
   raise exception 'Disabled recovery released a hold'; end if;
end $recovery$;

update public.internal_runtime_config
set value=jsonb_set(value,'{recovery_enabled}','true'::jsonb)
where key='inventory_checkout';

do $recovery$
declare r jsonb; h jsonb;
begin
 h:=public.core_checkout_recovery_health();
 if (h->>'stale_without_payment')::integer<>1
    or (h->>'requires_provider_review')::integer<>1 then
   raise exception 'Recovery health did not distinguish unpaid/provider session holds: %',h; end if;
 r:=public.core_checkout_recover_abandoned(25,90);
 if (r->>'expired_orders')::integer<>1
    or (r->>'released_units')::integer<>2 then
   raise exception 'Only no-session order should expire: %',r; end if;
 if (select status from public.orders
      where id='a0000000-0000-4000-8000-000000000006')<>'checkout_expired' then
   raise exception 'Expired order not marked terminal'; end if;
 if (select status from public.orders
      where id='a0000000-0000-4000-8000-000000000007')<>'submitted' then
   raise exception 'Payment session incorrectly expired'; end if;
 if (select count(*) from public.inventory_order_allocations
      where order_id='a0000000-0000-4000-8000-000000000006'
        and status='released')<>2 then
   raise exception 'Unpaid units were not released'; end if;
 if (select count(*) from public.inventory_order_allocations
      where order_id='a0000000-0000-4000-8000-000000000007'
        and status='held')<>1 then
   raise exception 'Provider session stock incorrectly released'; end if;
 if (select count(*) from public.inventory_order_allocations
      where order_id='a0000000-0000-4000-8000-000000000008'
        and status='held')<>1 then
   raise exception 'Fresh hold incorrectly expired'; end if;
 if (public.core_checkout_recover_abandoned(25,90)->>'expired_orders')::integer<>0 then
   raise exception 'Recovery retry must be idempotent'; end if;
end $recovery$;

-- No late provider session may be recorded after an order was expired,
-- even if PayPal made a delayed external order.
do $recovery$
declare rejected boolean:=false;
begin
 begin
   insert into public.payments(order_id,status,provider,amount,provider_order_id)
   values('a0000000-0000-4000-8000-000000000006',
          'paypal_created','PayPal',20,'SHOULD-BE-REJECTED');
 exception when others then rejected:=true; end;
 if NOT rejected then raise exception 'Expired order accepted late payment session'; end if;
end $recovery$;

-- Provider-session order can still complete verified payment: never release
-- before receipt verification. Test capture ID / same amount and repeated commit.
update public.orders set payment_status='paid',status='processing'
 where id='a0000000-0000-4000-8000-000000000007';
update public.payments set status='verified',paid_at=now(),
 provider_capture_id='SYNTH-CAPTURE'
 where order_id='a0000000-0000-4000-8000-000000000007';
select public.core_checkout_commit_inventory('a0000000-0000-4000-8000-000000000007');
select public.core_checkout_commit_inventory('a0000000-0000-4000-8000-000000000007');
do $recovery$
begin
 if (select count(*) from public.inventory_order_allocations
      where order_id='a0000000-0000-4000-8000-000000000007'
        and status='committed')<>1 then
   raise exception 'Verified provider stock did not commit exactly once'; end if;
 if (select count(*) from public.inventory_movements where reason='allocated')<>4 then
   raise exception 'Unexpected duplicate or missed allocation movement'; end if;
 if (select count(*) from public.inventory_units WHERE state='reserved')<>1 then
   raise exception 'Fresh checkout reservation was changed'; end if;
 if (select count(*) from public.inventory_movements)<>36 then
   raise exception 'Recovery unexpectedly changed immutable inventory events'; end if;
end $recovery$;

update public.internal_runtime_config set
 value='{"reservation_enabled":false,"deduction_enabled":false,"recovery_enabled":false,"activated_at":null}'::jsonb
where key='inventory_checkout';


-- Phase 5C: monitoring-only SQL in a rolled-back synthetic Postgres database.
\i supabase/migrations/20261106031000_core_inventory_monitor_snapshot.sql

do $monitor$
declare snapshot jsonb;
begin
 snapshot:=public.core_inventory_monitor_snapshot();
 if (snapshot->'totals'->>'total')::integer<>0 THEN
   raise exception 'Monitor must exclude historical orders without activation cutoff';
 end if;
 if (snapshot->'flags'->>'reservation_enabled')::boolean OR
    (snapshot->'flags'->>'deduction_enabled')::boolean OR
    (snapshot->'flags'->>'recovery_enabled')::boolean THEN
   raise exception 'Monitoring must not activate inventory flags';
 end if;
 if has_function_privilege('anon','public.core_inventory_monitor_snapshot()','EXECUTE') OR
    has_function_privilege('authenticated','public.core_inventory_monitor_snapshot()','EXECUTE') THEN
   raise exception 'Monitoring endpoint is exposed to customer roles';
 end if;
 if NOT has_function_privilege('service_role',
   'public.core_inventory_monitor_snapshot()','EXECUTE') THEN
   raise exception 'Monitoring missing private service access';
 end if;
end $monitor$;

insert into public.orders(id,status,payment_status,payment_method,total,paid_at,admin_notes,created_at,updated_at)
values(
 'a0000000-0000-4000-8000-000000000041','processing','paid','PayPal',10,
 now()-interval '5 minutes','Nexus Pay Now checkout',
 now()-interval '10 minutes',now()-interval '5 minutes'
);
insert into public.order_items(order_id,product_id,quantity)
values('a0000000-0000-4000-8000-000000000041',
 '22222222-2222-4222-8222-222222222221',2);
update public.internal_runtime_config set
 value=jsonb_build_object('reservation_enabled',false,'deduction_enabled',false,
 'recovery_enabled',false,'activated_at',(now()-interval '30 minutes')::text)
where key='inventory_checkout';

do $monitor$
declare snapshot jsonb;
begin
 snapshot:=public.core_inventory_monitor_snapshot();
 if (snapshot->'totals'->>'critical')::integer<2 THEN
   raise exception 'Monitoring failed to detect paid stock gap and unverified capture: %',snapshot;
 end if;
 if NOT EXISTS(
   select 1 from jsonb_array_elements(snapshot->'alerts') x
   where x->>'code'='paid_stock_gap' AND x->>'order_id'=
     'a0000000-0000-4000-8000-000000000041'
 ) OR NOT EXISTS(
   select 1 from jsonb_array_elements(snapshot->'alerts') x
   where x->>'code'='paid_payment_mismatch' AND x->>'order_id'=
     'a0000000-0000-4000-8000-000000000041'
 ) THEN
   raise exception 'Missing actionable paid-order alerts: %',snapshot;
 END IF;
 if (select count(*) from public.inventory_order_allocations where status='held')<>1 THEN
   raise exception 'Monitoring changed synthetic held units';
 END IF;
 if (select count(*) from public.inventory_movements where reason='allocated')<>4 THEN
   raise exception 'Monitoring mutated allocation history';
 END IF;
end $monitor$;

rollback;
