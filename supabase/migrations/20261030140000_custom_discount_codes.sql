-- Custom discount codes and per-customer assignment (2026-10-30).
-- Additive and backward compatible: existing codes, the SBH### generator, Nexus checkout
-- (create-checkout-order) and the discount-code Edge Function keep working unchanged.

-- 1) New columns.
alter table public.discount_codes
  add column if not exists label text,
  add column if not exists assigned_profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists discount_codes_assigned_profile_idx
  on public.discount_codes (assigned_profile_id) where assigned_profile_id is not null;

-- 2) Allow a "custom" kind: either a percent off merchandise or an amount off shipping.
alter table public.discount_codes drop constraint if exists discount_codes_kind_check;
alter table public.discount_codes add constraint discount_codes_kind_check
  check (kind = any (array['free_shipping','referral_bonus','new_customer','group_buy','custom']));

alter table public.discount_codes drop constraint if exists discount_codes_value_check;
alter table public.discount_codes add constraint discount_codes_value_check check (
  (kind = 'free_shipping' and shipping_discount is not null and discount_percent is null)
  or (kind = any (array['referral_bonus','new_customer','group_buy']) and discount_percent is not null and shipping_discount is null)
  or (kind = 'custom' and ((discount_percent is not null) <> (shipping_discount is not null)))
);

alter table public.discount_codes drop constraint if exists discount_codes_amount_range_check;
alter table public.discount_codes add constraint discount_codes_amount_range_check check (
  (discount_percent is null or (discount_percent > 0 and discount_percent <= 100))
  and (shipping_discount is null or (shipping_discount > 0 and shipping_discount <= 1000))
);

alter table public.discount_codes drop constraint if exists discount_codes_label_length_check;
alter table public.discount_codes add constraint discount_codes_label_length_check
  check (label is null or char_length(label) <= 80);

-- 3) Validation used by both the discount-code check and create-checkout-order.
--    Adds: assigned codes only work for their customer; expired codes are refused;
--    custom codes describe themselves with their label.
create or replace function public.evaluate_discount_code(p_code text, p_profile_id uuid, p_subtotal numeric, p_shipping numeric)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare
  d public.discount_codes%rowtype;
  prior_order_exists boolean := false;
  merchandise_discount numeric := 0;
  shipping_discount numeric := 0;
  description text;
begin
  select * into d
  from public.discount_codes
  where lower(code)=lower(trim(p_code))
    and active=true
  limit 1;

  if d.id is null then
    return jsonb_build_object('valid',false,'error','Discount code not found.');
  end if;

  if d.assigned_profile_id is not null and d.assigned_profile_id is distinct from p_profile_id then
    return jsonb_build_object('valid',false,'error','Discount code not found.');
  end if;

  if d.expires_at is not null and d.expires_at <= now() then
    return jsonb_build_object('valid',false,'error','This discount code has expired.');
  end if;

  if d.one_time and d.used_at is not null then
    return jsonb_build_object('valid',false,'error','This discount code has already been used.');
  end if;

  if d.kind='new_customer' then
    select exists(
      select 1 from public.orders o
      where o.customer_id=p_profile_id
        and (
          lower(coalesce(o.payment_status,''))='paid'
          or lower(coalesce(o.status,'')) in ('invoice_requested','processing','ordered','shipped','delivered')
        )
    ) into prior_order_exists;
    if prior_order_exists then
      return jsonb_build_object('valid',false,'error','NewCustomer5 is only available on a customer’s first order.');
    end if;
  end if;

  if d.shipping_discount is not null then
    shipping_discount := least(greatest(coalesce(p_shipping,0),0), coalesce(d.shipping_discount,0));
  else
    merchandise_discount := round(greatest(coalesce(p_subtotal,0),0) * coalesce(d.discount_percent,0) / 100.0, 2);
  end if;

  description := case d.kind
    when 'free_shipping' then 'Free Shipping'
    when 'referral_bonus' then 'Referral Bonus · 10% off'
    when 'new_customer' then 'New Customer · 5% off'
    when 'group_buy' then 'Group Buy · 50% off'
    else coalesce(nullif(trim(d.label),''),
      case when d.discount_percent is not null
        then trim(to_char(d.discount_percent,'FM999990.##')) || '% off'
        else '$' || trim(to_char(d.shipping_discount,'FM999990.00')) || ' off shipping' end)
  end;

  return jsonb_build_object(
    'valid',true,
    'id',d.id,
    'code',d.code,
    'kind',d.kind,
    'oneTime',d.one_time,
    'permanent',d.permanent,
    'discountPercent',d.discount_percent,
    'merchandiseDiscount',merchandise_discount,
    'shippingDiscount',shipping_discount,
    'description',description
  );
end;
$function$;

-- 4) A signed-in customer's own assigned codes that they can still use (Nexus account page).
create or replace function public.my_discount_codes()
 returns table (
   code text,
   description text,
   discount_percent numeric,
   shipping_discount numeric,
   one_time boolean,
   expires_at timestamptz
 )
 language sql
 stable
 security definer
 set search_path to ''
as $function$
  select d.code,
         coalesce(nullif(trim(d.label),''),
           case when d.discount_percent is not null
             then trim(to_char(d.discount_percent,'FM999990.##')) || '% off'
             else '$' || trim(to_char(d.shipping_discount,'FM999990.00')) || ' off shipping' end),
         d.discount_percent,
         d.shipping_discount,
         d.one_time,
         d.expires_at
    from public.discount_codes d
    join public.profiles p on p.id = d.assigned_profile_id
   where p.auth_user_id = auth.uid()
     and d.active = true
     and (d.one_time = false or d.used_at is null)
     and (d.expires_at is null or d.expires_at > now())
   order by d.expires_at nulls last, d.created_at desc;
$function$;

revoke all on function public.my_discount_codes() from public;
revoke all on function public.my_discount_codes() from anon;
grant execute on function public.my_discount_codes() to authenticated;
