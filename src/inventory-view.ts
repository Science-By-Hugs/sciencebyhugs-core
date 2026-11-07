import {
  addInventoryVendor,classifyInventoryProduct,listInventory,listInventoryLotLabels,
  lookupInventoryUnit,receiveInventoryPurchase,saveVendorOffer,loadInventoryMonitoring,
  type InventoryLot,type InventoryPurchase,type InventorySnapshot,type InventoryUnitLabel,
} from './services/inventory'
import { inventoryBoxPng, inventoryPngFilename, inventoryUnitPng, inventoryVialPng, lotBoxFilename, suggestedVialFields, vialPngFilename } from './inventory-png'
import { mountMultiInventory } from './inventory-multi'
import { mountInventoryDashboard } from './inventory-dashboard'
import { mountInventoryMonitor } from './inventory-monitor'
import { mountInventoryAudit } from './inventory-audit'
import { mountStockManager } from './inventory-adjust'
import './inventory.css'

type Helpers = {
  isOwner?:boolean
  escapeHtml:(value:unknown)=>string
  money:(value:number|string|null|undefined)=>string
  dateTime:(value:string|null|undefined)=>string
}
const id = (name:string) => document.getElementById(name)
const val = (form:HTMLFormElement,name:string) =>
  (form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement|null)?.value?.trim() || ''
const num = (form:HTMLFormElement,name:string) => Number(val(form,name))
const uuid = () => crypto.randomUUID()
const number = (v:unknown) => Number(v || 0)

export function inventoryPageMarkup(email:string,escapeHtml:Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">STOCK & PROCUREMENT</span><h1 class="dashboard-title">Inventory</h1>' +
    '<p class="copy">See physical stock, supplier pricing, reorder alerts and traceable lots in one place.</p>' +
    '</div><div class="operator">Signed in as <strong>'+escapeHtml(email)+'</strong></div></section>' +
    '<section id="inventory-app"><div class="loading">Loading inventory…</div></section>'
}

function option(value:string,label:string,escapeHtml:Helpers['escapeHtml']) {
  return '<option value="'+escapeHtml(value)+'">'+escapeHtml(label)+'</option>'
}
function card(content:string) { return '<section class="inv-panel">'+content+'</section>' }
function field(label:string,html:string) { return '<label class="inv-field"><span>'+label+'</span>'+html+'</label>' }
const input = (name:string,type='text',extra='')=>
  '<input name="'+name+'" type="'+type+'" '+extra+'>'

function vendorForm(h:Helpers) {
  return card('<div class="inv-panel-head"><h2>Add a supplier</h2><p>Give each source its own cost history.</p></div>'+
    '<form id="inv-add-vendor" class="inv-form">'+
    field('Vendor name',input('name','text','required maxlength="120" placeholder="Vendor name"'))+
    field('Vendor code',input('code','text','required maxlength="8" minlength="2" placeholder="EML"'))+
    field('Internal note',input('notes','text','maxlength="500" placeholder="Optional"'))+
    '<div class="inv-form-action"><button class="primary" type="submit">Add vendor</button></div></form>')
}

function offersForm(data:InventorySnapshot,h:Helpers) {
  const vendorOptions=data.vendors.filter(v=>v.active).map(v=>option(v.id,v.name+' · '+v.code,h.escapeHtml)).join('')
  const productOptions=data.products.map(p=>option(p.id,(p.product_code||'—')+' · '+p.name,h.escapeHtml)).join('')
  return card('<div class="inv-panel-head"><h2>Supplier price book</h2>'+
    '<p>One Core product can have single-unit and 10-unit kit offers from different vendors. Retail prices stay unchanged.</p></div>'+
    '<form id="inv-save-offer" class="inv-form">'+
    field('Vendor','<select name="vendorId" required>'+vendorOptions+'</select>')+
    field('Core product','<select name="productId" required>'+productOptions+'</select>')+
    field('Units per pack',input('unitsPerPack','number','required min="1" max="1000" step="1" value="10"'))+
    field('Price per pack ($)',input('pricePerPack','number','required min="0" max="1000000" step="0.01" placeholder="100.00"'))+
    field('Estimated inbound shipping ($)',input('estimatedInboundShipping','number','min="0" max="1000000" step="0.01" value="0"'))+
    field('Vendor product code',input('vendorSku','text','maxlength="120" placeholder="Optional"'))+
    field('Lead time (days)',input('leadTimeDays','number','min="0" max="365" step="1" placeholder="Optional"'))+
    '<div class="inv-form-action"><button class="primary" type="submit">Save supplier offering</button></div></form>'+
    '<div class="inv-list">'+(data.offers.length?data.offers.map(o=>{
      const v=data.vendors.find(v=>v.id===o.vendor_id)
      const p=data.products.find(p=>p.id===o.product_id)
      return '<div class="inv-line"><div><strong>'+h.escapeHtml(p?.name||'Unknown product')+
        '</strong><small>'+h.escapeHtml(v?.name||'Unknown vendor')+
        ' · '+h.escapeHtml(o.units_per_pack)+' units/pack</small></div><div class="inv-right"><strong>'+
        h.money(o.price_per_pack)+'</strong><small>'+h.money(number(o.price_per_pack)/o.units_per_pack)+
        ' / unit · quote only</small></div></div>'
    }).join(''):'<p class="inv-empty">No supplier offerings yet.</p>')+'</div>')
}

