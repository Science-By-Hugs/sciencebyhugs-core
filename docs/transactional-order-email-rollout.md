# Step 4 — Optional transactional email via Brevo

## Goal
Send **non-promotional** order-status and local-delivery updates to customers who opted in under Nexus → Account → Notifications. This is **not** the marketing newsletter flow. Push notifications remain independent and unchanged.

## Verified configuration and deployment status (November 2026)
- Brevo account has an active sender: `marketing@sciencebyhugs.com` (sender name: `Sciencebyhugs.com`).
- Brevo transactional SMTP relay is enabled. One previous controlled order-email smoke test was delivered to the owner and is recorded as `sent` (Brevo accepted it); this is **not** an automated customer rollout.
- Shared Supabase contains `public.customer_notification_preferences`; opt-in defaults to false and has RLS.
- `public.orders` stores `status`, `estimated_delivery_date`, `order_number`, `customer_id`; `public.profiles.auth_user_id` maps customers to sign-in accounts.
- Existing order push trigger, service worker, and push cron are preserved.

## Implemented components
- `private.order_email_settings`, with `queue_enabled=false` by default. A migration adds the outbox and trigger, but **never begins queueing until explicitly switched on**.
- `private.order_email_outbox` records one event per qualifying order insert/change for signed-in active customers who enabled optional emails, without storing recipient email or product details.
- `order-email-dispatch` Edge Function, secured by a long private token and **`ORDER_EMAIL_SEND_ENABLED=false` by default**. It checks current preferences, active profile, verified auth email, and order ownership before sending.
- Inline, neutral HTML email template for received orders, status changes, and local delivery-date changes. Uses only the verified brand URL and plain typography.
- Brevo API integration `POST https://api.brevo.com/v3/smtp/email`. Records `messageId` when accepted. Defers transient HTTP errors with limited retries; ambiguous network outcomes are held for manual review to avoid uncontrolled duplicates.

## Live readiness snapshot (read-only verification)

- Core email guardrail PR #56 is merged and Core CI passed. The merged tests cover unauthorized calls, the disabled-send switch, disabled queue, recipient suppression, provider acceptance, duplicate processing, retry and ambiguous network outcomes.
- The `order-email-dispatch` Supabase Edge Function is deployed and ACTIVE.
- The shared database has exactly one previously accepted-and-recorded `sent` outbox event, zero pending and zero failed events at the latest inspection. The production queue remains **disabled** and **no email-related cron exists**. These counts are a snapshot, not a promise that they cannot change.
- The customer email preference column defaults to `false`, is protected by RLS, and is editable from Nexus Account → Notifications. A consenting recipient must be identified and reconfirmed before the next real test.
- The order-email message uses `https://nexus.sciencebyhugs.com` (now hosted on Cloudflare Pages). The Apple association file has been verified publicly as valid JSON with `application/json`; launching the native iOS app still requires testing a new signed build on-device.
- Do **not** infer the live `ORDER_EMAIL_SEND_ENABLED` secret value from the presence of an Edge Function or from source code. The database queue being disabled is independently confirmed; do not expose any secret while checking configuration.
- **Status:** Infrastructure and mocked regression tests ready; end-to-end automated customer delivery not activated, and no additional live messages authorized.

## Controlled test acceptance criteria

1. Record the exact approved account and recipient; confirm its verified email address, current opt-in and order ownership.
2. Validate received, status-changed and local-delivery-date-changed subjects and HTML (no product/catalog contents, no promotional material, safe escaping, correct Nexus link).
3. Arrange a technically enforced **single-recipient** scope or isolated environment *before* enabling any queue/send flag. Confirm other recipients cannot be enqueued or sent; otherwise stop.
4. Use one clearly identified test event, and check that only one provider message ID and one `sent` outbox row are recorded. Test opt-out and retry behavior with mocks or isolation before any production-wide activation.
5. Immediately restore `queue_enabled=false` and `ORDER_EMAIL_SEND_ENABLED=false` after the scoped test, with no cron installed. Confirm outbox/dispatch logs; reconcile ambiguous provider responses before further sends.
6. Require a separate explicit owner approval for automatic customer delivery and scheduling.

## SAFE RELEASE PROCESS — separate from code merge
1. Review the PR and verify CI tests.
2. Merge the Core PR; code merges alone do **not** enable email queueing, create cron jobs, or send messages. Deploying Edge Functions and applying migrations remain separate release operations.
3. Apply the `optional_order_email_outbox` migration in shared Supabase. Confirm settings row is **false**, there are no unexpected queued or processing rows, RLS is enabled, and existing push functionality still passes. A prior controlled `sent` row may remain in the outbox.
4. Store these **secret values** in Supabase Edge Function Secrets, never in GitHub or a chat:
   - `BREVO_API_KEY`: a Brevo transactional API key with appropriate authorization.
   - `BREVO_ORDER_SENDER_EMAIL`: `marketing@sciencebyhugs.com` (verified sender, until a dedicated order-sender is verified).
   - `ORDER_EMAIL_DISPATCH_TOKEN`: a unique secret (at least 24 characters) used only for the private cron endpoint.
   - `ORDER_EMAIL_SEND_ENABLED`: `false`.
   - `SUPABASE_DB_URL`: protected server-side database connection URL as used by the existing Core Edge Functions.
5. Deploy `order-email-dispatch` with `verify_jwt=false` as configured in `supabase/config.toml`; the function explicitly validates `x-order-email-token`. Do **not** expose that token to clients.
6. Check a request without a valid token returns HTTP 401. Check an authorized request with disabled sending returns `enabled:false`, `sent:0`; verify **no email was sent**.
7. Review sending costs, Brevo's sender/domain authentication, and the provider's content and acceptable-use requirements.
8. **Separate approval is required to activate customer delivery.** Obtain the exact recipient address and explicit consent. Test the three templates without sending, then prepare a scope-restricted end-to-end test account or isolated test environment. **Do not enable both production-wide flags just to run a test:** the queue switch is global and any opted-in customer with an order event could receive an email. Verify the scope restriction and rollback first.
9. Only after acceptance, schedule a private dispatch cron using `pg_cron` + `pg_net` with its token stored in Supabase Vault. No cron is created or scheduled by this PR. Protect the secret and monitor job results.
10. Run opt-in, opt-out, status-change, duplicate event, declined/invalid address, and iPhone email-render acceptance tests before expanding.

## Operator checks (read-only)
After migration:
```sql
select queue_enabled from private.order_email_settings where singleton;
select state, count(*) from private.order_email_outbox group by state;
```

## Notes
- A `sent` row means Brevo **accepted** the request and returned a messageId; it does not prove delivery to an inbox.
- Provider retries are bounded. On ambiguous network failures, a row becomes failed and requires human reconciliation in Brevo.
- Delivery preferences can change after a queued event; the worker suppresses the message when the customer has opted out.
- Only actual order events trigger these optional emails; onboarding clicks or marketing consent never do.
- This phase does not send TestFlight invitations or SMS.
