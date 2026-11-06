const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261106163349_support_google_pay_inventory_verification.sql'),
  'utf8',
)
const orders = fs.readFileSync(path.join(root, 'src/orders-hub.ts'), 'utf8')

test('verified Google Pay payments require a PayPal capture receipt', () => {
  assert.match(migration, /payments_google_pay_capture_required/)
  assert.match(migration, /provider IS DISTINCT FROM 'Google Pay'/)
  assert.match(migration, /status IS DISTINCT FROM 'verified'/)
  assert.match(migration, /NULLIF\(provider_capture_id, ''\) IS NOT NULL/)
})

test('Core no longer offers Venmo for new manual payment records', () => {
  const options = orders.split('class="od-provider"')[1]?.split('</select>')[0] || ''
  assert.doesNotMatch(options, />Venmo</)
  assert.doesNotMatch(options, />Google Pay</)
})
