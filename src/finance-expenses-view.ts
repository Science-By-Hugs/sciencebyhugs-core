import {
  loadCoreExpenses,saveCoreExpense,voidCoreExpense,
  type FinanceExpense,type FinanceExpenseCategory,type FinancePaymentMethod,
  type FinanceExpenseSnapshot,type ExpenseInput
} from './services/expenses'

type Helpers={
  escapeHtml:(value:unknown)=>string
  money:(value:number|string|null|undefined)=>string
}
type Filter='all'|'month'|'90'
let selectedFilter:Filter='all'
let expenseNotice=''

const CATEGORIES:Array<[FinanceExpenseCategory,string]>=[
  ['inventory_purchase','Vendor merchandise / inventory'],
  ['vendor_shipping','Inbound vendor shipping'],
  ['processing_fee','Payment / processing fee'],
  ['software','Software & services'],
  ['marketing','Marketing'],
  ['packaging','Packaging'],
  ['supplies','Business supplies'],
  ['operations','Operating expense'],
  ['other','Other expense']
]
const METHODS:Array<[FinancePaymentMethod,string]>=[
  ['card','Card'],['bank_transfer','Bank transfer'],['paypal','PayPal'],
  ['zelle','Zelle'],['cash','Cash'],['crypto','Crypto'],['other','Other / not recorded']
]
const categoryName=(value:string)=>CATEGORIES.find(item=>item[0]===value)?.[1]||'Other'
const todayLocal=()=>{
  const d=new Date()
  return [String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')
}
const withinFilter=(date:string,period:Filter)=>{
  if(period==='all')return true
  if(period==='month')return date.slice(0,7)===todayLocal().slice(0,7)
  const start=new Date()
  start.setHours(0,0,0,0)
  start.setDate(start.getDate()-89)
  const min=[start.getFullYear(),String(start.getMonth()+1).padStart(2,'0'),String(start.getDate()).padStart(2,'0')].join('-')
  return date.slice(0,10)>=min&&date.slice(0,10)<=todayLocal()
}
const amount=(value:number|string)=>Math.round(Number(value||0)*100)/100

export function expensesPageMarkup(){
  return '<section class="finance-expenses-area" id="finance-expenses" aria-label="Expenses and vendor spending">' +
    '<div class="loading">Loading expenses and vendor purchase orders…</div></section>'
}
function selectOptions(options:Array<[string,string]>,current:string,escape:Helpers['escapeHtml']){
  return options.map(([value,label])=>'<option value="'+escape(value)+'"'+
    (value===current?' selected':'')+'>'+escape(label)+'</option>').join('')
}
function expenseForm(e:FinanceExpense|null,data:FinanceExpenseSnapshot,helpers:Helpers){
  const h=helpers.escapeHtml
  const poOptions:Array<[string,string]>=[['','Not linked to a purchase order'],
    ...data.purchase_orders.map(po=>[po.id,po.po_number+' · '+(data.vendors.find(v=>v.id===po.vendor_id)?.name||'Vendor')])]
  const vendorOptions:Array<[string,string]>=[['','No linked Core vendor'],
    ...data.vendors.map(v=>[v.id,v.name])]
  return '<form class="core-expense-form" data-id="'+h(e?.id||'')+
    '" data-version="'+h(e?.updated_at||'')+'">' +
    '<div class="expense-form-grid">'+
      '<label><span>Payee / business name</span><input name="payee" required maxlength="120" '+
        'placeholder="Who did you pay?" value="'+h(e?.payee||'')+'"></label>'+
      '<label><span>Category</span><select name="category" required>'+
        selectOptions(CATEGORIES,e?.category||'operations',h)+'</select></label>'+
      '<label><span>Amount (USD)</span><input name="amount" type="number" min="0.01" max="1000000" '+
        'step="0.01" inputmode="decimal" required placeholder="0.00" value="'+
        h(e?Number(e.amount).toFixed(2):'')+'"></label>'+
      '<label><span>Expense date</span><input name="expense_date" type="date" required value="'+h(e?.expense_date||todayLocal())+'"></label>'+
      '<label><span>Status</span><select name="status">'+
        selectOptions([['planned','Planned / not confirmed paid'],['paid','Paid (manual record)']],
          e?.status==='paid'?'paid':'planned',h)+'</select></label>'+
      '<label><span>Payment method</span><select name="payment_method">'+
        selectOptions(METHODS,e?.payment_method||'other',h)+'</select></label>'+
      '<label><span>Core supplier (optional)</span><select name="vendor_id">'+
        selectOptions(vendorOptions,e?.vendor_id||'',h)+'</select></label>'+
      '<label><span>Core purchase order (optional)</span><select name="purchase_order_id">'+
        selectOptions(poOptions,e?.purchase_order_id||'',h)+'</select></label>'+
      '<label><span>Reference / receipt ID</span><input name="reference_number" maxlength="120" '+
        'placeholder="Optional transaction reference" value="'+h(e?.reference_number||'')+'"></label>'+
      '<label class="expense-form-wide"><span>Notes</span><textarea name="notes" rows="2" maxlength="1000" '+
        'placeholder="What was this purchase for?">'+h(e?.notes||'')+'</textarea></label>'+
    '</div>'+
    '<p class="expense-form-guidance">Paid means <strong>you manually marked this expense as paid</strong>.'+
      ' It does not verify a bank payment. Linking a PO is for reference only; no stock, COGS or checkout changes occur.</p>'+
    '<div class="expense-form-actions"><button class="primary" type="submit">'+
      (e?'Save expense changes':'Save expense')+'</button>'+
      '<span class="expense-form-message" role="status" aria-live="polite"></span></div>'+
  '</form>'
}
function render(data:FinanceExpenseSnapshot,helpers:Helpers){
  const root=document.querySelector<HTMLElement>('#finance-expenses')
  if(!root)return
  const h=helpers.escapeHtml
  const money=helpers.money
  const all=data.expenses.filter(e=>withinFilter(e.expense_date,selectedFilter))
  const active=all.filter(e=>e.status!=='voided')
  const paid=active.filter(e=>e.status==='paid')
  const planned=active.filter(e=>e.status==='planned')
  const paidTotal=paid.reduce((sum,e)=>sum+amount(e.amount),0)
  const plannedTotal=planned.reduce((sum,e)=>sum+amount(e.amount),0)
  const orders=data.purchase_orders.filter(po=>
    po.status!=='cancelled'&&withinFilter(po.ordered_at,selectedFilter))
  const totalPO=orders.reduce((sum,po)=>
    sum+amount(po.merchandise_total)+amount(po.inbound_shipping)+amount(po.fees),0)
  const poMerchandise=orders.reduce((sum,po)=>sum+amount(po.merchandise_total),0)
  const poShipping=orders.reduce((sum,po)=>sum+amount(po.inbound_shipping),0)
  const poFees=orders.reduce((sum,po)=>sum+amount(po.fees),0)
  const vendorById=new Map(data.vendors.map(v=>[v.id,v.name]))
  const byVendor=new Map<string,{count:number,total:number}>()
  for(const exp of paid){
    if(!exp.vendor_id&&exp.category!=='inventory_purchase'&&exp.category!=='vendor_shipping')continue
    const name=(exp.vendor_id&&vendorById.get(exp.vendor_id))||exp.payee
    const previous=byVendor.get(name)||{count:0,total:0}
    byVendor.set(name,{count:previous.count+1,total:previous.total+amount(exp.amount)})
  }
  const vendorRows=[...byVendor.entries()].sort((a,b)=>b[1].total-a[1].total)
  const purchaseList=orders.map(po=>{
    const vendor=vendorById.get(po.vendor_id)||'Unknown vendor'
    const total=amount(po.merchandise_total)+amount(po.inbound_shipping)+amount(po.fees)
    return '<article class="expense-po-row"><div><strong>'+h(po.po_number)+'</strong>'+
      '<small>'+h(vendor)+' · '+h(po.ordered_at.slice(0,10))+'</small></div>'+
      '<div class="expense-po-right"><strong>'+money(total)+'</strong>'+
        '<small>'+h(po.status.replaceAll('_',' '))+'</small></div>'+
      '<small class="expense-po-breakdown">Products '+money(po.merchandise_total)+
      ' · Shipping '+money(po.inbound_shipping)+' · Fees '+money(po.fees)+'</small></article>'
  }).join('')
  const expenseRows=all.map(e=>{
    const isVoid=e.status==='voided'
    const label=e.status==='paid'?'Paid · manual':isVoid?'Voided':'Planned'
    return '<article class="expense-entry'+(isVoid?' expense-entry-void':'')+'">'+
      '<div class="expense-entry-head"><div><strong>'+h(e.payee)+'</strong>'+
        '<small>'+h(categoryName(e.category))+' · '+h(e.expense_date)+'</small></div>'+
        '<div class="expense-entry-end"><strong>'+money(e.amount)+'</strong>'+
          '<span class="expense-status expense-status-'+h(e.status)+'">'+label+'</span></div></div>'+
      ((e.purchase_order_id||e.reference_number)?
        '<p class="expense-entry-meta">'+
        (e.purchase_order_id?'Linked PO: '+h(data.purchase_orders.find(po=>po.id===e.purchase_order_id)?.po_number||'PO')+' · ':'')+
        (e.reference_number?'Ref: '+h(e.reference_number):'')+'</p>':'')+
      (e.notes?'<p class="expense-entry-meta">'+h(e.notes)+'</p>':'')+
      (!isVoid?'<div class="expense-entry-actions"><details class="expense-edit">' +
        '<summary>Edit expense</summary>'+expenseForm(e,data,helpers)+'</details>'+
        '<button type="button" class="expense-void" data-void-id="'+h(e.id)+'">Void</button></div>':'')+
    '</article>'
  }).join('')
  root.innerHTML=
    '<div class="report-section-heading"><div><span class="eyebrow">BUSINESS COSTS</span>'+
      '<h2>Expenses & vendor spending</h2></div><label class="expense-period-label">'+
      '<span>Period</span><select class="expense-period" aria-label="Expense period">'+
        selectOptions([['all','All time'],['month','This month'],['90','Last 90 days']],selectedFilter,h)+
      '</select></label></div>'+
    '<p class="finance-note">Record actual business expenses separately from product cost snapshots. '+
    'Supplier purchase orders below are tracked commitments, <strong>not confirmed cash payments</strong>.</p>'+
    '<div class="expense-kpis">'+
      '<div class="expense-kpi-paid"><span>Paid expenses · entered manually</span><strong>'+money(paidTotal)+'</strong>'+
        '<small>'+paid.length+' records marked paid</small></div>'+
      '<div><span>Planned expenses</span><strong>'+money(plannedTotal)+'</strong><small>'+planned.length+' outstanding records</small></div>'+
      '<div><span>Recorded PO value</span><strong>'+money(totalPO)+'</strong><small>'+orders.length+' non-cancelled purchase orders; not cash paid</small></div>'+
    '</div>'+
    '<p class="expense-separation"><strong>Do not add these totals together.</strong> Purchase orders can also have manual paid expense entries, and inventory purchases are not an extra deduction from cost of goods sold.</p>'+
    (expenseNotice?'<p class="expense-notice" role="status">'+h(expenseNotice)+'</p>':'')+
    '<details class="expense-create"><summary><span class="primary catalog-create-button">+ Add expense</span></summary>'+
      expenseForm(null,data,helpers)+'</details>'+
    '<div class="expense-columns">'+
      '<section class="expense-panel"><div class="dashboard-section-head"><div>'+
        '<span class="eyebrow">EXPENSE LEDGER</span><h3>Manual expense records</h3></div>'+
        '<span class="expense-subcount">'+all.length+' records</span></div>'+
        (expenseRows||'<p class="finance-empty">No expenses recorded for this period. Add your first expense above.</p>')+
      '</section>'+
      '<section class="expense-panel"><div class="dashboard-section-head"><div>'+
        '<span class="eyebrow">INVENTORY PURCHASING</span><h3>Vendor purchase orders</h3></div>'+
        '<a href="#products?section=purchasing">Purchasing</a></div>'+
        '<div class="expense-po-summary"><strong>'+money(totalPO)+'</strong>'+
          '<small>Merchandise '+money(poMerchandise)+' · Inbound shipping '+money(poShipping)+
          ' · Fees '+money(poFees)+'</small></div>'+
        (purchaseList||'<p class="finance-empty">No active purchase orders for this period.</p>')+
        '<p class="expense-panel-note">Totals are based on recorded PO lines, shipping and fees once per order.'+
        ' Received does not mean paid. Cancelling a PO removes it from this summary only.</p>'+
      '</section>'+
    '</div>'+
    '<details class="report-expander expense-vendor-breakdown"><summary>Paid spending by vendor</summary>'+
      '<div class="expense-vendor-rows">'+
      (vendorRows.length?vendorRows.map(([name,entry])=>
        '<div class="expense-vendor-row"><strong>'+h(name)+'</strong>'+
        '<small>'+entry.count+' paid expense(s)</small><strong>'+money(entry.total)+'</strong></div>').join(''):
        '<p class="finance-empty">No manually recorded paid vendor expenses in this period.</p>')+
      '</div><p class="expense-panel-note">Based on paid expense entries only—not on ordered merchandise or sale-time product costs.</p></details>'+
    '<p class="expense-panel-note">This is an owner-entered operating ledger, not accounting or bank reconciliation.'+
      ' It does not yet calculate net profit or reconcile credit card, Zelle, PayPal or bank statements.</p>'

  root.querySelector<HTMLSelectElement>('.expense-period')?.addEventListener('change',e=>{
    const val=(e.currentTarget as HTMLSelectElement).value
    if(val==='all'||val==='month'||val==='90'){
      selectedFilter=val;expenseNotice='';render(data,helpers)
    }
  })
  root.querySelectorAll<HTMLFormElement>('.core-expense-form').forEach(form=>{
    const purchaseSelect=form.querySelector<HTMLSelectElement>('[name=purchase_order_id]')
    purchaseSelect?.addEventListener('change',()=>{
      const po=data.purchase_orders.find(p=>p.id===purchaseSelect.value)
      if(!po)return
      const vendor=form.querySelector<HTMLSelectElement>('[name=vendor_id]')
      const payee=form.querySelector<HTMLInputElement>('[name=payee]')
      if(vendor)vendor.value=po.vendor_id
      if(payee&&!payee.value.trim())payee.value=vendorById.get(po.vendor_id)||''
    })
    const vendorSelect=form.querySelector<HTMLSelectElement>('[name=vendor_id]')
    vendorSelect?.addEventListener('change',()=>{
      const payee=form.querySelector<HTMLInputElement>('[name=payee]')
      if(payee&&!payee.value.trim()&&vendorSelect.value)
        payee.value=vendorById.get(vendorSelect.value)||''
    })
    form.addEventListener('submit',async e=>{
      e.preventDefault()
      const get=(name:string)=>form.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(
        '[name="'+name+'"]')?.value.trim()||''
      const prior=data.expenses.find(x=>x.id===form.dataset.id)
      const payload:ExpenseInput={
        ...(prior?{id:prior.id}:{}),
        payee:get('payee'),category:get('category') as FinanceExpenseCategory,
        amount:get('amount'),expense_date:get('expense_date'),
        status:get('status') as 'planned'|'paid',
        payment_method:get('payment_method') as FinancePaymentMethod,
        vendor_id:get('vendor_id')||null,purchase_order_id:get('purchase_order_id')||null,
        reference_number:get('reference_number'),notes:get('notes')
      }
      if(!/^\\d+(\\.\\d{1,2})?$/.test(payload.amount)||Number(payload.amount)<=0){
        const el=form.querySelector<HTMLElement>('.expense-form-message')
        if(el)el.textContent='Enter a positive amount with at most two decimals.'
        return
      }
      if(prior&&prior.status==='paid'&&(Number(prior.amount)!==Number(payload.amount)||
        prior.status!==payload.status)&&
        !window.confirm('This changes an expense previously marked paid. The edit will be recorded in the audit log. Continue?'))return
      const button=form.querySelector<HTMLButtonElement>('button[type=submit]')
      const msg=form.querySelector<HTMLElement>('.expense-form-message')
      if(button)button.disabled=true
      if(msg)msg.textContent='Saving and auditing…'
      try{
        await saveCoreExpense(payload,prior?.updated_at)
        expenseNotice=prior?'Expense updated and audited.':'Expense saved and audited.'
        await bindExpensesPage(helpers)
      }catch(err){
        if(msg)msg.textContent=err instanceof Error?err.message:'Could not save expense.'
        if(button)button.disabled=false
      }
    })
  })
  root.querySelectorAll<HTMLButtonElement>('.expense-void').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const exp=data.expenses.find(x=>x.id===btn.dataset.voidId)
      if(!exp)return
      const typed=window.prompt('Void expense for '+exp.payee+' ('+money(exp.amount)+')? Type VOID exactly. It will remain in the audit history.')
      if(typed!=='VOID')return
      btn.disabled=true
      try{
        await voidCoreExpense(exp.id,exp.updated_at,'VOID')
        expenseNotice='Expense voided. Audit history retained.'
        await bindExpensesPage(helpers)
      }catch(err){
        expenseNotice=err instanceof Error?err.message:'Could not void expense.'
        await bindExpensesPage(helpers)
      }
    })
  })
}
export async function bindExpensesPage(helpers:Helpers){
  const root=document.querySelector<HTMLElement>('#finance-expenses')
  if(!root)return
  root.innerHTML='<div class="loading">Loading expenses and vendor orders…</div>'
  try{
    const snapshot=await loadCoreExpenses()
    if(root.isConnected)render(snapshot,helpers)
  }catch(error){
    if(!root.isConnected)return
    root.innerHTML='<div class="expense-panel"><h2>Expenses unavailable</h2>'+
      '<p class="finance-empty">'+helpers.escapeHtml(
        error instanceof Error?error.message:'Could not load expense records')+
      '</p><p class="finance-empty">Revenue and profit reporting above remain available. No financial records were changed.</p></div>'
  }
}
