-- Core owner push noise reduction, 2026-11-07.
-- No changes to Nexus notifications, payments, order lifecycle, or subscription records.
-- Queue only:
--   1. One "new order" alert per order/owner.
--   2. One later "payment needs review" alert, when payment is SUBMITTED and
--      no order alert has been queued for that owner/order in the last 10 minutes.
-- Routine pending -> paid, paid -> pending, and fulfillment state changes stay visible
-- in Core Orders/Today but do not generate additional owner phone notifications.

create or replace function private.core_order_push_kind(
  operation text, old_payment text, new_payment text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when operation = 'INSERT' then 'new_order'
    when operation = 'UPDATE'
      and lower(btrim(coalesce(new_payment,''))) = 'submitted'
      and new_payment is distinct from old_payment
      then 'payment_review'
    else null
  end;
$$;

revoke all on function private.core_order_push_kind(text,text,text)
  from public,anon,authenticated;

-- Retain the active production Nexus customer push behavior, including
-- per-recipient 10-minute duplicate-message suppression and native recipients.
create or replace function private.queue_order_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  customer_auth uuid;
  event_key text := gen_random_uuid()::text;
  nexus_body text;
  core_kind text;
  core_body text;
begin
  core_kind := private.core_order_push_kind(
    TG_OP,
    case when TG_OP = 'INSERT' then null else OLD.payment_status end,
    NEW.payment_status
  );
  if core_kind = 'new_order' then
    core_body := 'A new order is ready to review in CORE.';
  elsif core_kind = 'payment_review' then
    core_body := 'A payment was submitted for review in CORE.';
  end if;

  nexus_body := private.order_push_customer_body(
    TG_OP,
    case when TG_OP = 'INSERT' then null else OLD.status end, NEW.status,
    case when TG_OP = 'INSERT' then null else OLD.payment_status end, NEW.payment_status,
    case when TG_OP = 'INSERT' then null else OLD.estimated_delivery_date end, NEW.estimated_delivery_date,
    NEW.order_number
  );

  if nexus_body is not null then
    select auth_user_id into customer_auth from public.profiles where id = NEW.customer_id;
    if customer_auth is not null
      and (
        exists (select 1 from public.app_push_subscriptions s where s.app = 'nexus' and s.user_id = customer_auth)
        or exists (select 1 from public.native_push_devices d where d.app = 'nexus' and d.user_id = customer_auth and d.invalidated_at is null)
      )
      and not exists (
        select 1 from private.app_push_queue q
        where q.user_id = customer_auth and q.app = 'nexus'
          and q.payload->>'tag' = 'order-' || NEW.id
          and q.payload->>'body' = nexus_body
          and q.created_at > now() - interval '10 minutes'
      )
    then
      insert into private.app_push_queue(event_key,user_id,app,payload)
      values (event_key, customer_auth, 'nexus',
        jsonb_build_object('title','NEXUS · Order update','body',nexus_body,'url','?push=orders','tag','order-' || NEW.id))
      on conflict do nothing;
    end if;
  end if;

  if core_body is not null then
    insert into private.app_push_queue(event_key,user_id,app,payload)
      select
        -- Deterministic keys prevent repeated events even with concurrent updates.
        'core-' || core_kind || ':' || NEW.id::text,
        s.user_id,'core',
        jsonb_build_object('title','CORE · Order alert','body',core_body,'url','#orders','tag','order-' || NEW.id)
      from public.app_push_subscriptions s
      join auth.users u on u.id = s.user_id
      where s.app = 'core'
        and lower(u.raw_app_meta_data->>'role') in ('owner','admin')
        and (
          core_kind = 'new_order'
          or not exists (
            -- Don't deliver a second "payment review" alert seconds after
            -- the initial new-order notification for this same order/owner.
            select 1 from private.app_push_queue q
            where q.user_id = s.user_id and q.app = 'core'
              and q.payload->>'tag' = 'order-' || NEW.id
              and q.created_at > now() - interval '10 minutes'
          )
        )
      group by s.user_id
      on conflict (event_key,user_id,app) do nothing;
  end if;
  return NEW;
end;
$function$;

revoke all on function private.queue_order_push()
  from public,anon,authenticated;
