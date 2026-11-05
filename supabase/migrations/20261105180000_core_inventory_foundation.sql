-- Core inventory foundation. REVIEW-ONLY: do not apply until owner signs off.
-- This migration is ADDITIVE. It does not modify products, products.price,
-- products.quantity, legacy product_costs, payments, fulfillment, or email dispatch.
-- Phase 1 is a single-line purchase order / full-receipt workflow; reservations
-- and Nexus availability must remain off until stock reconciliation is approved.

create sequence if not exists public.core_inventory_po_seq start with 1 increment by 1;
create sequence if not exists public.core_inventory_lot_seq start with 1 increment by 1;
revoke all on sequence public.core_inventory_po_seq, public.core_inventory_lot_seq from public, anon, authenticated;
grant usage, select on sequence public.core_inventory_po_seq, public.core_inventory_lot_seq to service_role;

create table if not exists public.inventory_vendors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{2,8}$'),
  name text not null unique check (char_length(btrim(name)) between 2 and 120),
  active boolean not null default true,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_product_settings (
  product_id uuid primary key references public.products(id) on delete cascade,
  supply_mode text not null default 'unreviewed'
    check (supply_mode in ('unreviewed','physical','vendor')),
  reorder_point integer not null default 0 check (reorder_point >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_vendor_offers (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.inventory_vendors(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  vendor_sku text,
  units_per_pack integer not null check (units_per_pack between 1 and 1000),
  price_per_pack numeric(14,2) not null check (price_per_pack >= 0),
  estimated_inbound_shipping numeric(14,2) not null default 0 check (estimated_inbound_shipping >= 0),
  lead_time_days integer check (lead_time_days between 0 and 365),
  active boolean not null default true,
  quote_date date not null default current_date,
  updated_at timestamptz not null default now(),
  unique(vendor_id,product_id,units_per_pack)
);

create table if not exists public.inventory_vendor_price_history (
  id bigint generated always as identity primary key,
  offer_id uuid not null references public.inventory_vendor_offers(id) on delete restrict,
  price_per_pack numeric(14,2) not null check(price_per_pack >= 0),
  units_per_pack integer not null,
  quote_date date not null,
  recorded_at timestamptz not null default now()
);

create or replace function private.core_inventory_snapshot_vendor_quote()
returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' or new.price_per_pack is distinct from old.price_per_pack
     or new.quote_date is distinct from old.quote_date then
    insert into public.inventory_vendor_price_history(offer_id,price_per_pack,units_per_pack,quote_date)
      values(new.id,new.price_per_pack,new.units_per_pack,new.quote_date);
  end if;
  return new;
end;
$function$;
drop trigger if exists inventory_offer_price_history on public.inventory_vendor_offers;
create trigger inventory_offer_price_history
after insert or update of price_per_pack, quote_date on public.inventory_vendor_offers
for each row execute function private.core_inventory_snapshot_vendor_quote();

create table if not exists public.inventory_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique default
    ('SBH-PO-' || lpad(nextval('public.core_inventory_po_seq')::text,6,'0')),
  vendor_id uuid not null references public.inventory_vendors(id) on delete restrict,
  status text not null default 'ordered'
    check(status in ('ordered','received','cancelled')),
  request_id uuid not null unique,
  shipping_actual numeric(14,2) not null default 0 check (shipping_actual >= 0),
  fees_actual numeric(14,2) not null default 0 check (fees_actual >= 0),
  notes text,
  created_by uuid,
  ordered_at timestamptz not null default now(),
  received_at timestamptz
);

create table if not exists public.inventory_purchase_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null unique references public.inventory_purchase_orders(id) on delete restrict,
  offer_id uuid not null references public.inventory_vendor_offers(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  packs_ordered integer not null check (packs_ordered between 1 and 1000),
  units_per_pack_snapshot integer not null check (units_per_pack_snapshot between 1 and 1000),
  pack_price_snapshot numeric(14,2) not null check(pack_price_snapshot >= 0),
  expected_units integer generated always as (packs_ordered * units_per_pack_snapshot) stored
);

create table if not exists public.inventory_receipts (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null unique references public.inventory_purchase_orders(id) on delete restrict,
  request_id uuid not null unique,
  accepted_units integer not null check (accepted_units >= 0),
  damaged_units integer not null check (damaged_units >= 0),
  supplier_lot text not null check (char_length(btrim(supplier_lot)) between 1 and 120),
  expiry_date date,
  received_by uuid,
  received_at timestamptz not null default now()
);

create table if not exists public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null unique references public.inventory_receipts(id) on delete restrict,
  purchase_line_id uuid not null references public.inventory_purchase_lines(id) on delete restrict,
  vendor_id uuid not null references public.inventory_vendors(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  internal_lot text not null unique,
  supplier_lot text not null,
  expiry_date date,
  accepted_units integer not null check(accepted_units >= 0),
  damaged_units integer not null check(damaged_units >= 0),
  landed_unit_cost numeric(16,4) check(landed_unit_cost >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_units (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  ordinal integer not null check(ordinal > 0),
  scan_token uuid not null unique default gen_random_uuid(),
  state text not null check(state in ('available','reserved','shipped','damaged','quarantined','returned')),
  created_at timestamptz not null default now(),
  unique(lot_id,ordinal)
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.inventory_units(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  quantity_delta integer not null check(quantity_delta between -1 and 1),
  reason text not null check(reason in ('received','damaged','dispatched','returned','adjustment')),
  event_key text not null unique,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists inventory_units_product_state_idx on public.inventory_units(product_id,state);
create index if not exists inventory_movements_lot_idx on public.inventory_movements(lot_id,created_at);

create or replace function private.core_inventory_immutable_movement()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  raise exception 'Inventory movement history is append-only';
end;
$function$;
drop trigger if exists inventory_movements_immutable on public.inventory_movements;
create trigger inventory_movements_immutable before update or delete
on public.inventory_movements for each row
execute function private.core_inventory_immutable_movement();

-- Inventory is exclusively accessed by an authenticated Core admin Edge Function
-- using its server-held service role. No public API grants or permissive RLS.
do $block$
declare t text;
begin
  foreach t in array array[
    'inventory_vendors','inventory_product_settings','inventory_vendor_offers',
    'inventory_vendor_price_history','inventory_purchase_orders',
    'inventory_purchase_lines','inventory_receipts','inventory_lots',
    'inventory_units','inventory_movements'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public, anon, authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end;
$block$;
revoke all on sequence public.inventory_vendor_price_history_id_seq from public,anon,authenticated;
grant usage,select on sequence public.inventory_vendor_price_history_id_seq to service_role;

-- Creates one purchase order with a single product offering. The pack price and
-- pack size are SNAPSHOTTED and will not change when the vendor quote changes.
create or replace function public.core_inventory_create_purchase(
  p_offer_id uuid, p_packs integer, p_shipping numeric, p_fees numeric,
  p_request_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_offer record;
  v_po public.inventory_purchase_orders%rowtype;
  v_line public.inventory_purchase_lines%rowtype;
begin
  if p_request_id is null or p_offer_id is null or p_packs not between 1 and 1000
     or p_shipping is null or p_shipping < 0 or p_shipping > 1000000
     or p_fees is null or p_fees < 0 or p_fees > 1000000 then
    raise exception 'Invalid purchase order request';
  end if;
  select o.*, v.active as vendor_active into v_offer
  from public.inventory_vendor_offers o
  join public.inventory_vendors v on v.id = o.vendor_id
  where o.id = p_offer_id;
  if not found or not v_offer.active or not v_offer.vendor_active then
    raise exception 'Vendor offering is unavailable';
  end if;
  insert into public.inventory_purchase_orders(
    vendor_id,request_id,shipping_actual,fees_actual,created_by
  ) values(
    v_offer.vendor_id,p_request_id,round(p_shipping,2),round(p_fees,2),p_actor_id
  ) on conflict(request_id) do nothing
  returning * into v_po;
  if v_po.id is null then
    select * into strict v_po from public.inventory_purchase_orders
    where request_id=p_request_id;
    select * into v_line from public.inventory_purchase_lines
    where purchase_order_id=v_po.id;
    if v_line.offer_id is distinct from p_offer_id or v_line.packs_ordered is distinct from p_packs
      or v_po.shipping_actual is distinct from round(p_shipping,2)
      or v_po.fees_actual is distinct from round(p_fees,2) then
      raise exception 'Idempotency key reused for different purchase';
    end if;
  else
    insert into public.inventory_purchase_lines(
      purchase_order_id,offer_id,product_id,packs_ordered,
      units_per_pack_snapshot,pack_price_snapshot
    ) values(
      v_po.id,v_offer.id,v_offer.product_id,p_packs,
      v_offer.units_per_pack,v_offer.price_per_pack
    );
  end if;
  return jsonb_build_object('id',v_po.id,'po_number',v_po.po_number,
    'status',v_po.status,'expected_units',
      (select expected_units from public.inventory_purchase_lines where purchase_order_id=v_po.id));
end;
$function$;
revoke all on function public.core_inventory_create_purchase(uuid,integer,numeric,numeric,uuid,uuid) from public, anon, authenticated;
grant execute on function public.core_inventory_create_purchase(uuid,integer,numeric,numeric,uuid,uuid) to service_role;

-- Full receipt, one line per PO (Phase 1). Locking + unique receipt prevents
-- duplicate stock creation, including concurrent requests/retries.
create or replace function public.core_inventory_receive_purchase(
  p_order_id uuid, p_accepted integer, p_damaged integer,
  p_supplier_lot text, p_expiry date, p_request_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_po public.inventory_purchase_orders%rowtype;
  v_line public.inventory_purchase_lines%rowtype;
  v_vendor public.inventory_vendors%rowtype;
  v_receipt public.inventory_receipts%rowtype;
  v_lot public.inventory_lots%rowtype;
  v_unit_cost numeric(16,4);
  v_lot_number text;
begin
  if p_order_id is null or p_request_id is null
     or p_accepted is null or p_damaged is null
     or p_accepted < 0 or p_damaged < 0
     or char_length(btrim(coalesce(p_supplier_lot,''))) not between 1 and 120 then
    raise exception 'Invalid receiving details or missing manufacturer/supplier lot';
  end if;
  select * into v_receipt from public.inventory_receipts where request_id=p_request_id;
  if found then
    if v_receipt.purchase_order_id <> p_order_id
      or v_receipt.accepted_units <> p_accepted
      or v_receipt.damaged_units <> p_damaged
      or v_receipt.supplier_lot <> btrim(p_supplier_lot)
      or v_receipt.expiry_date is distinct from p_expiry then
      raise exception 'Receiving request ID was reused with different details';
    end if;
    return jsonb_build_object('receipt_id',v_receipt.id,'already_received',true,
      'accepted_units',v_receipt.accepted_units,'damaged_units',v_receipt.damaged_units);
  end if;
  select * into v_po from public.inventory_purchase_orders
    where id=p_order_id for update;
  if not found or v_po.status <> 'ordered' then
    raise exception 'Purchase order is not awaiting receipt';
  end if;
  select * into strict v_line from public.inventory_purchase_lines
    where purchase_order_id=v_po.id;
  if p_accepted + p_damaged <> v_line.expected_units then
    raise exception 'Phase 1 requires a full receipt: accepted + damaged must equal expected units';
  end if;
  select * into strict v_vendor from public.inventory_vendors
    where id=v_po.vendor_id;
  v_unit_cost := case when p_accepted > 0 then
    round((v_line.pack_price_snapshot * v_line.packs_ordered
        + v_po.shipping_actual + v_po.fees_actual) / p_accepted,4)
    else null end;
  insert into public.inventory_receipts(
    purchase_order_id,request_id,accepted_units,damaged_units,supplier_lot,expiry_date,received_by
  ) values(v_po.id,p_request_id,p_accepted,p_damaged,btrim(p_supplier_lot),p_expiry,p_actor_id)
    returning * into v_receipt;
  v_lot_number := 'SBH-' ||
    to_char(now() at time zone 'America/Los_Angeles','YYMMDD') || '-' ||
    v_vendor.code || '-' ||
    lpad(nextval('public.core_inventory_lot_seq')::text,4,'0');
  insert into public.inventory_lots(
    receipt_id,purchase_line_id,vendor_id,product_id,internal_lot,supplier_lot,
    expiry_date,accepted_units,damaged_units,landed_unit_cost
  ) values(
    v_receipt.id,v_line.id,v_po.vendor_id,v_line.product_id,v_lot_number,
    btrim(p_supplier_lot),p_expiry,p_accepted,p_damaged,v_unit_cost
  ) returning * into v_lot;
  insert into public.inventory_units(lot_id,product_id,ordinal,state)
  select v_lot.id,v_line.product_id,seq,
    case when seq<=p_accepted then 'available' else 'damaged' end
  from generate_series(1,v_line.expected_units) seq;
  insert into public.inventory_movements(
    unit_id,product_id,lot_id,quantity_delta,reason,event_key,actor_id
  )
  select u.id,v_line.product_id,v_lot.id,
    case when u.state='available' then 1 else 0 end,
    case when u.state='available' then 'received' else 'damaged' end,
    'receipt:' || v_receipt.id::text || ':unit:' || u.ordinal::text,p_actor_id
  from public.inventory_units u where u.lot_id=v_lot.id;
  update public.inventory_purchase_orders
    set status='received',received_at=now() where id=v_po.id;
  return jsonb_build_object('receipt_id',v_receipt.id,'lot_id',v_lot.id,
    'internal_lot',v_lot.internal_lot,'accepted_units',p_accepted,
    'damaged_units',p_damaged,'landed_unit_cost',v_lot.landed_unit_cost,
    'already_received',false);
end;
$function$;
revoke all on function public.core_inventory_receive_purchase(uuid,integer,integer,text,date,uuid,uuid) from public,anon,authenticated;
grant execute on function public.core_inventory_receive_purchase(uuid,integer,integer,text,date,uuid,uuid) to service_role;
