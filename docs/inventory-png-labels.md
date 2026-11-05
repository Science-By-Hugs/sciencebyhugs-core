# Core Inventory: downloadable PNG labels

## Why

The Core Innovations Shipping Label Thermal Printer does not connect through the owner's Apple printing workflow. Instead of triggering `window.print()`, the owner needs files that can be imported into the printer's own software.

## Label specification

- File format: PNG, one PNG for each inventory unit.
- Content: product code, internal SBH lot, unit ordinal, and the existing **unique per-unit Core QR destination**.
- Physical size: **1.90 × 0.90 inches**, horizontal, inset from standard 2 × 1-inch horizontal media.
- Resolution: **570 × 270 pixels, 300 DPI**; embed PNG `pHYs` resolution metadata.
- Black-and-white, no retail pricing, vendor pricing, secret keys, or customer data.
- Scan destination: existing owner/admin-protected Core unit lookup, unchanged.
- Downloaded locally from the admin session. No changes to QR tokens or inventory records.

## Operator workflow

1. In Core, open **Inventory → Lots & QR labels**.
2. Choose a lot and select **Prepare PNG downloads**.
3. Review the preview and download the PNG for each specific numbered unit.
4. Import the PNG into Core Innovations printer software on a compatible device.
5. Use horizontal **2 × 1 inch media**, center the 1.90 × 0.90-inch image, and avoid cropping, stretching, or automatic enlargement.
6. Print one first, scan it using the phone camera, and verify that the Core owner/admin lookup reports the right product, internal lot, and unit number.
7. Print the remaining numbered files only after the first scan succeeds.

## Release and validation

- Frontend-only change; existing `core-inventory-control` function generates the unchanged QR SVG.
- No SQL migration, Supabase function deployment, catalog, price, checkout, stock, payment, or customer notification changes.
- Verify PNG dimensions and DPI in actual output, Chrome/Safari download behavior, and scanability from the **physical thermal print** before declaring printer acceptance.
- Do not merge and deploy without successful CI and owner review.
