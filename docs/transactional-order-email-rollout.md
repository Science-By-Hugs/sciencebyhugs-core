# Step 4 — Optional transactional email via Brevo

## Goal
Send **non-promotional** order-status and local-delivery updates to customers who opted in under Nexus → Account → Notifications. This is **not** the marketing newsletter flow. Push notifications remain independent and unchanged.

## Verified on November 4, 2026
- Brevo account has an active sender: `marketing@sciencebyhugs.com` (sender name: `Sciencebyhugs.com`).
- Brevo account exposes a transactional SMTP relay; a live-send smoke test has **not** been run.
- Shared Supabase contains `public.customer_notification_preferences`; opt-in defaults to false and has RLS.
- `public.orders` stores `status`, `estimated_delivery_date`, `order_number`, `customer_id`; `public.profiles.auth_user_id` maps customers to sign-in accounts.
- Existing order push trigger, service worker, and push cron are preserved.

## What's staged in this PR
- `private.order_email_settings`, with `queue_enabled=false` by default. A migration adds the outbox and trigger, but **never begins queueing until explicitly switched on**.
- `private.order_email_outbox` records one event per qualifying order insert/change for signed-in active customers who enabled optional emails, without storing recipient email or product details.
- `order-email-dispatch` Edge Function, secured by a long private token and **`ORDER_EMAIL_SEND_ENABLED=false` by default**. It checks current preferences, active profile, verified auth email, and order ownership before sending.
- Inline, neutral HTML email template for received orders, status changes, and local delivery-date changes. Uses only the verified brand URL and plain typography.
- Brevo API integration `POST https://api.brevo.com/v3/smtp/email`. Records `messageId` when accepted. Defers transient HTTP errors with limited retries; ambiguous network outcomes are held for manual review to avoid uncontrolled duplicates.

## SAFE RELEASE PROCESS — separate from code merge
1. Review the PR and verify CI tests.
2. Merge the Core PR; this triggers the existing GitHub Pages deploy, **not** an Edge Function or database migration.
3. Apply the `optional_order_email_outbox` migration in shared Supabase. Confirm settings row is **false**, outbox empty, RLS enabled, and existing push functionality still passes.
4. Store these **secret values** in Supabase Edge Function Secrets, never in GitHub or a chat:
   - `BREVO_API_KEY`: a Brevo transactional API key with appropriate authorization.
   - `BREVO_ORDER_SENDER_EMAIL`: `marketing@sciencebyhugs.com` (verified sender, until a dedicated order-sender is verified).
   - `ORDER_EMAIL_DISPATCH_TOKEN`: a unique secret (at least 24 characters) used only for the private cron endpoint.
   - `ORDER_EMAIL_SEND_ENABLED`: `false`.
   - `SUPABASE_DB_URL`: protected server-side database connection URL as used by the existing Core Edge Functions.
5. Deploy `order-email-dispatch` with `verify_jwt=false` as configured in `supabase/config.toml`; the function explicitly validates `x-order-email-token`. Do **not** expose that token to clients.
6. Check a request without a valid token returns HTTP 401. Check an authorized request with disabled sending returns `enabled:false`, `sent:0`; verify **no email was sent**.
7. Review sending costs, Brevo's sender/domain authentication, and the provider's content and acceptable-use requirements.
8. **Separate approval is required to activate customer delivery.** Arrange a known consenting test account, confirm one opted-in order event, then set the DB queue flag and Edge delivery flag to true **for a controlled test**. Do not activate for all customers until that test is successful, since production order activity can queue messages.
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
