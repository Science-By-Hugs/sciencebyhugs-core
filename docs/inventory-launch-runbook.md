# Inventory automation launch and rollback

The production launch enables exact physical reservations, verified-payment
deductions, and conservative abandoned-hold recovery from the migration's UTC
cutover time. Orders created before that cutover remain historical and are never
backfilled.

## Immediate rollback

If monitoring reports a critical alert, stop new automation without changing any
order, payment, allocation, or unit record:

```sql
update public.internal_runtime_config
set value = value || jsonb_build_object(
  'reservation_enabled', false,
  'deduction_enabled', false,
  'recovery_enabled', false
), updated_at = statement_timestamp()
where key = 'inventory_checkout';
```

Keep `activated_at` unchanged so post-cutover records remain identifiable. Then
read `core_inventory_monitor_snapshot()` and reconcile any held allocation before
reenabling a flag. Never manually return a paid or committed unit to available.

## Normal monitoring

- Review Core's **Payments & stock monitoring** panel after launch and after the
  first physical-product checkout.
- The recovery job runs every 15 minutes and only expires unpaid holds at least
  90 minutes old that have no payment record.
- Any checkout with a provider session is excluded from automated recovery and
  requires provider review.
