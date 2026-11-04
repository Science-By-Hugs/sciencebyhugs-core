-- Nexus customer order-email preferences; intentionally separate from marketing consent.
-- Applied to the shared ecosystem Supabase project before deploying the Nexus settings UI.
create table public.customer_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  order_email_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_notification_preferences enable row level security;
revoke all on public.customer_notification_preferences from anon, authenticated;
grant select on public.customer_notification_preferences to authenticated;
grant insert(user_id, order_email_enabled) on public.customer_notification_preferences to authenticated;
grant update(order_email_enabled) on public.customer_notification_preferences to authenticated;

create policy notification_preference_owner_select
on public.customer_notification_preferences for select to authenticated
using ((select auth.uid()) = user_id);

create policy notification_preference_owner_insert
on public.customer_notification_preferences for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy notification_preference_owner_update
on public.customer_notification_preferences for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function private.touch_customer_notification_preferences()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function private.touch_customer_notification_preferences() from public, anon, authenticated;

create trigger touch_customer_notification_preferences
before update on public.customer_notification_preferences
for each row execute function private.touch_customer_notification_preferences();
