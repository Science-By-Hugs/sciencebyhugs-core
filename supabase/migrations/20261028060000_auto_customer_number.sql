-- Auto-assign customer numbers (2026-10-27).
-- Root cause: private.link_profile_for_new_auth_user() creates a profile on Nexus
-- signup but never set customer_number (numbers used to come from the Google-era
-- import), so every signup since then had none. This assigns the next SBH-#### to
-- ANY new profile with a blank number (Nexus signup, Core "New customer", anything),
-- and backfills the profiles that are missing one. Numbers are never reused.

create or replace function private.next_customer_number()
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_next integer;
begin
  -- Serialize assignment so two simultaneous signups can't get the same number.
  perform pg_advisory_xact_lock(hashtext('public.profiles.customer_number'));
  select coalesce(max((substring(p.customer_number from '^SBH-(\d+)$'))::integer), 0) + 1
    into v_next
  from public.profiles p
  where p.customer_number ~ '^SBH-\d+$';
  return 'SBH-' || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end;
end;
$$;

revoke all on function private.next_customer_number() from public, anon, authenticated;

create or replace function private.profiles_assign_customer_number()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.customer_number is null or btrim(new.customer_number) = '' then
    new.customer_number := private.next_customer_number();
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_assign_customer_number on public.profiles;
create trigger profiles_assign_customer_number
  before insert on public.profiles
  for each row execute function private.profiles_assign_customer_number();

-- Backfill, oldest first.
do $$
declare
  r record;
begin
  for r in
    select id from public.profiles
    where customer_number is null or btrim(customer_number) = ''
    order by created_at, id
  loop
    update public.profiles
      set customer_number = private.next_customer_number()
      where id = r.id;
  end loop;
end;
$$;
