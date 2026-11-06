const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const launch = fs.readFileSync(
  'supabase/migrations/20261106171732_launch_inventory_automation.sql', 'utf8'
)

test('inventory launch aborts on uncounted stock or pre-existing holds', () => {
  assert.match(launch, /lacks a verified physical count/)
  assert.match(launch, /Pre-launch inventory holds or allocations exist/)
  assert.match(launch, /state='reserved'/)
})

test('launch classifies only active products without an existing setting', () => {
  assert.match(launch, /INSERT INTO public\.inventory_product_settings/)
  assert.match(launch, /WHERE p\.active/)
  assert.match(launch, /NOT EXISTS[\s\S]*inventory_product_settings/)
  assert.match(launch, /'vendor',0/)
})

test('launch enables all three gates from a fresh cutover and schedules recovery', () => {
  assert.match(launch, /'reservation_enabled',true/)
  assert.match(launch, /'deduction_enabled',true/)
  assert.match(launch, /'recovery_enabled',true/)
  assert.match(launch, /'activated_at',statement_timestamp\(\)/)
  assert.match(launch, /core-inventory-recovery-15m/)
  assert.match(launch, /core_checkout_recover_abandoned\(25,90\)/)
})
