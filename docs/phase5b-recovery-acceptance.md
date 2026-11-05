# Phase 5B recovery acceptance — staged, provider-safe

Status: **not activated**. The latest migration \`20261106023000_core_checkout_abandoned_recovery.sql\` adds a **separate** \`recovery_enabled: false\` flag; reservations and deductions also remain off.

## Rules

- A no-payment checkout may release held physical units only after **both** the checkout and the exact unit reservations are at least **90 minutes old**, it was created after the future activation timestamp, the order is still \`submitted/pending\`, and it has **no payment record at all**. The resulting \`checkout_expired\` status is terminal. The existing cancellation trigger returns exactly those units to \`available\`.
- **Do not expire any order that already has a payment row**, including PayPal, Apple Pay, Venmo, Card, Zelle, failed/unknown states, or pending provider creation. Those are held for provider verification or owner review to avoid restoring stock while payment could still complete.
- An order-row locking trigger on \`payments\` serializes payment insertion/update against checkout expiry. A late provider-session write after an order expires is rejected. This does not refund or modify an external PayPal order.
- A paid/verified order keeps its committed physical allocation. Duplicate commit calls do not create new ledger movements. Refunds/returns require explicit audited reconciliation, not automatic restocking.
- \`core_checkout_recovery_health()\` reports **aggregate** held, committed, stale-without-session, provider-needs-review and paid-but-held counts. It is service-role only, with no supplier names, stock lots, QR tokens, individual order/customer IDs.
- \`core_checkout_recover_abandoned(limit,age_minutes)\` is service-role only; at most 25 orders per call, minimum 90 minutes. When either \`reservation_enabled\` or \`recovery_enabled\` is false, it is a **read-only no-op**.

## CI coverage

The PostgreSQL 16 integration suite in \`tests/inventory-multi-db.sql\` creates synthetic Core physical units, reserves checkouts, backdates synthetic timestamps inside a **single rolled-back transaction**, and asserts:

1. Disabled-by-default recovery cannot change a hold.
2. Only sufficiently old, unpaid, no-payment-session checkouts expire.
3. A payment session, regardless of provider, prevents automatic release.
4. Fresh holds remain reserved; retrying recovery does not duplicate anything.
5. Payment attempts written after a checkout expires are rejected.
6. Verified capture commits held units exactly once; refunds and late cancellation cannot auto-restock.
7. Only service-role clients can see recovery health or operate the worker.
8. No existing orders, stock, prices, receipts, payments, QR tokens or historical ledger events change.

## Future activation prerequisites

- Physical counts approved in Core (last production audit showed 0 recorded counts).
- Two authenticated customer sessions and concurrent last-unit checkout test with **real Postgres separate transactions** (CI tests cover SQL locking/idempotency; no real customer charges).
- Staged wallet confirmation (PayPal/Apple Pay/Venmo/Card) + manual Zelle verification.
- Reconciliation alert when \`paid_with_hold\` or \`requires_provider_review\` is positive, with a trusted operator checking provider status.
- A server-side scheduled call (e.g. Supabase Cron using service-role permissions) **only after** separately approving the recovery flag. No job is installed or activated by this migration.
- Document an incident response for "provider captured payment but Core failed to commit" (never silently auto-refund or re-sell allocated items).

## Production go/no-go

\`internal_runtime_config['inventory_checkout']\` must remain:
\`\`\`json
{"reservation_enabled":false,"deduction_enabled":false,"recovery_enabled":false,"activated_at":null}
\`\`\`
until all acceptance criteria are complete and owner explicitly authorizes cutover.

Internal recovery endpoints must remain **absent from Nexus** and inaccessible to customer roles.
