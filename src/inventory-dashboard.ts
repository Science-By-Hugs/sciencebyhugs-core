import type { InventorySnapshot } from './services/inventory'

type Status = 'available'|'reserved'|'damaged'|'quarantined'|'returned'|'shipped'|'missing'|'allocated'
type SupplyMode = 'physical'|'vendor'|'unreviewed'
export type StockProductRow = {
  id:string
  name:string
  code:string
  mode:SupplyMode
  available:number
  reserved:number
  allocated:number
  damaged:number
  quarantined:number
  returned:number
  shipped:number
  missing:number
  reorderPoint:number
  reorderConfigured:boolean
  lowStock:boolean
  needsClassification:boolean
  pendingUnits:number
  latestLandedCost:number|null
  finalCostPending:boolean
  supplierQuote:number|null
  supplierName:string|null
  mostRecentLotId:string|null
}
export type StockDashboardModel = {
  rows:StockProductRow[]
  available:number
  reserved:number
  allocated:number
  damaged:number
  quarantined:number
  openPurchases:number
  lowStockProducts:number
  needsClassification:number
  activeSupplierOffers:number
  countsComplete:boolean
  catalogCoverageComplete:boolean
}

// All physical counts come from actual per-unit states, not historical receipts.
// Quotes are vendor cost estimates excluding freight and payment fees.
export function buildStockDashboardModel(data:InventorySnapshot):StockDashboardModel {
  const counts=new Map<string,Partial<Record<Status,number>>>()
  for (const unit of data.unit_counts||[]) {
    const entry=counts.get(unit.product_id)||{}
    const state=unit.state as Status
    entry[state]=(entry[state]||0)+Number(unit.count||0)
    counts.set(unit.product_id,entry)
  }
  const orders=new Map(data.orders.map(po=>[po.id,po]))
  const receivedByLine=new Map<string,number>()
  for(const receipt of data.receipts||[]) {
    if(!receipt.purchase_line_id)continue
    receivedByLine.set(receipt.purchase_line_id,
      (receivedByLine.get(receipt.purchase_line_id)||0)+
        Number(receipt.accepted_units)+Number(receipt.damaged_units))
  }
  const pendingByProduct=new Map<string,number>()
  for(const line of data.lines) {
    const po=orders.get(line.purchase_order_id)
    if(!po || !['ordered','partially_received'].includes(po.status))continue
    const expected=Number(line.expected_units)
    const received=receivedByLine.get(line.id)||0
    const pending=Math.max(0,expected-received)
    pendingByProduct.set(line.product_id,(pendingByProduct.get(line.product_id)||0)+pending)
  }
  const settings=new Map(data.settings.map(setting=>[setting.product_id,setting]))
  const vendors=new Map(data.vendors.map(vendor=>[vendor.id,vendor]))
  const offers=new Map<string,{unitPrice:number;vendor:string}>()
  for(const offer of data.offers) {
    if(!offer.active || !vendors.get(offer.vendor_id)?.active) continue
    const units=Number(offer.units_per_pack)
    if(!(units>0))continue
    const unitPrice=Number(offer.price_per_pack)/units
    const old=offers.get(offer.product_id)
    if(!old || unitPrice<old.unitPrice)
      offers.set(offer.product_id,{unitPrice,vendor:vendors.get(offer.vendor_id)?.name||'Vendor'})
  }
  const lots=new Map<string,{latest:string;lastCost:number|null;pending:boolean;lastLotId:string}>()
  const byRecent=[...data.lots].sort((a,b)=>b.created_at.localeCompare(a.created_at))
  for(const lot of byRecent) {
    const old=lots.get(lot.product_id)
    if (!old) lots.set(lot.product_id,{
      latest:lot.created_at,lastCost:lot.cost_finalized===false?null:(
        lot.landed_unit_cost===null?null:Number(lot.landed_unit_cost)
      ),pending:lot.cost_finalized===false,lastLotId:lot.id,
    })
    else if(old.lastCost===null && lot.cost_finalized!==false && lot.landed_unit_cost!==null)
      old.lastCost=Number(lot.landed_unit_cost)
  }
  const countedProducts=new Set(data.products.map(p=>p.id))
  // Only display products represented in the catalog response. Warn if it is
  // at its 250-row limit or if unit-status rows reference an absent product.
  const catalogCoverageComplete=data.products.length<250 &&
    [...counts.keys()].every(key=>countedProducts.has(key))
  const rows=data.products.map(product=>{
    const value=counts.get(product.id)||{}
    const setting=settings.get(product.id)
    const mode=(setting?.supply_mode||'unreviewed') as SupplyMode
    const reorderPoint=Number(setting?.reorder_point||0)
    const available=value.available||0
    const reserved=value.reserved||0
    const allocated=value.allocated||0
    const damaged=value.damaged||0
    const quarantined=value.quarantined||0
    const returned=value.returned||0
    const shipped=value.shipped||0
    const missing=value.missing||0
    const hasPhysical=available+reserved+allocated+damaged+quarantined+returned+missing>0
    const lowStock=mode==='physical' && reorderPoint>0 &&
      available<=reorderPoint && data.counts_complete===true
    const needsClassification=mode==='unreviewed' && hasPhysical ||
      mode==='vendor' && hasPhysical
    const lot=lots.get(product.id)
    const quote=offers.get(product.id)
    return {
      id:product.id,name:product.name,code:product.product_code||'—',
      mode,available,reserved,allocated,damaged,quarantined,returned,shipped,missing,
      reorderPoint,reorderConfigured:reorderPoint>0,lowStock,
      needsClassification,pendingUnits:pendingByProduct.get(product.id)||0,
      latestLandedCost:lot?.lastCost??null,finalCostPending:lot?.pending||false,
      supplierQuote:quote?.unitPrice??null,supplierName:quote?.vendor||null,
      mostRecentLotId:lot?.lastLotId||null,
    }
  })
  // Prioritize actual, relevant inventory over untracked catalog listings.
  rows.sort((a,b)=>{
    const priority=(r:StockProductRow)=>(
      (r.lowStock?1000:0)+(r.needsClassification?500:0)+
      ((r.available+r.reserved+r.allocated+r.damaged+r.quarantined)>0?100:0)+
      (r.pendingUnits>0?50:0)+(r.supplierQuote!==null?10:0)
    )
    return priority(b)-priority(a)||a.name.localeCompare(b.name)
  })
  return {
    rows,
    available:rows.reduce((s,r)=>s+r.available,0),
    reserved:rows.reduce((s,r)=>s+r.reserved,0),
    allocated:rows.reduce((s,r)=>s+r.allocated,0),
    damaged:rows.reduce((s,r)=>s+r.damaged,0),
    quarantined:rows.reduce((s,r)=>s+r.quarantined,0),
    openPurchases:data.orders.filter(o=>o.status==='ordered'||o.status==='partially_received').length,
    lowStockProducts:rows.filter(r=>r.lowStock).length,
    needsClassification:rows.filter(r=>r.needsClassification).length,
    activeSupplierOffers:data.offers.filter(o=>o.active).length,
    countsComplete:data.counts_complete===true,
    catalogCoverageComplete,
  }
}

