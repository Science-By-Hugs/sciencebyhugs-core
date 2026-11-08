import {
  loadReconciliation,recordReconciliation,
  type ReconciliationSnapshot,type MissingCost,type MissingDate
} from './services/reconciliation'
import {downloadCsv,reconciliationCsv} from './finance-csv'
import {groupMissingCosts,purchaseReviewStatus,sortCostGroups} from './finance-reconciliation-triage'
import {saveCoreExpense} from './services/expenses'

type Helpers={
  escapeHtml:(v:unknown)=>string
  money:(v:string|number|null|undefined)=>string
  dateTime:(v:string|null|undefined)=>string
}
const localDateTime=(value:string)=>{
  const d=new Date(value)
  return Number.isNaN(d.getTime())?'':new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)
}
let notice=''
export function reconciliationPageMarkup(){
  return '<section id="finance-reconciliation" class="finance-panel finance-reconcile" aria-label="Financial reconciliation">' +
    '<div class="loading">Checking financial records…</div></section>'
}

function costCard(item:MissingCost,h:Helpers){
  const e=h.escapeHtml
  const source=item.evidence
  return '<article class="reconcile-record">' +
    '<div class="reconcile-record-head"><div><strong>'+e(item.order_number)+'</strong>'+
      '<small>'+e(item.product_name)+' · Qty '+Number(item.quantity)+'</small></div>'+
      '<strong>'+h.money(item.sales)+' sale</strong></div>'+
    '<details class="reconcile-edit"><summary>'+(source?'Review / correct evidence':'Add historical cost evidence')+'</summary>'+
      '<form class="reconcile-evidence-form" data-kind="historical_cost" data-id="'+e(item.id)+
        '" data-version="'+e(source?.updated_at||'')+'">' +
        '<p class="reconcile-hint">Use an invoice or documented vendor cost from the <strong>time of this sale</strong>.'+
        ' Do not use today’s cost unless your original records prove it applied then.</p>'+
        '<label>Unit cost at sale (USD) <input name="unitCost" inputmode="decimal" type="number" step="0.01" min="0" max="1000000" required'+
          ' value="'+e(source?.unit_cost??'')+'" placeholder="0.00"></label>'+
        '<label>Evidence reference <input name="reference" required minlength="6" maxlength="200" '+
          'placeholder="Invoice #, vendor receipt # or archived document" value="'+e(source?.evidence_reference||'')+'"></label>'+
        '<label>Notes <textarea name="notes" maxlength="1000" rows="2" placeholder="Why this cost is supported">'+
          e(source?.explanation||'')+'</textarea></label>'+
        '<label class="reconcile-evidence-check"><input type="checkbox" required> I checked the supporting records. This is not an estimate.</label>'+
        '<div class="reconcile-actions"><button class="primary" type="submit">'+
          (source?'Save audited correction':'Record evidenced cost')+'</button>'+
          '<span class="reconcile-message" role="status"></span></div>'+
      '</form></details></article>'
}
function dateCard(item:MissingDate,h:Helpers){
  const e=h.escapeHtml,source=item.evidence
  return '<article class="reconcile-record"><div class="reconcile-record-head"><div>'+
    '<strong>'+e(item.order_number)+'</strong><small>Order created: '+e(h.dateTime(item.created_at))+'</small></div>'+
    '<strong>'+h.money(item.total)+'</strong></div>'+
    '<details class="reconcile-edit"><summary>'+(source?'Review / correct payment evidence':'Add verified payment date')+'</summary>'+
      '<form class="reconcile-evidence-form" data-kind="payment_date" data-id="'+e(item.id)+
        '" data-version="'+e(source?.updated_at||'')+'">' +
        '<p class="reconcile-hint">Check payment-provider or bank records for the actual payment time.'+
        ' This updates reporting only, not the order or payment record.</p>'+
        '<label>Documented payment date and time <input name="paidDate" type="datetime-local" required'+
          ' value="'+e(source?.effective_paid_at?localDateTime(source.effective_paid_at):'')+'"></label>'+
        '<label>Evidence reference <input name="reference" required minlength="6" maxlength="200" '+
          'placeholder="Verified transaction / settlement reference" value="'+e(source?.evidence_reference||'')+'"></label>'+
        '<label>Notes <textarea name="notes" maxlength="1000" rows="2">'+e(source?.explanation||'')+'</textarea></label>'+
        '<label class="reconcile-evidence-check"><input type="checkbox" required> I verified the payment date against a source record.</label>'+
        '<div class="reconcile-actions"><button class="primary" type="submit">'+
          (source?'Save audited correction':'Record evidenced date')+'</button>'+
          '<span class="reconcile-message" role="status"></span></div>'+
      '</form></details></article>'
}
function render(data:ReconciliationSnapshot,h:Helpers,refresh:()=>void){
  const root=document.querySelector<HTMLElement>('#finance-reconciliation')
  if(!root)return
  const e=h.escapeHtml,s=data.summary
  const totalCosted=s.native_cost_lines+s.reconciled_cost_lines
  const coverage=s.paid_lines?Math.round(totalCosted/s.paid_lines*100):100
  const missing=s.missing_cost_lines+s.missing_paid_dates
  const groupedCosts=sortCostGroups(groupMissingCosts(data.missing_costs),'largest')
  const impactedOrders=new Set(data.missing_costs.map(line=>line.order_id)).size
  const affectedSales=data.missing_costs.reduce((sum,line)=>sum+Number(line.sales||0),0)
  const groupedMarkup=groupedCosts.map(group=>{
    const search=[group.name,group.productCode||'',...group.lines.map(line=>line.order_number)]
      .join(' ').toLocaleLowerCase('en-US')
    return '<details class="reconcile-cost-group" data-search="'+e(search)+'" '+
      'data-total="'+Number(group.salesAmount).toFixed(2)+'" '+
      'data-lines="'+group.lineCount+'" '+
      'data-oldest="'+e(group.oldestOrderAt)+'" '+
      'data-name="'+e(group.name.toLocaleLowerCase('en-US'))+'">'+
      '<summary><div class="reconcile-cost-group-title"><strong>'+e(group.name)+'</strong>'+
      '<small>'+group.lineCount+' sale line'+(group.lineCount===1?'':'s')+
      ' · '+group.units+' units · '+group.distinctOrders+' order'+(group.distinctOrders===1?'':'s')+
      '</small></div><div class="reconcile-cost-group-value"><strong>'+h.money(group.salesAmount)+
      '</strong><small>sales awaiting cost evidence</small></div></summary>'+
      '<p class="reconcile-hint">Grouping is based on product name and SKU only. '+
      'Costs must be documented separately for each historical sale.</p>'+
      '<div class="reconcile-cost-group-lines">'+
        group.lines.map(line=>costCard(line,h)).join('')+
      '</div></details>'
  }).join('')
  const poRows=data.purchase_matches.map(po=>{
    const linked=po.linked_expenses
    const status=purchaseReviewStatus(po)
    const candidates=data.unmatched_expenses.filter(exp=>
      (!exp.vendor_id||exp.vendor_id===po.vendor_id) &&
      ['inventory_purchase','vendor_shipping','processing_fee'].includes(exp.category))
    return '<article class="reconcile-po"><div class="reconcile-record-head">'+
      '<div><strong>'+e(po.number)+'</strong><small>'+e(po.vendor_name)+' · '+e(po.status)+'</small></div>'+
      '<strong>'+h.money(po.total)+'</strong></div>'+
      '<div class="reconcile-po-facts"><span>Manual paid entries '+h.money(po.paid_total)+'</span>'+
      '<span>Planned entries '+h.money(po.planned_total)+'</span>'+
      '<span class="reconcile-po-status">'+e(status.label)+'</span></div>'+
      '<p class="reconcile-hint">'+e(status.caution)+'</p>'+
      (linked.length?'<p class="reconcile-hint">Linked: '+
        linked.map(x=>e(x.payee)+' ('+h.money(x.amount)+', '+e(x.status)+')').join(' · ')+'</p>':'')+
      '<details class="reconcile-edit"><summary>Match an existing expense</summary>'+
        (po.status==='cancelled'?'<p class="reconcile-hint">Cancelled purchase orders cannot receive new expense matches.</p>':
        candidates.length?
        '<form class="reconcile-match-form" data-po="'+e(po.id)+'" data-vendor="'+e(po.vendor_id)+'">'+
          '<label>Unlinked expense <select name="expense" required><option value="">Select an existing expense</option>'+
            candidates.map(x=>'<option value="'+e(x.id)+'">'+e(x.payee)+' · '+h.money(x.amount)+
              ' · '+e(x.status)+'</option>').join('')+'</select></label>'+
          '<label>Matching evidence reference <input name="matchReference" minlength="6" maxlength="120" required '+
            'placeholder="Receipt / transfer / PO verification reference"></label>'+
          '<p class="reconcile-hint">Links the existing ledger entry to this PO. It does not change the amount,'+
            ' create an expense, or verify a payment.</p>'+
          '<div class="reconcile-actions"><button class="secondary" type="submit">Link expense to PO</button>'+
            '<span class="reconcile-message" role="status"></span></div></form>':
          '<p class="reconcile-hint">There are no unlinked manual expenses for this vendor. Add an expense in Finances first.</p>'+
          '<button type="button" class="secondary reconcile-goto-expenses">Open Expenses</button>')+
      '</details></article>'
  }).join('')
  root.innerHTML=
    '<div class="dashboard-section-head"><div><span class="eyebrow">FINANCIAL ACCURACY</span>'+
      '<h2>Reconciliation Center</h2></div><div class="reconcile-head-actions">'+
       '<span class="reconcile-label">'+missing+' records need evidence</span>'+
       '<button type="button" data-reconcile-export>Download review CSV</button></div></div>'+
    '<p class="reconcile-export-feedback" role="status" aria-live="polite"></p>'+
    '<p class="reconcile-intro">Review original evidence before correcting historical reporting.'+
      ' Each submission is authorized and audited; original orders, payment timestamps and sale-time cost snapshots remain unchanged.</p>'+
    (notice?'<p class="reconcile-notice" role="status">'+e(notice)+'</p>':'')+
    '<div class="reconcile-kpis">'+
      '<div><small>Paid-line cost coverage</small><strong>'+totalCosted+' / '+s.paid_lines+'</strong>'+
        '<span>'+coverage+'% costed (original + evidenced)</span></div>'+
      '<div><small>Missing historical costs</small><strong>'+s.missing_cost_lines+'</strong>'+
        '<span>Requires dated vendor evidence</span></div>'+
      '<div><small>Missing paid dates</small><strong>'+s.missing_paid_dates+'</strong>'+
        '<span>Requires verified payment records</span></div>'+
    '</div>'+
    '<p class="reconcile-scope">A reviewed figure improves financial reporting; it does not verify money reached a bank account.'+
      ' Sale-line gross profit is not net business income. Purchase orders are commitments, not proof of payment.</p>'+
    '<div class="reconcile-sections">'+
      '<details class="reconcile-section"'+(s.missing_paid_dates?' open':'')+'><summary>'+
        '<span>Payment dates needing evidence</span><strong>'+s.missing_paid_dates+'</strong></summary>'+
        '<div class="reconcile-records">'+
          (data.missing_dates.length?data.missing_dates.map(item=>dateCard(item,h)).join(''):
           '<p class="finance-empty">No unpaid-date corrections need review.</p>')+
        '</div></details>'+
      '<details class="reconcile-section"><summary>'+
        '<span>Historical product costs needing evidence</span><strong>'+s.missing_cost_lines+'</strong></summary>'+
        '<div class="reconcile-cost-overview">'+
          '<strong>'+s.missing_cost_lines+' lines across '+impactedOrders+' paid orders</strong>'+
          '<p>'+h.money(affectedSales)+' of product-line sales still need historical cost evidence. '+
          'That is affected revenue, <strong>not an estimated product cost or debt.</strong></p>'+
          '<p>Product names differing only in capitalization or spacing are grouped for easier review. '+
          'Do not assume shared supplier costs or reuse an invoice without checking the date and lot.</p>'+
        '</div>'+
        '<div class="reconcile-cost-controls">'+
          '<label>Find a product or order<input type="search" class="reconcile-cost-search" '+
            'placeholder="Product or order number" autocomplete="off" aria-label="Find missing historical costs"></label>'+
          '<label>Review order<select class="reconcile-cost-sort" aria-label="Sort missing historical costs">'+
            '<option value="largest">Highest affected sales first</option>'+
            '<option value="most_lines">Most missing lines first</option>'+
            '<option value="oldest">Oldest orders first</option>'+
            '<option value="product">Product name A–Z</option>'+
          '</select></label>'+
        '</div>'+
        '<p class="reconcile-cost-count" aria-live="polite">'+groupedCosts.length+' product-name groups</p>'+
        '<div class="reconcile-cost-groups">'+
          (groupedMarkup||'<p class="finance-empty">No missing cost evidence remains.</p>')+
        '</div></details>'+
      '<details class="reconcile-section"><summary>'+
        '<span>Purchase orders & expense matching</span><strong>'+data.purchase_matches.length+'</strong></summary>'+
        '<p class="reconcile-po-intro">These totals are purchase commitments, not confirmed payments. '+
          'Only link a real expense when the supplier, amount and supporting reference agree. '+
          'A linked expense does not automatically prove settlement.</p>'+
        '<div class="reconcile-records">'+
          (poRows||'<p class="finance-empty">No purchase orders to reconcile.</p>')+
        '</div></details>'+
      '<details class="reconcile-section"><summary>'+
        '<span>Reviewed evidence and corrections</span><strong>'+
          (data.reviewed_costs.length+data.reviewed_dates.length)+'</strong></summary>'+
        '<p class="reconcile-hint">These records have owner-entered supporting references.'+
        ' Corrections remain editable and every revision is logged.</p>'+
        '<div class="reconcile-records">'+
          data.reviewed_dates.map(item=>dateCard(item,h)).join('')+
          data.reviewed_costs.map(item=>costCard(item,h)).join('')+
          (!data.reviewed_dates.length&&!data.reviewed_costs.length?
           '<p class="finance-empty">No historical evidence has been recorded yet.</p>':'')+
        '</div></details>'+
    '</div>'+
    '<p class="reconcile-footnote">Original sale-time cost snapshots take priority when they exist.'+
      ' Core never automatically replaces them with newer product prices. Expense matching never creates duplicate charges.</p>'
  const costSearch=root.querySelector<HTMLInputElement>('.reconcile-cost-search')
  const costSort=root.querySelector<HTMLSelectElement>('.reconcile-cost-sort')
  const costList=root.querySelector<HTMLElement>('.reconcile-cost-groups')
  const updateCostReview=()=>{
    if(!costList)return
    const query=(costSearch?.value||'').trim().toLocaleLowerCase('en-US')
    const nodes=[...costList.querySelectorAll<HTMLDetailsElement>('.reconcile-cost-group')]
    const sort=costSort?.value||'largest'
    nodes.sort((a,b)=>{
      const amount=(n:HTMLElement)=>Number(n.dataset.total||0)
      const count=(n:HTMLElement)=>Number(n.dataset.lines||0)
      if(sort==='most_lines')return count(b)-count(a)||amount(b)-amount(a)
      if(sort==='oldest')return (a.dataset.oldest||'9999').localeCompare(b.dataset.oldest||'9999')
      if(sort==='product')return (a.dataset.name||'').localeCompare(b.dataset.name||'')
      return amount(b)-amount(a)||count(b)-count(a)
    })
    let visible=0
    for(const node of nodes){
      node.hidden=!!query&&!((node.dataset.search||'').includes(query))
      if(!node.hidden)visible++
      costList.appendChild(node)
    }
    const counter=root.querySelector<HTMLElement>('.reconcile-cost-count')
    if(counter)counter.textContent=visible+' of '+nodes.length+' product-name groups shown'
  }
  costSearch?.addEventListener('input',updateCostReview)
  costSort?.addEventListener('change',updateCostReview)
  root.querySelector<HTMLButtonElement>('[data-reconcile-export]')?.addEventListener('click',()=>{
    const feedback=root.querySelector<HTMLElement>('.reconcile-export-feedback')
    try{
      const day=data.generated_at.slice(0,10)
      downloadCsv(reconciliationCsv(data),'science-by-hugs-reconciliation-'+day+'.csv')
      if(feedback)feedback.textContent='Review CSV prepared. It contains sensitive order and vendor details; keep it private.'
    }catch(error){
      if(feedback)feedback.textContent=error instanceof Error?error.message:'CSV export unavailable.'
    }
  })
  root.querySelectorAll<HTMLFormElement>('.reconcile-evidence-form').forEach(form=>{
    form.addEventListener('submit',async event=>{
      event.preventDefault()
      const get=(name:string)=>form.querySelector<HTMLInputElement|HTMLTextAreaElement>(
        '[name="'+name+'"]')?.value.trim()||''
      const kind=form.dataset.kind as 'historical_cost'|'payment_date'
      const dateText=kind==='payment_date'?get('paidDate'):null
      const paidDate=dateText?new Date(dateText):null
      if(paidDate&&Number.isNaN(paidDate.getTime()))return
      if(!window.confirm('I confirm that the original evidence supports this historical '+
        (kind==='historical_cost'?'cost':'payment date')+
        '. Save this audited reporting correction?'))return
      const submit=form.querySelector<HTMLButtonElement>('[type="submit"]')
      const message=form.querySelector<HTMLElement>('.reconcile-message')
      if(submit)submit.disabled=true
      if(message)message.textContent='Saving verified reference…'
      try{
        await recordReconciliation({
          kind,targetId:form.dataset.id||'',
          ...(kind==='historical_cost'?{unitCost:get('unitCost')}:{paidDate:paidDate?.toISOString()}),
          reference:get('reference'),notes:get('notes'),
          expectedUpdatedAt:form.dataset.version||null
        })
        notice='Evidence saved with audit history. Original records remain unchanged.'
        await bindReconciliationPage(h,refresh)
        refresh()
      }catch(error){
        if(message)message.textContent=error instanceof Error?error.message:'Could not save evidence'
        if(submit)submit.disabled=false
      }
    })
  })
  root.querySelectorAll<HTMLFormElement>('.reconcile-match-form').forEach(form=>{
    form.addEventListener('submit',async event=>{
      event.preventDefault()
      const choice=form.querySelector<HTMLSelectElement>('[name="expense"]')?.value||''
      const reference=form.querySelector<HTMLInputElement>('[name="matchReference"]')?.value.trim()||''
      const row=data.unmatched_expenses.find(exp=>exp.id===choice)
      const po=data.purchase_matches.find(x=>x.id===form.dataset.po)
      const message=form.querySelector<HTMLElement>('.reconcile-message')
      if(!row||!po||reference.length<6)return
      if(row.vendor_id&&row.vendor_id!==po.vendor_id){
        if(message)message.textContent='Expense vendor does not match this PO.'
        return
      }
      if(!window.confirm('Link existing expense '+h.money(row.amount)+' to '+po.number+
        '? This does not verify payment or change the amount.'))return
      const button=form.querySelector<HTMLButtonElement>('[type="submit"]')
      if(button)button.disabled=true
      if(message)message.textContent='Linking and auditing…'
      const suffix='PO match evidence: '+reference
      const notes=[row.notes||'',suffix].filter(Boolean).join(' · ')
      if(notes.length>1000){
        if(message)message.textContent='This expense has too many notes to add match evidence. Edit and shorten its notes first.'
        if(button)button.disabled=false
        return
      }
      try{
        await saveCoreExpense({
          id:row.id,payee:row.payee,category:row.category as
            'inventory_purchase'|'vendor_shipping'|'processing_fee'|'software'|
            'marketing'|'packaging'|'supplies'|'operations'|'other',
          expense_date:row.expense_date,amount:String(Number(row.amount).toFixed(2)),
          payment_method:row.payment_method as
            'card'|'bank_transfer'|'paypal'|'zelle'|'cash'|'crypto'|'other',
          status:row.status==='paid'?'paid':'planned',
          vendor_id:po.vendor_id,purchase_order_id:po.id,
          reference_number:row.reference_number||reference,notes
        },row.updated_at)
        notice='Expense linked to purchase order and audited; payment status unchanged.'
        await bindReconciliationPage(h,refresh)
        refresh()
      }catch(error){
        if(message)message.textContent=error instanceof Error?error.message:'Cannot link expense'
        if(button)button.disabled=false
      }
    })
  })
  root.querySelectorAll<HTMLButtonElement>('.reconcile-goto-expenses').forEach(button=>{
    button.addEventListener('click',()=>document.getElementById('finance-expenses')?.scrollIntoView({behavior:'smooth'}))
  })
}
export async function bindReconciliationPage(h:Helpers,refresh:()=>void){
  const el=document.querySelector<HTMLElement>('#finance-reconciliation')
  if(!el)return
  el.innerHTML='<div class="loading">Reviewing evidence and purchase orders…</div>'
  try{
    const data=await loadReconciliation()
    if(el.isConnected)render(data,h,refresh)
  }catch(error){
    if(!el.isConnected)return
    el.innerHTML='<div class="empty-state error-state"><h2>Reconciliation temporarily unavailable</h2><p>'+
      h.escapeHtml(error instanceof Error?error.message:'Could not load review records')+
      '</p><p>No financial records were changed.</p>'+
      '<button type="button" class="primary reconcile-retry">Retry loading</button></div>'
    el.querySelector<HTMLButtonElement>('.reconcile-retry')?.addEventListener('click',()=>{
      void bindReconciliationPage(h,refresh)
    })
  }
}
