import {
  adjustInventoryUnits,createInventoryPurchase,loadLotAudit,
  receiveInventoryPurchase,
  type InventorySnapshot,type InventoryAuditLot,type TrackedStockAction,
} from './services/inventory'

// This workspace uses receipt/lot/unit records; it never assigns a stock total
// or changes the state of reserved, allocated, or shipped customer units.
const element = <T extends HTMLElement = HTMLElement>(tag:string,className='',value='') => {
  const node=document.createElement(tag) as T
  if(className)node.className=className
  if(value)node.textContent=value
  return node
}
const label = (title:string,control:HTMLElement) => {
  const wrapper=element('label','inv-field')
  wrapper.append(element('span','',title),control)
  return wrapper
}
const option = (select:HTMLSelectElement,value:string,text:string) =>
  select.add(new Option(text,value))
const quantity = (value:string) => Number(value)
const message = (panel:HTMLElement,text:string) => { panel.textContent=text }

export function mountStockManager(
  target:HTMLElement,data:InventorySnapshot,onRefresh:()=>Promise<void>,
) {
  const grid=element('div','inv-grid')
  target.replaceChildren(grid)
  const modes=new Map(data.settings.map(s=>[s.product_id,s.supply_mode]))
  const activeVendors=new Map(data.vendors.filter(v=>v.active).map(v=>[v.id,v.name]))
  const offers=data.offers.filter(o=>o.active && activeVendors.has(o.vendor_id) &&
    modes.get(o.product_id)==='physical' && o.units_per_pack>0)
  const stock=element('section','inv-panel')
  stock.append(element('h2','','Add current physical stock'),
    element('p','inv-helper',
      'Use this only for units not already tracked in Core. Each receipt creates a new lot and unique unit IDs. Existing units must never be added twice.'))
  grid.append(stock)
  if(!offers.length){
    stock.append(element('p','inv-empty',
      'No active vendor offers for physical products. Add a vendor offering in the price book first.'))
  }else{
    const form=element<HTMLFormElement>('form','inv-form')
    const pick=element<HTMLSelectElement>('select')
    pick.required=true
    for(const offer of offers){
      const product=data.products.find(p=>p.id===offer.product_id)
      option(pick,offer.id,(product?.product_code||product?.name||'Product')+
        ' · '+activeVendors.get(offer.vendor_id)+' · '+offer.units_per_pack+' units/pack')
    }
    const packs=element<HTMLInputElement>('input')
    Object.assign(packs,{type:'number',min:'1',max:'100',step:'1',value:'1',required:true})
    const damaged=element<HTMLInputElement>('input')
    Object.assign(damaged,{type:'number',min:'0',max:'100',step:'1',value:'0',required:true})
    const supplierLot=element<HTMLInputElement>('input')
    Object.assign(supplierLot,{type:'text',maxLength:120,required:true,placeholder:'Lot printed on packaging'})
    const expiry=element<HTMLInputElement>('input')
    expiry.type='date'
    const freight=element<HTMLInputElement>('input')
    Object.assign(freight,{type:'number',min:'0',step:'0.01',value:'0',required:true})
    const fees=element<HTMLInputElement>('input')
    Object.assign(fees,{type:'number',min:'0',step:'0.01',value:'0',required:true})
    const preview=element('p','inv-helper')
    const confirmed=element<HTMLInputElement>('input')
    confirmed.type='checkbox';confirmed.required=true
    const confirmation=element('label','inv-field')
    confirmation.append(confirmed,element('span','',
      'I have physically counted these units and confirm they are NOT already in Core.'))
    const submit=element<HTMLButtonElement>('button','primary','Create tracked receipt')
    submit.type='submit'
    const notice=element('p','inv-helper')
    form.append(
      label('Product / supplier offering',pick),
      label('Number of packs',packs),
      label('Damaged units within this receipt',damaged),
      label('Supplier lot number',supplierLot),
      label('Expiry date (if printed)',expiry),
      label('Actual vendor shipping ($)',freight),
      label('Other actual fees ($)',fees),
      preview,confirmation,submit,notice
    )
    stock.append(form)
    const selectedOffer=()=>offers.find(o=>o.id===pick.value)
    const update=()=>{
      const offer=selectedOffer()
      const expected=(offer?.units_per_pack||0)*quantity(packs.value)
      const unusable=quantity(damaged.value)
      preview.textContent='New units: '+expected+' total · '+(expected-unusable)+
        ' available · '+unusable+' damaged. Limit: 100 units per receipt.'
    }
    pick.addEventListener('change',update)
    packs.addEventListener('input',update)
    damaged.addEventListener('input',update)
    update()
    let poRequest=crypto.randomUUID(),receiptRequest=crypto.randomUUID()
    let started=false
    form.addEventListener('submit',async e=>{
      e.preventDefault()
      const offer=selectedOffer()
      const count=Number(packs.value),bad=Number(damaged.value)
      const expected=(offer?.units_per_pack||0)*count
      const shipping=Number(freight.value),extraFees=Number(fees.value)
      if(!offer||!Number.isInteger(count)||count<1||!Number.isInteger(bad)||
        bad<0||bad>expected||expected>100||!supplierLot.value.trim()||
        !Number.isFinite(shipping)||shipping<0||!Number.isFinite(extraFees)||extraFees<0||
        !confirmed.checked){
        message(notice,'Check quantities, supplier lot and the duplicate-stock confirmation.')
        return
      }
      if(!window.confirm('Create '+expected+' NEW tracked units? Existing Core stock will not be changed.'))return
      submit.disabled=true
      // Reuse these keys on retries. If receiving fails after PO creation,
      // the open PO remains available in the existing Receive Inventory form.
      started=true
      try{
        const order=await createInventoryPurchase(offer.id,count,shipping,extraFees,poRequest)
        await receiveInventoryPurchase({
          orderId:order.purchase.id,accepted:expected-bad,damaged:bad,
          supplierLot:supplierLot.value.trim(),expiryDate:expiry.value,requestId:receiptRequest,
        })
        message(notice,'Stock received with unique lot and unit IDs.')
        await onRefresh()
      }catch(err){
        message(notice,(err instanceof Error?err.message:'Stock receipt failed')+
          ' If a purchase order was created, finish it under Receive inventory; do not create another.')
      }finally{
        submit.disabled=false
      }
    })
    // Prevent accidental reuse of the same idempotency key with edited content.
    form.addEventListener('input',()=>{
      if(started)notice.textContent='Receipt started. Keep the original values when retrying.'
      else {poRequest=crypto.randomUUID();receiptRequest=crypto.randomUUID()}
    })
  }

  const adjust=element('section','inv-panel')
  adjust.append(
    element('h2','','Edit tracked stock'),
    element('p','inv-helper',
      'Choose exact unit IDs to mark damaged, quarantine, or restore. Paid and reserved units are always protected. To record missing stock, use Count stock below.'))
  grid.append(adjust)
  if(!data.lots.length){
    adjust.append(element('p','inv-empty','No tracked lots yet.'))
    return
  }
  const lotPick=element<HTMLSelectElement>('select')
  option(lotPick,'','Select lot')
  for(const lot of data.lots){
    const product=data.products.find(p=>p.id===lot.product_id)
    option(lotPick,lot.id,(product?.product_code||product?.name||'Product')+' · '+lot.internal_lot)
  }
  const actionPick=element<HTMLSelectElement>('select')
  const actions:[TrackedStockAction,string][]=[
    ['damage','Mark available units damaged'],
    ['quarantine','Quarantine available units'],
    ['restore_damaged','Restore verified damaged units'],
    ['restore_quarantined','Release verified quarantined units'],
  ]
  for(const [value,title] of actions)option(actionPick,value,title)
  const unitsArea=element('div','inv-audit-unit-grid')
  const reason=element<HTMLTextAreaElement>('textarea')
  Object.assign(reason,{maxLength:500,rows:2,placeholder:'Why are these specific units changing status?'})
  const acknowledger=element<HTMLInputElement>('input')
  acknowledger.type='checkbox'
  const approval=element('label','inv-field')
  approval.append(acknowledger,element('span','',
    'I verified the selected physical units and approve an audited status change.'))
  const button=element<HTMLButtonElement>('button','secondary','Apply unit changes')
  button.type='submit'
  const status=element('p','inv-helper')
  const adjustForm=element<HTMLFormElement>('form','inv-form')
  adjustForm.append(label('Tracked lot',lotPick),label('Stock adjustment',actionPick),
    unitsArea,label('Required reason',reason),approval,button,status)
  adjust.append(adjustForm)
  let detail:InventoryAuditLot|null=null
  let adjustRequest=crypto.randomUUID()
  const eligible=(state:string,action:TrackedStockAction)=>(
    action==='damage'||action==='quarantine'?state==='available':
    action==='restore_damaged'?state==='damaged':state==='quarantined'
  )
  const redraw=()=>{
    unitsArea.replaceChildren()
    const action=actionPick.value as TrackedStockAction
    const candidates=(detail?.units||[]).filter(unit=>eligible(unit.state,action))
    if(!candidates.length){
      unitsArea.append(element('p','inv-empty','No eligible units for this adjustment.'))
      return
    }
    for(const unit of candidates){
      const item=element('label','inv-audit-unit')
      const check=element<HTMLInputElement>('input')
      check.type='checkbox';check.value=unit.id
      item.append(check,element('span','',
        'Unit '+String(unit.ordinal).padStart(2,'0')+' · '+unit.state))
      unitsArea.append(item)
    }
  }
  lotPick.addEventListener('change',async()=>{
    detail=null;unitsArea.replaceChildren()
    if(!lotPick.value)return
    message(status,'Loading tracked units…')
    try{
      detail=await loadLotAudit(lotPick.value)
      message(status,'Select the exact physical unit IDs.')
      redraw()
    }catch(err){message(status,err instanceof Error?err.message:'Could not read tracked lot')}
  })
  actionPick.addEventListener('change',()=>{adjustRequest=crypto.randomUUID();redraw()})
  unitsArea.addEventListener('change',()=>{adjustRequest=crypto.randomUUID()})
  reason.addEventListener('input',()=>{adjustRequest=crypto.randomUUID()})
  adjustForm.addEventListener('submit',async e=>{
    e.preventDefault()
    const unitIds=[...unitsArea.querySelectorAll<HTMLInputElement>('input:checked')]
      .map(x=>x.value).sort()
    const action=actionPick.value as TrackedStockAction
    const note=reason.value.trim()
    if(!detail||!unitIds.length||note.length<8||!acknowledger.checked){
      message(status,'Select units, provide a reason of at least 8 characters, and confirm.')
      return
    }
    if(!window.confirm('Change '+unitIds.length+' specifically selected unit(s)? This is audited.'))return
    button.disabled=true
    try{
      const result=await adjustInventoryUnits({
        lotId:detail.lot.id,unitIds,statusAction:action,reason:note,requestId:adjustRequest,
      })
      message(status,result.adjustment.already_saved?'Already recorded.':'Unit statuses updated.')
      await onRefresh()
    }catch(err){
      message(status,err instanceof Error?err.message:'Stock adjustment failed')
      button.disabled=false
    }
  })
}
