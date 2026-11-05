import {
  addInventoryVendor,classifyInventoryProduct,createInventoryPurchase,listInventory,listInventoryLotLabels,
  lookupInventoryUnit,receiveInventoryPurchase,saveVendorOffer,
  type InventoryLot,type InventoryPurchase,type InventorySnapshot,type InventoryUnitLabel,
} from './services/inventory'
import { inventoryBoxPng, inventoryPngFilename, inventoryUnitPng, inventoryVialPng, lotBoxFilename, suggestedVialFields, vialPngFilename } from './inventory-png'
import './inventory.css'

type Helpers = {
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
    '<p class="copy">Track vendor costs, receive kits as individual units, and download traceable PNG labels.</p>' +
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

function summary(data:InventorySnapshot,h:Helpers) {
  const physical=data.lots.reduce((sum,l)=>sum+number(l.accepted_units),0)
  const damaged=data.lots.reduce((sum,l)=>sum+number(l.damaged_units),0)
  const open=data.orders.filter(x=>x.status==='ordered').length
  return '<div class="inv-metrics">'+[
    ['Received units',physical],['Damaged units',damaged],
    ['Open purchases',open],['Supplier offers',data.offers.length],
  ].map(([label,value])=>'<div class="inv-metric"><strong>'+h.escapeHtml(value)+
    '</strong><small>'+h.escapeHtml(label)+'</small></div>').join('')+'</div>'+
    '<p class="inv-helper">These are recorded receipts, not a sellable-stock guarantee. '+
    'Live Nexus stock limits remain disabled until physical counts are reconciled.</p>'
}

function vendorForm(h:Helpers) {
  return card('<div class="inv-panel-head"><h2>1. Vendors</h2><p>Give each source its own cost history.</p></div>'+
    '<form id="inv-add-vendor" class="inv-form">'+
    field('Vendor name',input('name','text','required maxlength="120" placeholder="Vendor name"'))+
    field('Vendor code',input('code','text','required maxlength="8" minlength="2" placeholder="EML"'))+
    field('Internal note',input('notes','text','maxlength="500" placeholder="Optional"'))+
    '<div class="inv-form-action"><button class="primary" type="submit">Add vendor</button></div></form>')
}

function offersForm(data:InventorySnapshot,h:Helpers) {
  const vendorOptions=data.vendors.filter(v=>v.active).map(v=>option(v.id,v.name+' · '+v.code,h.escapeHtml)).join('')
  const productOptions=data.products.map(p=>option(p.id,(p.product_code||'—')+' · '+p.name,h.escapeHtml)).join('')
  return card('<div class="inv-panel-head"><h2>2. Vendor price book</h2>'+
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

function purchaseForm(data:InventorySnapshot,h:Helpers) {
  const offerOpts=data.offers.filter(o=>o.active).map(o=>{
    const p=data.products.find(p=>p.id===o.product_id),v=data.vendors.find(v=>v.id===o.vendor_id)
    return option(o.id,(v?.code||'—')+' · '+(p?.product_code||p?.name||'—')+
      ' · '+o.units_per_pack+' units @ '+h.money(o.price_per_pack),h.escapeHtml)
  }).join('')
  return card('<div class="inv-panel-head"><h2>3. Purchase kits</h2>'+
    '<p>Actual inbound freight is entered once per purchase. Supplier pricing is snapshotted.</p></div>'+
    '<form id="inv-create-po" class="inv-form">'+
    field('Vendor offering','<select name="offerId" required>'+offerOpts+'</select>')+
    field('Packs purchased',input('packs','number','required min="1" max="1000" value="1" step="1"'))+
    field('Actual inbound shipping ($)',input('shipping','number','min="0" step="0.01" value="0" required'))+
    field('Other inbound fees ($)',input('fees','number','min="0" step="0.01" value="0" required'))+
    '<div class="inv-form-action"><button class="primary" type="submit">Create purchase order</button></div></form>')
}

function receivingForm(data:InventorySnapshot,h:Helpers) {
  const pending=data.orders.filter(o=>o.status==='ordered')
  const select=pending.map(o=>{
    const line=data.lines.find(l=>l.purchase_order_id===o.id)
    const prod=data.products.find(p=>p.id===line?.product_id)
    return option(o.id,o.po_number+' · '+(prod?.name||'Item')+
      ' · '+(line?.expected_units||0)+' expected units',h.escapeHtml)
  }).join('')
  const first=data.lines.find(l=>l.purchase_order_id===pending[0]?.id)
  return card('<div class="inv-panel-head"><h2>4. Receive inventory</h2>'+
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

function lotRows(lots:InventoryLot[],data:InventorySnapshot,h:Helpers) {
  return card('<div class="inv-panel-head"><h2>5. Lots & QR labels</h2>'+
    '<p>Download one lot QR PNG for the outer box and a 1.2 × 0.8-inch horizontal vial-label PNG. Both work with external thermal printer software.</p></div>'+
    '<div class="inv-list">'+(lots.length?lots.map(l=>{
      const p=data.products.find(p=>p.id===l.product_id)
      const v=data.vendors.find(v=>v.id===l.vendor_id)
      return '<div class="inv-line"><div><strong>'+h.escapeHtml(l.internal_lot)+'</strong>'+
        '<small>'+h.escapeHtml(p?.product_code||'—')+' · '+h.escapeHtml(v?.name||'—')+
        ' · '+h.escapeHtml(l.accepted_units)+' accepted, '+h.escapeHtml(l.damaged_units)+' damaged</small>'+
        '<small>Original lot: '+h.escapeHtml(l.supplier_lot)+
        (l.expiry_date?' · Expires '+h.escapeHtml(l.expiry_date):'')+'</small></div>'+
        '<div class="inv-right"><strong>'+h.escapeHtml(l.landed_unit_cost===null?'—':h.money(l.landed_unit_cost))+
        ' / unit</strong><button class="secondary inv-download-lot" data-lot="'+h.escapeHtml(l.id)+
        '" type="button">Prepare box + vial PNGs</button></div></div>'
    }).join(''):'<p class="inv-empty">Receiving lots will appear here.</p>')+'</div>')
}

function classificationForm(data:InventorySnapshot,h:Helpers) {
  const codes=data.products.map(p=>option(p.id,
    (p.product_code||'—')+' · '+p.name,h.escapeHtml)).join('')
  const counts={
    physical:data.settings.filter(s=>s.supply_mode==='physical').length,
    vendor:data.settings.filter(s=>s.supply_mode==='vendor').length,
  }
  return card('<div class="inv-panel-head"><h2>6. Product supply mode</h2>'+
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

export async function bindInventoryPage(h:Helpers) {
  const root=id('inventory-app')
  if (!root) return
  try {
    const data=await listInventory()
    const vendorOptions=data.vendors.length
    root.innerHTML=summary(data,h)+'<div class="inv-grid">'+
      vendorForm(h)+
      (vendorOptions?offersForm(data,h):card('<h2>2. Vendor price book</h2><p>Add a vendor first.</p>'))+
      (data.offers.length?purchaseForm(data,h):card('<h2>3. Purchase kits</h2><p>Add an offering first.</p>'))+
      receivingForm(data,h)+
      lotRows(data.lots,data,h)+classificationForm(data,h)+'</div>'+ 
      '<section id="inv-png-downloads" class="inv-panel" hidden></section>'+ 
      '<section id="inventory-lookup" class="inv-panel" hidden></section>'

    const form=(name:string,fn:(f:HTMLFormElement)=>Promise<void>)=>{
      const el=id(name) as HTMLFormElement|null
      el?.addEventListener('submit',async e=>{
        e.preventDefault()
        const button=el.querySelector<HTMLButtonElement>('button[type=submit]')
        if (button) button.disabled=true
        try { await fn(el); await bindInventoryPage(h) }
        catch(err){alert(err instanceof Error?err.message:'Inventory action failed');if(button)button.disabled=false}
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
    const purchaseId=uuid()
    form('inv-create-po',async f=>{
      await createInventoryPurchase(val(f,'offerId'),num(f,'packs'),
        num(f,'shipping'),num(f,'fees'),purchaseId)
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
    root.querySelectorAll<HTMLButtonElement>('.inv-download-lot').forEach(b=>
      b.addEventListener('click',async()=>{
        b.disabled=true
        try{await prepareLotPngDownloads(b.dataset.lot||'')}
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
          panel.replaceChildren(heading,details)
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
    root.innerHTML='<section class="inv-panel"><h2>Inventory foundation is not activated yet</h2>'+
      '<p class="copy">This feature is being developed separately. Current catalog, orders and emails are unchanged.</p>'+
      '<p class="inv-error">'+h.escapeHtml(err instanceof Error?err.message:'Inventory service unavailable')+'</p></section>'
  }
}
