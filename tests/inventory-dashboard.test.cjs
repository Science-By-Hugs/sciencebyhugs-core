const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const ts=require('typescript')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')

const dash=read('src/inventory-dashboard.ts')
const ui=read('src/inventory-view.ts')
const api=read('supabase/functions/core-inventory-control/index.ts')
const css=read('src/inventory.css')
const compiled=ts.transpileModule(dash,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
}}).outputText
const moduleExports={}
vm.runInNewContext(compiled,{exports:moduleExports,require:()=>({}),Intl,Math,Number,Map,Set,Date,Error})
const {buildStockDashboardModel}=moduleExports

function fixtures(){
  return {
    products:[
      {id:'ret',name:'RETATRUTIDE 20MG',product_code:'SBH-RET-20',price:80},
      {id:'ghk',name:'GHK-CU 50MG',product_code:'SBH-GHK-50',price:35},
      {id:'vendor',name:'SUPPLIER ONLY',product_code:'SBH-VEN-01',price:20},
      {id:'unknown',name:'UNCLASSIFIED',product_code:'SBH-UNK-01',price:10},
    ],
    unit_counts:[
      {product_id:'ret',state:'available',count:6},
      {product_id:'ret',state:'reserved',count:3},
      {product_id:'ghk',state:'available',count:0},
      {product_id:'ghk',state:'damaged',count:5},
      {product_id:'unknown',state:'available',count:2},
    ],
    counts_complete:true,
    settings:[
      {product_id:'ret',supply_mode:'physical',reorder_point:7},
      {product_id:'ghk',supply_mode:'physical',reorder_point:0},
      {product_id:'vendor',supply_mode:'vendor',reorder_point:10},
    ],
    vendors:[{id:'e',name:'Emlin',active:true},{id:'g',name:'GIGI',active:true}],
    offers:[
      {id:'offer1',vendor_id:'e',product_id:'ret',units_per_pack:10,price_per_pack:126,active:true},
      {id:'offer2',vendor_id:'g',product_id:'ret',units_per_pack:1,price_per_pack:16,active:true},
      {id:'offer3',vendor_id:'e',product_id:'vendor',units_per_pack:10,price_per_pack:80,active:true},
    ],
    lots:[
      {id:'lot_old',product_id:'ret',created_at:'2026-10-01',landed_unit_cost:19.6,cost_finalized:true},
      {id:'lot_new',product_id:'ret',created_at:'2026-11-05',landed_unit_cost:null,cost_finalized:false},
    ],
    orders:[{id:'po1',status:'partially_received',multi_line:true},
      {id:'po2',status:'received',multi_line:false}],
    lines:[{id:'line1',purchase_order_id:'po1',product_id:'ret',expected_units:20}],
    receipts:[{id:'r1',purchase_line_id:'line1',accepted_units:5,damaged_units:2}],
  }
}
const row=(model,id)=>model.rows.find(x=>x.id===id)

