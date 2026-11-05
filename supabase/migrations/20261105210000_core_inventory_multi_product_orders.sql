-- Core multi-product purchase orders and partial receipts.
-- ADDITIVE: preserves legacy purchase orders, immutable movements, lots and prices.
-- Intentionally NOT applied to production until PR validation and rollout approval.
-- All writes remain service-role-only, mediated by the authenticated Core Edge Function.

alter table public.inventory_purchase_orders
  drop constraint if exists inventory_purchase_orders_status_check;
alter table public.inventory_purchase_orders
  add constraint inventory_purchase_orders_status_check
  check (status in ('ordered','partially_received','received','cancelled'));

alter table public.inventory_purchase_orders
  add column if not exists multi_line boolean not null default false,
  add column if not exists allocation_method text,
  add column if not exists request_payload jsonb;
alter table public.inventory_purchase_orders
  add constraint inventory_purchase_orders_allocation_method_check
  check (allocation_method is null or allocation_method in ('per_kit','by_cost','manual'));

-- The original schema enforced one line per order; retain all existing rows.
alter table public.inventory_purchase_lines
  drop constraint if exists inventory_purchase_lines_purchase_order_id_key;
create index if not exists inventory_purchase_lines_po_idx
  on public.inventory_purchase_lines(purchase_order_id);
alter table public.inventory_purchase_lines
  add column if not exists shipping_allocated numeric(14,2) not null default 0 check (shipping_allocated >= 0),
  add column if not exists fees_allocated numeric(14,2) not null default 0 check (fees_allocated >= 0);

-- A receipt represents one line/batch; multiple receipts per order are now possible.
alter table public.inventory_receipts
  add column if not exists purchase_line_id uuid
    references public.inventory_purchase_lines(id) on delete restrict;
update public.inventory_receipts r
set purchase_line_id=l.id
from public.inventory_purchase_lines l
where r.purchase_order_id=l.purchase_order_id and r.purchase_line_id is null;
alter table public.inventory_receipts
  drop constraint if exists inventory_receipts_purchase_order_id_key;
create index if not exists inventory_receipts_po_idx
  on public.inventory_receipts(purchase_order_id);
create index if not exists inventory_receipts_line_idx
  on public.inventory_receipts(purchase_line_id);
alter table public.inventory_lots
  add column if not exists cost_finalized boolean not null default true;

-- Legacy single-line order functions are preserved; reject a multi-line order
-- at the old full-receipt endpoint through its strict single-row selection.

