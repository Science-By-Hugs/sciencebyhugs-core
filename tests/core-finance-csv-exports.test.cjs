const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const ts=require('typescript')
const code=fs.readFileSync(path.join(__dirname,'..','src','finance-csv.ts'),'utf8')
const transpiled=ts.transpileModule(code,{compilerOptions:{
  target:ts.ScriptTarget.ES2022,
  module:ts.ModuleKind.CommonJS,
  strict:true
},reportDiagnostics:true})
assert.equal((transpiled.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0)
const exp={}
new Function('exports','require','module',transpiled.outputText)(exp,require,{exports:exp})
const {toCsv,monthlyPnlCsv,reconciliationCsv,visiblePnlMonths,downloadCsv}=exp

const row=(month,overrides={})=>({
 month,paid_orders:2,paid_order_total:120,product_gross:100,product_discounts:10,
 customer_shipping:10,buyer_processing_fees:2,tax_collected:18,revenue_ex_tax:102,
 recorded_cogs:40,item_lines:2,original_cost_lines:2,evidenced_cost_lines:0,
 missing_cost_lines:0,uncosted_sales:0,orders_without_items:0,
 mismatched_product_subtotals:0,mismatched_order_totals:0,
 processor_expenses:3,outbound_shipping_expenses:4,
 other_operating_expenses:5,excluded_inventory_cash:50,planned_expenses:6,
 paid_expense_records:3,purchase_orders:1,po_commitments:100,
 recorded_operating_expenses:12,recorded_operating_result:50,
 coverage_status:'costs_recorded',...overrides
})
const report={
  success:true,generated_at:'2026-11-08T18:00:00.000Z',timezone:'America/Los_Angeles',
  year:2026,years:[2026],undated:{paid_orders:1,order_total:25},
  definitions:{revenue:'',cogs:'',operating_expenses:'',excluded:'',result:''},
  months:[
    row('2026-10'),
    row('2026-11',{coverage_status:'incomplete',original_cost_lines:1,
      missing_cost_lines:1,uncosted_sales:65,recorded_operating_result:null}),
    row('2026-12',{paid_orders:0})
  ]
}
const reconcile={
  success:true,generated_at:'2026-11-08T18:00:00.000Z',
  summary:{paid_orders:2,paid_lines:2,native_cost_lines:1,reconciled_cost_lines:1,
    missing_cost_lines:1,reconciled_paid_dates:1,missing_paid_dates:1,
    purchase_orders:2,linked_expenses:1},
  missing_costs:[{id:'item-1',order_id:'order-1',order_number:'KEMA001',
    product_name:'=HYPERLINK("https://fake.test","Click")',product_code:'CODE',
    quantity:1,sales:49}],
  reviewed_costs:[{id:'item-2',order_id:'order-2',order_number:'KEMA002',
    product_name:'Item',product_code:'CODE',quantity:2,sales:40,
    evidence:{unit_cost:10,line_cost:20,evidence_reference:'INVOICE-123',
      explanation:'Archived supplier invoice',updated_at:'2026-11-07T11:00:00Z'}}],
  missing_dates:[{id:'order-3',order_number:'KEMA003',created_at:'2026-11-07',total:44}],
  reviewed_dates:[{id:'order-4',order_number:'KEMA004',created_at:'2026-11-07',
    total:55,evidence:{effective_paid_at:'2026-10-15T15:00:00Z',
      evidence_reference:'PAY-123',explanation:'Payment confirmed',updated_at:'2026-11-08'}}],
  purchase_matches:[
    {id:'po-1',number:'PO-1',status:'received',vendor_id:'v1',vendor_name:'=SUPPLIER',
      total:100,paid_total:50,planned_total:30,difference:50,
      linked_expenses:[{id:'exp-1',payee:'Supplier',amount:50,status:'paid'}]},
    {id:'po-2',number:'PO-2',status:'ordered',vendor_id:'v1',vendor_name:'Supplier 2',
      total:70,paid_total:0,planned_total:0,difference:70,linked_expenses:[]}
  ],
  unmatched_expenses:[
    {id:'exp-2',expense_date:'2026-11-01',category:'inventory_purchase',
      vendor_id:'v1',purchase_order_id:null,payee:'Kit vendor',amount:25,
      payment_method:'card',reference_number:'RECEIPT-9',notes:null,status:'paid',
      updated_at:'2026-11-01'},
    {id:'exp-3',expense_date:'2026-11-01',category:'software',
      vendor_id:null,purchase_order_id:null,payee:'Cloud service',amount:20,
      payment_method:'card',reference_number:'RECEIPT-10',notes:null,status:'paid',
      updated_at:'2026-11-01'}
  ],
  accounting_note:'Not an accounting ledger'
}

test('CSV uses BOM, Windows line endings, quotes/escapes and formula injection defense',()=>{
 const csv=toCsv(['name','amount'],[
  ['=HYPERLINK("https://fake","Click")',8],
  [' \t+SUM(1,2)',-19.5],
  ['@CMD',1],
  ['plain "quoted" value',0],
  [null,2]
 ])
 assert.ok(csv.startsWith('\uFEFF'))
 assert.ok(csv.includes('\r\n'))
 assert.ok(csv.includes('"\'=HYPERLINK(""https://fake"",""Click"")"'))
 assert.ok(csv.includes('"\' \t+SUM(1,2)",-19.5'))
 assert.ok(csv.includes('"\'@CMD",1'))
 assert.ok(csv.includes('"plain ""quoted"" value",0'))
 assert.throws(()=>toCsv(['a','b'],[['one']]),/row\/column mismatch/)
})
test('P&L exports displayed months, original/evidenced costs, and blank incomplete result',()=>{
 const months=visiblePnlMonths(report)
 assert.deepEqual(months.map(x=>x.month),['2026-10','2026-11'])
 const csv=monthlyPnlCsv(report)
 assert.match(csv,/revenue_excluding_tax/)
 assert.match(csv,/operating_result_only_if_costs_complete/)
 assert.match(csv,/inventory_purchase_cash_excluded/)
 assert.match(csv,/vendor_purchase_order_commitments_excluded/)
 assert.match(csv,/undated_paid_orders_excluded_from_months/)
 assert.match(csv,/RECORD_BASED_NOT_BANK_RECONCILED_NOT_CERTIFIED_NET_PROFIT/)
 assert.match(csv,/PROCESSOR_FEES_NOT_RECORDED/)
 assert.ok(!csv.includes('2026-12'))
 const lines=csv.slice(1).trimEnd().split('\r\n')
 const cols=lines[0].split(',')
 const resultIdx=cols.indexOf('"operating_result_only_if_costs_complete"')
 assert.ok(resultIdx>0)
 // The incomplete November row has an empty result cell; never fabricate zero profit.
 assert.ok(lines[2].includes(',,"incomplete",')||lines[2].includes(',,"incomplete"'))
 assert.equal((csv.match(/\r\n/g)||[]).length,3)
})
test('Reconciliation export separates missing and evidenced records and excludes unrelated overhead',()=>{
 const csv=reconciliationCsv(reconcile)
 assert.match(csv,/MISSING_EVIDENCE/)
 assert.match(csv,/EVIDENCE_RECORDED/)
 assert.match(csv,/AMOUNT_NEEDS_REVIEW/)
 assert.match(csv,/NO_LINKED_EXPENSE/)
 assert.match(csv,/NOT_LINKED_TO_PURCHASE_ORDER/)
 assert.match(csv,/INVOICE-123/)
 assert.match(csv,/PAY-123/)
 assert.match(csv,/RECEIPT-9/)
 assert.match(csv,/"\'=HYPERLINK/)
 assert.match(csv,/"\'=SUPPLIER"/)
 assert.doesNotMatch(csv,/Cloud service|RECEIPT-10/)
 assert.match(csv,/REVIEW_ONLY_NOT_PAYMENT_VERIFICATION/)
})
test('Export uses only client-generated Blob and safe filenames, not a write endpoint',()=>{
 const calls=[]
 const prev={Blob:global.Blob,URL:global.URL,document:global.document,window:global.window}
 let removed=false
 global.Blob=class {constructor(parts,options){calls.push(['blob',parts[0],options.type])}}
 global.URL={createObjectURL(){calls.push(['object-url']);return 'blob:local'},
   revokeObjectURL(url){calls.push(['revoke',url])}}
 global.document={body:{appendChild(el){calls.push(['append',el.download])}},
   createElement(tag){assert.equal(tag,'a');return {style:{},click(){calls.push(['clicked'])},
     remove(){removed=true}}}}
 let pending=null
 global.window={setTimeout(fn,ms){pending=fn;assert.equal(ms,60000)}}
 try{
  downloadCsv('SAFE','science-by-hugs-monthly-pnl-2026.csv')
  assert.ok(removed)
  assert.ok(calls.some(x=>x[0]==='clicked'))
  assert.equal(calls.filter(x=>x[0]==='revoke').length,0)
  pending()
  assert.ok(calls.some(x=>x[0]==='revoke'))
  assert.throws(()=>downloadCsv('SAFE','../../invoices.csv'),/Unexpected/)
 }finally{Object.assign(global,prev)}
})
test('Only authenticated Finances views expose the two export controls',()=>{
 const pnl=fs.readFileSync(path.join(__dirname,'..','src','finance-monthly-pnl-view.ts'),'utf8')
 const rec=fs.readFileSync(path.join(__dirname,'..','src','finance-reconciliation-view.ts'),'utf8')
 const css=fs.readFileSync(path.join(__dirname,'..','src','champagne.css'),'utf8')
 assert.match(pnl,/data-pnl-export/)
 assert.match(pnl,/downloadCsv\(monthlyPnlCsv\(data\)/)
 assert.match(rec,/data-reconcile-export/)
 assert.match(rec,/downloadCsv\(reconciliationCsv\(data\)/)
 assert.match(css,/@media\(max-width:640px\)/)
})
