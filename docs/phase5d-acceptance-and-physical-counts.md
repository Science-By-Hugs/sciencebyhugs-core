# Phase 5D — Safe checkout acceptance and activation gate

Status: **NOT READY FOR LIVE STOCK DEDUCTIONS**. Production checkout reservation, deduction, and recovery feature flags remain OFF; `activated_at` is null. Never enable from this document or an automated test.

## What was tested without production data writes

Production inspection (SELECT-only) on November 5, 2026, America/Los_Angeles:
- 21 orders, 21 payment records, 20 tracked units (15 available / 5 damaged), 20 historical movements, 0 inventory checkout allocations and 0 physical-count audits.
- 1 historical paid order lacks an order-level `paid_at` timestamp; 12 historical order items have an unmapped or null product reference. Both must stay out of automatic retroactive deductions.
- Inventory grants: anonymous and authenticated customers cannot directly reserve, commit, recover or monitor stock, or query the allocation ledger / supplier columns.
- Two lots need actual physical verification. No existing count audit is `matched` or `resolved`.
- Cloud catalog request was intermittently unavailable (HTTP 503 on one probe, followed by HTTP 200). Successful reply had 85 RLS-permitted products, 84 with `available:true`, and **no vendor, unit, quantity, lot or QR fields**. This warrants endpoint error-rate monitoring and an appropriate reliability review before activation.
- The database contains **118 active unreviewed products** manually set to Available, 2 active vendor-mode products manually Available, and 3 active physical-mode products listed Available. A manual flag is not proof of real supplier stock. Classification and availability promise need review before a full automated stock launch.
- Two tracked lots have no recorded expiration date. Confirm their underlying labels/documents in Core; do not infer shelf life from missing data.

Existing tests (already passing on Core and Nexus main):
- Core CI PostgreSQL 16 transactional fixture: disabled flags, no historical backfill, damaged-unit exclusion, product supply-mode separation, exact unit reservations, atomic shortage failure, duplicate reservation, verified payment commits only after matching provider/capture, duplicate callback, cancelling unpaid holds, no automatic restock of paid allocations, staged recovery expiry, retention of any payment-session order, and owner-only monitoring.
- Dedicated **two separate PostgreSQL sessions** compete for the same last physical-stock balance; exactly one order succeeds, the other fails without overselling.
- Nexus CI: server-only checkout reservation calls, post-capture stock commit hooks, no supplier/stock-count fields exposed in browser, normal build and security checks.
- This PR adds more regression tests on synthetic rollback-only data: mismatched payment amount, wrong payment provider, missing wallet capture ID, unmapped future item, failed payment leaves unit held, valid payment commits exactly once, and recovery flag stays independently disabled.

## Owner steps — actual physical count, not a simulated database test

Open [Core Inventory](https://core.sciencebyhugs.com/#inventory), sign in with your authorized Core owner account, and locate **Physical stock reconciliation**.

1. Choose **RETATRUTIDE 20MG · SBH-261105-EM-0001** (Core currently expects **10 usable, 0 damaged**). Inspect that specific labeled lot, including the box QR and vial identity. Physically count **usable vials** and **damaged vials** separately. Type the *actual* numbers in **Usable vials physically present** and **Damaged vials physically present**—do not simply accept prefilled counts unless independently verified. Add a note with storage location and who counted. Select **Save physical count**.
2. Choose **GHK-CU 50MG · SBH-261105-EM-0002** (expects **5 usable, 5 damaged**). Repeat the physical separation, count, notes, and **Save physical count**.
3. For a matching count, confirm the lot's **Previous counts for this lot** history says `matched`. Matching counts do **not** alter stock.
4. For a mismatch, the saved count is `pending`. Investigate before changing anything. If there are missing vials, you must be able to identify their **specific numbered unit IDs**, select the exact missing identifiers for each category, read the confirmation, and only then click **Confirm missing units**; this records an audited correction. If you cannot identify specific missing units, **leave pending**. If physical counts are greater than recorded, investigate receipts or supplier lot records; Core intentionally will not invent units.
5. Confirm the owner **Payments & stock monitoring** panel no longer flags unverified physical counts or pending reconciliations. If a lot is a test/example record rather than actual stock, do **not** treat those quantities as physical inventory.

Never bulk-edit existing orders/payments or enable stock automation to get a green count.

## What automated tests cannot prove

- These tests do not perform live external PayPal, Venmo, Apple Pay or Card charges; real payment authorization, 3-D Secure, refund and settlement behavior remains unverified for stock activation.
- They do not authenticate as two real customer accounts to perform end-to-end cross-account isolation, nor emulate Apple/Android device payment sheets.
- Core's read-only monitoring counts are **post-activation scoped**; zero current alerts does not certify all historical records.
- No production expired checkout cleanup job runs yet, and all three stock automation flags remain disabled.
- The two physical counts and any receipt corrections can only be established by the owner inspecting the actual stock.
- A prior catalog 503 remains an availability/reliability warning even though a repeat request succeeded.

## Activation gate

Explicit owner approval is necessary only **after** physical count history is `matched`/`resolved` for every active stocked lot, available products are correctly classified, provider sandbox testing passes, monitoring/reporting and manual incident runbook are accepted, and any catalog availability errors are investigated. Schedule recovery only after that separate controlled approval; no automatic activation during testing.

Suggested readiness state: **BLOCKED** on physical counts; **NOT VERIFIED** for real-provider end-to-end tests and catalog reliability. Database isolation and synthetic concurrency/payment tests are **PASS** when the PR CI is green.
