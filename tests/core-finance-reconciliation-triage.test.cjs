const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const ts=require('typescript')
const file=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')
const src=file('src/finance-reconciliation-triage.ts')
const js=ts.transpileModule(src,{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,strict:true},
 reportDiagnostics:true
})
assert.equal((js.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0)
const exports={}
new Function('exports','require','module',js.outputText)(exports,require,{exports})
const {groupMissingCosts,sortCostGroups,purchaseReviewStatus}=exports

const item=(id,name,sales,date,extras={})=>({
 id,order_id:'order-'+id,order_number:'ORDER-'+id,product_name:name,
 product_code:null,quantity:1,sales,order_created_at:date,...extras
})
test('Group by display name case/whitespace only, never blend distinct product or SKU names',()=>{
 const a=[
  item('1','Tesamorelin 10mg',40,'2026-10-14'),
  item('2','  TESAMORELIN   10MG  ',50,'2026-10-01'),
  item('3','Tesamorelin 10MG KIT',140,'2026-10-03'),
  item('4','Tesamorelin 10mg',39,'2026-10-07',{product_code:'SBH-OTHER'}),
  item('5','Testosterone 10mg',48,'2026-10-09')
 ]
 const groups=groupMissingCosts(a)
 assert.equal(groups.length,4)
 const t=groups.find(x=>x.lineCount===2)
 assert.equal(t.salesAmount,90)
 assert.equal(t.units,2)
 assert.equal(t.oldestOrderAt,'2026-10-01')
 assert.equal(t.distinctOrders,2)
 assert.equal(t.lines[0].id,'1')
 assert.equal(t.lines[1].id,'2')
 assert.deepEqual(groups.flatMap(x=>x.lines.map(y=>y.id)).sort(),a.map(y=>y.id).sort())
 assert.equal(groups.filter(x=>x.name.includes('KIT')).length,1)
 assert.equal(groups.filter(x=>x.productCode==='SBH-OTHER').length,1)
})
test('Unknown product names remain separate review records, not assumed matching stock',()=>{
 const groups=groupMissingCosts([item('a','',30,'2026-10-04'),item('b','',10,'2026-10-05')])
 assert.equal(groups.length,2)
})
test('All triage sorts retain original input order and never infer a historical unit cost',()=>{
 const input=groupMissingCosts([
  item('1','A',40,'2026-10-10'),item('2','A',50,'2026-10-12'),
  item('3','B',160,'2026-11-01'),item('4','C',10,'2026-09-01')
 ])
 assert.deepEqual(sortCostGroups(input,'largest').map(x=>x.name),['B','A','C'])
 assert.deepEqual(sortCostGroups(input,'most_lines').map(x=>x.name),['A','B','C'])
 assert.deepEqual(sortCostGroups(input,'oldest').map(x=>x.name),['C','A','B'])
 assert.deepEqual(sortCostGroups(input,'product').map(x=>x.name),['A','B','C'])
 assert.deepEqual(input.map(x=>x.name),['A','B','C'])
 assert.ok(!/unitCost|cost_per_unit|historical_cost/.test(src))
})
test('PO review never mistakes matching amounts for payment verification',()=>{
 const basic={status:'received',linked_expenses:[],paid_total:0,planned_total:0,difference:200}
 assert.equal(purchaseReviewStatus(basic).code,'unlinked')
 assert.equal(purchaseReviewStatus({...basic,status:'cancelled'}).code,'cancelled')
 assert.equal(purchaseReviewStatus({...basic,linked_expenses:[{status:'planned'}],planned_total:200}).code,'planned')
 assert.equal(purchaseReviewStatus({...basic,linked_expenses:[{status:'paid'}],paid_total:40,difference:160}).code,'difference')
 const aligned=purchaseReviewStatus({...basic,linked_expenses:[{status:'paid'}],paid_total:200,difference:0})
 assert.equal(aligned.code,'amounts_align')
 assert.match(aligned.label,/not verified/i)
 assert.match(aligned.caution,/not independent proof/i)
})
test('Core reconciliation view provides mobile owner review and remains evidence-by-sale',()=>{
 const ui=file('src/finance-reconciliation-view.ts')
 const css=file('src/champagne.css')
 assert.match(ui,/groupMissingCosts\(data\.missing_costs\)/)
 assert.match(ui,/impactedOrders/)
 assert.match(ui,/affectedSales/)
 assert.match(ui,/reconcile-cost-search/)
 assert.match(ui,/reconcile-cost-sort/)
 assert.match(ui,/reconcile-cost-groups/)
 assert.match(ui,/node\.hidden=/)
 assert.match(ui,/costList\.appendChild\(node\)/)
 assert.match(ui,/group\.lines\.map\(line=>costCard\(line,h\)\)/)
 assert.match(ui,/Do not assume shared supplier costs/)
 assert.match(ui,/status\.caution/)
 assert.match(ui,/not confirmed payments/i)
 assert.match(ui,/recordReconciliation\(/)
 assert.match(ui,/saveCoreExpense\(/)
 assert.match(css,/#finance-reconciliation \.reconcile-cost-group\[hidden\]/)
 assert.match(css,/@media\(max-width:600px\)/)
})
