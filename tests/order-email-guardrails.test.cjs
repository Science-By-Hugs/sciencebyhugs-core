const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261104235500_optional_order_email_outbox.sql'), 'utf8')
const workerSrc = fs.readFileSync(path.join(__dirname, '../supabase/functions/order-email-dispatch/index.ts'), 'utf8')

test('migration queues zero mail unless explicitly enabled', () => {
  assert.match(sql, /queue_enabled boolean not null default false/i)
  assert.match(sql, /values \(true, false\)/i)
  assert.match(sql, /if not exists[\s\S]*queue_enabled/i)
  assert.match(sql, /join public\.customer_notification_preferences n/i)
  assert.match(sql, /n\.order_email_enabled = true/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /revoke all on private\.order_email_outbox from public, anon, authenticated/i)
  assert.doesNotMatch(sql, /cron\.schedule|net\.http_post|brevo_api_key/i)
})

test('sender checks current consent before dispatch, records delivery, and requires private token', () => {
  assert.match(workerSrc, /ORDER_EMAIL_SEND_ENABLED/)
  assert.match(workerSrc, /ORDER_EMAIL_DISPATCH_TOKEN/)
  assert.match(workerSrc, /req\.headers\.get\('x-order-email-token'\)/)
  assert.match(workerSrc, /pref\.order_email_enabled = true/)
  assert.match(workerSrc, /email_confirmed_at is not null/)
  assert.match(workerSrc, /for update skip locked/i)
  assert.match(workerSrc, /provider_message_id/)
  assert.match(workerSrc, /state = 'suppressed'/)
})

test('unauthorized request cannot reach Brevo or the database', async () => {
  let handler
  const code = ts.transpileModule(workerSrc.replace(/^import .*$/gm, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const calls = []
  const Deno = {
    serve: fn => { handler = fn },
    env: { get: key => ({
      ORDER_EMAIL_DISPATCH_TOKEN: 'AveryLongSecretForThePrivateWorker',
      ORDER_EMAIL_SEND_ENABLED: 'true',
      BREVO_API_KEY: 'not-real',
    })[key] || null },
  }
  vm.runInNewContext(code, { Deno, Response, AbortSignal, postgres: () => { calls.push('db') }, fetch: () => { calls.push('brevo') } })
  const response = await handler(new Request('https://project.invalid/dispatch', { method: 'POST' }))
  assert.equal(response.status, 401)
  assert.deepEqual(calls, [])
})

test('disabled sending cannot reach provider even with authorization', async () => {
  let handler
  const code = ts.transpileModule(workerSrc.replace(/^import .*$/gm, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const calls = []
  const secret = 'AveryLongSecretForThePrivateWorker'
  const Deno = {
    serve: fn => { handler = fn },
    env: { get: key => ({ ORDER_EMAIL_DISPATCH_TOKEN: secret, ORDER_EMAIL_SEND_ENABLED: 'false' })[key] || null },
  }
  vm.runInNewContext(code, { Deno, Response, AbortSignal, postgres: () => { calls.push('db') }, fetch: () => { calls.push('brevo') } })
  const response = await handler(new Request('https://project.invalid/dispatch', { method: 'POST', headers: { 'x-order-email-token': secret } }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).enabled, false)
  assert.deepEqual(calls, [])
})
