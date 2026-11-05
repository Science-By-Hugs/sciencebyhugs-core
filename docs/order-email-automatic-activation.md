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

At preparation time, queue_enabled=false, zero pending, one historic sent test row, one opted-in account, no email schedule, and no Vault email token. Counts can change; recheck before activating.

## Secure credentials (manual, private operations)

1. In Supabase project `tkhcvmkejzaoervocnzk`, open **Edge Functions → Secrets**. Check `BREVO_API_KEY`, `BREVO_ORDER_SENDER_EMAIL` (verified `marketing@sciencebyhugs.com`), `SUPABASE_DB_URL`, and `ORDER_EMAIL_DISPATCH_TOKEN` are correctly configured. Do not reveal values in chat.
2. Create or rotate the dispatch token if necessary, with at least 32 random bytes. Store the **identical token** in Supabase Vault under name `nexus_order_email_dispatch_token` using the dashboard's secure Vault interface, and in Edge Function Secrets as `ORDER_EMAIL_DISPATCH_TOKEN`. The existing dispatcher specifically expects request header `x-order-email-token`.
3. Ensure `ORDER_EMAIL_TEST_MODE=false` and remove any `ORDER_EMAIL_TEST_USER_ID` / `ORDER_EMAIL_TEST_OUTBOX_ID` values. The single-recipient test mode must not be enabled during global delivery.
4. Keep `private.order_email_settings.queue_enabled=false` while configuring. Only once the credentials and reviewed worker are correct, set the Edge secret `ORDER_EMAIL_SEND_ENABLED=true`. This alone must not send because the database queue is still disabled.
5. From a private authorized invocation interface, POST `{}` to the Edge Function with the private `x-order-email-token` header. With database queue disabled, the response must be `{ "enabled": false, ... "sent": 0 }`. Test invalid token returns 401. Do not store these request headers in shared logs.

## Schedule (only after successful preflight)

Supabase supports `pg_cron` + `pg_net` to invoke an Edge Function, with secrets obtained from Vault. Verify that the Vault entry exists and matches the Edge token; this SQL deliberately **does not contain** a plaintext key.

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

After all preflight checks are green, and only once the owner explicitly approves automatic sends to every opted-in customer:

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

The linked Supabase tools can read the project and deploy Edge Functions, but cannot inspect or update Edge Function Secrets. Neither the Vault dispatch token nor the cron job exists as of preparation. A secure dashboard step is required before scheduling, and a separate owner approval remains required for live automatic sending.

Official references:
- https://supabase.com/docs/guides/functions/schedule-functions
- https://supabase.com/docs/guides/cron
