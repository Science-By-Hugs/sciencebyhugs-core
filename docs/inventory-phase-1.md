# Core Inventory — Phase 1 implementation (review branch only)

This branch introduces a separate **Inventory** destination in Core. It is intentionally **not deployed** and does **not** alter Nexus, customer checkout, retail prices, payment verification, order statuses, email dispatch, or live stock availability.

## Delivered in this branch
- Vendor directory (e.g. Emlin and Gigi) and vendor-specific offers for the *same* existing `products.id`.
- Vendor pack prices and quantities (1 unit or 10-unit kit); quote-change history.
- One-product purchase orders, with price/pack-size snapshots and actual inbound freight/fee tracking.
- Transactional full receipt: usable and damaged units, original supplier/manufacturer lot, optional expiry, internal SBH lot, individual unit token and immutable movement entries.
- Landed unit cost computed from **purchase price + actual inbound shipping + fees**, divided by **usable units actually accepted**. Damaged units are traceable but not counted as available.
- Secure QR URLs to Core, separate QR for each physical unit, original lot retained separately.
- Core admin-only inventory screens: Vendors, Price Book, Purchase, Receive, Lots, Reprint, scanned-unit lookup.
- Thermal print CSS: exactly **2 inches wide × 1 inch tall, landscape**, monochrome, no page margins; printed QR as local data-URI SVG. Print **one label per unit** with internal lot, product code and unit ordinal.
- RLS and no client grants on all new tables; dedicated Edge Function validates owner/admin JWT before service-only access.

## Migration / activation gate (NOT applied in this branch)

1. Review migration `supabase/migrations/20261105180000_core_inventory_foundation.sql` with a database administrator.
2. Validate and apply to an isolated/staging database first, never the working Nexus/Core production database as a test.
3. Deploy `core-inventory-control` into staging only; **do not deploy the branch to production**.
4. Verify vendor-offer updates append to quote history and never modify `products.price` or `product_costs.vendor_cost`.
5. Verify double-click/retry/concurrent purchase/receipt creates exactly one set of units.
6. Confirm access denied to anonymous users, regular customers and non-admin authenticated sessions, including direct REST/RPC calls.
7. Test lots and QR on an actual **Core Innovations Shipping Label Thermal Printer**, on 2 × 1 inch horizontal black/white labels. Validate scanability with a phone camera, physical printed size and no clipping.
8. Verify label QR requires an authenticated Core owner/admin session, and scanner lookup never exposes vendor cost to customers.
9. Reconcile physical inventory counts with the warehouse before enabling any Nexus availability/checkout stock logic.
10. Require a separate owner approval for production migration, Edge deployment and Core client deployment.

## Deliberate Phase 1 limitations

- **One product offering per purchase order** and **full receipt only**. Multi-line orders and partial shipment/receipt allocation are subsequent milestones.
- `inventory_product_settings` is created but remains **unreviewed** for existing products. Existing `products.quantity` is text and must **not** be converted into stock.
- No existing 125 products are auto-classified as physical or vendor-supplied. The current shipping source is *not* evidence of the purchasing vendor.
- Existing `product_costs` (125 records) remains an unattributed reference cost, *not* automatically labeled as Gigi's cost.
- Stock data and QR lookups are owner/admin-only; **Nexus still uses existing availability**, without stock decrement/reservations in this milestone.
- No supplier quote, existing retail price, or vendor ID is exposed in a public label.
- This is an internal traceability system, not proof of manufacturing origin or legal sale eligibility. Retain genuine manufacturer batch records and comply with applicable product rules.

## Phase 2 backlog

- Purchase orders with multiple lines and shared freight allocation; partial receipts.
- Physical-vendor inventory classification and reconciliation workflow.
- Stock movements for pick, dispatch, returns, quarantines and cycle counts.
- Transaction-safe reservations tied to verified payment; availability projection to Nexus.
- Vendor-sourced direct fulfillment and staff alerts.
- True source-based cost of goods sold in Finance, without rewriting historical order costs.

### Staging test checklist

- [ ] New 10-unit kit offer → purchase 2 packs → expect exactly 20 units.
- [ ] Receive 19 usable + 1 damaged: 19 accepted inventory units; 1 damaged unit; 20 labels; landed cost allocated across 19 accepted units.
- [ ] Retry receiving same request ID → no additional units.
- [ ] Concurrent receipt with different request ID → one succeeds, one cannot duplicate.
- [ ] Updated vendor kit price → new quote snapshot; previously received cost remains unchanged.
- [ ] Gigi single-vial and Emlin kit offers coexist under one Core product, Nexus retail price unchanged.
- [ ] Print 2 × 1 inch label with 20-character lot; scan unique QR, login required, correct unit/lot lookup.
- [ ] No change to current order email processing or delivery-stage suppression.
