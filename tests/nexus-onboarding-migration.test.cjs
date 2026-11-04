const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261104223000_nexus_onboarding_adoption.sql'), 'utf8')

test('onboarding events are unique per customer, with owner-only writes and admin reads', () => {
  assert.match(sql, /create table public\.nexus_onboarding_events/i)
  assert.match(sql, /primary key\(user_id, event_type\)/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /nexus_onboarding_owner_insert/i)
  assert.match(sql, /nexus_onboarding_admin_read/i)
  assert.match(sql, /app_metadata/i)
})
test('beta SMS handoff never claims to receive or store the message', () => {
  assert.match(sql, /beta_text_opened/)
  assert.doesNotMatch(sql, /nexus_beta_requests|marketing_consent_events/i)
})