create or replace function public.core_inventory_create_multi_purchase(
  p_vendor_id uuid, p_lines jsonb, p_shipping numeric, p_fees numeric,
  p_allocation_method text, p_request_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_po public.inventory_purchase_orders%rowtype;
  v_offer record;
  v_item jsonb;
  v_saved jsonb := '[]'::jsonb;
  v_payload jsonb;
  v_seen uuid[] := '{}'::uuid[];
  v_packs integer;
  v_line_count integer;
  v_index integer := 0;
  v_total_kits numeric := 0;
  v_total_cost numeric := 0;
  v_weight numeric;
  v_weight_total numeric;
  v_ship numeric(14,2);
  v_fee numeric(14,2);
  v_ship_left numeric(14,2);
  v_fee_left numeric(14,2);
  v_manual_ship numeric(14,2) := 0;
  v_manual_fee numeric(14,2) := 0;
  v_expected integer := 0;
begin
  if p_vendor_id is null or p_request_id is null or p_actor_id is null
    or p_lines is null or jsonb_typeof(p_lines) <> 'array'
    or p_shipping is null or p_fees is null
    or p_shipping < 0 or p_fees < 0
    or p_shipping > 1000000 or p_fees > 1000000
    or round(p_shipping,2) <> p_shipping or round(p_fees,2) <> p_fees
    or p_allocation_method not in ('per_kit','by_cost','manual') then
    raise exception 'Invalid multi-product order details';
  end if;
  v_line_count := jsonb_array_length(p_lines);
  if v_line_count not between 1 and 25 then
    raise exception 'Each purchase order must contain 1 to 25 different offerings';
  end if;
  if not exists(select 1 from public.inventory_vendors where id=p_vendor_id and active) then
    raise exception 'Vendor is unavailable';
  end if;
  for v_item in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_item)<>'object'
      or coalesce(v_item->>'offerId','')=''
      or coalesce(v_item->>'packs','') !~ '^[1-9][0-9]{0,3}$' then
      raise exception 'Each line needs a vendor offering and positive kit count';
    end if;
    v_packs := (v_item->>'packs')::integer;
    if v_packs > 1000 then raise exception 'Too many packs on one line'; end if;
    select o.* into v_offer
      from public.inventory_vendor_offers o
      where o.id=(v_item->>'offerId')::uuid and o.vendor_id=p_vendor_id and o.active;
    if not found then raise exception 'Offering must belong to the selected active vendor'; end if;
    if v_offer.id = any(v_seen) then raise exception 'Duplicate offering in the same purchase'; end if;
    v_seen:=array_append(v_seen,v_offer.id);
    if v_packs * v_offer.units_per_pack > 5000 then
      raise exception 'A product line cannot exceed 5,000 vials'; end if;
    v_expected:=v_expected+v_packs*v_offer.units_per_pack;
    if v_expected>10000 then raise exception 'Order cannot exceed 10,000 vials'; end if;
    v_total_kits:=v_total_kits+v_packs;
    v_total_cost:=v_total_cost+v_packs*v_offer.price_per_pack;
    v_saved:=v_saved||jsonb_build_array(jsonb_build_object(
      'offer_id',v_offer.id,'product_id',v_offer.product_id,
      'packs',v_packs,'units_per_pack',v_offer.units_per_pack,
      'pack_price',v_offer.price_per_pack,
      'manual_shipping',v_item->>'shipping','manual_fees',v_item->>'fees'
    ));
  end loop;
  if p_allocation_method='by_cost' and v_total_cost=0 and (p_shipping>0 or p_fees>0) then
    raise exception 'Cost-weighted allocation requires nonzero product prices';
  end if;

  v_payload := jsonb_build_object('vendor',p_vendor_id,'lines',p_lines,
    'shipping',p_shipping,'fees',p_fees,'method',p_allocation_method);
  select * into v_po from public.inventory_purchase_orders where request_id=p_request_id;
  if found then
    if not v_po.multi_line or v_po.request_payload is distinct from v_payload then
      raise exception 'Idempotency key reused for a different purchase order';
    end if;
    return jsonb_build_object('id',v_po.id,'po_number',v_po.po_number,
      'expected_units',v_expected,'line_count',v_line_count,'already_created',true);
  end if;

  v_ship_left:=p_shipping;
  v_fee_left:=p_fees;
  insert into public.inventory_purchase_orders(
    vendor_id,request_id,shipping_actual,fees_actual,created_by,
    multi_line,allocation_method,request_payload
  ) values(p_vendor_id,p_request_id,p_shipping,p_fees,p_actor_id,
    true,p_allocation_method,v_payload)
  on conflict(request_id) do nothing returning * into v_po;
  if v_po.id is null then
    select * into strict v_po from public.inventory_purchase_orders
      where request_id=p_request_id;
    if not v_po.multi_line or v_po.request_payload is distinct from v_payload then
      raise exception 'Idempotency key reused for a different purchase order';
    end if;
    return jsonb_build_object('id',v_po.id,'po_number',v_po.po_number,
      'expected_units',v_expected,'line_count',v_line_count,'already_created',true);
  end if;

  for v_item in select value from jsonb_array_elements(v_saved) loop
    v_index:=v_index+1;
    v_packs:=(v_item->>'packs')::integer;
    v_weight:=case when p_allocation_method='by_cost'
      then (v_item->>'pack_price')::numeric * v_packs else v_packs end;
    v_weight_total:=case when p_allocation_method='by_cost'
      then v_total_cost else v_total_kits end;
    if p_allocation_method='manual' then
      if coalesce(v_item->>'manual_shipping','')='' or coalesce(v_item->>'manual_fees','')='' then
        raise exception 'Manual allocation requires shipping and fees for every line'; end if;
      v_ship:=(v_item->>'manual_shipping')::numeric;
      v_fee:=(v_item->>'manual_fees')::numeric;
      if v_ship<0 or v_fee<0 or round(v_ship,2)<>v_ship or round(v_fee,2)<>v_fee then
        raise exception 'Manual allocations must be nonnegative cents'; end if;
      v_manual_ship:=v_manual_ship+v_ship;
      v_manual_fee:=v_manual_fee+v_fee;
    else
      if v_index=v_line_count then
        v_ship:=v_ship_left;
        v_fee:=v_fee_left;
      else
        v_ship:=round(p_shipping * v_weight / v_weight_total,2);
        v_fee:=round(p_fees * v_weight / v_weight_total,2);
      end if;
      v_ship_left:=v_ship_left-v_ship;
      v_fee_left:=v_fee_left-v_fee;
    end if;
    insert into public.inventory_purchase_lines(
      purchase_order_id,offer_id,product_id,packs_ordered,
      units_per_pack_snapshot,pack_price_snapshot,shipping_allocated,fees_allocated
    ) values(
      v_po.id,(v_item->>'offer_id')::uuid,(v_item->>'product_id')::uuid,v_packs,
      (v_item->>'units_per_pack')::integer,(v_item->>'pack_price')::numeric,v_ship,v_fee
    );
  end loop;
  if p_allocation_method='manual' and
    (v_manual_ship<>p_shipping or v_manual_fee<>p_fees) then
    raise exception 'Manually allocated shipping and fees must match order totals';
  end if;
  return jsonb_build_object('id',v_po.id,'po_number',v_po.po_number,
    'expected_units',v_expected,'line_count',v_line_count,'already_created',false);