function receivingForm(data:InventorySnapshot,h:Helpers) {
  const pending=data.orders.filter(o=>o.status==='ordered' && !o.multi_line)
  const select=pending.map(o=>{
    const line=data.lines.find(l=>l.purchase_order_id===o.id)
    const prod=data.products.find(p=>p.id===line?.product_id)
    return option(o.id,o.po_number+' · '+(prod?.name||'Item')+
      ' · '+(line?.expected_units||0)+' expected units',h.escapeHtml)
  }).join('')
  const first=data.lines.find(l=>l.purchase_order_id===pending[0]?.id)
  return card('<div class="inv-panel-head"><h2>Receive a purchase</h2>'+
    '<p>Check every vial. This first version receives one complete purchase at a time.</p></div>'+
    (pending.length?'<form id="inv-receive-po" class="inv-form">'+
    field('Purchase order','<select name="orderId" required>'+select+'</select>')+
    field('Usable units verified',input('accepted','number','required min="0" step="1" value="'+number(first?.expected_units)+'"'))+
    field('Damaged / unusable units',input('damaged','number','required min="0" step="1" value="0"'))+
    field('Original supplier/manufacturer lot',input('supplierLot','text','required maxlength="120" placeholder="As printed on packaging"'))+
    field('Expiration (if printed)',input('expiryDate','date',''))+
    '<div class="inv-form-action"><button class="primary" type="submit">Confirm & generate unit IDs</button></div></form>':
    '<p class="inv-empty">No open purchase orders. Create an order above to receive stock.</p>'))
}

function lotRows(lots:InventoryLot[],data:InventorySnapshot,h:Helpers,showCount=true) {
  return card('<div class="inv-panel-head"><h2>Lots & QR labels</h2>'+
    '<p>Download one lot QR PNG for the outer box and a 1.2 × 0.8-inch horizontal vial-label PNG. Both work with external thermal printer software.</p></div>'+
    '<div class="inv-list">'+(lots.length?lots.map(l=>{
      const p=data.products.find(p=>p.id===l.product_id)
      const v=data.vendors.find(v=>v.id===l.vendor_id)
      return '<div class="inv-line"><div><strong>'+h.escapeHtml(l.internal_lot)+'</strong>'+
        '<small>'+h.escapeHtml(p?.product_code||'—')+' · '+h.escapeHtml(v?.name||'—')+
        ' · '+h.escapeHtml(l.accepted_units)+' accepted, '+h.escapeHtml(l.damaged_units)+' damaged</small>'+
        '<small>Original lot: '+h.escapeHtml(l.supplier_lot)+
        (l.expiry_date?' · Expires '+h.escapeHtml(l.expiry_date):'')+'</small></div>'+
        '<div class="inv-right"><strong>'+h.escapeHtml(l.cost_finalized === false ? 'Pending final cost' : (l.landed_unit_cost===null?'—':h.money(l.landed_unit_cost)))+
        ' / unit</strong><button class="secondary inv-download-lot" data-lot="'+h.escapeHtml(l.id)+
        '" type="button">Prepare box + vial PNGs</button>'+
        (showCount?'<button class="secondary inv-audit-lot" data-lot="'+h.escapeHtml(l.id)+'" type="button">Count stock</button>':'')+
        '</div></div>'
    }).join(''):'<p class="inv-empty">Receiving lots will appear here.</p>')+'</div>')
}

