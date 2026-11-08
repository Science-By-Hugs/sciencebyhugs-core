const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const source = path => readFileSync(join(__dirname, '..', path), 'utf8')

test('shipping display names are stored separately from checkout rates and source IDs', () => {
  const sql = source('supabase/migrations/20261108030000_core_shipping_display_labels.sql')
  assert.match(sql, /shippingDisplayLabels/)
  assert.match(sql, /checkout_key_unchanged/)
  assert.doesNotMatch(sql, /products\s+SET\s+shipping_from/i)
  assert.doesNotMatch(sql, /jsonb_set\(v_config,\s*'\{shippingRates\}'/i)
  assert.match(sql, /core_audit_events/)
  assert.match(sql, /TO service_role/)
})

test('catalog control exposes separate display name command under existing admin auth', () => {
  const api = source('supabase/functions/core-catalog-control/index.ts')
  assert.match(api, /app_metadata\?\.role/)
  assert.match(api, /set_shipping_display_label/)
  assert.match(api, /core_catalog_set_shipping_display_label/)
  assert.match(api, /shippingDisplayLabels/)
})

test('Core shipping UI edits display labels without renaming product shipping sources', () => {
  const ui = source('src/catalog-view.ts')
  const service = source('src/services/catalog.ts')
  assert.match(ui, /Checkout key:/)
  assert.match(ui, /Business display name \(Core only\)/)
  assert.match(ui, /setShippingDisplayLabel/)
  assert.match(service, /set_shipping_display_label/)
  assert.doesNotMatch(ui, /shippingFrom\s*=\s*displayLabel/)
})
