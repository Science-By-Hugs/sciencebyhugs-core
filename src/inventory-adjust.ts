import {
  adjustInventoryUnits,loadLotAudit,registerCurrentStock,
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
  const products=data.products.filter(p=>modes.get(p.id)==='physical')
  const vendors=data.vendors.filter(v=>v.active)
  const stock=element('section','inv-panel')
  stock.append(element('h2','','Add current physical stock'),
    element('p','inv-helper',
      'Enter your exact on-hand count, even if it is fewer than a full kit. Core creates a new receipt, lot and unique unit IDs. Never enter units that Core already tracks.'))
  grid.append(stock)
  if(!products.length || !vendors.length) {
    stock.append(element('p','inv-empty',
      'Classify a product as Physical stock and add an active inventory vendor first.'))
  } else {
    const form=element<HTMLFormElement>('form','inv-form')
    const product=element<HTMLSelectElement>('select')
    for(const item of products)option(product,item.id,(item.product_code||'—')+' · '+item.name)
    const vendor=element<HTMLSelectElement>('select')
    for(const item of vendors)option(vendor,item.id,item.name+' · '+item.code)
    const total=element<HTMLInputElement>('input')
    Object.assign(total,{type:'number',min:'1',max:'100',step:'1',value:'1',required:true})
    const damaged=element<HTMLInputElement>('input')
    Object.assign(damaged,{type:'number',min:'0',max:'100',step:'1',value:'0',required:true})
    const unitCost=element<HTMLInputElement>('input')
    Object.assign(unitCost,{type:'number',min:'0.01',max:'100000',step:'0.01',required:true,placeholder:'Actual or verified estimated cost per unit'})
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
      'I counted these physical units and confirm they are NOT already in Core.'))
    const submit=element<HTMLButtonElement>('button','primary','Record current stock')
    submit.type='submit'
    const notice=element('p','inv-helper')
    form.append(
      label('Core product',product),label('Source vendor',vendor),
      label('Actual total units',total),label('Damaged within this count',damaged),
      label('Purchase cost per unit ($)',unitCost),
      label('Supplier lot number',supplierLot),
      label('Expiry date (if printed)',expiry),
      label('Original inbound shipping ($)',freight),
      label('Original other fees ($)',fees),
      preview,confirmation,submit,notice
    )
    stock.append(form)
    const update=()=>{
      const count=quantity(total.value),bad=quantity(damaged.value)
      preview.textContent='New units: '+count+' total · '+(count-bad)+
        ' available · '+bad+' damaged. Existing Core stock remains recorded separately.'
    }
    total.addEventListener('input',update)
    damaged.addEventListener('input',update)
    update()
    let request=crypto.randomUUID(),started=false
    form.addEventListener('submit',async e=>{
      e.preventDefault()
      const count=Number(total.value),bad=Number(damaged.value),
        cost=Number(unitCost.value),ship=Number(freight.value),fee=Number(fees.value)
      if(!Number.isInteger(count)||count<1||count>100||!Number.isInteger(bad)||
        bad<0||bad>count||!Number.isFinite(cost)||cost<=0||
        !Number.isFinite(ship)||ship<0||!Number.isFinite(fee)||fee<0||
        !supplierLot.value.trim()||!confirmed.checked){
        message(notice,'Verify the exact units, cost, supplier lot, and duplicate-stock confirmation.')
        return
      }
      if(!window.confirm('Register '+count+' NEW physical units? This creates a permanent tracked receipt.'))return
      submit.disabled=true
      started=true
      try {
        const result=await registerCurrentStock({
          productId:product.value,vendorId:vendor.value,total:count,damaged:bad,
          unitCost:cost,shipping:ship,fees:fee,supplierLot:supplierLot.value.trim(),
          expiryDate:expiry.value,requestId:request,
        })
        message(notice,result.receipt.already_received?'Receipt already recorded.':'Current stock recorded with unique lot and unit IDs.')
        await onRefresh()
      } catch(err) {
        message(notice,err instanceof Error?err.message:'Current stock could not be recorded')
        submit.disabled=false
      }
    })
    form.addEventListener('input',()=>{
      if(started)notice.textContent='A receipt was submitted. Keep these values unchanged when retrying.'
      else request=crypto.randomUUID()
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
