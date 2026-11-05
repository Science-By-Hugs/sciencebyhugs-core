const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const ts=require('typescript')
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')
const migration=read('supabase/migrations/20261105210000_core_inventory_multi_product_orders.sql')
const api=read('supabase/functions/core-inventory-control/index.ts')
const ui=read('src/inventory-view.ts')
const multi=read('src/inventory-multi.ts')
const service=read('src/services/inventory.ts')

const transpiled=ts.transpileModule(multi,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText
const moduleExports={}
vm.runInNewContext(transpiled,{
  exports:moduleExports,require:()=>({}),Intl,Math,Number,Set,Error,
})
const {splitCents,allocationPreview}=moduleExports

test('shipping is entered once and allocated exactly once across ten kits',()=>{
  const allocations=splitCents(70,Array(10).fill(1))
  assert.equal(allocations.length,10)
  assert.equal(allocations.reduce((a,b)=>a+b,0),70)
  assert(allocations.every(x=>x===7))
})
test('shared charges never go negative with penny rounding',()=>{
  const result=splitCents(0.05,Array(10).fill(1))
  assert.equal(Math.round(result.reduce((sum,x)=>sum+x,0)*100),5)
  assert(result.every(x=>x>=0))
})
test('allocate proportional to kit cost and preserve pack snapshots',()=>{
  const offers=[
    {id:'a',vendor_id:'vendor',product_id:'p1',price_per_pack:25,units_per_pack:10},
    {id:'b',vendor_id:'vendor',product_id:'p2',price_per_pack:75,units_per_pack:10},
  ]
  const rows=[{offerId:'a',packs:1,shipping:0,fees:0},
    {offerId:'b',packs:1,shipping:0,fees:0}]
  const r=allocationPreview(rows,offers,'by_cost',40,0)
  assert.equal(r[0].shipping,10)
  assert.equal(r[1].shipping,30)
  assert.equal(r[0].expectedUnits,10)
  assert.equal(r[1].expectedUnits,10)
  assert.equal(r[0].estimatedUnitCost,3.5)
  assert.equal(r[1].estimatedUnitCost,10.5)
})
test('manual allocation preserves operator-entered line shares',()=>{
  const offers=[
    {id:'a',product_id:'p1',price_per_pack:25,units_per_pack:10},
    {id:'b',product_id:'p2',price_per_pack:75,units_per_pack:10},
  ]
  const rows=[{offerId:'a',packs:1,shipping:4,fees:2},
    {offerId:'b',packs:1,shipping:6,fees:3}]
  const result=allocationPreview(rows,offers,'manual',10,5)
  assert.equal(result[0].shipping,4)
  assert.equal(result[1].fees,3)
})
test('SQL extends existing orders without rewriting original sales records',()=>{
  assert.match(migration,/drop constraint if exists inventory_purchase_lines_purchase_order_id_key/)
  assert.match(migration,/drop constraint if exists inventory_receipts_purchase_order_id_key/)
  assert.match(migration,/partially_received/)
  assert.match(migration,/multi_line boolean not null default false/)
  assert.match(migration,/shipping_allocated numeric\(14,2\)/)
  assert.match(migration,/fees_allocated numeric\(14,2\)/)
  assert.match(migration,/cost_finalized boolean not null default true/)
  assert.doesNotMatch(migration,/update\s+public\.products\s+/i)
  assert.doesNotMatch(migration,/update\s+public\.orders\s+/i)
  assert.doesNotMatch(migration,/delete\s+from\s+public\.inventory_/i)
})
test('multi-order purchasing is atomic, idempotent and vendor restricted',()=>{
  assert.match(migration,/create or replace function public\.core_inventory_create_multi_purchase/)
  assert.match(migration,/request_payload is distinct from v_payload/)
  assert.match(migration,/on conflict\(request_id\) do nothing/)
  assert.match(migration,/o\.vendor_id=p_vendor_id and o\.active/)
  assert.match(migration,/duplicate offering/i)
  assert.match(migration,/p_allocation_method='manual'/)
  assert.match(migration,/v_ship_left/)
  assert.match(migration,/v_weight_left/)
  assert.match(migration,/round\(v_ship_left \* v_weight \/ v_weight_left,2\)/)
  assert.match(migration,/revoke all on function public\.core_inventory_create_multi_purchase/)
  assert.match(migration,/grant execute on function public\.core_inventory_create_multi_purchase[\s\S]*?to service_role/)
})
test('partial receipts lock order, prevent over-receiving and preserve movement ledger',()=>{
  assert.match(migration,/create or replace function public\.core_inventory_receive_multi_line/)
  assert.match(migration,/for update/)
  assert.match(migration,/v_prior\+p_accepted\+p_damaged>v_line\.expected_units/)
  assert.match(migration,/p_accepted\+p_damaged not between 1 and 100/)
  assert.match(migration,/inventory_receipts where request_id=p_request_id/)
  assert.match(migration,/insert into public\.inventory_units/)
  assert.match(migration,/insert into public\.inventory_movements/)
  assert.match(migration,/cost_finalized=true/)
  assert.match(migration,/v_total_accepted/)
  assert.match(migration,/status=case when v_order_fully_received then 'received'/)
  assert.match(migration,/revoke all on function public\.core_inventory_receive_multi_line/)
})
test('Edge API checks admin auth and serves multi-order actions',()=>{
  assert.match(api,/userClient\.auth\.getUser\(\)/)
  assert.match(api,/user\.app_metadata\?\.role/)
  assert.match(api,/action === "create_multi_purchase"/)
  assert.match(api,/action === "receive_multi_line"/)
  assert.match(api,/p_actor_id:user\.id/)
  assert.match(api,/inventory_receipts/)
  assert.match(api,/shipping_allocated,fees_allocated/)
  assert.match(service,/createMultiInventoryPurchase/)
  assert.match(service,/receiveMultiInventoryLine/)
})
test('Core UI has editable multi-line POs and staged receiving without changing Nexus',()=>{
  assert.match(ui,/mountMultiInventory/)
  assert.match(ui,/!o\.multi_line/)
  assert.match(multi,/Add another product kit/)
  assert.match(multi,/Allocate inbound costs/)
  assert.match(multi,/Receive multi-product orders/)
  assert.match(multi,/Create multi-product purchase order/)
  assert.match(multi,/receiveMultiInventoryLine/)
  assert.match(multi,/purchaseRequestId/)
  assert.match(multi,/receiptRequestId/)
  assert.match(multi,/Landed cost is preliminary/)
})
