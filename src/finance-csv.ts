import type {MonthlyPnlReport,MonthlyPnlRow} from './services/monthly-pnl'
import type {ReconciliationSnapshot} from './services/reconciliation'

// CSVs are generated only in the authenticated owner's Core browser.
// No server writes, analytics, or public export endpoints are involved.
type Value=string|number|boolean|null|undefined
const CRLF='\r\n'
const column=(value:Value):string=>{
 if(value===null||value===undefined)return ''
 if(typeof value==='number')return Number.isFinite(value)?String(value):''
 if(typeof value==='boolean')return value?'true':'false'
 let text=value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,' ')
 // Excel/Sheets can interpret even a quoted string as a spreadsheet formula.
 // Protect all untrusted text, including prefixed whitespace and Unicode lookalikes.
 if(/^[\s\uFEFF]*[=+@\-\uFF1D\uFF0B\uFF20]/.test(text))text="'"+text
 return '"'+text.replace(/"/g,'""')+'"'
}
export function toCsv(columns:readonly string[],rows:Value[][]):string{
 if(rows.some(row=>row.length!==columns.length))
  throw new Error('CSV row/column mismatch: export cancelled rather than creating a misleading file')
 return '\uFEFF'+[columns,...rows].map(row=>row.map(column).join(',')).join(CRLF)+CRLF
}
const n=(value:unknown):number|null=>{
 if(value===null||value===undefined||value==='')return null
 const num=Number(value)
 return Number.isFinite(num)?Math.round(num*100)/100:null
}
// Keep precisely the months shown on the dashboard. Current and past months
// are available; future empty months are not represented as actual activity.
export function visiblePnlMonths(data:MonthlyPnlReport):MonthlyPnlRow[]{
 const dt=new Date(data.generated_at)
 const parts=new Intl.DateTimeFormat('en-US',{
  timeZone:data.timezone,year:'numeric',month:'2-digit'
 }).formatToParts(dt)
 const thisMonth=(parts.find(p=>p.type==='year')?.value||String(data.year))+'-'+
  (parts.find(p=>p.type==='month')?.value||'12')
 return data.months.filter(row=>row.month<=thisMonth)
}
const PNL_COLUMNS=[
 'month','currency','report_timezone','generated_at','paid_orders',
 'paid_order_total_including_tax','product_gross_sales','product_discounts',
 'customer_shipping_revenue','customer_checkout_processing_fee_revenue',
 'sales_tax_collected_excluded','revenue_excluding_tax','original_cost_lines',
 'evidence_backed_cost_lines','missing_cost_lines','uncosted_product_sales',
 'documented_cost_of_goods_sold','merchant_processor_expenses_paid',
 'merchant_outbound_shipping_paid','other_operating_expenses_paid',
 'total_operating_expenses_paid','operating_result_only_if_costs_complete',
 'cost_coverage_status','missing_order_items','subtotal_discrepancies',
 'order_total_discrepancies','planned_expenses_excluded',
 'inventory_purchase_cash_excluded','vendor_purchase_order_commitments_excluded',
 'undated_paid_orders_excluded_from_months',
 'undated_paid_order_total_excluded_from_months',
 'expense_completeness_warning','report_scope'
] as const
export function monthlyPnlCsv(data:MonthlyPnlReport):string{
 const rows=visiblePnlMonths(data).map(row=>{
  const incomplete=row.coverage_status!=='costs_recorded'
  const warnings=[
   row.missing_cost_lines>0?'MISSING_HISTORICAL_COSTS':'',
   row.orders_without_items>0?'MISSING_ORDER_ITEMS':'',
   row.mismatched_product_subtotals>0?'PRODUCT_SUBTOTAL_MISMATCH':'',
   row.mismatched_order_totals>0?'ORDER_TOTAL_MISMATCH':'',
   // A zero posted merchant fee is not proof that a processor charged nothing.
   row.processor_expenses===0?'PROCESSOR_FEES_NOT_RECORDED':'',
   row.outbound_shipping_expenses===0?'OUTBOUND_DELIVERY_COSTS_NOT_RECORDED':''
  ].filter(Boolean).join(';')
  return [
   row.month,'USD',data.timezone,data.generated_at,row.paid_orders,
   n(row.paid_order_total),n(row.product_gross),n(row.product_discounts),
   n(row.customer_shipping),n(row.buyer_processing_fees),
   n(row.tax_collected),n(row.revenue_ex_tax),row.original_cost_lines,
   row.evidenced_cost_lines,row.missing_cost_lines,n(row.uncosted_sales),
   n(row.recorded_cogs),n(row.processor_expenses),
   n(row.outbound_shipping_expenses),n(row.other_operating_expenses),
   n(row.recorded_operating_expenses),
   incomplete||row.recorded_operating_result===null?null:n(row.recorded_operating_result),
   row.coverage_status,row.orders_without_items,
   row.mismatched_product_subtotals,row.mismatched_order_totals,
   n(row.planned_expenses),n(row.excluded_inventory_cash),
   n(row.po_commitments),data.undated.paid_orders,n(data.undated.order_total),
   warnings,
   'RECORD_BASED_NOT_BANK_RECONCILED_NOT_CERTIFIED_NET_PROFIT'
  ] as Value[]
 })
 return toCsv(PNL_COLUMNS,rows)
}

