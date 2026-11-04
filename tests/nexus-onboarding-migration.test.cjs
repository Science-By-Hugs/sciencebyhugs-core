const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261104223000_nexus_onboarding_and_beta_requests.sql'), 'utf8')

test('only signed-in users can request beta for their own authenticated email', () => {
  assert.match(sql, /create table public\.nexus_beta_requests/i)
  assert.match(sql, /enable row level security/i)
  assert.match(sql, /grant insert \(user_id, email\)/i)
  assert.match(sql, /auth\.uid\(\)\) = user_id/i)
  assert.match(sql, /lower\(email\) = lower\(coalesce/i)
  assert.match(sql, /grant update \(status\)/i)
  assert.match(sql, /nexus_beta_admin_update/i)
  assert.match(sql, /app_metadata/i)
})

test('tracking counts one event per customer and never opts into marketing', () => {
  assert.match(sql, /create table public\.nexus_onboarding_events/i)
  assert.match(sql, /primary key\(user_id,event_type\)/i)
  assert.match(sql, /nexus_onboarding_owner_insert/i)
  assert.match(sql, /nexus_onboarding_admin_read/i)
  assert.doesNotMatch(sql, /marketing_consent_events/i)
})
