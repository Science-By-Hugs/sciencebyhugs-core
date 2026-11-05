# Nexus automatic order email — launch runbook

**Not an activation script.** Review and complete these steps in order. Do not run a cron job until the protected dispatch token is available in both Edge Function Secrets and Supabase Vault. Never paste a secret in GitHub, a chat, a screenshot, or a SQL migration.

## Intended behavior

Only opted-in, signed-in customers with a verified email, active profile, and order ownership qualify. New order inserts, real order status changes, and estimated local delivery-date changes create non-promotional outbox events; the Edge Function rechecks eligibility before asking Brevo to send. No past orders are backfilled. Existing PWA/native push remains independent.

## Read-only production preflight

The operator should run these in the SQL Editor for the shared project `tkhcvmkejzaoervocnzk`:

```sql
select queue_enabled from private.order_email_settings where singleton;
select state, count(*) from private.order_email_outbox group by state;
select count(*) as opted_in_accounts from public.customer_notification_preferences where order_email_enabled = true;
select jobname, active from cron.job where jobname='nexus-order-email-dispatch';
select name from vault.secrets where name='nexus_order_email_dispatch_token';
```

At initial preparation, queue_enabled=false, zero pending, one historic sent test row, and one opted-in account. The Vault token was subsequently created by the operator and the schedule was installed **inactive**. Counts can change; recheck before activating.

## Secure credentials (manual, private operations)

1. In Supabase project `tkhcvmkejzaoervocnzk`, open **Edge Functions → Secrets**. Check `BREVO_API_KEY`, `BREVO_ORDER_SENDER_EMAIL` (verified `marketing@sciencebyhugs.com`), `SUPABASE_DB_URL`, and `ORDER_EMAIL_DISPATCH_TOKEN` are correctly configured. Do not reveal values in chat.
2. Create or rotate the dispatch token if necessary, with at least 32 random bytes. Store the **identical token** in Supabase Vault under name `nexus_order_email_dispatch_token` using the dashboard's secure Vault interface, and in Edge Function Secrets as `ORDER_EMAIL_DISPATCH_TOKEN`. The existing dispatcher specifically expects request header `x-order-email-token`.
3. Ensure `ORDER_EMAIL_TEST_MODE=false` and remove any `ORDER_EMAIL_TEST_USER_ID` / `ORDER_EMAIL_TEST_OUTBOX_ID` values. The single-recipient test mode must not be enabled during global delivery.
4. Keep `private.order_email_settings.queue_enabled=false` and `ORDER_EMAIL_SEND_ENABLED=false` while configuring.
5. With the reviewed dispatcher version that supports preflight deployed, use a private authorized POST to the Edge Function with headers `x-order-email-token: <Vault token>` and `x-order-email-preflight: true`, and an empty JSON body. Expect `{ "preflight": true, "authenticated": true, "processed": 0, "sent": 0 }`. This is a **no-send path** that does not open a database connection or call Brevo, regardless of send or test-mode flags. Test an invalid token returns 401. Never expose the token or request headers in shared logs.
6. Only after the preflight succeeds, with queue still disabled, configure `ORDER_EMAIL_SEND_ENABLED=true` and confirm `ORDER_EMAIL_TEST_MODE=false`. The database queue remains the independent kill switch until activation is explicitly approved.

## Schedule (already installed inactive; do not recreate)

Supabase supports `pg_cron` + `pg_net` to invoke an Edge Function with secrets obtained from Vault. The existing job is `nexus-order-email-dispatch`, initially `active=false`, with a database-queue-enabled guard; **do not rerun the illustrative `cron.schedule` SQL below**. Its command deliberately does not contain a plaintext key. Before release, verify this installed command is correct.

```sql
-- Confirm the secret exists before scheduling:
select exists (
  select 1 from vault.secrets
  where name='nexus_order_email_dispatch_token'
) as dispatch_token_available;

-- Run ONLY after it is true and the authenticated disabled-queue test passed:
select cron.schedule(
  'nexus-order-email-dispatch',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://tkhcvmkejzaoervocnzk.supabase.co/functions/v1/order-email-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-order-email-token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name='nexus_order_email_dispatch_token'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    ) as request_id;
  $job$
);
```

With the database queue disabled, the scheduled calls should return `enabled:false` and `sent:0`, and the outbox must remain unchanged. Verify the cron run logs and Edge Function logs before proceeding. **Do not activate just because a cron job exists.** The connection between cron and worker has to be verified first.

## Activation (separate owner approval required)

After all preflight checks are green, and only once the owner explicitly approves automatic sends to every opted-in customer, activate the existing, reviewed cron job and enable the queue (these are separate reversible steps):

```sql
select cron.alter_job(jobid, active := true)
from cron.job
where jobname = 'nexus-order-email-dispatch' and active = false;
```

Then:

```sql
update private.order_email_settings
set queue_enabled=true, updated_at=now()
where singleton=true and queue_enabled=false
returning queue_enabled;
```

Monitor actual future order events. Verify Brevo accepted message IDs, expected subjects, opt-out suppression, absence of duplicate provider sends and that only opted-in accounts received mail. A provider-accepted `sent` row is not the same as confirmed inbox delivery.

## Immediate rollback (disable new sends)

```sql
-- Stop queueing and dispatch claims first:
update private.order_email_settings
set queue_enabled=false, updated_at=now()
where singleton=true;
-- Then stop scheduled function calls:
select cron.unschedule('nexus-order-email-dispatch');
```

Also set Edge Function Secret `ORDER_EMAIL_SEND_ENABLED=false` in the dashboard and verify `cron.job` has no matching row. The queue flag alone stops new dispatch processing, but an already in-flight request may still finish; treat it as a soft stop, and inspect logs. Review existing queued/processing rows before restarting.

## Monitor and reconcile

```sql
select state, count(*) from private.order_email_outbox group by state order by state;
select id, event_type, attempts, created_at, locked_at, last_error_code
from private.order_email_outbox
where state='processing' and locked_at < now() - interval '15 minutes'
order by locked_at;
select j.jobname, d.status, d.start_time, d.end_time
from cron.job_run_details d join cron.job j on j.jobid=d.jobid
where j.jobname='nexus-order-email-dispatch'
order by d.start_time desc limit 15;
```

An interrupted `processing` event is **never automatically retried**: Brevo may have accepted it before the database acknowledgement. Reconcile with Brevo before modifying or retrying that row. Transient confirmed HTTP 429/5xx responses still use bounded retries.

## Current connector limitation

The linked Supabase tools can read the project and deploy Edge Functions, but cannot inspect or update Edge Function Secrets. The operator reports the dispatch token was matched in Vault and Edge Function Secrets, while the existing cron schedule remains inactive and the production queue remains disabled. The no-send authenticated preflight must succeed before releasing the paused cron. A separate explicit owner approval remains required for live automatic sending.

Official references:
- https://supabase.com/docs/guides/functions/schedule-functions
- https://supabase.com/docs/guides/cron
