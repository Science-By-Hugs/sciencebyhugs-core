-- Core Inventory Phase 4: controlled physical lot counts and evidence-backed shortages.
-- No backfills, no changes to previous receipts, lots, purchase prices or payments.
-- Existing immutable inventory movements remain append-only.
-- All audit write operations stay behind the owner/admin authenticated Edge Function.

alter table public.inventory_units drop constraint if exists inventory_units_state_check;
alter table public.inventory_units add constraint inventory_units_state_check
  check (state in ('available','reserved','shipped','damaged',
    'quarantined','returned','missing'));

create table if not exists public.inventory_stock_counts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  lot_id uuid not null references public.inventory_lots(id) on delete restrict,
  expected_available integer not null check(expected_available>=0),
  expected_damaged integer not null check(expected_damaged>=0),
  counted_available integer not null check(counted_available>=0),
  counted_damaged integer not null check(counted_damaged>=0),
  notes text not null default '' check(char_length(notes)<=500),
  status text not null check(status in ('matched','pending','resolved')),
  resolved_unit_ids uuid[] not null default '{}'::uuid[],
  created_by uuid not null,
  created_at timestamptz not null default now(),
  resolved_by uuid,
  resolved_at timestamptz
);
create index if not exists inventory_stock_counts_lot_created_idx
  on public.inventory_stock_counts(lot_id,created_at desc);

-- Stock count evidence is private, just like unit scans and receipts.
alter table public.inventory_stock_counts enable row level security;
revoke all on public.inventory_stock_counts from public,anon,authenticated;
grant all on public.inventory_stock_counts to service_role;

