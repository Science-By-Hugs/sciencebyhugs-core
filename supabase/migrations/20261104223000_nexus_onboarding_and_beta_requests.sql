-- Step 3: Nexus onboarding adoption and iOS TestFlight beta requests.
-- No marketing opt-in is inferred; no invitation is sent from these tables.
create table public.nexus_beta_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  status text not null default 'pending' check (status in ('pending', 'invited', 'declined')),
  requested_at timestamptz not null default now()
);
alter table public.nexus_beta_requests enable row level security;
revoke all on public.nexus_beta_requests from public, anon, authenticated;
grant select on public.nexus_beta_requests to authenticated;
grant insert (user_id, email) on public.nexus_beta_requests to authenticated;
grant update (status) on public.nexus_beta_requests to authenticated;

create policy nexus_beta_owner_or_admin_read on public.nexus_beta_requests
for select to authenticated
using (
  (select auth.uid()) = user_id
  or lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role','')) in ('owner','admin')
);
create policy nexus_beta_owner_insert on public.nexus_beta_requests
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and lower(email) = lower(coalesce((select auth.jwt()) ->> 'email',''))
);
create policy nexus_beta_admin_update on public.nexus_beta_requests
for update to authenticated
using (lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role','')) in ('owner','admin'))
with check (lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role','')) in ('owner','admin'));

-- One event per account/type: lightweight funnel counts without repeat page-view tracking.
create table public.nexus_onboarding_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'invitation_seen',
    'not_now',
    'email_setup_selected',
    'push_setup_selected',
    'pwa_guide_opened',
    'pwa_launched',
    'beta_request_opened',
    'beta_requested'
  )),
  first_recorded_at timestamptz not null default now(),
  primary key(user_id,event_type)
);
alter table public.nexus_onboarding_events enable row level security;
revoke all on public.nexus_onboarding_events from public, anon, authenticated;
grant insert(user_id,event_type) on public.nexus_onboarding_events to authenticated;
grant select on public.nexus_onboarding_events to authenticated;

create policy nexus_onboarding_owner_insert on public.nexus_onboarding_events
for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy nexus_onboarding_admin_read on public.nexus_onboarding_events
for select to authenticated
using (lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role','')) in ('owner','admin'));
