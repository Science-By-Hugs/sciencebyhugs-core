# Core Inventory — Owner Stock Dashboard

## Owner question
Answer in one view: what is physically available, what is damaged/reserved, what needs attention, what is on order, and what it cost.

## Data and definitions
- Available, reserved, damaged and quarantined units are calculated from the current `inventory_units.state` rows, not summed receipts or supplier offers.
- A read-only aggregate runs inside the existing owner/admin-authenticated Core inventory Edge Function. It returns product IDs, unit states and counts only; it does **not** return scan tokens, customer details, or sensitive credentials.
- Pagination of 1,000 units per page protects against the Supabase/PostgREST default row cap. If the maximum scan bound is reached, the UI explicitly marks totals incomplete and suppresses low-stock decisions.
- Products have a supply mode: physical, vendor-supplied, or unreviewed. Vendor pricing is a quote only, never on-hand stock.
- A low-stock flag is shown **only** if physical mode is selected, a positive reorder threshold is configured, and available units are at or below that threshold. Zero means not configured.
- Physical units found under an unreviewed or vendor-supplied classification trigger a classification review.
- Supplier quote shows the **lowest active vendor price per unit excluding shipping/fees**. Landed cost shows the latest finalized lot cost per usable accepted unit, and flags an in-progress cost if a later lot is pending.
- Incoming quantity is from listed open purchase order lines less accepted and damaged receipts. The UI must not promise completeness for paginated purchase history.

## Interface
- Five compact scorecards: Available, Reserved, Damaged, Low stock, Open purchases.
- Search by name, SKU or vendor and filter tracked, full catalog, physical, vendor-supplied, needs attention, low stock.
- Product rows include unit counts, supplier classification, reorder point, vendor quote, last finalized landed cost, incoming quantity.
- 'Supply settings' navigates to the existing product classification/reorder form without writing automatically.
- 'Lot labels' launches the existing PNG label workflow for the most recently recorded lot.
- 'Refresh counts' rereads the authorized inventory endpoint; no purchases, receiving, stock adjustments, checkout, or product price updates are made by viewing.

## Rollout verification
1. Pass Core TypeScript build, existing tests and new dashboard regression tests.
2. Compare exact production counts, especially the two Emlin lots, before and after.
3. Deploy the additive `core-inventory-control` update with JWT verification enabled before deploying the frontend.
4. Merge the frontend after CI; verify GitHub Pages deployment.
5. Owner confirms the dashboard appears in Core Inventory and that filters, 'Supply settings', and 'Lot labels' work.
6. Do not enable Nexus inventory deductions or vendor-stock promises from this dashboard milestone.

## Limitations
- Current catalog list is capped at 250 rows, purchase orders/lines and lots at 100 rows, and receipts at 1,000. The dashboard warns when unit or catalog coverage is incomplete, but the incoming/open purchase history still reflects only the listed records.
- This milestone is monitoring and review; adding manual count corrections, cycle-count reconciliation, vendor order procurement limits and shipping statuses are future steps.