const money=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value)
function node<K extends keyof HTMLElementTagNameMap>(tag:K,className='',label='') {
  const el=document.createElement(tag)
  if (className)el.className=className
  if (label)el.textContent=label
  return el
}
function stat(label:string,value:number,hint:string) {
  const box=node('div','inv-stock-stat')
  box.append(node('strong','',String(value)),
    node('span','',label),node('small','',hint))
  return box
}
function status(row:StockProductRow,countsComplete:boolean) {
  if(!countsComplete)return 'Counts incomplete'
  if(row.needsClassification)return row.mode==='vendor'?'Review physical stock':'Needs classification'
  if(row.lowStock)return row.available===0?'Out of stock':'Low stock'
  if(row.mode==='physical'&&!row.reorderConfigured)return 'Set reorder point'
  if(row.mode==='vendor')return 'Vendor-supplied'
  if(row.mode==='physical')return 'Physical stock'
  return 'Unreviewed'
}
function labelButton(title:string,action:string,productId:string) {
  const button=node('button','inv-stock-action',title)
  button.type='button';button.dataset.action=action
  button.dataset.product=productId
  return button
}

export function mountInventoryDashboard(root:HTMLElement,data:InventorySnapshot,onRefresh:()=>Promise<void>) {
  const model=buildStockDashboardModel(data)
  const section=node('section','inv-panel inv-stock-dashboard')
  section.id='inventory-stock-overview'
  const heading=node('div','inv-stock-heading')
  const h=node('div')
  h.append(node('span','eyebrow','INVENTORY OVERVIEW'),node('h2','','What’s in stock?'))
  const refresh=node('button','secondary','Refresh counts')
  refresh.type='button';refresh.dataset.action='refresh'
  heading.append(h,refresh)
  section.appendChild(heading)

  const metrics=node('div','inv-stock-metrics')
  metrics.append(
    stat('Available',model.available,'Physically available units'),
    stat('Reserved',model.reserved,'Held during checkout'),
    stat('Allocated',model.allocated,'Paid, waiting for fulfillment'),
    stat('Damaged',model.damaged,'Not available for fulfillment'),
    stat('Low stock',model.lowStockProducts,'Products at or below threshold'),
    stat('Open purchases',model.openPurchases,'Ordered or partially received'),
  )
  section.appendChild(metrics)
  if (!model.countsComplete || !model.catalogCoverageComplete) {
    const note=node('p','inv-stock-warning',
      'The stock summary is incomplete due to response limits. Do not use these totals for fulfillment or reorder decisions.')
    section.appendChild(note)
  } else {
    section.appendChild(node('p','inv-helper',
      'Counts reflect unit tracking in Core, not stock promises in Nexus. Vendor quotes do not count as on-hand inventory.'))
  }

  const controls=node('div','inv-stock-controls')
  const search=node('input')
  search.type='search'
  search.placeholder='Search product, SKU, vendor…'
  search.setAttribute('aria-label','Search inventory')
  const filter=node('select')
  filter.setAttribute('aria-label','Filter inventory')
  const filters=[
    ['tracked','Tracked & sourced'],
    ['all','All catalog'],
    ['physical','Physical stock'],
    ['vendor','Vendor-supplied'],
    ['attention','Needs attention'],
    ['low','Low stock'],
  ]
  for (const [value,label] of filters) {
    const option=node('option','',label)
    option.value=value;filter.appendChild(option)
  }
  controls.append(search,filter)
  section.appendChild(controls)
  const details=node('div','inv-stock-table-wrap')
  const table=node('table','inv-stock-table')
  const caption=node('caption','','Product-level stock status and purchase costs')
  table.appendChild(caption)
  const head=node('thead')
  const titles=['Product','Available','Other stock','Source / status','Vendor quote','Landed cost','Incoming','']
  const hr=node('tr')
  titles.forEach(t=>hr.appendChild(node('th','',t)))
  head.appendChild(hr);table.appendChild(head)
  const body=node('tbody')
  table.appendChild(body)
  details.appendChild(table)
  section.appendChild(details)
  const foot=node('p','inv-stock-footnote',
    'Quote = lowest active supplier price per unit, before freight and fees. Landed cost = latest known finalized lot cost per accepted unit. “Incoming” is undelivered quantity on listed open purchase orders.')
  section.appendChild(foot)

  function render() {
    body.replaceChildren()
    const term=search.value.trim().toLowerCase()
    const mode=filter.value
    const rows=model.rows.filter(row=>{
      const hasTracked=row.available+row.reserved+row.allocated+row.damaged+
        row.quarantined+row.returned+row.missing+row.pendingUnits>0 ||
        row.supplierQuote!==null || row.mode!=='unreviewed'
      if(mode==='tracked'&&!hasTracked)return false
      if(mode==='physical'&&row.mode!=='physical')return false
      if(mode==='vendor'&&row.mode!=='vendor')return false
      if(mode==='low'&&!row.lowStock)return false
      if(mode==='attention'&&!row.lowStock&&!row.needsClassification&&
        !(row.mode==='physical'&&!row.reorderConfigured))return false
      return !term || [row.name,row.code,row.supplierName||''].some(s=>s.toLowerCase().includes(term))
    })
    if(!rows.length) {
      const tr=node('tr');const td=node('td','inv-stock-empty','No matching products')
      td.colSpan=8;tr.appendChild(td);body.appendChild(tr)
      return
    }
    for(const row of rows) {
      const tr=node('tr')
      const product=node('td')
      product.append(node('strong','',row.name),node('small','',row.code))
      const available=node('td','inv-stock-number',String(row.available))
      const other=node('td')
      other.append(node('small','',row.reserved+' reserved · '+row.allocated+' allocated · '+row.damaged+' damaged'))
      if(row.missing)other.append(node('small','',''+row.missing+' missing / reconciled'))
      if(row.quarantined||row.returned)
        other.append(node('small','',row.quarantined+' quarantined · '+row.returned+' returned'))
      const source=node('td')
      const state=status(row,model.countsComplete)
      source.append(node('span',
        row.lowStock?'inv-stock-state is-low':row.needsClassification?'inv-stock-state is-review':'inv-stock-state',state),
        node('small','',row.mode==='physical'?'Physical inventory':row.mode==='vendor'?'Vendor offering':'Not classified'))
      if(row.mode==='physical' && row.reorderConfigured)
        source.append(node('small','','Reorder at '+row.reorderPoint+' available'))
      const quote=node('td','',row.supplierQuote===null?'—':money(row.supplierQuote))
      if(row.supplierName)quote.appendChild(node('small','',row.supplierName))
      const landed=node('td','',row.latestLandedCost===null?'—':money(row.latestLandedCost))
      if(row.finalCostPending)landed.appendChild(node('small','','New lot cost pending'))
      const incoming=node('td','inv-stock-number',String(row.pendingUnits))
      const actions=node('td')
      const actionGroup=node('div','inv-stock-actions')
      actionGroup.appendChild(labelButton('Supply settings','classify',row.id))
      if(row.mostRecentLotId) {
        const labels=labelButton('Lot labels','labels',row.id)
        labels.dataset.lot=row.mostRecentLotId
        actionGroup.appendChild(labels)
      }
      actions.appendChild(actionGroup)
      // Display the same field names when the desktop table becomes mobile cards.
      ;[product,available,other,source,quote,landed,incoming,actions].forEach((cell,i)=>{
        cell.dataset.label=titles[i] || 'Actions'
      })
      tr.append(product,available,other,source,quote,landed,incoming,actions)
      body.appendChild(tr)
    }
  }
  search.addEventListener('input',render)
  filter.addEventListener('change',render)
  section.addEventListener('click',async event=>{
    const target=event.target
    if(!(target instanceof HTMLElement))return
    const button=target.closest<HTMLButtonElement>('button[data-action]')
    if(!button)return
    const action=button.dataset.action
    if(action==='refresh') {
      button.disabled=true
      button.textContent='Refreshing…'
      try { await onRefresh() }
      catch(err) { button.textContent=err instanceof Error?err.message:'Refresh failed' }
      finally { button.disabled=false }
      return
    }
    if(action==='classify') {
      const form=document.getElementById('inv-classify-product') as HTMLFormElement|null
      const select=form?.elements.namedItem('productId') as HTMLSelectElement|null
      if(select){
        select.value=button.dataset.product||''
        select.dispatchEvent(new Event('change',{bubbles:true}))
        const disclosure=form?.closest('details')
        if(disclosure)disclosure.open=true
        form?.scrollIntoView({behavior:'smooth',block:'start'})
      }
    }
    if(action==='labels') {
      const lotId=button.dataset.lot
      const all=document.querySelectorAll<HTMLButtonElement>('.inv-download-lot')
      const matched=[...all].find(b=>b.dataset.lot===lotId)
      if(matched){
        const disclosure=matched.closest('details')
        if (disclosure) disclosure.open=true
        matched.scrollIntoView({behavior:'smooth',block:'center'})
        matched.click()
      }
    }
  })
  render()
  root.replaceChildren(section)
}
