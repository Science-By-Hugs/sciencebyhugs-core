-- Core discount-delete actor verification needs to read auth.users.
-- Hosted Supabase does not expose SELECT on auth.users to service_role.
-- Keep that restriction: execute as the postgres-owned function, after the
-- Edge function authenticates the operator, and verify owner/admin from
-- server-owned auth.users.raw_app_meta_data INSIDE this function.
-- Every call remains service_role-only; public/anon/authenticated cannot run it.
-- The function already pins search_path = '' and qualifies every relation.
alter function public.core_delete_unused_discount_code(uuid,text,uuid)
  security definer;
revoke all on function public.core_delete_unused_discount_code(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.core_delete_unused_discount_code(uuid,text,uuid)
  to service_role;
