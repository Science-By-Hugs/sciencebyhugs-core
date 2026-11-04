import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import postgres from 'npm:postgres@3.4.5'
import { composeOrderEmail, type OrderEmailEvent } from '../_shared/order-email-template.ts'

// Private cron-only function. Never call from a public browser.
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

type OutboxRow = OrderEmailEvent & {
  id: string
  order_id: string
  user_id: string
  attempts: number
}
type Recipient = { email: string; name: string }

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const dispatchToken = Deno.env.get('ORDER_EMAIL_DISPATCH_TOKEN') || ''
  if (dispatchToken.length < 24 || req.headers.get('x-order-email-token') !== dispatchToken) {
    return json({ error: 'Unauthorized' }, 401)
  }
  // Fail closed: configuring a key or deploying this function alone cannot send email.
  if (Deno.env.get('ORDER_EMAIL_SEND_ENABLED') !== 'true') {
    return json({ enabled: false, processed: 0, sent: 0 })
  }

  const brevoKey = Deno.env.get('BREVO_API_KEY') || ''
  const senderEmail = Deno.env.get('BREVO_ORDER_SENDER_EMAIL') || ''
  const databaseUrl = Deno.env.get('SUPABASE_DB_URL') || ''
  if (!brevoKey || !databaseUrl || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    return json({ error: 'Email service configuration incomplete' }, 503)
  }

  const sql = postgres(databaseUrl, { prepare: false, max: 1, idle_timeout: 1, connect_timeout: 10 })
  const stats = { processed: 0, sent: 0, suppressed: 0, retry: 0, failed: 0 }
  try {
    const settings = await sql`
      select queue_enabled from private.order_email_settings where singleton = true`
    if (!settings[0]?.queue_enabled) return json({ enabled: false, ...stats })

    const events = await sql<OutboxRow[]>`
      update private.order_email_outbox
      set state = 'processing', locked_at = now(), attempts = attempts + 1
      where id in (
        select id from private.order_email_outbox
        where (
          (state in ('queued','retry') and available_at <= now())
          or (state = 'processing' and locked_at < now() - interval '15 minutes')
        ) and attempts < 5
        order by created_at
        limit 10
        for update skip locked
      )
      returning id, order_id, user_id, event_type, order_number, order_status,
        delivery_date::text as delivery_date, attempts`

    stats.processed = events.length
    for (const event of events) {
      try {
        // Revalidate opt-in, verified account email, active profile, and order ownership
        // immediately before sending. No customer email is stored in the outbox.
        const recipients = await sql<Recipient[]>`
          select u.email as email,
                 coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)),''), 'there') as name
          from auth.users u
          join public.profiles p on p.auth_user_id = u.id
          join public.orders o on o.customer_id = p.id and o.id = ${event.order_id}::uuid
          join public.customer_notification_preferences pref
            on pref.user_id = u.id and pref.order_email_enabled = true
          where u.id = ${event.user_id}::uuid
            and u.email_confirmed_at is not null
            and u.email is not null
            and lower(p.account_status) = 'active'
            and (
              ${event.event_type} <> 'status_changed'
              or o.status = ${event.order_status}
            )
            and (
              ${event.event_type} <> 'delivery_date_changed'
              or o.estimated_delivery_date is not distinct from ${event.delivery_date}::date
            )
          limit 1`
        if (!recipients.length || !recipients[0]?.email) {
          await sql`update private.order_email_outbox
            set state = 'suppressed', locked_at = null
            where id = ${event.id}::uuid`
          stats.suppressed++
          continue
        }

        const { subject, htmlContent } = composeOrderEmail(event, recipients[0].name)
        // Brevo's request idempotency header helps with repeated invocations.
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': brevoKey,
            'accept': 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sender: { name: 'Science By Hugs', email: senderEmail },
            to: [{ email: recipients[0].email, name: recipients[0].name }],
            subject,
            htmlContent,
            tags: ['nexus-order-update'],
            headers: { IdempotencyKey: event.id },
          }),
          signal: AbortSignal.timeout(12000),
        })

        if (response.ok) {
          const body = await response.json().catch(() => ({})) as { messageId?: string }
          if (!body.messageId) {
            // Ambiguous acceptance: require manual reconciliation, never auto-retry.
            await sql`update private.order_email_outbox
              set state = 'failed', last_error_code = 'brevo_missing_message_id', locked_at = null
              where id = ${event.id}::uuid`
            stats.failed++
            continue
          }
          await sql`update private.order_email_outbox
            set state = 'sent', provider_message_id = ${body.messageId},
                sent_at = now(), last_error_code = null, locked_at = null
            where id = ${event.id}::uuid`
          stats.sent++
          continue
        }

        const canRetry = (response.status === 429 || response.status >= 500) && event.attempts < 5
        const retryMinutes = Math.min(240, 2 ** event.attempts * 3)
        if (canRetry) {
          await sql`update private.order_email_outbox
            set state = 'retry',
                available_at = now() + (${retryMinutes} || ' minutes')::interval,
                last_error_code = ${'brevo_http_' + response.status}, locked_at = null
            where id = ${event.id}::uuid`
          stats.retry++
        } else {
          await sql`update private.order_email_outbox
            set state = 'failed', last_error_code = ${'brevo_http_' + response.status},
                locked_at = null
            where id = ${event.id}::uuid`
          stats.failed++
        }
      } catch (_error) {
        // A connection timeout can occur after Brevo accepted an email. Avoid
        // automatic retries and possible duplicates; reconcile in Brevo first.
        await sql`update private.order_email_outbox
          set state = 'failed', last_error_code = 'network_result_unknown', locked_at = null
          where id = ${event.id}::uuid`
        stats.failed++
      }
    }
    return json({ enabled: true, ...stats })
  } catch (_error) {
    console.error('Order email dispatch encountered an internal error')
    return json({ error: 'Email dispatch failed' }, 500)
  } finally {
    await sql.end({ timeout: 1 })
  }
})
