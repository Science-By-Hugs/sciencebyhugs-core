-- Step 3: aggregate distinct Nexus onboarding actions for authenticated customers.
-- TestFlight requests are sent manually through the customer's SMS app.
-- Opening the SMS composer is not evidence that the customer sent a text.
create table public.nexus_onboarding_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'invitation_seen',
    'not_now',
    'email_setup_selected',
    'push_setup_selected',
    'pwa_guide_opened',
    'pwa_launched',
    'beta_text_opened'
  )),
  first_recorded_at timestamptz not null default now(),
  primary key(user_id, event_type)
);
alter table public.nexus_onboarding_events enable row level security;
revoke all on public.nexus_onboarding_events from public, anon, authenticated;
grant insert(user_id, event_type) on public.nexus_onboarding_events to authenticated;
grant select on public.nexus_onboarding_events to authenticated;
create policy nexus_onboarding_owner_insert on public.nexus_onboarding_events
for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy nexus_onboarding_admin_read on public.nexus_onboarding_events
for select to authenticated
using (lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '')) in ('owner', 'admin'));
