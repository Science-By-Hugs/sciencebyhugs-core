const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261104210000_customer_notification_preferences.sql'), 'utf8')

test('transactional order email preferences are opt-in, not marketing consent', () => {
  assert.match(sql, /customer_notification_preferences/)
  assert.match(sql, /order_email_enabled boolean not null default false/)
  assert.doesNotMatch(sql, /marketing_consent_events/i)
})

test('customers may only read, insert, and update their own preferences', () => {
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /for select to authenticated[\s\S]*auth\.uid\(\)\) = user_id/i)
  assert.match(sql, /for insert to authenticated[\s\S]*auth\.uid\(\)\) = user_id/i)
  assert.match(sql, /for update to authenticated[\s\S]*with check \(\(select auth\.uid\(\)\) = user_id\)/i)
  assert.match(sql, /revoke all on public\.customer_notification_preferences from anon, authenticated/i)
})