end;
$function$;
revoke all on function public.core_inventory_create_multi_purchase(uuid,jsonb,numeric,numeric,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.core_inventory_create_multi_purchase(uuid,jsonb,numeric,numeric,text,uuid,uuid)
  to service_role;

create or replace function public.core_inventory_receive_multi_line(
  p_line_id uuid, p_accepted integer, p_damaged integer,
  p_supplier_lot text, p_expiry date, p_request_id uuid, p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_po public.inventory_purchase_orders%rowtype;
  v_line public.inventory_purchase_lines%rowtype;
  v_receipt public.inventory_receipts%rowtype;
  v_lot public.inventory_lots%rowtype;
  v_prior integer;
  v_total_received integer;
  v_total_accepted integer;
  v_cost numeric(16,4);
  v_vendor_code text;
  v_order_fully_received boolean;
begin
  if p_line_id is null or p_request_id is null or p_actor_id is null
    or p_accepted is null or p_damaged is null
    or p_accepted < 0 or p_damaged < 0
    or p_accepted+p_damaged not between 1 and 100
    or char_length(btrim(coalesce(p_supplier_lot,''))) not between 1 and 120 then
    raise exception 'Valid line, supplier lot and 1–100 received units required';
  end if;
  select * into v_line from public.inventory_purchase_lines where id=p_line_id;
  if not found then raise exception 'Purchase line was not found'; end if;

  -- Serialize all receipts for an order, including different lines.
  select * into v_po from public.inventory_purchase_orders
    where id=v_line.purchase_order_id for update;
  if not found or not v_po.multi_line then
    raise exception 'Line does not belong to a multi-product order'; end if;
  select * into v_receipt from public.inventory_receipts where request_id=p_request_id;
  if found then
    if v_receipt.purchase_line_id is distinct from p_line_id
      or v_receipt.accepted_units<>p_accepted
      or v_receipt.damaged_units<>p_damaged
      or v_receipt.supplier_lot<>btrim(p_supplier_lot)
      or v_receipt.expiry_date is distinct from p_expiry then
      raise exception 'Receiving request key reused with different details';
    end if;
    select * into v_lot from public.inventory_lots where receipt_id=v_receipt.id;
    return jsonb_build_object('receipt_id',v_receipt.id,'lot_id',v_lot.id,
      'internal_lot',v_lot.internal_lot,'already_received',true);
  end if;
  if v_po.status not in ('ordered','partially_received') then
    raise exception 'Purchase order is not accepting receipts'; end if;
  select coalesce(sum(r.accepted_units+r.damaged_units),0)
    into v_prior from public.inventory_receipts r
    where r.purchase_line_id=p_line_id;
  if v_prior+p_accepted+p_damaged>v_line.expected_units then
    raise exception 'This receipt exceeds the remaining units on the purchase line';
  end if;
  select code into v_vendor_code from public.inventory_vendors
    where id=v_po.vendor_id;
  insert into public.inventory_receipts(
    purchase_order_id,purchase_line_id,request_id,accepted_units,damaged_units,
    supplier_lot,expiry_date,received_by
  ) values(
    v_po.id,p_line_id,p_request_id,p_accepted,p_damaged,
    btrim(p_supplier_lot),p_expiry,p_actor_id
  ) returning * into v_receipt;
  insert into public.inventory_lots(
    receipt_id,purchase_line_id,vendor_id,product_id,internal_lot,supplier_lot,
    expiry_date,accepted_units,damaged_units,landed_unit_cost,cost_finalized
  ) values(
    v_receipt.id,p_line_id,v_po.vendor_id,v_line.product_id,
    'SBH-' || to_char(now() at time zone 'America/Los_Angeles','YYMMDD') ||
      '-' || v_vendor_code || '-' ||
      lpad(nextval('public.core_inventory_lot_seq')::text,4,'0'),
    btrim(p_supplier_lot),p_expiry,p_accepted,p_damaged,null,false
  ) returning * into v_lot;
  insert into public.inventory_units(lot_id,product_id,ordinal,state)
  select v_lot.id,v_line.product_id,idx,
    case when idx<=p_accepted then 'available' else 'damaged' end
    from generate_series(1,p_accepted+p_damaged) idx;
  insert into public.inventory_movements(
    unit_id,product_id,lot_id,quantity_delta,reason,event_key,actor_id
  ) select u.id,v_line.product_id,v_lot.id,
    case when u.state='available' then 1 else 0 end,
    case when u.state='available' then 'received' else 'damaged' end,
    'receipt:' || v_receipt.id::text || ':unit:' || u.ordinal::text,p_actor_id
    from public.inventory_units u where u.lot_id=v_lot.id;

  select coalesce(sum(accepted_units+damaged_units),0),
    coalesce(sum(accepted_units),0)
    into v_total_received,v_total_accepted
    from public.inventory_receipts where purchase_line_id=p_line_id;
  if v_total_received=v_line.expected_units then
    v_cost:=case when v_total_accepted>0 then
      round((v_line.pack_price_snapshot*v_line.packs_ordered+
        v_line.shipping_allocated+v_line.fees_allocated)/v_total_accepted,4)
      else null end;
    update public.inventory_lots set
      landed_unit_cost=v_cost,cost_finalized=true
      where purchase_line_id=p_line_id;
  end if;

  select not exists (
    select 1 from public.inventory_purchase_lines pl
      where pl.purchase_order_id=v_po.id
        and pl.expected_units >
          (select coalesce(sum(accepted_units+damaged_units),0)
           from public.inventory_receipts r where r.purchase_line_id=pl.id)
  ) into v_order_fully_received;
  update public.inventory_purchase_orders
    set status=case when v_order_fully_received then 'received'
      else 'partially_received' end,
      received_at=case when v_order_fully_received then now() else null end
    where id=v_po.id;
  return jsonb_build_object('receipt_id',v_receipt.id,'lot_id',v_lot.id,
    'internal_lot',v_lot.internal_lot,'accepted_units',p_accepted,
    'damaged_units',p_damaged,'cost_finalized',v_total_received=v_line.expected_units,
    'landed_unit_cost',case when v_total_received=v_line.expected_units then v_cost else null end,
    'already_received',false);
end;
$function$;
revoke all on function public.core_inventory_receive_multi_line(uuid,integer,integer,text,date,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.core_inventory_receive_multi_line(uuid,integer,integer,text,date,uuid,uuid)
  to service_role;
