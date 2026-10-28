-- Google exit (2026-10-27): assign order numbers in Supabase (same format as the
-- legacy Google numbers: INITIALS + 4-digit counter). Applied to production 2026-10-27.
-- Idempotent: returns the existing number if the order already has one.
create or replace function public.assign_order_number(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing text;
  v_first text;
  v_last text;
  v_prefix text;
  v_max int;
  v_number text;
begin
  select o.order_number, coalesce(p.first_name,''), coalesce(p.last_name,'')
    into v_existing, v_first, v_last
  from orders o
  left join profiles p on p.id = o.customer_id
  where o.id = p_order_id
  for update of o;

  if not found then
    raise exception 'Order % not found', p_order_id;
  end if;

  if v_existing is not null and v_existing <> '' then
    return v_existing;
  end if;

  v_prefix := rpad(left(upper(regexp_replace(v_first, '[^A-Za-z]', '', 'g')), 2), 2, 'X')
           || rpad(left(upper(regexp_replace(v_last,  '[^A-Za-z]', '', 'g')), 2), 2, 'X');

  perform pg_advisory_xact_lock(hashtext('order_number:' || v_prefix));

  select coalesce(max((regexp_match(n, '^' || v_prefix || '([0-9]+)$'))[1]::int), 0)
    into v_max
  from (
    select order_number as n from orders where order_number like v_prefix || '%'
    union all
    select invoice_number from invoices where invoice_number like v_prefix || '%'
  ) s;

  v_number := v_prefix || lpad((v_max + 1)::text, 4, '0');

  update orders set order_number = v_number, updated_at = now() where id = p_order_id;
  return v_number;
end;
$$;

revoke all on function public.assign_order_number(uuid) from public, anon, authenticated;
grant execute on function public.assign_order_number(uuid) to service_role;

-- Rollback: drop function if exists public.assign_order_number(uuid);
