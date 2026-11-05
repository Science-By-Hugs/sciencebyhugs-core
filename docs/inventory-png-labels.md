# Core inventory: two horizontal thermal-label formats

Core will provide separate PNG exports for the **outer box** and the **vials**, with the owner's Core Innovations thermal label software handling actual printing. No Apple-native printer connection is required.

## Box: one QR per lot

- **1.90 × 0.90 inches** on the **2 × 1-inch horizontal** media, 570 × 270 pixels, 300 DPI.
- A single **lot-level QR** encodes `#inventory?lot=<lot UUID>` on the verified Core host.
- QR opens the **owner/admin-only** Core lot view after authentication. It identifies the lot and its receipt, not an arbitrary single unit.
- Label includes Science By Hugs, product code, and the Core internal lot.
- Existing individual unit QR labels remain available as a collapsed **optional** advanced choice, preserving previous unit traceability.

## Vials: matching the approved mockup

- **1.20 × 0.80 inches**, horizontal, exactly **360 × 240 pixels at 300 DPI**.
- **Pure black and white**, curved border, small centered Science By Hugs header with side rules, large uppercase product title, white strength on a black strip, a verified formulation descriptor, and “FOR RESEARCH USE ONLY” footer.
- **No QR on the vial** in the default design. This preserves the mockup's legibility on small media. Keep vials physically associated with their labeled box; the QR alone does not substitute for chain-of-custody records.
- Product title and strength are suggested from Core's product name if unambiguous, but are **editable and must be verified by the operator**.
- The formulation field remains **blank until verified**, so the system does not invent a powder/liquid presentation or claim an unverified form.
- One vial PNG is downloaded and can be printed as many copies as there are actual labeled vials using Core Innovations printer software. No duplicate lot receipt or new inventory record is created.

## Interface

1. Core → Inventory → Lots & QR labels → **Prepare box + vial PNGs**.
2. Download the **box QR PNG** and print one on the box.
3. Review the **product name, strength and verified formulation**, then click **Generate vial label PNG**.
4. Download the vial PNG and import it into the Core Innovations software. Select **1.2 × 0.8-inch horizontal** media, 100% scale, no auto-stretch.
5. Print one first; inspect text legibility, border clipping, black/white contrast, label adhesion, and QR scanning for the **box**.
6. Print the appropriate copy count for the physical vials in the box. For the current Emlin Retatrutide 20MG lot, owner confirmed 10 physical vials.
7. If needed, expand **Optional: individual unit QR labels** to download the older unit-specific identifiers.

## Production gates

- The Edge Function source now returns an additional `box_qr_svg` from the already-authenticated `labels_for_lot` action. **Deploy the Edge Function change and Core frontend together**. A frontend-only deployment will not support box-level QR PNGs.
- Keep authorization via verified JWT and app metadata owner/admin role before using service-only database access.
- Do not change database schema, inventory counts, retail prices, vendor costs, catalog exposure, checkout, order statuses, or customer notifications.
- Verify both PNGs' pixel dimensions and 300-DPI resolution metadata, verify box QR points to `#inventory?lot=` and requires admin login, and test the printed PNGs on the physical printer.
- The research-use footer is not a substitute for accurate product identification, genuine supplier/manufacturer batch information, or applicable labeling rules.
- Merge/deploy only after CI and owner review.
