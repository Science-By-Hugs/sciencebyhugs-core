\set ON_ERROR_STOP on
-- Isolated temporary CI database. The entire migration and assertions roll back.
-- No real orders or notifications are produced.
begin;
create role anon;
create role authenticated;
create schema private;
\i supabase/migrations/20261107192500_core_order_push_quiet_notifications.sql

do $core_push$
begin
  if private.core_order_push_kind('INSERT',null,'pending') <> 'new_order' then
    raise exception 'New order alert not identified'; end if;
  if private.core_order_push_kind('UPDATE','pending','submitted') <> 'payment_review' then
    raise exception 'Submitted payment review alert not identified'; end if;
  if private.core_order_push_kind('UPDATE','submitted','paid') is not null then
    raise exception 'Verification step still sends redundant CORE push'; end if;
  if private.core_order_push_kind('UPDATE','pending','paid') is not null then
    raise exception 'Automatic pending to paid transition still alerts'; end if;
  if private.core_order_push_kind('UPDATE','paid','pending') is not null then
    raise exception 'Routine status reversal still alerts'; end if;
  if private.core_order_push_kind('UPDATE','submitted','submitted') is not null then
    raise exception 'Unchanged submitted payment still alerts'; end if;
  if private.core_order_push_kind('UPDATE','paid','paid') is not null then
    raise exception 'No-op update still alerts'; end if;
  if private.core_order_push_kind('UPDATE',null,'processing') is not null then
    raise exception 'Fulfillment status incorrectly queues CORE push'; end if;
  if not pg_get_functiondef('private.queue_order_push()'::regprocedure)
    like '%private.order_push_customer_body%' then
    raise exception 'Nexus customer push routing was removed'; end if;
  if not pg_get_functiondef('private.queue_order_push()'::regprocedure)
    like '%on conflict (event_key,user_id,app) do nothing%' then
    raise exception 'Per-order duplicate rejection missing'; end if;
  if has_function_privilege('anon','private.core_order_push_kind(text,text,text)','EXECUTE') then
    raise exception 'Anonymous role can execute protected helper'; end if;
end $core_push$;
rollback;
