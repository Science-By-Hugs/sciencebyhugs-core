const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const shipping=read('supabase/migrations/20261107030000_core_catalog_shipping_rate_permissions.sql');
const stock=read('supabase/migrations/20261107031500_core_inventory_owner_unit_adjustments.sql');
const page=read('src/inventory-adjust.ts');
const service=read('src/services/inventory.ts');
const api=read('supabase/functions/core-inventory-control/index.ts');
const catalogApi=read('supabase/functions/core-catalog-control/index.ts');
test('shipping rate writes are scoped and audited, not a blanket UPDATE grant',()=>{
  assert.match(shipping,/core_catalog_change_shipping_rate/);
  assert.match(shipping,/FOR UPDATE/);
  assert.match(shipping,/jsonb_set\(v_config,'\{shippingRates\}'/);
  assert.match(shipping,/core_audit_events/);
  assert.doesNotMatch(shipping,/GRANT UPDATE ON/);
  assert.match(catalogApi,/admin\.rpc\("core_catalog_change_shipping_rate"/);
});
test('stock increases use existing purchase/receipt flow with confirmation',()=>{
  assert.match(page,/registerCurrentStock/);
  assert.match(service,/registerCurrentStock/);
  assert.match(api,/action === "register_current_stock"/);
  assert.match(page,/NOT already in Core/);
  assert.match(page,/expected>100/);
});
test('unit adjustments preserve allocation protections and immutable events',()=>{
  assert.match(stock,/a\.status IN \('held','committed'\)/);
  assert.match(stock,/WHERE id=ANY\(v_ids\) ORDER BY id FOR UPDATE/);
  assert.match(stock,/owner_adjust:/);
  assert.match(stock,/inventory_owner_adjustments ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(stock,/UPDATE public\.inventory_lots/);
  assert.match(api,/action === "adjust_units"/);
  assert.match(service,/adjustInventoryUnits/);
});

test('opening stock creates an atomic receipt with exact unit counts',()=>{
  const sql=read('supabase/migrations/20261107033000_core_inventory_opening_stock.sql');
  assert.match(sql,/core_inventory_receive_purchase/);
  assert.match(sql,/p_total NOT BETWEEN 1 AND 100/);
  assert.match(sql,/supplier lot is already tracked/i);
  assert.match(sql,/units_per_pack_snapshot,pack_price_snapshot/);
  assert.match(sql,/request_payload IS DISTINCT FROM v_payload/);
});
