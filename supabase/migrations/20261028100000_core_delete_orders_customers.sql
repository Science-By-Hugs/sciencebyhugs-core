-- Core: delete orders and customers (2026-10-28).
-- Decisions (Anthony): any order may be permanently deleted after typing its order
-- number, with a full copy kept in the Audit Log (Finance totals drop it).
-- Deleting a customer removes the profile and their login but KEEPS their orders,
-- which then show as "Deleted customer" using a snapshot stamped on each order.
-- Both functions are service-role only (called by the core-delete-records function).

alter table public.orders add column if not exists deleted_customer jsonb;

create or replace function public.core_delete_order(
  p_order_id uuid,
  p_confirm text,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_expected text;
  v_snapshot jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  v_expected := coalesce(nullif(btrim(v_order.order_number), ''), v_order.id::text);
  if upper(btrim(coalesce(p_confirm, ''))) <> upper(v_expected) then
    raise exception 'Type the order number exactly to confirm' using errcode = '22023';
  end if;

  v_snapshot := jsonb_build_object(
    'order', to_jsonb(v_order),
    'customer', (select jsonb_build_object('id', p.id, 'customer_number', p.customer_number,
                   'first_name', p.first_name, 'last_name', p.last_name, 'email', p.email)
                 from public.profiles p where p.id = v_order.customer_id),
    'items', coalesce((select jsonb_agg(to_jsonb(i)) from public.order_items i where i.order_id = p_order_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(y)) from public.payments y where y.order_id = p_order_id), '[]'::jsonb),
    'item_costs', coalesce((select jsonb_agg(to_jsonb(c)) from public.order_item_costs c where c.order_id = p_order_id), '[]'::jsonb),
    'invoices', coalesce((select jsonb_agg(to_jsonb(v)) from public.invoices v where v.order_id = p_order_id), '[]'::jsonb),
    'invoice_events', coalesce((select jsonb_agg(to_jsonb(e)) from public.invoice_events e
                                join public.invoices v on v.id = e.invoice_id where v.order_id = p_order_id), '[]'::jsonb),
    'discount_codes', coalesce((select jsonb_agg(to_jsonb(d)) from public.discount_codes d where d.used_order_id = p_order_id), '[]'::jsonb),
    'rewards', coalesce((select jsonb_agg(to_jsonb(r)) from public.customer_rewards r
                         where r.reserved_order_id = p_order_id or r.redeemed_order_id = p_order_id), '[]'::jsonb)
  );

  insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id,
                                       before_data, after_data, metadata)
  values (p_actor_user_id, p_actor_email, coalesce(nullif(btrim(p_actor_role), ''), 'admin'),
          'order.delete', 'order', v_order.id::text, v_snapshot, null,
          jsonb_build_object('source', 'core', 'order_number', v_order.order_number,
                             'customer_number', v_snapshot #>> '{customer,customer_number}',
                             'total', v_order.total, 'payment_status', v_order.payment_status));

  -- The order never happened: free a one-time discount code it used.
  update public.discount_codes
     set used_at = null, used_by_profile_id = null, used_order_id = null
   where one_time = true and used_order_id = p_order_id;

  -- Linked invoices go too (their events cascade); copies are in the audit snapshot.
  delete from public.invoices where order_id = p_order_id;

  -- Cascades: order_items, payments, order_item_costs. Rewards/codes keep their row (order link set null).
  delete from public.orders where id = p_order_id;

  return jsonb_build_object('success', true, 'orderId', v_order.id, 'orderNumber', v_order.order_number);
end;
$$;

create or replace function public.core_delete_customer(
  p_customer_id uuid,
  p_confirm text,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_stamp jsonb;
  v_orders integer;
begin
  select * into v_profile from public.profiles where id = p_customer_id for update;
  if not found then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;

  if lower(btrim(coalesce(p_confirm, ''))) <> lower(btrim(v_profile.email)) then
    raise exception 'Type the customer''s email exactly to confirm' using errcode = '22023';
  end if;

  v_stamp := jsonb_build_object(
    'customer_number', v_profile.customer_number,
    'first_name', v_profile.first_name,
    'last_name', v_profile.last_name,
    'email', v_profile.email,
    'phone', v_profile.phone,
    'deleted_at', now()
  );

  -- Keep their orders, labelled with who they were.
  update public.orders set deleted_customer = v_stamp where customer_id = p_customer_id;
  get diagnostics v_orders = row_count;

  insert into public.core_audit_events(actor_user_id, actor_email, actor_role, action, entity_type, entity_id,
                                       before_data, after_data, metadata)
  values (p_actor_user_id, p_actor_email, coalesce(nullif(btrim(p_actor_role), ''), 'admin'),
          'customer.delete', 'profile', v_profile.id::text,
          jsonb_build_object(
            'profile', to_jsonb(v_profile),
            'rewards', coalesce((select jsonb_agg(to_jsonb(r)) from public.customer_rewards r where r.customer_id = p_customer_id), '[]'::jsonb),
            'referrals', coalesce((select jsonb_agg(to_jsonb(x)) from public.referrals x
                                   where x.referrer_id = p_customer_id or x.referred_customer_id = p_customer_id), '[]'::jsonb)
          ),
          null,
          jsonb_build_object('source', 'core', 'customer_number', v_profile.customer_number,
                             'auth_user_id', v_profile.auth_user_id, 'orders_kept', v_orders));

  -- FKs: orders/payments/invoices/referrals/discount_codes -> set null; customer_rewards -> cascade.
  delete from public.profiles where id = p_customer_id;

  return jsonb_build_object('success', true, 'customerId', v_profile.id,
                            'customerNumber', v_profile.customer_number,
                            'authUserId', v_profile.auth_user_id, 'ordersKept', v_orders);
end;
$$;

revoke all on function public.core_delete_order(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.core_delete_customer(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.core_delete_order(uuid, text, uuid, text, text) to service_role;
grant execute on function public.core_delete_customer(uuid, text, uuid, text, text) to service_role;