function classificationForm(data:InventorySnapshot,h:Helpers) {
  const codes=data.products.map(p=>option(p.id,
    (p.product_code||'—')+' · '+p.name,h.escapeHtml)).join('')
  const counts={
    physical:data.settings.filter(s=>s.supply_mode==='physical').length,
    vendor:data.settings.filter(s=>s.supply_mode==='vendor').length,
  }
  return card('<div class="inv-panel-head"><h2>Product supply mode</h2>'+
    '<p>Classify physical on-hand stock separately from vendor-supplied products. This does not change what Nexus sells.</p></div>'+
    '<p class="inv-helper">'+counts.physical+' physical · '+counts.vendor+
    ' vendor-supplied · '+(data.products.length-counts.physical-counts.vendor)+' unreviewed</p>'+
    '<form id="inv-classify-product" class="inv-form">'+
    field('Core product','<select name="productId" required>'+codes+'</select>')+
    field('Supply mode','<select name="supplyMode"><option value="unreviewed">Unreviewed</option>'+
      '<option value="physical">Physical stock</option><option value="vendor">Vendor-supplied</option></select>')+
    field('Low-stock alert at',input('reorderPoint','number','required min="0" max="100000" step="1" value="0"'))+
    '<div class="inv-form-action"><button class="primary" type="submit">Save classification</button></div></form>')
}


type PurchaseStep = 'supplier'|'purchase'|'receive'|'labels'
const PURCHASE_STEPS: Array<[PurchaseStep,string]> = [
  ['supplier','Supplier'],['purchase','Purchase'],['receive','Receive'],['labels','Labels'],
]

// One guided surface. Existing vendor/offer, purchase, receipt and label forms
// remain mounted with the original handlers and authorized server operations.
function purchasingJourneyMarkup(data:InventorySnapshot,h:Helpers) {
  const activeVendors=data.vendors.filter(v=>v.active)
  const activeOffers=data.offers.filter(o=>o.active&&activeVendors.some(v=>v.id===o.vendor_id))
  const openOrders=data.orders.filter(o=>o.status==='ordered'||o.status==='partially_received')
  const recentLots=[...data.lots].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,8)
  const supplierRows=activeVendors.slice(0,6).map(v=>{
    const count=activeOffers.filter(o=>o.vendor_id===v.id).length
    return '<div class="inv-journey-supplier-row"><strong>'+h.escapeHtml(v.name)+
      '</strong><span>'+count+' active offering'+(count===1?'':'s')+'</span></div>'
  }).join('')
  const tabs=PURCHASE_STEPS.map(([step,label],index)=>
    '<button type="button" class="inv-journey-tab" role="tab" data-inv-journey-tab="'+step+
    '" id="inv-journey-tab-'+step+'" aria-controls="inv-journey-panel-'+step+
    '" aria-selected="false" tabindex="-1"><span class="inv-journey-index">'+
    (index+1)+'</span><span>'+label+'</span></button>'
  ).join('')
  const panel=(step:PurchaseStep,html:string)=>
    '<section role="tabpanel" class="inv-journey-panel" data-inv-journey-panel="'+step+
    '" id="inv-journey-panel-'+step+'" aria-labelledby="inv-journey-tab-'+step+
    '" hidden>'+html+'</section>'
  return '<section class="inv-journey" aria-label="Purchasing and receiving guide">'+
    '<header class="inv-journey-head"><span class="eyebrow">PURCHASING WORKFLOW</span>'+
      '<h2>From supplier to labeled stock</h2>'+
      '<p>Set up your source, order kits, receive verified units, then prepare traceable labels.</p>'+
    '</header>'+
    '<div class="inv-journey-nav" role="tablist" aria-label="Purchasing steps">'+tabs+'</div>'+
    panel('supplier',
      '<div class="inv-journey-step-head"><span>STEP 1 OF 4</span><h3>Choose your source</h3>'+
        '<p>Supplier offerings are linked to the same Core catalog products, with separate kit and single-vial costs.</p></div>'+
      '<div class="inv-journey-stats"><div><strong>'+activeVendors.length+'</strong><span>Active suppliers</span></div>'+
        '<div><strong>'+activeOffers.length+'</strong><span>Active price offers</span></div></div>'+
      (supplierRows?'<div class="inv-journey-supplier-list">'+supplierRows+'</div>':
        '<p class="inv-journey-empty">Start by adding a supplier and a product offering.</p>')+
      '<div class="inv-journey-actions">'+
        '<a href="#products?section=suppliers" class="inv-journey-link">Manage suppliers & prices</a>'+
        (activeOffers.length?'<button type="button" class="secondary" data-inv-journey-next="purchase">Next: Create purchase</button>':'')+
      '</div>'
    )+
    panel('purchase',
      '<div class="inv-journey-step-head"><span>STEP 2 OF 4</span><h3>Build your purchase order</h3>'+
      '<p>Choose one supplier and one or more product kits. Shipping and fees are counted once, with landed costs previewed before ordering.</p></div>'+
      '<div id="inv-multi-anchor" class="inv-multi-anchor"></div>'+
      '<div class="inv-journey-actions"><a href="#products?section=suppliers" class="inv-journey-subtle-link">Need a new supplier price?</a>'+
      '<button type="button" class="secondary" data-inv-journey-next="receive">Go to receiving</button></div>'
    )+
    panel('receive',
      '<div class="inv-journey-step-head"><span>STEP 3 OF 4</span><h3>Receive and verify</h3>'+
      '<p>Check usable and damaged quantities against each purchase line. Core creates traceable lots when a receipt is confirmed.</p>'+
      '<p class="inv-journey-counter">'+openOrders.length+' open purchase order'+(openOrders.length===1?'':'s')+'</p></div>'+
      '<div id="inv-multi-receiving-anchor" class="inv-multi-anchor"></div>'+
      (data.orders.some(o=>o.status==='ordered'&&!o.multi_line)?receivingForm(data,h):'')+
      '<div class="inv-journey-actions"><button type="button" class="secondary" data-inv-journey-next="labels">Go to lot labels</button></div>'
    )+
    panel('labels',
      '<div class="inv-journey-step-head"><span>STEP 4 OF 4</span><h3>Prepare QR and vial labels</h3>'+
      '<p>Use received lot records to prepare outer-box QR codes and individual vial-label PNGs. Label content is taken from the existing lot.</p></div>'+
      lotRows(recentLots,data,h,false)+
      '<div class="inv-journey-actions"><a href="#products?section=inventory" class="inv-journey-link">View all lots in Inventory</a>'+
      '<button type="button" class="secondary" data-inv-journey-next="purchase">Start another purchase</button></div>'
    )+
  '</section>'
}

