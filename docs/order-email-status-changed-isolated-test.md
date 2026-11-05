# Nexus Order Status Changed — isolated dry-run fixture

**Scenario:** Simulate an order progressing from `processing` to `delivered`. This is a **synthetic** event only: it is not an actual order transition and must not update any row in `public.orders` or insert into the live email outbox.

## Fixture

| Field | Value |
| --- | --- |
| Event | `status_changed` |
| Previous status (scenario narrative) | `processing` |
| Current status (synthetic event) | `delivered` |
| Order reference | `SBH-TEST-STATUS-001` |
| Display name | `Test Customer` |
| Mock recipient | `safe-test@example.invalid` (not deliverable) |
| Environment | Isolated GitHub Actions Node test with mocked Postgres and mocked Brevo fetch |
| Global queue in the simulated dispatcher | `false` |
| Scoped test mode in the simulated dispatcher | `true` |
| Simulated email send flag | `true` **only inside the mock runtime**, not in Supabase |

The owner-designated future real test recipient is known to the operator and has been verified in Nexus, but their personal email address, account UUID, order UUID, tokens, and provider credentials are **not** copied into source control.

## Expected message

- Subject: `[TEST] Order SBH-TEST-STATUS-001: delivered`
- Greeting: `Hi Test Customer,`
- Body: `Your order is now delivered. Sign in to Nexus to review the details.`
- Call to action: **Open Nexus** linking to `https://nexus.sciencebyhugs.com`
- Footer: user-managed optional email preferences under Account → Notifications; no promotional or product-specific content

## What the regression suite checks

- Uses the **real** `composeOrderEmail` module, not a placeholder HTML body.
- Executes the currently implemented dispatcher with **mocked database and HTTP provider**; neither network requests nor production data writes are possible in the test harness.
- Confirms a single simulated Brevo acceptance with the correct recipient and HTML, and a second invocation makes zero additional provider calls.
- Confirms the one-message scope excludes mismatched user IDs and outbox IDs, missing IDs fail closed, and test mode rejects a globally enabled queue.
- Retains existing checks for opt-out, missing auth, transient HTTP errors and ambiguous network results.

## Boundary between this dry run and a real send

This preparation **does not send an email**, enable a production queue, set Edge Function secrets, install a cron job, or change a customer order. The live dispatcher uses an order-linked outbox row and separately configured private test IDs; that is **not** created here.

Before any real single-recipient test, a reviewer must choose an isolated, auditable approach that does not misrepresent a real order change, confirm secure access to Edge secrets and invocation, verify the account and consent again, and obtain an explicit send approval. The global production queue must remain off. A successful simulated provider response is not evidence of inbox delivery.
