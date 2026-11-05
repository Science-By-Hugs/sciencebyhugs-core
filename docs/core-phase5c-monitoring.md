# Core Phase 5C — Owner-only payment and inventory monitoring

**Scope:** Live, read-only operational monitoring in the authenticated Core Inventory page. This phase does **not** turn on reservations, deductions, recovery, refund processing, cron, or customer notifications.

## Source of truth and protection

- Existing Core JWT owner role from `app_metadata.role` is checked by the Core inventory Edge Function, then the server-held secret invokes `core_inventory_monitor_snapshot()`.
- The SQL snapshot function is `STABLE`, service-role-only and has `REVOKE EXECUTE` on `PUBLIC`, `anon` and `authenticated`. Product/vendor costs, individual unit QR/lot details, customer contact information and payment credentials never appear in its response.
- Only the Core owner sees the monitor; Core admins can still use other inventory tools but are denied the monitor action.
- The page renders plain text with `textContent`, not injected HTML, with a manual **Refresh alerts** button and last-checked timestamp.

## What it checks

- **Critical: paid stock gap** — a future cutover-eligible, paid Nexus checkout contains physical products but does not have the corresponding committed unit allocations after a two-minute reconciliation grace period.
- **Critical: payment verification mismatch** — the paid order has physical products, but lacks a matching verified payment by amount, provider, owner and (for PayPal, Venmo, Apple Pay and Card) a capture identifier.
- **Critical: unit state conflict** — an allocation marked held no longer has a reserved unit, or a committed allocation has neither allocated nor shipped status.
- **Critical: expired checkout still held / released paid stock / reserved unit without active order.**
- **Review: stale checkout with no payment session** — held longer than 90 minutes, eligible for future gated recovery.
- **Review: stale checkout with a payment record** — must be manually/provider verified before release; never automatically return those units to sale.
- **Launch readiness:** physical lots without verified stock-count audits; unresolved count discrepancies.

The alerts intentionally examine only checkout orders created at or after the owner-approved `activated_at` timestamp. Current historical paid orders are **not** treated as missed deductions. If that timestamp remains null, there can be no new paid-stock-gap alerts; current count-readiness remains visible.

## What the dashboard does not do

No auto-fix, stock deduction, refund, payment capture, SMS, push alert, email, or cron job. An empty alert list means **no issues detected by this set of checks**, not a complete guarantee. A failed monitoring request is surfaced as unavailable rather than silently treated as zero alerts.

## Acceptance gates

- PostgreSQL 16 integration test with isolated synthetic future paid/unallocated order, verified mismatch alerts, and transaction rollback.
- Node tests for owner-only authorization, frontend display, safe scopes, and flags.
- Core GitHub CI and production Pages deployment pass.
- Production migration applied with all three automation flags false and active stock/order/payment counts unchanged.
- Read-only live monitoring RPC returns counts and no historical false-positive payment alerts.
- No enabled recovery cron or external notifications.

Manual physical counts and provider payment acceptance still need owner verification before enabling inventory deductions.