function bindPurchasingJourney(root:HTMLElement,initial:PurchaseStep) {
  const tabs=[...root.querySelectorAll<HTMLButtonElement>('[data-inv-journey-tab]')]
  const panels=[...root.querySelectorAll<HTMLElement>('[data-inv-journey-panel]')]
  const activate=(step:PurchaseStep,focus=false)=>{
    const current=tabs.find(tab=>tab.dataset.invJourneyTab===step)
    if(!current)return
    root.dataset.journeyStep=step
    for(const tab of tabs) {
      const selected=tab===current
      tab.setAttribute('aria-selected',String(selected))
      tab.tabIndex=selected?0:-1
    }
    panels.forEach(panel=>{panel.hidden=panel.dataset.invJourneyPanel!==step})
    if(focus)current.focus({preventScroll:true})
  }
  tabs.forEach((tab,i)=>{
    tab.addEventListener('click',()=>activate(tab.dataset.invJourneyTab as PurchaseStep))
    tab.addEventListener('keydown',event=>{
      let next=i
      if(event.key==='ArrowRight')next=(i+1)%tabs.length
      else if(event.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length
      else if(event.key==='Home')next=0
      else if(event.key==='End')next=tabs.length-1
      else return
      event.preventDefault()
      activate(tabs[next].dataset.invJourneyTab as PurchaseStep,true)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-inv-journey-next]').forEach(button=>{
    button.addEventListener('click',()=>{
      activate(button.dataset.invJourneyNext as PurchaseStep,true)
      root.querySelector('.inv-journey-nav')?.scrollIntoView({behavior:'smooth',block:'nearest'})
    })
  })
  activate(initial)
}

const activePngUrls:string[]=[]
function clearPngLinks() {
  activePngUrls.forEach(url=>URL.revokeObjectURL(url))
  activePngUrls.length=0
}
function createPngDownload(blob:Blob,filename:string,label:string) {
  const url=URL.createObjectURL(blob)
  activePngUrls.push(url)
  const link=document.createElement('a')
  link.className='secondary inv-png-link'
  link.textContent=label
  link.href=url
  link.download=filename
  return {url,link}
}
function labelInput(form:HTMLFormElement,title:string,name:string,value:string,placeholder:string,maxLength:number) {
  const label=document.createElement('label')
  label.className='inv-field'
  const text=document.createElement('span')
  text.textContent=title
  const input=document.createElement('input')
  input.type='text'
  input.name=name
  input.value=value
  input.placeholder=placeholder
  input.maxLength=maxLength
  input.required=true
  label.append(text,input)
  form.appendChild(label)
  return input
}

async function prepareLotPngDownloads(lotId:string) {
  const panel=id('inv-png-downloads')
  if (!panel) throw new Error('PNG download panel unavailable')
  panel.hidden=false
  panel.textContent='Preparing box and vial labels…'
  const base=location.origin+location.pathname
  try {
    const {units,box_qr_svg}=await listInventoryLotLabels(lotId,base)
    if (!units.length) throw new Error('No inventory units found for this lot')
    if (!box_qr_svg) throw new Error('Lot QR service update is required before generating a box label')
    clearPngLinks()
    const first=units[0]
    const boxPng=await inventoryBoxPng(first,box_qr_svg)
    const boxFile=createPngDownload(boxPng,lotBoxFilename(first),'Download box QR PNG')
    panel.replaceChildren()
    const title=document.createElement('h2')
    title.textContent='Box and vial labels — '+first.internal_lot
    panel.appendChild(title)
    const info=document.createElement('p')
    info.className='inv-helper'
    info.textContent='One lot QR on the outer box. Small vial labels have no QR. Nothing is sent to the printer from Core.'
    panel.appendChild(info)

    const boxTitle=document.createElement('h3')
    boxTitle.textContent='1. Box / lot QR · 1.90 × 0.90 in'
    panel.appendChild(boxTitle)
    const boxPreview=document.createElement('img')
    boxPreview.className='inv-png-preview'
    boxPreview.alt='Lot QR PNG for outer box'
    boxPreview.src=boxFile.url
    panel.append(boxPreview,boxFile.link)

    const vialTitle=document.createElement('h3')
    vialTitle.textContent='2. Vial label · 1.20 × 0.80 in'
    panel.appendChild(vialTitle)
    const help=document.createElement('p')
    help.className='inv-helper'
    help.textContent='Verify the name, strength and actual formulation as printed on the supplied product. The formulation is intentionally blank until you confirm it. The sample design does not automatically prove product identity or compliance.'
    panel.appendChild(help)
    const fields=suggestedVialFields(first.product_name)
    const form=document.createElement('form')
    form.className='inv-form'
    const nameInput=labelInput(form,'Product name','product',fields.name,'Product name',90)
    const strengthInput=labelInput(form,'Strength / quantity','strength',fields.strength,'e.g. 20 mg',25)
    const formInput=labelInput(form,'Verified formulation','form','',
      'e.g. Lyophilized Peptide (only if verified)',45)
    const action=document.createElement('div')
    action.className='inv-form-action'
    const generate=document.createElement('button')
    generate.type='submit'
    generate.className='primary'
    generate.textContent='Generate vial label PNG'
    action.appendChild(generate)
    form.appendChild(action)
    panel.appendChild(form)
    const vialResults=document.createElement('div')
    vialResults.className='inv-vial-results'
    panel.appendChild(vialResults)
    let vialUrl:string|null=null
    form.addEventListener('submit',async event=>{
      event.preventDefault()
      generate.disabled=true
      try {
        const png=await inventoryVialPng({
          name:nameInput.value,strength:strengthInput.value,form:formInput.value,
        })
        if(vialUrl) {
          URL.revokeObjectURL(vialUrl)
          const idx=activePngUrls.indexOf(vialUrl)
          if(idx>=0) activePngUrls.splice(idx,1)
        }
        const vial=createPngDownload(png,vialPngFilename(first),'Download vial label PNG')
        vialUrl=vial.url
        const preview=document.createElement('img')
        preview.className='inv-vial-preview'
        preview.alt='Black-and-white vial label matching your reference'
        preview.src=vial.url
        const note=document.createElement('p')
        note.className='inv-helper'
        note.textContent='Use the same PNG for the physically verified '+units.filter(u=>u.state==='available').length+
          ' available vials, adjusting the actual copy count in your Core Innovations printer software. Keep the printed vials together with their lot-tracked box.'
        vialResults.replaceChildren(preview,vial.link,note)
      }catch(err){alert(err instanceof Error?err.message:'Could not create vial label')}
      finally{generate.disabled=false}
    })

    // Preserve the older per-unit QR option for operators who need it;
    // keep it collapsed so the new box + vial workflow stays uncluttered.
    const optional=document.createElement('details')
    optional.className='inv-advanced-qr'
    const heading=document.createElement('summary')
    heading.textContent='Optional: individual unit QR labels'
    optional.appendChild(heading)
    const optionalHint=document.createElement('p')
    optionalHint.className='inv-helper'
    optionalHint.textContent='These are separate unit identifiers, not the single box QR.'
    optional.appendChild(optionalHint)
    const optionalButton=document.createElement('button')
    optionalButton.type='button'
    optionalButton.className='secondary'
    optionalButton.textContent='Prepare individual QR PNGs'
    optional.appendChild(optionalButton)
    const list=document.createElement('div')
    list.className='inv-list'
    optional.appendChild(list)
    optionalButton.addEventListener('click',async()=>{
      optionalButton.disabled=true
      try {
        for(const unit of units) {
          const png=await inventoryUnitPng(unit)
          const file=createPngDownload(png,inventoryPngFilename(unit),
            'Download unit '+String(unit.ordinal).padStart(2,'0'))
          const row=document.createElement('div')
          row.className='inv-line'
          row.append(file.link)
          list.appendChild(row)
        }
        optionalButton.remove()
      }catch(err){alert(err instanceof Error?err.message:'Could not prepare individual QR labels')}
      finally{optionalButton.disabled=false}
    })
    panel.appendChild(optional)
    panel.scrollIntoView({block:'start',behavior:'smooth'})
  } catch(err) {
    panel.textContent=err instanceof Error?err.message:'PNG label generation failed'
    throw err
  }
}

export async function bindInventoryPage(
  h:Helpers,
  section:'inventory'|'purchasing'|'suppliers'='inventory',
) {
  const root=id('inventory-app')
  if (!root) return
  try {
    const data=await listInventory()
    const previousSection=root.dataset.section
    const openPanels=previousSection===section
      ? new Set([...root.querySelectorAll<HTMLDetailsElement>('details[data-core-panel][open]')]
          .map(panel=>panel.dataset.corePanel||''))
      : new Set<string>()
    const priorSearch=previousSection===section
      ? root.querySelector<HTMLInputElement>('.inv-stock-controls input[type="search"]')?.value || ''
      : ''
    const priorFilter=previousSection===section
      ? root.querySelector<HTMLSelectElement>('.inv-stock-controls select')?.value || 'tracked'
      : 'tracked'
    const previousJourneyStep=root.dataset.journeyStep as PurchaseStep|undefined
    const hasSupplierOffers=data.offers.some(o=>o.active&&
      data.vendors.some(v=>v.id===o.vendor_id&&v.active))
    const initialJourneyStep:PurchaseStep=previousSection==='purchasing'&&
      PURCHASE_STEPS.some(([step])=>step===previousJourneyStep)
        ? previousJourneyStep!
        : hasSupplierOffers?'purchase':'supplier'
    const vendorOptions=data.vendors.length
    // Group existing audited workflows without changing their backend actions.
    // Every form remains in the DOM so QR lookups and existing event bindings work.
    root.dataset.section=section
    root.innerHTML=
      '<div data-inventory-group="inventory">'+
      (h.isOwner?'<details class="core-disclosure" data-core-panel="monitor"><summary>Monitoring & alerts</summary><div class="core-disclosure-body"><div id="inv-monitor-slot" class="inv-monitor-slot"></div></div></details>':'')+
      '<div id="inv-overview" class="inv-overview"></div>'+
      '<details class="core-disclosure" data-core-panel="adjust"><summary>Add or adjust physical stock</summary><div class="core-disclosure-body"><div id="inv-manage-stock"></div></div></details>'+
      '<details class="core-disclosure" data-core-panel="audit"><summary>Count and reconcile lots</summary><div class="core-disclosure-body"><div id="inv-audit-slot"></div></div></details>'+
      '<details class="core-disclosure" data-core-panel="lots"><summary>Lots & QR labels</summary><div class="core-disclosure-body">'+lotRows(data.lots,data,h)+'</div></details>'+
      '<details class="core-disclosure" data-core-panel="classification"><summary>Supply settings & reorder thresholds</summary><div class="core-disclosure-body">'+classificationForm(data,h)+'</div></details>'+
      '</div>'+
      '<div data-inventory-group="purchasing">'+purchasingJourneyMarkup(data,h)+'</div>'+
      '<div data-inventory-group="suppliers">'+
      '<div class="inv-journey-supplier-home"><h2>Supplier setup</h2>'+
      '<p>Add suppliers and kit or single-unit offers here. Your purchase workflow will use these prices automatically.</p>'+
      '<a href="#products?section=purchasing" class="inv-journey-subtle-link">Return to Purchasing</a></div>'+
      '<div class="inv-grid">'+
      vendorForm(h)+(data.vendors.length?offersForm(data,h):
        card('<h2>Supplier price book</h2><p>Add a supplier first.</p>'))+
      '</div></div>'+
      '<section id="inv-png-downloads" class="inv-panel" hidden></section>'+
      '<section id="inventory-lookup" class="inv-panel" hidden></section>'

    root.querySelectorAll<HTMLElement>('[data-inventory-group]').forEach(group=>{
      group.hidden=group.dataset.inventoryGroup!==section
    })
    root.querySelectorAll<HTMLDetailsElement>('details[data-core-panel]').forEach(panel=>{
      panel.open=openPanels.has(panel.dataset.corePanel||'')
    })
    // Unit/lot QR deep links always reveal their stock detail panel.
    if (location.hash.startsWith('#inventory?')) {
      root.querySelectorAll<HTMLElement>('[data-inventory-group]').forEach(group=>{
        group.hidden=group.dataset.inventoryGroup!=='inventory'
      })
    }

    const monitorSlot=id('inv-monitor-slot')
    if(h.isOwner && monitorSlot) mountInventoryMonitor(monitorSlot,loadInventoryMonitoring)
    const overview=id('inv-overview')
    if(overview) {
      mountInventoryDashboard(overview,data,async()=>bindInventoryPage(h,section))
      const search=overview.querySelector<HTMLInputElement>('.inv-stock-controls input[type="search"]')
      const filter=overview.querySelector<HTMLSelectElement>('.inv-stock-controls select')
      if (search && priorSearch) {
        search.value=priorSearch
        search.dispatchEvent(new Event('input',{bubbles:true}))
      }
      if (filter && [...filter.options].some(option=>option.value===priorFilter)) {
        filter.value=priorFilter
        filter.dispatchEvent(new Event('change',{bubbles:true}))
      }
    }
    const managerSlot=id('inv-manage-stock')
    if(managerSlot) mountStockManager(managerSlot,data,async()=>bindInventoryPage(h,section))
    const auditSlot=id('inv-audit-slot')
    if(auditSlot) mountInventoryAudit(auditSlot,data,async()=>bindInventoryPage(h,section))
    mountMultiInventory(root,data,async(nextStep)=>{
      if(nextStep)root.dataset.journeyStep=nextStep
      await bindInventoryPage(h,section)
    })
    if(section==='purchasing')bindPurchasingJourney(root,initialJourneyStep)

    const form=(name:string,fn:(f:HTMLFormElement)=>Promise<void>)=>{
      const el=id(name) as HTMLFormElement|null
      el?.addEventListener('submit',async e=>{
        e.preventDefault()
        const button=el.querySelector<HTMLButtonElement>('button[type=submit]')
        if (button) button.disabled=true
        try {
          await fn(el)
          if(name==='inv-receive-po')root.dataset.journeyStep='labels'
          await bindInventoryPage(h,section)
        } catch(err){
          alert(err instanceof Error?err.message:'Inventory action failed')
          if(button)button.disabled=false
        }
      })
    }
    form('inv-add-vendor',async f=>{
      await addInventoryVendor(val(f,'name'),val(f,'code'),val(f,'notes'))
    })
    form('inv-save-offer',async f=>{
      await saveVendorOffer({
        vendorId:val(f,'vendorId'),productId:val(f,'productId'),
        unitsPerPack:num(f,'unitsPerPack'),pricePerPack:num(f,'pricePerPack'),
        estimatedInboundShipping:num(f,'estimatedInboundShipping'),
        vendorSku:val(f,'vendorSku'),leadTimeDays:val(f,'leadTimeDays'),
      })
    })
    const classification=id('inv-classify-product') as HTMLFormElement|null
    const classifiedProduct=classification?.elements.namedItem('productId') as HTMLSelectElement|null
    const updateClassification=()=>{
      const current=data.settings.find(s=>s.product_id===classifiedProduct?.value)
      const mode=classification?.elements.namedItem('supplyMode') as HTMLSelectElement|null
      const reorder=classification?.elements.namedItem('reorderPoint') as HTMLInputElement|null
      if(mode) mode.value=current?.supply_mode||'unreviewed'
      if(reorder) reorder.value=String(current?.reorder_point||0)
    }
    classifiedProduct?.addEventListener('change',updateClassification)
    updateClassification()
    form('inv-classify-product',async f=>{
      await classifyInventoryProduct(val(f,'productId'),
        val(f,'supplyMode') as 'unreviewed'|'physical'|'vendor',num(f,'reorderPoint'))
    })
    const receiveId=uuid()
    const receiveForm=id('inv-receive-po') as HTMLFormElement|null
    const purchaseSelect=receiveForm?.elements.namedItem('orderId') as HTMLSelectElement|null
    const setExpected=()=>{
      const line=data.lines.find(l=>l.purchase_order_id===purchaseSelect?.value)
      const qty=receiveForm?.elements.namedItem('accepted') as HTMLInputElement|null
      if(qty) qty.value=String(line?.expected_units||0)
    }
    purchaseSelect?.addEventListener('change',setExpected)
    form('inv-receive-po',async f=>{
      const orderId=val(f,'orderId'),line=data.lines.find(l=>l.purchase_order_id===orderId)
      const accepted=num(f,'accepted'),damaged=num(f,'damaged')
      if (!line || accepted+damaged!==line.expected_units)
        throw new Error('Usable plus damaged counts must equal the expected units')
      await receiveInventoryPurchase({
        orderId,accepted,damaged,supplierLot:val(f,'supplierLot'),
        expiryDate:val(f,'expiryDate'),requestId:receiveId,
      })
    })
    root.querySelectorAll<HTMLButtonElement>('.inv-audit-lot').forEach(b=>
      b.addEventListener('click',()=>{
        const panel=id('inv-audit-slot')
        const disclosure=panel?.closest('details')
        if(disclosure)disclosure.open=true
        document.dispatchEvent(
          new CustomEvent('core-inventory-audit-lot',{detail:b.dataset.lot||''})
        )
      })
    )
    root.querySelectorAll<HTMLButtonElement>('.inv-download-lot').forEach(b=>
      b.addEventListener('click',async()=>{
        b.disabled=true
        try{
          await prepareLotPngDownloads(b.dataset.lot||'')
          id('inv-png-downloads')?.scrollIntoView({behavior:'smooth',block:'start'})
        }
        catch(err){alert(err instanceof Error?err.message:'Could not create PNG labels')}
        finally{b.disabled=false}
      })
    )
    const query=location.hash.split('?')[1]||''
    const params=new URLSearchParams(query)
    const lotToken=params.get('lot')
    if (lotToken) {
      const panel=id('inventory-lookup')
      if(panel) {
        panel.hidden=false
        const lot=data.lots.find(l=>l.id===lotToken)
        if (!lot) panel.textContent='Lot not found in the current inventory view'
        else {
          const product=data.products.find(p=>p.id===lot.product_id)
          const heading=document.createElement('h2')
          heading.textContent='Scanned inventory lot'
          const details=document.createElement('p')
          details.textContent=(product?.name||'Product')+' · '+lot.internal_lot+
            ' · '+lot.accepted_units+' accepted / '+lot.damaged_units+' damaged'+
            ' · Supplier lot: '+lot.supplier_lot
          const countButton=document.createElement('button')
          countButton.type='button'
          countButton.className='secondary'
          countButton.textContent='Count this lot'
          countButton.addEventListener('click',()=>document.dispatchEvent(
            new CustomEvent('core-inventory-audit-lot',{detail:lot.id})
          ))
          panel.replaceChildren(heading,details,countButton)
        }
        panel.scrollIntoView({block:'start'})
      }
    }
    const unitToken=params.get('unit')
    if (unitToken) {
      const panel=id('inventory-lookup')
      if(panel) {
        panel.hidden=false
        panel.textContent='Looking up scanned inventory unit…'
        try {
          const {units}=await lookupInventoryUnit(unitToken)
          const u=units[0]
          panel.innerHTML='<h2>Scanned unit</h2>'+
            '<p><strong>'+h.escapeHtml(u?.product_name||'Unknown product')+'</strong> · '+
            h.escapeHtml(u?.product_code||'')+'</p>'+
            '<p>Internal lot: '+h.escapeHtml(u?.internal_lot||'')+'</p>'+
            '<p>Supplier lot: '+h.escapeHtml(u?.supplier_lot||'')+'</p>'+
            '<p>Unit '+h.escapeHtml(u?.ordinal||'')+' of '+h.escapeHtml(u?.total_units||'')+
            ' · State: '+h.escapeHtml(u?.state||'')+'</p>'
        } catch(err){panel.textContent=err instanceof Error?err.message:'Could not find scanned unit'}
        panel.scrollIntoView({block:'start'})
      }
    }
  } catch(err) {
    root.innerHTML='<section class="inv-panel"><h2>Inventory could not load</h2>'+
      '<p class="copy">Please refresh and try again. Your existing stock records are unchanged.</p>'+
      '<p class="inv-error">'+h.escapeHtml(err instanceof Error?err.message:'Inventory service unavailable')+'</p></section>'
  }
}
