# Customer notifications — preferences contract

Owner: `sciencebyhugs-core` (shared Supabase schema). Customer UI: `sciencebyhugs-nexus`.

## Step 2: Stored choices

The migration `20261104210000_customer_notification_preferences.sql` introduces `public.customer_notification_preferences`.

- `user_id`: Auth user ID; one preference record per customer.
- `order_email_enabled`: **false** by default. Optional order status and local delivery email subscription.
- `created_at` / `updated_at`: preference audit timestamps.
- RLS ensures authenticated users can read and update only their own row. Operations staff must not use the frontend service role to bypass RLS.

Email preferences are **not** marketing permission. Never write these choices to `marketing_consent_events`, and do not infer promotions consent from them. Mandatory receipts and essential operational messages may follow separate policy requirements.

## Push is separate, per device

The existing `public.app_push_subscriptions` table is the source of truth for push permission and device subscriptions. Keep existing `app-push`, `core-nexus-push`, `private.app_push_queue`, and the dispatch cron intact.

## Release order

1. Review and apply the Core migration to the shared Supabase project using your normal database deployment process.
2. Deploy the corresponding Nexus settings UI only after the table is available and RLS verified.
3. Verify a customer can turn optional email updates on and off and read the saved state across sessions.
4. Verify a separate Nexus Home Screen PWA still receives its existing push test notification.
5. Do **not** claim automated order emails are live yet. Brevo transactional email delivery and actual order-event integration are planned for a later step.

## Planned Core implementation

Future order-email dispatch must read `customer_notification_preferences.order_email_enabled` for optional order-status messages, use verified account email from the authenticated customer profile, and log idempotent attempts. Keep the marketing preference and operational messages independent. Do not send a message solely because this preference record exists.
