import type { InventoryMonitoringSnapshot } from './services/inventory'

type Loader=()=>Promise<InventoryMonitoringSnapshot>
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text='')=>{
  const node=document.createElement(tag)
  if(className)node.className=className
  if(text)node.textContent=text
  return node
}
const count=(n:unknown)=>Number.isFinite(Number(n))?Math.max(0,Math.trunc(Number(n))):0

export function monitorDisplayState(snapshot:InventoryMonitoringSnapshot){
  const alerts=Array.isArray(snapshot.alerts)?snapshot.alerts:[]
  const critical=count(snapshot.totals?.critical)
  const warning=count(snapshot.totals?.warning)
  const pendingCounts=count(snapshot.metrics?.open_physical_lots_without_verified_count)
  const pendingReconciliation=count(snapshot.metrics?.pending_reconciliation)
  const enabled=Boolean(snapshot.flags?.reservation_enabled||snapshot.flags?.deduction_enabled||
    snapshot.flags?.recovery_enabled)
  return {
    label:critical>0?'Immediate attention':warning>0?'Needs review':
      pendingCounts+pendingReconciliation>0?'Counts still need verification':'No discrepancies detected',
    critical,warning,pendingCounts,pendingReconciliation,enabled,
    clipped:count(snapshot.totals?.total)>alerts.length,
    alerts,
  }
}

// Not available in the customer storefront, only inside authenticated Core.
// All rendered text uses textContent, never innerHTML or untrusted HTML.
export function mountInventoryMonitor(root:HTMLElement,load:Loader){
  root.replaceChildren()
  const panel=el('section','inv-panel inv-monitor')
  panel.id='inventory-monitor'
  const header=el('div','inv-stock-heading')
  const heading=el('div')
  heading.append(el('span','eyebrow','PHASE 5C · OWNER ONLY'),
    el('h2','','Payments & stock monitoring'))
  const refresh=el('button','secondary','Refresh alerts')
  refresh.type='button'
  refresh.dataset.action='refresh-monitor'
  header.append(heading,refresh)
  panel.appendChild(header)
  const message=el('p','inv-helper','Checking live payment and stock records…')
  message.setAttribute('role','status')
  panel.appendChild(message)
  const content=el('div','inv-monitor-body')
  panel.appendChild(content)
  root.appendChild(panel)

  function render(snapshot:InventoryMonitoringSnapshot){
    const state=monitorDisplayState(snapshot)
    const stamp=new Date(snapshot.checked_at)
    const checked=Number.isNaN(stamp.getTime())?'Last checked unavailable':
      'Last checked '+stamp.toLocaleString()
    message.textContent=state.enabled
      ? checked+' · Live stock controls have been activated. Review alerts before fulfillment.'
      : checked+' · Reservations, deductions and recovery are OFF. Monitoring is read-only.'
    content.replaceChildren()
    const heading=el('p','inv-monitor-summary',state.label)
    heading.dataset.level=state.critical?'critical':state.warning?'warning':'neutral'
    content.appendChild(heading)

    const stats=el('div','inv-monitor-metrics')
    const tiles:[
      [string,number,string]
    ]=[
      ['Critical',state.critical,'Payment/stock discrepancies'],
      ['Review',state.warning,'Stale holds or provider checks'],
      ['Held',count(snapshot.metrics.held_units),'Unpaid physical units'],
      ['Paid allocations',count(snapshot.metrics.committed_units),'Committed to verified orders'],
    ]
    for(const [label,value,note] of tiles){
      const box=el('div','inv-stock-stat')
      box.append(el('strong','',String(value)),el('span','',label),el('small','',note))
      stats.appendChild(box)
    }
    content.appendChild(stats)
    if(state.pendingCounts||state.pendingReconciliation){
      const audit=el('p','inv-stock-warning')
      audit.textContent=state.pendingCounts+' physical lot(s) still need a verified stock count'+
        (state.pendingReconciliation?' · '+state.pendingReconciliation+' unresolved count discrepancy(ies)':'')+
        '. Keep automatic stock deductions disabled until reconciled.'
      content.appendChild(audit)
    }

    const alertsHeading=el('h3','','Orders requiring attention')
    content.appendChild(alertsHeading)
    if(!state.alerts.length){
      content.appendChild(el('p','inv-helper','No payment/inventory discrepancies detected for orders after the activation cutoff. Historical orders are excluded.'))
    }else{
      const list=el('div','inv-monitor-alerts')
      for(const alert of state.alerts){
        const row=el('div','inv-monitor-alert')
        row.dataset.severity=alert.severity
        const title=el('strong','',alert.title)
        const context=el('small','',
          (alert.order_number?'Order '+alert.order_number:'Inventory check')+
          ' · '+(alert.severity==='critical'?'Critical':'Review needed'))
        row.append(title,context,el('p','',alert.next_action))
        list.appendChild(row)
      }
      content.appendChild(list)
      if(state.clipped)content.appendChild(el('p','inv-helper','Showing the first 50 alerts. Use a fresh audit for additional cases.'))
    }
    content.appendChild(el('p','inv-stock-footnote',
      'Live read-only checks. No automatic refunds, changes to stock, order cancellations, payment captures, or provider queries.'))
  }

  async function reload(){
    refresh.disabled=true
    refresh.textContent='Checking…'
    try{
      const result=await load()
      render(result)
    }catch(error){
      message.textContent=error instanceof Error&&/owner access|required/i.test(error.message)
        ? 'Owner-only monitoring: sign in with your Core owner account.'
        : 'Monitoring could not load. No stock or payment records were changed.'
      content.replaceChildren()
    }finally{
      refresh.disabled=false
      refresh.textContent='Refresh alerts'
    }
  }
  refresh.addEventListener('click',()=>{void reload()})
  void reload()
}
