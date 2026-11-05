const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const ui = read('src/orders-hub.ts')
const api = read('supabase/functions/core-fulfillment-control/index.ts')
const payment = read('supabase/functions/core-payment-control/index.ts')
const migration = read('supabase/migrations/20261105130000_standardize_order_statuses.sql')

test('Core uses each canonical stage and each exception status', () => {
  const statuses = ['processing','ordered','shipped','out_for_delivery','delivered','on_hold','delayed','cancelled']
  for (const status of statuses) {
    assert.ok(api.includes(status), 'Fulfillment API missing ' + status)
    assert.ok(ui.includes(status), 'Orders UI missing ' + status)
  }
  assert.match(ui, /Submitted · awaiting payment/)
})

test('Shipped advances to Out for Delivery before Delivered', () => {
  assert.match(api, /shipped: \["out_for_delivery"/)
  assert.match(api, /out_for_delivery: \["delivered"/)
  assert.match(ui, /shipped: \[\['out_for_delivery'/)
  assert.match(ui, /out_for_delivery: \[\['delivered'/)
})

test('Processing remains behind verified payment, including re-entry', () => {
  assert.match(api, /order\.payment_status !== "paid"/)
  assert.match(payment, /status: "verified"/)
  assert.match(payment, /status: "processing"/)
  assert.match(migration, /guard_order_processing_requires_payment/)
  assert.match(migration, /p\.status = 'verified'/)
  assert.match(migration, /p\.verified_at is not null/)
  assert.match(migration, /Payment must be verified before the order enters Processing/)
})

test('legacy checkout can still be cleared without converting existing orders', () => {
  assert.match(migration, /checkout_pending', 'submitted'/)
  assert.match(migration, /default 'submitted'/)
  assert.doesNotMatch(migration, /update public\.orders\s+set status/i)
})
