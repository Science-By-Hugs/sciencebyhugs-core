-- Nine-stage order workflow: Submitted -> Processing -> Ordered -> Shipped
-- -> Out for Delivery -> Delivered; exceptions: On Hold, Delayed, Cancelled.
-- Legacy checkout_pending, pending and checkout_error rows are intentionally preserved.
-- Deploy the compatible Nexus/Core application functions before writing new 'submitted' orders.
alter table public.orders alter column status set default 'submitted';

-- Permit clearing unpaid submitted checkouts as well as legacy checkout_pending orders.
CREATE OR REPLACE FUNCTION public.clear_checkout_pending_orders(p_order_id uuid DEFAULT NULL::uuid, p_actor_user_id uuid DEFAULT NULL::uuid, p_actor_email text DEFAULT NULL::text, p_actor_role text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_ids uuid[];
  v_count integer := 0;
begin
  select array_agg(o.id)
  into v_ids
  from public.orders o
  where lower(trim(o.status)) in ('checkout_pending', 'submitted')
    and lower(coalesce(o.payment_status,'')) <> 'paid'
    and (p_order_id is null or o.id=p_order_id);

  if v_ids is null or array_length(v_ids,1) is null then
    return jsonb_build_object('success',true,'deleted',0,'orderIds','[]'::jsonb);
  end if;

  insert into public.core_audit_events(
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,before_data,after_data,metadata
  )
  select
    p_actor_user_id,
    p_actor_email,
    coalesce(nullif(trim(p_actor_role),''),'admin'),
    'order.checkout_pending.clear',
    'order',
    o.id::text,
    jsonb_build_object(
      'status',o.status,
      'payment_status',o.payment_status,
      'payment_method',o.payment_method,
      'total',o.total,
      'discount_code',o.discount_code
    ),
    null,
    jsonb_build_object('source','core','bulk',p_order_id is null)
  from public.orders o
  where o.id=any(v_ids);

  update public.discount_codes
  set used_at=null,
      used_by_profile_id=null,
      used_order_id=null
  where one_time=true
    and used_order_id=any(v_ids);

  delete from public.invoices
  where order_id=any(v_ids)
    and lower(coalesce(status,''))='direct_checkout'
    and paid_at is null;

  delete from public.orders
  where id=any(v_ids);

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'success',true,
    'deleted',v_count,
    'orderIds',to_jsonb(v_ids)
  );
end;
$function$


-- Keep push notifications aligned with the new statuses; payment updates remain separate.
CREATE OR REPLACE FUNCTION private.order_push_customer_body(op text, old_status text, new_status text, old_payment text, new_payment text, old_eta date, new_eta date, order_number text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  label text := case when coalesce(order_number, '') <> '' then 'Order ' || order_number else 'Your order' end;
  internal_statuses text[] := array['checkout_pending', 'checkout_error', 'submitted'];
begin
  if op = 'INSERT' then
    -- Checkout creates the order before payment; customers hear about it once paid.
    if new_status = any(internal_statuses) then return null; end if;
    return 'We received ' || lower(left(label, 1)) || substr(label, 2) || '. Open NEXUS for details.';
  end if;

  -- Payment milestones (internal *_pending steps are silent).
  if new_payment is distinct from old_payment then
    if new_payment = 'paid' then
      return 'Payment received — ' || lower(left(label, 1)) || substr(label, 2) || ' is confirmed.';
    elsif new_payment = 'refunded' then
      return 'Your refund for ' || lower(left(label, 1)) || substr(label, 2) || ' has been issued.';
    elsif new_payment = 'failed' then
      return 'Payment for ' || lower(left(label, 1)) || substr(label, 2) || ' did not go through. Open NEXUS to try again.';
    end if;
  end if;

  -- Fulfillment milestones.
  if new_status is distinct from old_status and not (new_status = any(internal_statuses)) then
    -- checkout_pending -> processing happens together with payment; already covered above.
    if old_status in ('checkout_pending', 'submitted') and new_status = 'processing' then return null; end if;
    return case new_status
      when 'processing' then label || ' is being prepared.'
      when 'ordered' then label || ' has been ordered.'
      when 'shipped' then label || ' is marked as shipped.'
      when 'out_for_delivery' then label || ' is out for delivery.'
      when 'on_hold' then label || ' is on hold.'
      when 'delayed' then label || ' is delayed.'
      when 'delivered' then label || ' has been delivered.'
      when 'cancelled' then label || ' has been cancelled.'
      else label || ' was updated. Open NEXUS for details.'
    end;
  end if;

  if new_eta is distinct from old_eta then
    return case when new_eta is null
      then label || ' has a new delivery estimate coming. Check NEXUS for details.'
      else label || ' is now expected ' || to_char(new_eta, 'Mon FMDD') || '.' end;
  end if;

  return null;
end;
$function$


-- Orders are submitted first. Processing is payment-gated for all write paths.
-- A paid flag alone is insufficient; the linked payment must be verified.
create or replace function private.guard_order_processing_requires_payment()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if lower(trim(new.status)) = 'processing' and
     (tg_op = 'INSERT' or old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
    if lower(coalesce(new.payment_status, '')) <> 'paid'
       or not exists (
          select 1 from public.payments p
          where p.order_id = new.id
            and p.status = 'verified'
            and p.verified_at is not null
       ) then
      raise exception 'Payment must be verified before the order enters Processing';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists orders_processing_payment_guard on public.orders;
create trigger orders_processing_payment_guard
before insert or update of status, payment_status on public.orders
for each row execute function private.guard_order_processing_requires_payment();
