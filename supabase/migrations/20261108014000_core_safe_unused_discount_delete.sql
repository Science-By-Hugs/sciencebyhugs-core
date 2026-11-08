-- Atomic, audited removal of an unused, inactive promotional code.
-- This is a *service-role only* RPC called by the owner/admin-authenticated Core
-- edge function. It is deliberately NOT exposed to anon/authenticated clients.
-- Orders and invoices are read only. Reusable redemptions referenced only by
-- order/invoice text are protected as well as one-time used_at markers.
create or replace function public.core_delete_unused_discount_code(
  p_id uuid, p_confirm_code text, p_actor_user_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  d public.discount_codes%rowtype;
  verified_email text;
  verified_role text;
begin
  -- Recheck actor role from server-owned app_metadata rather than trusting
  -- any actor/email/role fields supplied by the browser.
  select u.email, lower(u.raw_app_meta_data->>'role')
    into verified_email, verified_role
  from auth.users u
  where u.id = p_actor_user_id;

  if verified_role is null or verified_role not in ('owner','admin') then
    return jsonb_build_object('success',false,'error','Core administrator access required.');
  end if;

  -- Serialize against same-code updates and FK-based checkout order/invoice
  -- references. If an order already references the code, refuse deletion.
  select * into d from public.discount_codes where id = p_id for update;
  if d.id is null then
    return jsonb_build_object('success',false,'error','Discount code not found.');
  end if;
  if p_confirm_code is distinct from d.code then
    return jsonb_build_object('success',false,'error','Type the exact code to confirm deletion.');
  end if;
  if d.permanent or d.kind not in ('custom','free_shipping','referral_bonus') then
    return jsonb_build_object('success',false,'error','Built-in or protected codes cannot be deleted.');
  end if;
  if d.active then
    return jsonb_build_object('success',false,'error','Turn off this code before deleting it.');
  end if;
  if d.used_at is not null or d.used_by_profile_id is not null or d.used_order_id is not null then
    return jsonb_build_object('success',false,'error','Redeemed codes cannot be deleted. Their history must be preserved.');
  end if;
  if exists (
    select 1 from public.orders o
    where o.discount_code_id = d.id
      or lower(btrim(coalesce(o.discount_code,''))) = lower(btrim(d.code))
  ) or exists (
    select 1 from public.invoices i
    where i.discount_code_id = d.id
      or lower(btrim(coalesce(i.discount_code,''))) = lower(btrim(d.code))
  ) then
    return jsonb_build_object('success',false,
      'error','This code appears on an order or invoice and cannot be deleted. Turn it off instead.');
  end if;

  -- Same database transaction: failure of the audit insert OR of the delete
  -- prevents both from committing. The deleted row remains in audit history.
  insert into public.core_audit_events (
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,
    before_data,after_data,metadata
  ) values (
    p_actor_user_id,verified_email,verified_role,
    'admin.discount_code.delete','discount_code',d.id::text,
    to_jsonb(d),
    jsonb_build_object('deleted',true),
    jsonb_build_object('source','core','permanent_delete',true,'unused',true)
  );

  delete from public.discount_codes where id=d.id;
  if not found then
    raise exception 'Discount code deletion was not completed';
  end if;

  return jsonb_build_object('success',true,'deleted',jsonb_build_object('id',d.id,'code',d.code));
end;
$function$;
revoke all on function public.core_delete_unused_discount_code(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.core_delete_unused_discount_code(uuid,text,uuid)
  to service_role;