const REVIEW_COLUMNS=[
 'record_type','review_status','order_number','order_id','order_item_id',
 'product_code','product_name','quantity','sale_line_amount',
 'purchase_order_number','purchase_order_id','vendor_name','po_committed_value',
 'linked_paid_expenses','linked_planned_expenses','po_minus_paid_entries',
 'expense_id','expense_payee','expense_category','expense_amount','expense_status',
 'evidenced_unit_cost','documented_paid_at','evidence_reference','notes',
 'updated_at','report_generated_at','accounting_scope'
] as const
type ReviewRow=Partial<Record<typeof REVIEW_COLUMNS[number],Value>>
export function reconciliationCsv(data:ReconciliationSnapshot):string{
 const collected:ReviewRow[]=[]
 for(const x of data.missing_costs)collected.push({
  record_type:'HISTORICAL_COST',review_status:'MISSING_EVIDENCE',
  order_number:x.order_number,order_id:x.order_id,order_item_id:x.id,
  product_code:x.product_code,product_name:x.product_name,
  quantity:x.quantity,sale_line_amount:n(x.sales)
 })
 for(const x of data.reviewed_costs)collected.push({
  record_type:'HISTORICAL_COST',review_status:'EVIDENCE_RECORDED',
  order_number:x.order_number,order_id:x.order_id,order_item_id:x.id,
  product_code:x.product_code,product_name:x.product_name,
  quantity:x.quantity,sale_line_amount:n(x.sales),
  evidenced_unit_cost:n(x.evidence?.unit_cost),
  evidence_reference:x.evidence?.evidence_reference,
  notes:x.evidence?.explanation,updated_at:x.evidence?.updated_at
 })
 for(const x of data.missing_dates)collected.push({
  record_type:'PAID_DATE',review_status:'MISSING_EVIDENCE',
  order_number:x.order_number,order_id:x.id,sale_line_amount:n(x.total)
 })
 for(const x of data.reviewed_dates)collected.push({
  record_type:'PAID_DATE',review_status:'EVIDENCE_RECORDED',
  order_number:x.order_number,order_id:x.id,
  sale_line_amount:n(x.total),documented_paid_at:x.evidence?.effective_paid_at,
  evidence_reference:x.evidence?.evidence_reference,
  notes:x.evidence?.explanation,updated_at:x.evidence?.updated_at
 })
 for(const x of data.purchase_matches)collected.push({
  record_type:'PURCHASE_ORDER',
  review_status:x.linked_expenses.length===0?'NO_LINKED_EXPENSE':
   x.difference!==0?'AMOUNT_NEEDS_REVIEW':'AMOUNTS_ALIGN_NOT_PAYMENT_VERIFIED',
  purchase_order_number:x.number,purchase_order_id:x.id,vendor_name:x.vendor_name,
  po_committed_value:n(x.total),linked_paid_expenses:n(x.paid_total),
  linked_planned_expenses:n(x.planned_total),
  po_minus_paid_entries:n(x.difference)
 })
 // Unlinked general overhead is not itself a bookkeeping discrepancy.
 for(const x of data.unmatched_expenses.filter(x=>
  x.status!=='voided'&&['inventory_purchase','vendor_shipping'].includes(x.category)))collected.push({
   record_type:'INVENTORY_EXPENSE',review_status:'NOT_LINKED_TO_PURCHASE_ORDER',
   expense_id:x.id,expense_payee:x.payee,expense_category:x.category,
   expense_amount:n(x.amount),expense_status:x.status,
   evidence_reference:x.reference_number,notes:x.notes,updated_at:x.updated_at
  })
 const rows=collected.map(x=>REVIEW_COLUMNS.map(k=>k==='report_generated_at'?data.generated_at:
   k==='accounting_scope'?'REVIEW_ONLY_NOT_PAYMENT_VERIFICATION':x[k]??null))
 return toCsv(REVIEW_COLUMNS,rows)
}
export function downloadCsv(content:string,filename:string){
 if(!/^science-by-hugs-(monthly-pnl|reconciliation)-[0-9]{4}(-[0-9]{2}-[0-9]{2})?\.csv$/.test(filename))
  throw new Error('Unexpected financial export filename')
 const blob=new Blob([content],{type:'text/csv;charset=utf-8'})
 const url=URL.createObjectURL(blob)
 const link=document.createElement('a')
 link.href=url
 link.download=filename
 link.rel='noopener'
 link.style.display='none'
 document.body.appendChild(link)
 try{link.click()}finally{
  link.remove()
  // Safari/PWA file downloads may still be reading the Blob when click returns.
  window.setTimeout(()=>URL.revokeObjectURL(url),60000)
 }
}
