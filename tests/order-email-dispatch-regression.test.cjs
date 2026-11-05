const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const worker = fs.readFileSync(path.join(__dirname, '../supabase/functions/order-email-dispatch/index.ts'), 'utf8')
const source = ts.transpileModule(worker.replace(/^import .*$/gm, ''), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

// Run the actual customer email template inside the same isolated test VM.
const templateSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/_shared/order-email-template.ts'), 'utf8')
const templateExports = {}
vm.runInNewContext(ts.transpileModule(templateSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: templateExports, Intl, Date, Number, String })

const TOKEN = 'isolated-unit-test-token-not-for-production'
const EVENT_ID = '00000000-0000-4000-8000-000000000101'
const ORDER_ID = '00000000-0000-4000-8000-000000000102'
const USER_ID = '00000000-0000-4000-8000-000000000103'

function harness(options = {}) {
  const state = {
    queueEnabled: options.queueEnabled ?? true,
    sendEnabled: options.sendEnabled ?? true,
    recipientAllowed: options.recipientAllowed ?? true,
    testMode: options.testMode ?? false,
    testUserId: options.testUserId === null ? '' : (options.testUserId ?? USER_ID),
    testOutboxId: options.testOutboxId === null ? '' : (options.testOutboxId ?? EVENT_ID),
    providerStatus: options.providerStatus ?? 201,
    providerThrows: options.providerThrows ?? false,
    providerMessageId: options.providerMessageId ?? '<fake-id@provider.invalid>',
    outboxState: options.initialOutboxState ?? 'queued',
    attempts: 0,
    providerCalls: [],
    dbCalls: [],
    dbClosed: 0,
  }
  const event = {
    id: options.eventId ?? EVENT_ID, order_id: ORDER_ID, user_id: options.eventUserId ?? USER_ID,
    event_type: 'status_changed', order_number: 'SBH-TEST-STATUS-001',
    order_status: 'delivered', delivery_date: null,
  }
  async function sql(strings, ...values) {
    const q = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase()
    state.dbCalls.push({ query: q, values })
    if (q.includes('select queue_enabled from private.order_email_settings')) {
      return [{ queue_enabled: state.queueEnabled }]
    }
    if (q.includes("set state = 'processing'") && q.includes('returning id')) {
      if (state.outboxState !== 'queued' && state.outboxState !== 'retry') return []
      if (!state.queueEnabled && state.testMode &&
        (event.id !== state.testOutboxId || event.user_id !== state.testUserId)) return []
      state.outboxState = 'processing'
      state.attempts++
      return [{ ...event, attempts: state.attempts }]
    }
    if (q.includes('from auth.users')) {
      return state.recipientAllowed
        ? [{ email: 'safe-test@example.invalid', name: 'Test Customer' }]
        : []
    }
    const status = q.match(/set state = '([a-z]+)'/)
    if (status) {
      state.outboxState = status[1]
      return []
    }
    throw new Error('Unexpected SQL in isolated test: ' + q.slice(0, 120))
  }
  sql.end = async () => { state.dbClosed++ }

  let handler = null
  const Deno = {
    serve(fn) { handler = fn },
    env: {
      get(key) {
        const fakeSecrets = {
          ORDER_EMAIL_DISPATCH_TOKEN: TOKEN,
          ORDER_EMAIL_SEND_ENABLED: state.sendEnabled ? 'true' : 'false',
          ORDER_EMAIL_TEST_MODE: state.testMode ? 'true' : 'false',
          ORDER_EMAIL_TEST_USER_ID: state.testUserId,
          ORDER_EMAIL_TEST_OUTBOX_ID: state.testOutboxId,
          BREVO_API_KEY: 'fake-test-value',
          BREVO_ORDER_SENDER_EMAIL: 'verified-test@example.invalid',
          SUPABASE_DB_URL: 'postgresql://fake.invalid/isolated',
        }
        return fakeSecrets[key] || null
      },
    },
  }
  const fakeFetch = async (url, opts) => {
    state.providerCalls.push({ url, body: JSON.parse(opts.body) })
    if (state.providerThrows) throw new Error('simulated network timeout')
    return {
      ok: state.providerStatus >= 200 && state.providerStatus < 300,
      status: state.providerStatus,
      json: async () => ({ messageId: state.providerMessageId }),
    }
  }
  vm.runInNewContext(source, {
    Deno, Response, Request, AbortSignal, console,
    postgres: () => sql,
    fetch: fakeFetch,
    composeOrderEmail: templateExports.composeOrderEmail,
  })
  assert.equal(typeof handler, 'function')

  async function dispatch(token = TOKEN, preflight = false) {
    const response = await handler(new Request('https://private.invalid/order-email-dispatch', {
      method: 'POST',
      headers: { 'x-order-email-token': token, ...(preflight ? { 'x-order-email-preflight': 'true' } : {}) },
    }))
    return { status: response.status, body: await response.json() }
  }
  return { dispatch, state }
}

test('unauthorized callers do not query the database or invoke Brevo', async () => {
  const h = harness()
  const response = await h.dispatch('wrong-token')
  assert.equal(response.status, 401)
  assert.equal(h.state.dbCalls.length, 0)
  assert.equal(h.state.providerCalls.length, 0)
})

test('disabled send switch bypasses database and Brevo, even with a valid private token', async () => {
  const h = harness({ sendEnabled: false })
  const result = await h.dispatch()
  assert.equal(result.status, 200)
  assert.equal(result.body.enabled, false)
  assert.equal(h.state.dbCalls.length, 0)
  assert.equal(h.state.providerCalls.length, 0)
})

test('disabled database queue prevents sending even if the environment switch is enabled', async () => {
  const h = harness({ queueEnabled: false })
  const result = await h.dispatch()
  assert.equal(result.status, 200)
  assert.equal(result.body.enabled, false)
  assert.equal(h.state.providerCalls.length, 0)
  assert.equal(h.state.outboxState, 'queued')
})

test('opted-out, unverified, or inactive customer is suppressed by the server-side recipient query', async () => {
  const h = harness({ recipientAllowed: false })
  const result = await h.dispatch()
  assert.equal(result.body.sent, 0)
  assert.equal(result.body.suppressed, 1)
  assert.equal(h.state.outboxState, 'suppressed')
  assert.equal(h.state.providerCalls.length, 0)
  assert.ok(h.state.dbCalls.some(x => x.query.includes('pref.order_email_enabled = true')))
  assert.ok(h.state.dbCalls.some(x => x.query.includes('u.email_confirmed_at is not null')))
  assert.ok(h.state.dbCalls.some(x => x.query.includes("lower(p.account_status) = 'active'")))
})

test('successful provider acceptance records a sent event; a second run does not resend it', async () => {
  const h = harness()
  const first = await h.dispatch()
  const second = await h.dispatch()
  assert.equal(first.body.sent, 1)
  assert.equal(first.body.processed, 1)
  assert.equal(second.body.processed, 0)
  assert.equal(h.state.outboxState, 'sent')
  assert.equal(h.state.providerCalls.length, 1)
  assert.equal(h.state.providerCalls[0].body.headers.IdempotencyKey, EVENT_ID)
  assert.equal(h.state.providerCalls[0].body.to[0].email, 'safe-test@example.invalid')
})

test('rate-limit response schedules bounded retry without claiming delivery', async () => {
  const h = harness({ providerStatus: 429 })
  const result = await h.dispatch()
  assert.equal(result.body.sent, 0)
  assert.equal(result.body.retry, 1)
  assert.equal(h.state.outboxState, 'retry')
  assert.equal(h.state.providerCalls.length, 1)
  assert.ok(h.state.dbCalls.some(x => x.query.includes('available_at = now()')))
})

test('ambiguous provider/network result is held for manual review, not automatically retried', async () => {
  const h = harness({ providerThrows: true })
  const first = await h.dispatch()
  const second = await h.dispatch()
  assert.equal(first.body.failed, 1)
  assert.equal(second.body.processed, 0)
  assert.equal(h.state.outboxState, 'failed')
  assert.equal(h.state.providerCalls.length, 1)
})

test('successful HTTP status without a provider message ID is not marked as sent', async () => {
  const h = harness({ providerMessageId: '' })
  const result = await h.dispatch()
  assert.equal(result.body.sent, 0)
  assert.equal(result.body.failed, 1)
  assert.equal(h.state.outboxState, 'failed')
})

test('single-message smoke test works while global queue remains disabled and is clearly labeled', async () => {
  const h = harness({ queueEnabled: false, testMode: true })
  const first = await h.dispatch()
  const second = await h.dispatch()
  assert.equal(first.status, 200)
  assert.equal(first.body.sent, 1)
  assert.equal(second.body.processed, 0)
  assert.equal(h.state.providerCalls.length, 1)
  assert.equal(h.state.providerCalls[0].body.subject, '[TEST] Order SBH-TEST-STATUS-001: delivered')
  assert.match(h.state.providerCalls[0].body.htmlContent, /Your order is now delivered/)
  assert.match(h.state.providerCalls[0].body.htmlContent, /href="https:\/\/nexus\.sciencebyhugs\.com"/)
  assert.match(h.state.providerCalls[0].body.htmlContent, /Hi Test Customer/)
  assert.doesNotMatch(h.state.providerCalls[0].body.htmlContent, /coupon|discount code|tracking number|shipping address/i)
  assert.ok(h.state.providerCalls[0].body.tags.includes('nexus-controlled-test'))
  assert.equal(h.state.providerCalls[0].body.to[0].email, 'safe-test@example.invalid')
  assert.ok(worker.includes('and e.id = ${testOutboxId'))
  assert.ok(worker.includes('and e.user_id = ${testUserId'))
  assert.ok(worker.includes('limit ${testMode ? 1 : 10}'))
})

test('scoped test cannot send another user or another outbox row', async () => {
  for (const options of [{ eventUserId: '00000000-0000-4000-8000-000000000199' }, { eventId: '00000000-0000-4000-8000-000000000199' }]) {
    const h = harness({ queueEnabled: false, testMode: true, ...options })
    const result = await h.dispatch()
    assert.equal(result.status, 200)
    assert.equal(result.body.processed, 0)
    assert.equal(result.body.sent, 0)
    assert.equal(h.state.providerCalls.length, 0)
  }
})

test('scoped test rejects missing IDs before querying database or provider', async () => {
  const h = harness({ queueEnabled: false, testMode: true, testUserId: null })
  const result = await h.dispatch()
  assert.equal(result.status, 503)
  assert.equal(h.state.dbCalls.length, 0)
  assert.equal(h.state.providerCalls.length, 0)
})

test('scoped test fails closed if global queue is enabled', async () => {
  const h = harness({ queueEnabled: true, testMode: true })
  const result = await h.dispatch()
  assert.equal(result.status, 409)
  assert.equal(h.state.outboxState, 'queued')
  assert.equal(h.state.providerCalls.length, 0)
})

test('stale processing messages are held for provider reconciliation, never auto-reclaimed', async () => {
  const h = harness({ initialOutboxState: 'processing' })
  const result = await h.dispatch()
  assert.equal(result.status, 200)
  assert.equal(result.body.sent, 0)
  assert.equal(result.body.processed, 0)
  assert.equal(h.state.outboxState, 'processing')
  assert.equal(h.state.attempts, 0)
  assert.equal(h.state.providerCalls.length, 0)
  assert.ok(worker.includes("where state in ('queued','retry') and available_at <= now()"))
  assert.ok(!worker.includes("or (state = 'processing' and locked_at < now()"))
})

test('authenticated preflight proves token match without database or provider effects', async () => {
  for (const sendEnabled of [true, false]) {
    const h = harness({ queueEnabled: true, sendEnabled, testMode: true })
    const result = await h.dispatch(TOKEN, true)
    assert.equal(result.status, 200)
    assert.equal(result.body.preflight, true)
    assert.equal(result.body.authenticated, true)
    assert.equal(result.body.sent, 0)
    assert.equal(result.body.processed, 0)
    assert.equal(h.state.dbCalls.length, 0)
    assert.equal(h.state.providerCalls.length, 0)
  }
})

test('preflight with invalid token returns 401 without querying or sending', async () => {
  const h = harness({ queueEnabled: true, sendEnabled: true })
  const result = await h.dispatch('wrong-token', true)
  assert.equal(result.status, 401)
  assert.equal(h.state.dbCalls.length, 0)
  assert.equal(h.state.providerCalls.length, 0)
})

test('authenticated readiness reports no secret values and cannot send a message', async () => {
  const h = harness({ queueEnabled: false, sendEnabled: false, testMode: false })
  const result = await h.dispatch(TOKEN, true)
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(result.body.readiness)), {
    send_enabled: false,
    test_mode: false,
    brevo_key_configured: true,
    sender_email_configured: true,
    database_url_configured: true,
  })
  assert.equal(result.body.sent, 0)
  assert.equal(h.state.dbCalls.length, 0)
  assert.equal(h.state.providerCalls.length, 0)
  assert.doesNotMatch(JSON.stringify(result.body), /isolated-unit-test-token|postgresql:|fake-test-value/)
})
