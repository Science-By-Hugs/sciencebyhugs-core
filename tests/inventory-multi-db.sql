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

do $
begin
 if (select count(*) from public.inventory_stock_counts)<>0 then
   raise exception 'Migration should not invent counts for historical lots'; end if;
 if (select count(*) from public.inventory_units where state='available')<>29 then
   raise exception 'Existing stock counts were modified by migration'; end if;
 if (select count(*) from public.inventory_movements)<>30 then
   raise exception 'Existing movement history was modified by migration'; end if;
end $;

-- Matching count: audit only, no stock mutation.
select public.core_inventory_count_lot(
 (select id from public.inventory_lots where supplier_lot='RT-20'),
 10,0,'Verified all ten vials',
 'e1111111-1111-4111-8111-111111111111',
 '99999999-9999-4999-8999-999999999999'
);
do $
begin
 if (select status from public.inventory_stock_counts
   where request_id='e1111111-1111-4111-8111-111111111111')<>'matched' then
   raise exception 'Matching count was not recorded as matched'; end if;
 if (select count(*) from public.inventory_movements)<>30 then
   raise exception 'Matching count must not create stock movements'; end if;
end $;

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
do $
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
end $;

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
do $
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
end $;

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
do $
begin
 if (select count(*) from public.inventory_movements)<>32 then
   raise exception 'Retry created duplicate movement'; end if;
end $;

-- A surplus stays pending, cannot mint fictional unit IDs.
select public.core_inventory_count_lot(
 (select id from public.inventory_lots where supplier_lot='BATCH-C'),
 11,0,'Counted one unverified extra unit',
 'e3333333-3333-4333-8333-333333333333',
 '99999999-9999-4999-8999-999999999999'
);
do $
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
end $;

do $
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
end $;

rollback;
