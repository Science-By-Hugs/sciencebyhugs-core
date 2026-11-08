const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const read = file => readFileSync(join(__dirname, '..', file), 'utf8')

test('Memberships is routable from Core and customer management', () => {
  const main = read('src/main.ts')
  const customers = read('src/customers-view.ts')
  assert.match(main, /'memberships'/)
  assert.match(main, /membershipsPageMarkup/)
  assert.match(main, /bindMembershipsPage/)
  assert.match(customers, /href="#memberships"/)
})

test('Memberships editor uses owner/admin Core edge service', () => {
  const ui = read('src/memberships-view.ts')
  const svc = read('src/services/memberships.ts')
  const api = read('supabase/functions/core-memberships/index.ts')
  assert.match(ui, /Save membership/)
  assert.match(ui, /Create membership/)
  assert.match(svc, /supabase.functions.invoke\('core-memberships'/)
  assert.match(api, /auth.getUser\(\)/)
  assert.match(api, /user.app_metadata\?\.role/)
  assert.match(api, /core_manage_membership/)
})

test('Atomic membership updates preserve existing identifiers, Founding Member, and audit', () => {
  const sql = read('supabase/migrations/20261108032000_core_memberships_manage.sql')
  assert.match(sql, /v_before.slug = 'founding-member'/)
  assert.match(sql, /Founding Member name is protected by checkout rules/)
  assert.match(sql, /Existing membership slug cannot be renamed/)
  assert.match(sql, /p_expected_updated_at/)
  assert.match(sql, /core_audit_events/)
  assert.match(sql, /TO service_role/)
  assert.doesNotMatch(sql, /UPDATE public.profiles/)
  assert.doesNotMatch(sql, /DELETE FROM public.memberships/)
})

test('Inactive membership cannot be newly assigned by customer edit', () => {
  const customerControl = read('supabase/functions/core-customer-control/index.ts')
  assert.match(customerControl, /\.eq\("active",true\)\.maybeSingle\(\)/)
})
