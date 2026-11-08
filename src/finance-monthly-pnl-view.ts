import {loadMonthlyPnl,type MonthlyPnlReport,type MonthlyPnlRow} from './services/monthly-pnl'

type Helpers={
 escapeHtml:(value:unknown)=>string
 money:(value:string|number|null|undefined)=>string
}
let selectedYear:number|null=null
let loadVersion=0

export function monthlyPnlPageMarkup(){
 return '<section id="finance-monthly-pnl" class="finance-monthly-pnl" aria-label="Monthly profit and loss">' +
  '<div class="loading">Loading monthly business performance…</div></section>'
}
function sum(rows:MonthlyPnlRow[],key:keyof MonthlyPnlRow){
 return rows.reduce((t,row)=>t+Number(row[key]||0),0)
}
function view(data:MonthlyPnlReport,h:Helpers){
 const root=document.querySelector<HTMLElement>('#finance-monthly-pnl')
 if(!root)return
 const e=h.escapeHtml,money=h.money
 const currentMonth=new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit'})
  .format(new Date(data.generated_at)).slice(0,7)
 const visible=data.months.filter(row=>row.month<=currentMonth)
 const active=visible.filter(row=>row.paid_orders>0||row.paid_expense_records>0||row.planned_expenses>0||row.purchase_orders>0)
 const allRevenue=sum(visible,'revenue_ex_tax')
 const allProductNet=sum(visible,'product_gross')-sum(visible,'product_discounts')
 const knownCogs=sum(visible,'recorded_cogs')
 const operatingExpenses=sum(visible,'recorded_operating_expenses')
 const missingCosts=sum(visible,'missing_cost_lines')
 const saleLines=sum(visible,'item_lines')
 const recordedLines=sum(visible,'original_cost_lines')+sum(visible,'evidenced_cost_lines')
 const mathIssues=sum(visible,'orders_without_items')+sum(visible,'mismatched_product_subtotals')+sum(visible,'mismatched_order_totals')
 const fullYearWithOrders=active.filter(row=>row.paid_orders>0)
 const verifiedAll=fullYearWithOrders.length>0&&fullYearWithOrders.every(row=>row.coverage_status==='costs_recorded')
 const yearResult=verifiedAll?allRevenue-knownCogs-operatingExpenses:null
 const pctCoverage=saleLines>0?Math.round(recordedLines/saleLines*100):0
 const maxRevenue=Math.max(1,...visible.map(row=>Number(row.revenue_ex_tax)))
 const rows=visible.map(row=>{
  const monthLabel=new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'})
   .format(new Date(row.month+'-01T12:00:00Z'))
  const complete=row.coverage_status==='costs_recorded'
  const costStatus=row.paid_orders?
   complete?'Costed sales verified':'Cost review needed':
   row.paid_expense_records?'Expenses only':'No paid sales'
  const barWidth=Math.max(0,Math.min(100,Math.round(Number(row.revenue_ex_tax)/maxRevenue*100)))
  return '<details class="pnl-month'+(row.coverage_status==='incomplete'?' pnl-month-incomplete':'')+'">'+
   '<summary><div class="pnl-month-label"><strong>'+e(monthLabel)+'</strong>'+
     '<small>'+row.paid_orders+' paid orders · '+costStatus+'</small></div>'+
     '<div class="pnl-month-amount"><strong>'+money(row.revenue_ex_tax)+'</strong>'+
       '<small>Revenue excl. tax</small></div></summary>'+
   '<div class="pnl-month-expanded">'+
     '<div class="pnl-revenue-bar" aria-hidden="true"><span style="width:'+barWidth+'%"></span></div>'+
     '<div class="pnl-breakdown">'+
       '<div><span>Gross product sales</span><strong>'+money(row.product_gross)+'</strong></div>'+
       '<div><span>Product discounts</span><strong>−'+money(row.product_discounts)+'</strong></div>'+
       '<div><span>Customer shipping collected</span><strong>'+money(row.customer_shipping)+'</strong></div>'+
       '<div><span>Checkout fees charged to customers</span><strong>'+money(row.buyer_processing_fees)+'</strong></div>'+
       '<div class="pnl-breakdown-total"><span>Order revenue excluding tax</span><strong>'+money(row.revenue_ex_tax)+'</strong></div>'+
       '<div><span>Sales tax collected (excluded)</span><strong>'+money(row.tax_collected)+'</strong></div>'+
       '<div><span>Recorded sale-time product costs</span><strong>−'+money(row.recorded_cogs)+'</strong></div>'+
       '<div><span>Payment processor costs · paid ledger</span><strong>−'+money(row.processor_expenses)+'</strong></div>'+
       '<div><span>Outbound delivery expenses · paid ledger</span><strong>−'+money(row.outbound_shipping_expenses)+'</strong></div>'+
       '<div><span>Other paid operating expenses</span><strong>−'+money(row.other_operating_expenses)+'</strong></div>'+
       '<div class="pnl-breakdown-total"><span>Recorded operating result</span><strong>'+
         (row.recorded_operating_result===null?'Not available':money(row.recorded_operating_result))+'</strong></div>'+
     '</div>'+
     '<div class="pnl-month-foot">'+
       '<strong>'+row.original_cost_lines+' original + '+row.evidenced_cost_lines+
         ' evidenced cost lines · '+row.missing_cost_lines+' missing</strong>'+
       (row.missing_cost_lines?'<p>'+money(row.uncosted_sales)+
         ' of product-line sales have no recorded cost. Result intentionally withheld.</p>':'')+
       (row.orders_without_items||row.mismatched_order_totals||row.mismatched_product_subtotals?
         '<p>Order/item totals need review before a reliable result can be shown.</p>':'')+
       '<p>Inventory purchase orders '+money(row.po_commitments)+' ('+row.purchase_orders+
        ') and inventory-related payments '+money(row.excluded_inventory_cash)+
        ' are shown for context only and <strong>not deducted again</strong>.'+
        (row.planned_expenses?' Planned expenses '+money(row.planned_expenses)+' are also excluded.':'')+'</p>'+
       '<p>Paid-order gross total including sales tax: '+money(row.paid_order_total)+'.</p>'+
     '</div>'+
   '</div></details>'
 }).join('')
 const hasPaidProcessing=visible.some(row=>row.processor_expenses>0)
 const hasPaidDelivery=visible.some(row=>row.outbound_shipping_expenses>0)
 const exclusions=sum(visible,'excluded_inventory_cash')
 const poTotal=sum(visible,'po_commitments')
 root.innerHTML=
  '<div class="dashboard-section-head"><div><span class="eyebrow">FINANCIAL PERFORMANCE · MONTH BY MONTH</span>'+
   '<h2>Monthly Profit & Loss</h2></div>'+
   '<label class="pnl-year-label"><span>Year</span><select class="pnl-year" aria-label="Financial reporting year">'+
     data.years.map(y=>'<option value="'+y+'"'+(y===data.year?' selected':'')+'>'+y+'</option>').join('')+
   '</select></label></div>'+
  '<p class="pnl-intro">A record-based view of paid orders, known product costs, and manually recorded paid expenses. '+
  'Not bank reconciliation or a certified net-profit statement.</p>'+
  '<div class="pnl-key-figures">'+
   '<div><span>Paid-order revenue · excluding tax</span><strong>'+money(allRevenue)+'</strong>'+
     '<small>Net products '+money(allProductNet)+' + customer shipping and fees</small></div>'+
   '<div><span>Recorded cost of goods sold</span><strong>'+money(knownCogs)+'</strong>'+
     '<small>'+recordedLines+' of '+saleLines+' sold lines have native or evidenced costs</small></div>'+
   '<div><span>Paid operating expenses</span><strong>'+money(operatingExpenses)+'</strong>'+
     '<small>Only expenses manually marked paid</small></div>'+
   '<div class="pnl-result"><span>Recorded operating result</span><strong>'+
     (yearResult===null?'—':money(yearResult))+'</strong>'+
     '<small>'+(yearResult===null?
       'Unavailable until missing sale costs and order mismatches are resolved':
       'Based on documented amounts only · not certified net profit')+'</small></div>'+
  '</div>'+
  '<section class="pnl-quality" aria-label="Financial record completeness">'+
   '<div class="pnl-quality-head"><strong>Historical product-cost coverage</strong>'+
     '<span>'+recordedLines+' / '+saleLines+' lines · '+pctCoverage+'%</span></div>'+
   '<div class="pnl-meter" role="progressbar" aria-label="Paid sale lines with documented cost" '+
      'aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pctCoverage+'">'+
     '<span style="width:'+pctCoverage+'%"></span></div>'+
   '<p>'+(missingCosts?
     missingCosts+' sold lines still need historical evidence. ':
     saleLines?'All listed sold lines have documented costs. ':'No sold lines this year. ')+
     (mathIssues?mathIssues+' order subtotal/line-item discrepancies need review. ':'')+
     (data.undated.paid_orders?data.undated.paid_orders+' paid orders ('+
       money(data.undated.order_total)+') have no verified payment date and cannot be assigned to a month. ':'')+
     'A zero recorded expense does not prove the business had no cost.</p>'+
  '</section>'+
  '<div class="pnl-gap-note"><strong>Expenses not yet confirmed:</strong> '+
    (!hasPaidProcessing?'No manually paid processor-fee expenses have been entered. ':'')+
    (!hasPaidDelivery?'No outbound delivery expenses have been entered. ':'')+
    'If those costs occurred, record them under Expenses & vendor spending rather than estimating them.'+
  '</div>'+
  '<div class="pnl-month-header"><h3>Monthly breakdown</h3><span>Tap a month for details</span></div>'+
  '<div class="pnl-months">'+(rows||'<p class="finance-empty">No financial records for this year.</p>')+'</div>'+
  '<details class="pnl-separation"><summary>What is excluded from profit?</summary>'+
   '<p>Customer sales tax ('+money(sum(visible,'tax_collected'))+') is excluded from revenue. '+
     'Inventory purchase payments ('+money(exclusions)+') and supplier purchase orders ('+
     money(poTotal)+') are not charged against cost of goods sold a second time. '+
     'Unpaid planned expenses are also excluded. Actual bank deposits, refunds, unrecorded '+
     'processor charges, inventory valuation, depreciation, liabilities, and taxes payable need '+
     'separate accounting reconciliation.</p>'+
  '</details>'+
  '<nav class="pnl-actions" aria-label="Financial report actions">'+
   '<button type="button" data-pnl-reconcile>Resolve missing records</button>'+
   '<button type="button" data-pnl-expenses>Record expenses</button>'+
  '</nav>'+
  '<p class="pnl-generated">Based on records as of '+e(new Date(data.generated_at).toLocaleString())+
    '. Reporting months use '+e(data.timezone)+'.</p>'
 root.querySelector<HTMLSelectElement>('.pnl-year')?.addEventListener('change',event=>{
  const next=Number((event.currentTarget as HTMLSelectElement).value)
  if(data.years.includes(next)){
   selectedYear=next
   void bindMonthlyPnl(h)
  }
 })
 root.querySelector<HTMLButtonElement>('[data-pnl-reconcile]')?.addEventListener('click',()=>{
  document.getElementById('finance-reconciliation')?.scrollIntoView({behavior:'smooth',block:'start'})
 })
 root.querySelector<HTMLButtonElement>('[data-pnl-expenses]')?.addEventListener('click',()=>{
  document.getElementById('finance-expenses')?.scrollIntoView({behavior:'smooth',block:'start'})
 })
}
export async function bindMonthlyPnl(h:Helpers){
 const el=document.querySelector<HTMLElement>('#finance-monthly-pnl')
 if(!el)return
 const v=++loadVersion
 el.innerHTML='<div class="loading">Loading monthly Profit & Loss…</div>'
 try{
  const report=await loadMonthlyPnl(selectedYear??undefined)
  if(v!==loadVersion||!el.isConnected)return
  selectedYear=report.year
  view(report,h)
 }catch(err){
  if(v!==loadVersion||!el.isConnected)return
  const message=h.escapeHtml(err instanceof Error?err.message:'Could not load the monthly report')
  el.innerHTML='<div class="pnl-error"><h2>Monthly report unavailable</h2><p>'+
    message+'</p><p>No financial records were changed.</p>'+
    '<button class="primary" type="button" data-pnl-retry>Retry report</button></div>'
  el.querySelector<HTMLButtonElement>('[data-pnl-retry]')?.addEventListener('click',()=>{
   void bindMonthlyPnl(h)
  })
 }
}
