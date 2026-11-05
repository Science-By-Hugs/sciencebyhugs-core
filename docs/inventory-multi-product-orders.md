# Core Phase 2 — Multi-product purchasing and partial receiving

## Purpose
One purchase order per vendor shipment can contain many different product kits, without multiplying shipping or payment fees. Preserve historical Core inventory and Nexus prices.

## Example
- Vendor: Emlin; 10 different products, 1 kit per product, 10 vials per kit = 100 expected vials.
- Freight: $70 for the entire PO, not for each product.
- Default allocation: equal per kit = $7 freight per kit or $0.70 per expected vial.
- Each line keeps the original vendor offer ID, pack size, kit count and price snapshot.
- Receive individual lines in multiple batches: a partly delivered product stays open.

## Allocation and accounting
- Three methods: equal per kit (default), cost proportional, or manual per-line shares.
- Header shipping/fees are stored once. Per-line allocated shipping and fees sum exactly to header totals.
- Remaining-cent rounding prevents negative residuals and ensures penny-exact reconciliation.
- Lot landed cost is provisional (blank) until all expected units on that product line are received.
- Once line receiving completes, its total purchase cost plus allocated shared charges is divided by the accepted usable units, including the expense of damaged units, and the linked lots are finalized.
- Another unreceived product in the same PO does not delay cost finalization for a fully received line.

## Receiving and label generation
- One batch / product line / manufacturer lot per receipt action.
- Each receipt supports 1–100 units including accepted and damaged; subsequent deliveries can have different original lots.
- Each batch generates a new Core lot, individual unit tokens, status and immutable movement history.
- Existing Core box QR and 1.2×0.8-inch vial PNG generator works per resulting lot. Optional unit-level QR remains available.
- Outstanding units stay pending, not silently counted as damaged. Closing a PO short is out of scope.

## Backward compatibility and security
- Remove only the one-line-per-order and one-receipt-per-order unique constraints; all original records remain.
- Add multi_line status, allocation method, per-line charges, nullable receipt purchase-line link, cost_finalized flag.
- Backfill existing receipt purchase-line links without changing old received quantities or costs.
- Legacy single-line create/receipt database RPCs remain unchanged.
- New SQL RPCs are executable only by service_role; the Core Edge Function checks the authenticated owner/admin app role.
- No changes to Nexus checkout availability, published retail prices, payments, or notifications.

## Production rollout sequence
1. Apply migration first; verify existing Emlin orders, lots, stock and QR identifiers before/after.
2. Audit RPC EXECUTE grants and RLS; confirm legacy functions still work.
3. Deploy matching inventory Edge Function with JWT verification enabled.
4. Deploy Core frontend only once schema and API are ready.
5. Test multi-order allocation in nonproduction, or with genuine purchases only in production.
6. Verify line-by-line receiving, exact allocation totals and unchanged existing stock.
7. Print/scan a QR and small PNG label after the first real multi-product receipt.

## Limits
- Maximum 25 different vendor offerings per order, 1,000 kits per line, 10,000 expected vials total.
- Maximum 100 accepted/damaged units per receipt batch.
- API listing remains bounded (100 purchase orders, 100 lines, 1,000 receipts, 100 lots). Pagination is a later milestone.
- Do not merge or deploy until CI is green and SQL rollout reviewed.