test('available is actual unit state; reserved and damaged never count as available',()=>{
  const m=buildStockDashboardModel(fixtures())
  assert.equal(m.available,8)
  assert.equal(m.reserved,3)
  assert.equal(m.damaged,5)
  assert.equal(row(m,'ret').available,6)
  assert.equal(row(m,'ret').reserved,3)
})
test('configured physical reorder threshold flags only genuine available units',()=>{
  const m=buildStockDashboardModel(fixtures())
  assert.equal(row(m,'ret').lowStock,true)
  assert.equal(m.lowStockProducts,1)
  assert.equal(row(m,'ghk').lowStock,false) // reorder point unset
  assert.equal(row(m,'vendor').lowStock,false) // not physical
})
test('vendor supplies remain distinct from stocked items and unclassified stock needs review',()=>{
  const m=buildStockDashboardModel(fixtures())
  assert.equal(row(m,'vendor').mode,'vendor')
  assert.equal(row(m,'vendor').available,0)
  assert.equal(row(m,'unknown').needsClassification,true)
  assert.equal(m.needsClassification,1)
})
test('supplier unit quote excludes freight; final landed cost comes from lot, not catalog',()=>{
  const m=buildStockDashboardModel(fixtures())
  assert.equal(row(m,'ret').supplierQuote,12.6)
  assert.equal(row(m,'ret').supplierName,'Emlin')
  assert.equal(row(m,'ret').latestLandedCost,19.6)
  assert.equal(row(m,'ret').finalCostPending,true)
})
test('open purchase quantity nets out partial receipts including damaged vials',()=>{
  const m=buildStockDashboardModel(fixtures())
  assert.equal(row(m,'ret').pendingUnits,13)
  assert.equal(m.openPurchases,1)
})
test('incomplete stock responses never produce low-stock decisions',()=>{
  const data=fixtures()
  data.counts_complete=false
  const m=buildStockDashboardModel(data)
  assert.equal(m.countsComplete,false)
  assert.equal(m.lowStockProducts,0)
})
test('lot labels remain separately actionable; no automatic purchases or stock changes',()=>{
  assert.match(dash,/data-action|dataset\.action/)
  assert.match(dash,/Lot labels/)
  assert.match(dash,/Supply settings/)
  assert.match(dash,/mountInventoryDashboard/)
  assert.match(ui,/mountInventoryDashboard\(overview,data/)
  assert.match(ui,/mountMultiInventory/)
  assert.match(ui,/lotRows\(data\.lots/)
  assert.doesNotMatch(dash,/createMultiInventoryPurchase|receiveMultiInventoryLine/)
})
test('stock endpoint aggregates scoped states, paginates and does not return tokens',()=>{
  assert.match(api,/const counts=new Map/)
  assert.match(api,/\.select\("product_id,state"\)/)
  assert.match(api,/\.range\(page\*1000,page\*1000\+999\)/)
  assert.match(api,/counts_complete:countsComplete/)
  assert.match(api,/userClient\.auth\.getUser\(\)/)
  assert.match(api,/app_metadata\?\.role/)
  const fragment=api.split('const counts=new Map')[1].split('if (action === "add_vendor")')[0]
  assert.doesNotMatch(fragment,/select\(".*scan_token/)
  assert.match(css,/\.inv-stock-dashboard/)
})


test('Phase 5B displays paid allocated stock separately from unpaid holds',()=>{
  const data=fixtures()
  data.unit_counts.push({product_id:'ret',state:'allocated',count:4})
  const m=buildStockDashboardModel(data)
  assert.equal(m.available,8)
  assert.equal(m.reserved,3)
  assert.equal(m.allocated,4)
  assert.equal(row(m,'ret').allocated,4)
  assert.equal(row(m,'ret').available,6)
  assert.match(dash,/Paid, waiting for fulfillment/)
});

test('inventory stays within the phone viewport and stock rows become cards',()=>{
  const shell=read('src/slate.css')
  assert.match(shell,/html,body,#app,\.app,\.app-main,\.app-content\s*\{[\s\S]*?overflow-x:clip/)
  assert.match(css,/@media\(max-width:600px\)/)
  assert.match(css,/#inventory-app \.inv-stock-table\s*\{[\s\S]*?min-width:0/)
  assert.match(css,/#inventory-app \.inv-stock-table tbody tr\s*\{[\s\S]*?display:grid/)
  assert.match(css,/content:attr\(data-label\)/)
  assert.match(dash,/cell\.dataset\.label=titles\[i\]/)
  assert.doesNotMatch(css,/min-width:790px/)
})

test('supply settings open a product-scoped modal instead of jumping down the page',()=>{
  assert.match(dash,/function openSupplySettings\(/)
  assert.match(dash,/node\('dialog','inv-supply-dialog'\)/)
  assert.match(dash,/dialog\.showModal\(\)/)
  assert.match(dash,/mode\.value=row\.mode/)
  assert.match(dash,/threshold\.value=String\(row\.reorderPoint\)/)
  assert.match(dash,/classifyInventoryProduct\(row\.id,supplyMode,reorderPoint\)/)
  assert.match(dash,/trigger\.closest\('tr'\)/)
  assert.match(dash,/replacement\.getBoundingClientRect\(\)\.top-previousTop/)
  assert.match(dash,/replacement\.focus\(\{preventScroll:true\}\)/)
  assert.doesNotMatch(dash,/form\?\.scrollIntoView\(/)
  assert.doesNotMatch(dash,/select\.value=button\.dataset\.product/)
  assert.match(read('src/champagne.css'),/\.inv-supply-dialog::backdrop/)
})
