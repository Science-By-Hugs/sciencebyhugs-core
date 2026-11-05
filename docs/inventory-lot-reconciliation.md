# Core Inventory Phase 4 — Physical lot reconciliation

## Owner workflow
1. Scan a Core box/lot QR and sign in with owner/admin access, or open Inventory → Physical stock reconciliation and select a lot.
2. Compare the number of usable vials physically present and separately the number of damaged vials physically present with Core's recorded unit states.
3. Save a physical count with optional evidence notes (location, box condition, who counted). **Saving an audit never adjusts stock.**
4. If counts match, Core records a `matched` audit without inventory movements.
5. If counts differ, an audit with `pending` status records the discrepancy. Leave it pending while investigating supplier lots, unlabelled items, physical custody and unit identifiers.
6. If a **shortage** is verified AND the specific missing tracked units can be identified, select their unit ordinals, explicitly acknowledge the correction, and confirm. The database atomically marks those chosen units `missing` and appends one adjustment movement per unit.
7. If an **extra vial** is counted, keep it pending: Core never fabricates lot receipts, unit IDs or QR codes. Investigate the supplier batch and receipt source first.

## Core safeguards
- The count compares `available` and `damaged` states independently; reserved, quarantined, returned and shipped states must be reviewed separately.
- An audit records snapshot expected/current counts, actual counted quantities, notes, created actor/time, reconciliation actor/time, resolved unit IDs and status.
- Each auditable change locks the lot, checks the unit states have not changed since the count, and requires an exact selection of missing available/damaged IDs.
- Only the owner/admin authenticated Edge Function can call service-role-only database RPCs. Anonymous or other signed-in roles have no direct table/RPC access.
- Original supplier lot, purchase order, receipt quantities, landed unit costs, and QR token identities do not change.
- `inventory_movements` stays append-only with a unique idempotent key per stock count/unit. Replay does not double-adjust inventory.
- Prior recorded damaged units marked missing receive quantity_delta 0 (not an additional -1). Available units marked missing receive -1.
- Stock supplier offerings and Nexus checkout availability are not affected.
- Existing label printing and individual unit QR workflows are unchanged.

## Acceptance tests
- Migrations and reconciliation RPCs run in ephemeral Postgres 16 CI with seeded pre-existing inventory.
- Matching count has no movements; pending count has no stock changes; retrying an audit or resolution changes nothing; resolved shortage changes only selected units; surplus rejected; RLS/RPC grants verified.
- Production migration must be applied **before** the Edge Function and Core frontend.
- Before and after production deployment, verify the two original Emlin lots and counts; do not submit fictional reconciliation evidence into production.
- Owner then tests a real box QR, matching count, and, only if a real shortage exists, its confirmed correction.

## Limits
- Up to 100 tracked units per lot in the count review (receipt batch cap).
- Scanning the box-level QR identifies a **lot**, not individual vial IDs. If the vial labels are QR-free and missing unit identities cannot be determined, record the discrepancy and leave it pending instead of arbitrarily marking unit IDs missing.
- A missing state is not a disposal or sale record. Disposal, transfers, returns, and lot-level reconciliation without unique unit identification require additional workflows.