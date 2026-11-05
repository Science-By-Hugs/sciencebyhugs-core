# Core ↔ Nexus Phase 5B: staged stock reservation and allocation

## Status: implemented for testing, **disabled in production**
This phase creates a server-only reservation ledger and exact-unit state transitions. The migration **does not enable** reservations/deductions and **does not** touch any existing order, receipt, lot, QR, movement, or inventory unit state.

### Live read-only audit (November 5, 2026)
- 21 historically paid orders, 36 order-item lines; 12 historical lines have no current `product_id`.
- All 21 orders have verified payment records matching their totals; seven have PayPal/Apple Pay capture identifiers.
- No historical line currently references either physically classified SKU.
- Core tracks 20 units: 15 available, 5 damaged, 0 reserved. No recorded physical count audits.
- **Never backfill or retroactively deduct these historical orders.** Future activation has a required `activated_at` cutoff.

### Lifecycle
1. **Future Nexus checkout** creates order and order-item rows, then invokes `core_checkout_reserve_inventory(orderId)` using its existing server-side Supabase secret client. The Postgres function checks **both** the feature flag and activation cutoff, locks product and lot rows, and selects *actual available, unexpired* tracked units with `FOR UPDATE SKIP LOCKED`. The whole RPC transaction rolls back on insufficient stock; no partial holds.
2. Only products explicitly marked `physical` consume tracked stock; `vendor` and `unreviewed` do not. Historical purchases and supplier costs stay intact. Unit states transition `available → reserved` while payment is pending.
3. After a provider-verified payment has marked the order paid, `core_checkout_commit_inventory(orderId)` checks a verified payment record, exact order amount/provider, and capture ID for PayPal, Venmo, Apple Pay, or Card. It transitions *held* units `reserved → allocated` and appends exactly one movement per unit using an idempotent event key. Callbacks may retry safely.
4. An unpaid cancellation/failed payment releases the held units `reserved → available`; a database cancellation trigger runs for Core-originated cancellations as well. Paid or allocated units **never auto-restock** on cancellation or refund—returns require explicit owner review.
5. Core's owner inventory dashboard shows **Available**, **Reserved** (pending), **Allocated** (paid, pending fulfillment), and **Damaged** separately. Nexus's sanitized availability API still receives only a boolean and cannot read unit count, supplier, cost, lot or QR identifiers.

### Default flags
Migration creates `internal_runtime_config[key='inventory_checkout']` with:
```json
{"reservation_enabled":false,"deduction_enabled":false,"activated_at":null}
```
Only a separate owner-approved launch should set `activated_at` and enable flags. The rollout needs owner-confirmed physical counts (the audit found zero records), expired-hold recovery, live staging acceptance for Zelle and wallets, payment duplicate/cancellation tests and alerting for capture/bookkeeping mismatches.

### Security and safety
- `public.inventory_order_allocations` is RLS-enabled and entirely inaccessible to `anon` and `authenticated`. Only server-held service role can run the three RPCs or read the ledger. Helper functions pin `search_path`.
- Unique active-unit index prevents double allocation. Lot and unit locks coordinate with Core Phase 4 stock counting; all writes for a single checkout/commit/release are atomic inside their RPC.
- When flags are off, reservation and commit RPCs are read-only no-ops. Cancelling an unpaid order with an existing hold can still release safely.
- Existing data is preserved; newly added `allocated` state and `allocated` movement reason are not used until a future launch.
- Do **not** turn on production deductions before acceptance and a reconciliation/expiry recovery runbook.

### Integration and verification
Core GitHub CI runs `tests/inventory-multi-db.sql` using PostgreSQL 16 in a database transaction rolled back at the end. It verifies disabled flags, no history modifications, SKU separation, activation cutoff, exact unit selection, duplicate retries, failed oversell rollback, payment verification, paid allocation, unpaid cancellation release, and service-only permissions.