create or replace function public.core_inventory_count_lot(
  p_lot_id uuid,p_counted_available integer,p_counted_damaged integer,
  p_notes text,p_request_id uuid,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_lot public.inventory_lots%rowtype;
  v_existing public.inventory_stock_counts%rowtype;
  v_available integer;
  v_damaged integer;
  v_status text;
begin
  if p_lot_id is null or p_request_id is null or p_actor_id is null or
    p_counted_available is null or p_counted_damaged is null or
    p_counted_available not between 0 and 100 or
    p_counted_damaged not between 0 and 100 or
    char_length(coalesce(p_notes,''))>500 then
    raise exception 'Invalid physical count details';
  end if;

  select * into v_existing from public.inventory_stock_counts
    where request_id=p_request_id;
  if found then
    if v_existing.lot_id<>p_lot_id or
      v_existing.counted_available<>p_counted_available or
      v_existing.counted_damaged<>p_counted_damaged or
      v_existing.notes<>coalesce(p_notes,'') then
      raise exception 'Count request key reused for different data';
    end if;
    return jsonb_build_object('count_id',v_existing.id,'status',v_existing.status,
      'expected_available',v_existing.expected_available,
      'expected_damaged',v_existing.expected_damaged,
      'counted_available',v_existing.counted_available,
      'counted_damaged',v_existing.counted_damaged,'already_saved',true);
  end if;

  -- Serialize audit against explicit future stock corrections on this lot.
  select * into v_lot from public.inventory_lots where id=p_lot_id for update;
  if not found then raise exception 'Inventory lot does not exist'; end if;
  select count(*) filter (where state='available'),
         count(*) filter (where state='damaged')
    into v_available,v_damaged
    from public.inventory_units where lot_id=p_lot_id;
  v_status:=case when v_available=p_counted_available and
                       v_damaged=p_counted_damaged
    then 'matched' else 'pending' end;

  insert into public.inventory_stock_counts(
    request_id,lot_id,expected_available,expected_damaged,
    counted_available,counted_damaged,notes,status,created_by
  ) values(
    p_request_id,p_lot_id,v_available,v_damaged,
    p_counted_available,p_counted_damaged,coalesce(p_notes,''),v_status,p_actor_id
  ) on conflict(request_id) do nothing returning * into v_existing;
  if v_existing.id is null then
    select * into strict v_existing from public.inventory_stock_counts
      where request_id=p_request_id;
    if v_existing.lot_id<>p_lot_id or
      v_existing.counted_available<>p_counted_available or
      v_existing.counted_damaged<>p_counted_damaged or
      v_existing.notes<>coalesce(p_notes,'') then
      raise exception 'Count request key reused for different data';
    end if;
  end if;
  return jsonb_build_object('count_id',v_existing.id,'status',v_existing.status,
    'expected_available',v_existing.expected_available,
    'expected_damaged',v_existing.expected_damaged,
    'counted_available',v_existing.counted_available,
    'counted_damaged',v_existing.counted_damaged,'already_saved',false);
end;
$function$;
revoke all on function public.core_inventory_count_lot(uuid,integer,integer,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.core_inventory_count_lot(uuid,integer,integer,text,uuid,uuid)
  to service_role;

create or replace function public.core_inventory_resolve_lot_count(
  p_count_id uuid,p_missing_unit_ids uuid[],p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_count public.inventory_stock_counts%rowtype;
  v_available integer;
  v_damaged integer;
  v_expected_available_missing integer;
  v_expected_damaged_missing integer;
  v_ids integer;
  v_selected_available integer;
  v_selected_damaged integer;
begin
  if p_count_id is null or p_actor_id is null or p_missing_unit_ids is null then
    raise exception 'Count and selected missing units are required';
  end if;
  if cardinality(p_missing_unit_ids)>100 or
    (select count(*) from unnest(p_missing_unit_ids) as x(id) where id is null)>0 or
    (select count(distinct id) from unnest(p_missing_unit_ids) as x(id))<>
      cardinality(p_missing_unit_ids) then
    raise exception 'Selected units must be unique and valid';
  end if;

  select * into v_count from public.inventory_stock_counts
    where id=p_count_id for update;
  if not found then raise exception 'Count record not found'; end if;
  if v_count.status='resolved' then
    if v_count.resolved_unit_ids<>p_missing_unit_ids then
      raise exception 'Count was resolved with different tracked units'; end if;
    return jsonb_build_object('count_id',v_count.id,'status','resolved',
      'already_resolved',true,'changed_units',cardinality(p_missing_unit_ids));
  end if;
  if v_count.status<>'pending' then
    raise exception 'Only pending discrepancies can be resolved';
  end if;
  if v_count.counted_available>v_count.expected_available or
     v_count.counted_damaged>v_count.expected_damaged then
    raise exception 'Surplus stock requires investigation; no new inventory is created automatically';
  end if;
  v_expected_available_missing:=v_count.expected_available-v_count.counted_available;
  v_expected_damaged_missing:=v_count.expected_damaged-v_count.counted_damaged;
  if cardinality(p_missing_unit_ids) <>
      v_expected_available_missing+v_expected_damaged_missing then
    raise exception 'Select exactly the number of tracked units missing from the count';
  end if;

  -- The same lot row is locked by count submission and reconciliation.
  perform 1 from public.inventory_lots where id=v_count.lot_id for update;
  perform 1 from public.inventory_units
    where lot_id=v_count.lot_id order by id for update;

  select count(*) filter(where state='available'),
         count(*) filter(where state='damaged')
    into v_available,v_damaged from public.inventory_units
    where lot_id=v_count.lot_id;
  if v_available<>v_count.expected_available or
     v_damaged<>v_count.expected_damaged then
    raise exception 'Stock states changed since this count; take a new count before reconciling';
  end if;
  select count(*),
    count(*) filter(where state='available'),
    count(*) filter(where state='damaged')
    into v_ids,v_selected_available,v_selected_damaged
    from public.inventory_units
    where id=any(p_missing_unit_ids) and lot_id=v_count.lot_id
      and state in ('available','damaged');
  if v_ids<>cardinality(p_missing_unit_ids) or
    v_selected_available<>v_expected_available_missing or
    v_selected_damaged<>v_expected_damaged_missing then
    raise exception 'Selected missing units do not match the recorded available/damaged shortages';
  end if;

  -- Insert distinct adjustment movement events BEFORE marking tracked units
  -- missing. The original receipt and its landed cost remain immutable.
  insert into public.inventory_movements(
    unit_id,product_id,lot_id,quantity_delta,reason,event_key,actor_id
  ) select u.id,u.product_id,u.lot_id,
      case when u.state='available' then -1 else 0 end,
      'adjustment','stock_count:'||v_count.id::text||':unit:'||u.id::text,
      p_actor_id
    from public.inventory_units u
    where u.id=any(p_missing_unit_ids) and u.lot_id=v_count.lot_id;
  update public.inventory_units set state='missing'
    where id=any(p_missing_unit_ids) and lot_id=v_count.lot_id;
  update public.inventory_stock_counts
    set status='resolved',resolved_unit_ids=p_missing_unit_ids,
      resolved_by=p_actor_id,resolved_at=now()
    where id=v_count.id;
  return jsonb_build_object('count_id',v_count.id,'status','resolved',
    'already_resolved',false,'changed_units',cardinality(p_missing_unit_ids),
    'new_available',v_count.counted_available,
    'new_damaged',v_count.counted_damaged);
end;
$function$;
revoke all on function public.core_inventory_resolve_lot_count(uuid,uuid[],uuid)
  from public,anon,authenticated;
grant execute on function public.core_inventory_resolve_lot_count(uuid,uuid[],uuid)
  to service_role;
