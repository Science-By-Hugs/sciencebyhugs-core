import {
  addInventoryVendor,createInventoryPurchase,listInventory,listInventoryLotLabels,
  lookupInventoryUnit,receiveInventoryPurchase,saveVendorOffer,
  type InventoryLot,type InventoryPurchase,type InventorySnapshot,type InventoryUnitLabel,
} from './services/inventory'
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
    '<p class="copy">Track vendor costs, receive kits as individual units, and print traceable QR labels.</p>' +
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
    '<p class="inv-empty">No open purchase orders. Create an order above to receive stock.</p>')
}

function lotRows(lots:InventoryLot[],data:InventorySnapshot,h:Helpers) {
  return card('<div class="inv-panel-head"><h2>5. Lots & QR labels</h2>'+
    '<p>Print individual 2 × 1 inch landscape thermal labels, with one QR per vial.</p></div>'+
    '<div class="inv-list">'+(lots.length?lots.map(l=>{
      const p=data.products.find(p=>p.id===l.product_id)
      const v=data.vendors.find(v=>v.id===l.vendor_id)
      return '<div class="inv-line"><div><strong>'+h.escapeHtml(l.internal_lot)+'</strong>'+
        '<small>'+h.escapeHtml(p?.product_code||'—')+' · '+h.escapeHtml(v?.name||'—')+
        ' · '+h.escapeHtml(l.accepted_units)+' accepted, '+h.escapeHtml(l.damaged_units)+' damaged</small>'+
        '<small>Original lot: '+h.escapeHtml(l.supplier_lot)+
        (l.expiry_date?' · Expires '+h.escapeHtml(l.expiry_date):'')+'</small></div>'+
        '<div class="inv-right"><strong>'+h.escapeHtml(l.landed_unit_cost===null?'—':h.money(l.landed_unit_cost))+
        ' / unit</strong><button class="secondary inv-print-lot" data-lot="'+h.escapeHtml(l.id)+
        '" type="button">Print labels</button></div></div>'
    }).join(''):'<p class="inv-empty">Receiving lots will appear here.</p>')+'</div>')
}

function printLabelHtml(labels:InventoryUnitLabel[],h:Helpers) {
  return labels.map(l=>{
    const qr='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(l.qr_svg||'')
    return '<div class="inv-thermal-label"><img class="inv-qr" alt="Unit QR" src="'+qr+'">'+
      '<div class="inv-label-copy"><strong>SCIENCE BY HUGS</strong>'+
      '<span>'+h.escapeHtml(l.product_code||'PRODUCT')+'</span>'+
      '<b>'+h.escapeHtml(l.internal_lot)+'</b>'+
      '<small>UNIT '+String(l.ordinal).padStart(2,'0')+'/'+String(l.total_units).padStart(2,'0')+'</small>'+
      '</div></div>'
  }).join('')
}

async function printLot(lotId:string,h:Helpers) {
  const base=location.origin+location.pathname
  const {units}=await listInventoryLotLabels(lotId,base)
  if (!units.length) throw new Error('No printable units were found')
  if (units.length===100) alert('Only the first 100 labels are available in one batch')
  // Print sheet lives at body level, outside the replaceable Core app shell.
  // Reuse it for reprints to avoid duplicate hidden label pages.
  let target=document.body.querySelector<HTMLElement>('#inventory-print-sheet')
  if (!target) {
    target=document.createElement('section')
    target.id='inventory-print-sheet'
    target.setAttribute('aria-hidden','true')
    document.body.appendChild(target)
  }
  target.innerHTML=printLabelHtml(units,h)
  const imgs=Array.from(target.querySelectorAll<HTMLImageElement>('img'))
  await Promise.all(imgs.map(img=>img.decode().catch(()=>undefined)))
  window.print()
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
      lotRows(data.lots,data,h)+'</div>'+
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
    root.querySelectorAll<HTMLButtonElement>('.inv-print-lot').forEach(b=>
      b.addEventListener('click',async()=>{
        b.disabled=true
        try{await printLot(b.dataset.lot||'',h)}
        catch(err){alert(err instanceof Error?err.message:'Could not print lot labels')}
        finally{b.disabled=false}
      })
    )
    const query=location.hash.split('?')[1]||''
    const unitToken=new URLSearchParams(query).get('unit')
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
