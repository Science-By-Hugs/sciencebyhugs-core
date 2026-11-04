-- Step 4: optional order email outbox. NO CUSTOMER MAIL IS ENABLED BY THIS MIGRATION.
-- Review and run this migration before deploying the worker; activate only after testing.
create schema if not exists private;

create table private.order_email_settings (
  singleton boolean primary key default true check (singleton),
  queue_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.order_email_settings(singleton, queue_enabled) values (true, false);
revoke all on private.order_email_settings from public, anon, authenticated;
alter table private.order_email_settings enable row level security;

create table private.order_email_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('received','status_changed','delivery_date_changed')),
  order_number text,
  order_status text,
  delivery_date date,
  created_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts between 0 and 5),
  state text not null default 'queued'
    check (state in ('queued','processing','retry','sent','suppressed','failed')),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error_code text
);
create index order_email_outbox_dispatch_idx
  on private.order_email_outbox(available_at, created_at)
  where state in ('queued','retry');
create index order_email_outbox_order_idx on private.order_email_outbox(order_id, created_at desc);
alter table private.order_email_outbox enable row level security;
revoke all on private.order_email_outbox from public, anon, authenticated;

create or replace function private.enqueue_optional_order_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_event text;
begin
  -- Fail closed: queueing must be enabled explicitly by the owner.
  if not exists (
    select 1 from private.order_email_settings
    where singleton and queue_enabled
  ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_event := 'received';
  elsif new.status is distinct from old.status then
    v_event := 'status_changed';
  elsif new.estimated_delivery_date is distinct from old.estimated_delivery_date then
    v_event := 'delivery_date_changed';
  else
    return new;
  end if;

  -- Never infer opt-in from marketing preferences or an existing push subscription.
  select p.auth_user_id into v_user_id
  from public.profiles p
  join public.customer_notification_preferences n
    on n.user_id = p.auth_user_id and n.order_email_enabled = true
  where p.id = new.customer_id
    and p.auth_user_id is not null
    and lower(p.account_status) = 'active';

  if v_user_id is null then
    return new;
  end if;

  insert into private.order_email_outbox (
    order_id, user_id, event_type, order_number, order_status, delivery_date
  ) values (
    new.id, v_user_id, v_event,
    left(coalesce(new.order_number, ''), 100),
    left(coalesce(new.status, ''), 100),
    new.estimated_delivery_date
  );
  return new;
end;
$$;
revoke all on function private.enqueue_optional_order_email()
  from public, anon, authenticated;

create trigger orders_optional_email_events
  after insert or update of status, estimated_delivery_date on public.orders
  for each row execute function private.enqueue_optional_order_email();

comment on table private.order_email_settings is
  'Transactional email is OFF until explicitly enabled after delivery tests.';
comment on table private.order_email_outbox is
  'Internal opted-in order events; never store recipient email, product names, or API keys.';
