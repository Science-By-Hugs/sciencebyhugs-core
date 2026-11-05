import {
  loadLotAudit,submitLotCount,resolveLotCount,
  type InventoryAuditLot,type InventoryStockAudit,type InventoryAuditUnit,
  type InventorySnapshot,
} from './services/inventory'

const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',value='')=>{
  const node=document.createElement(tag)
  if(className)node.className=className
  if(value)node.textContent=value
  return node
}
function field(name:string,initial:number) {
  const label=el('label','inv-field')
  label.appendChild(el('span','',name))
  const input=el('input')
  input.type='number'
  input.min='0'
  input.max='100'
  input.step='1'
  input.required=true
  input.value=String(initial)
  label.appendChild(input)
  return {label,input}
}
function mismatch(audit:InventoryStockAudit) {
  return {
    available:audit.expected_available-audit.counted_available,
    damaged:audit.expected_damaged-audit.counted_damaged,
  }
}
const currentNote='A saved count does not change stock. Only explicitly confirmed, identified missing units are marked missing. Previous receipt history is never edited.'

export function mountInventoryAudit(
  host:HTMLElement,data:InventorySnapshot,
  onRefresh:()=>Promise<void>,
) {
  const section=el('section','inv-panel inv-audit-panel')
  section.id='inventory-audit-workspace'
  const header=el('div','inv-panel-head')
  header.append(
    el('h2','','Physical stock reconciliation'),
    el('p','',
      'Count the usable and damaged vials in a lot. Review differences before making any adjustment.')
  )
  section.appendChild(header)
  section.appendChild(el('p','inv-helper',currentNote))
  const picker=el('div','inv-audit-picker')
  const label=el('label','inv-field')
  label.appendChild(el('span','','Choose a lot, or scan its box QR'))
  const select=el('select')
  select.appendChild(el('option','','Select a lot to count'))
  for (const lot of data.lots) {
    const product=data.products.find(p=>p.id===lot.product_id)
    const option=el('option','',(product?.name||'Product')+' · '+lot.internal_lot)
    option.value=lot.id
    select.appendChild(option)
  }
  label.appendChild(select)
  picker.appendChild(label)
  section.appendChild(picker)
  const output=el('div','inv-audit-content')
  section.appendChild(output)
  let loadSequence=0
  let lotSelected=''
  let details:InventoryAuditLot|null=null

  async function showLot(lotId:string,scroll=false) {
    if(!lotId)return
    lotSelected=lotId
    select.value=lotId
    if(select.value!==lotId){
      output.replaceChildren(el('p','inv-stock-warning','That lot is outside the currently loaded inventory list. Refresh Core to locate it.'))
      return
    }
    const sequence=++loadSequence
    output.replaceChildren(el('p','inv-helper','Reading tracked units and count history…'))
    try{
      const response=await loadLotAudit(lotId)
      if(sequence!==loadSequence)return
      details=response
      renderDetails(response)
      if(scroll)section.scrollIntoView({behavior:'smooth',block:'start'})
    }catch(err){
      if(sequence!==loadSequence)return
      output.replaceChildren(el('p','inv-stock-warning',
        err instanceof Error?err.message:'Could not read stock count details'))
    }
  }

  function createResolution(
    audit:InventoryStockAudit,detail:InventoryAuditLot,
  ) {
    const diff=mismatch(audit)
    const box=el('div','inv-audit-reconcile')
    box.appendChild(el('h3','','Investigate this count'))
    if(diff.available<0||diff.damaged<0) {
      box.appendChild(el('p','inv-stock-warning',
        'The count shows additional vials. Core will not invent inventory or QR IDs. Check supplier/lot records and resolve this discrepancy manually.'))
      return box
    }
    if(diff.available===0&&diff.damaged===0) {
      box.appendChild(el('p','inv-helper','This count matches the recorded stock.'))
      return box
    }
    box.appendChild(el('p','inv-helper',
      'Shortage: '+diff.available+' available and '+diff.damaged+
      ' damaged. Choose the exact tracked unit numbers that are physically missing. If you cannot identify them, leave the discrepancy pending.'))
    const units=detail.units.filter(u=>u.state==='available'||u.state==='damaged')
    const choices=el('div','inv-audit-unit-grid')
    const checkboxes:{unit:InventoryAuditUnit;control:HTMLInputElement}[]=[]
    for(const unit of units) {
      const item=el('label','inv-audit-unit')
      const checkbox=el('input') as HTMLInputElement
      checkbox.type='checkbox'
      checkbox.value=unit.id
      const label=el('span','',
        'Unit '+String(unit.ordinal).padStart(2,'0')+' · '+unit.state)
      item.append(checkbox,label)
      choices.appendChild(item)
      checkboxes.push({unit,control:checkbox})
    }
    box.appendChild(choices)
    const validate=()=>{
      const chosen=checkboxes.filter(x=>x.control.checked)
      return {
        chosen,
        valid:chosen.filter(x=>x.unit.state==='available').length===diff.available &&
          chosen.filter(x=>x.unit.state==='damaged').length===diff.damaged,
      }
    }
    const text=el('p','inv-audit-selection','Select '+diff.available+
      ' available and '+diff.damaged+' damaged unit identifiers.')
    box.appendChild(text)
    const approve=el('label','inv-audit-confirm')
    const acknowledged=el('input') as HTMLInputElement
    acknowledged.type='checkbox'
    approve.append(acknowledged,el('span','',
      'I confirmed these exact unit identifiers are missing and approve an audited stock correction.'))
    box.appendChild(approve)
    const button=el('button','secondary','Confirm missing units')
    button.type='button';button.disabled=true
    const update=()=>{
      const result=validate()
      button.disabled=!result.valid||!acknowledged.checked
      text.textContent=result.chosen.length+' selected · '+
        (result.valid?'matches shortages':'selection must match shortages in both categories')
    }
    choices.addEventListener('change',update)
    acknowledged.addEventListener('change',update)
    const resultText=el('p','inv-helper')
    button.addEventListener('click',async()=>{
      const selected=validate()
      if(!selected.valid||!acknowledged.checked)return
      button.disabled=true
      try{
        const response=await resolveLotCount(audit.id,selected.chosen.map(x=>x.unit.id))
        resultText.textContent=response.reconciliation.already_resolved?
          'This count was already reconciled.':'Stock correction recorded with an immutable movement trail.'
        await onRefresh()
      }catch(err){
        resultText.textContent=err instanceof Error?err.message:'Stock correction failed'
        update()
      }
    })
    box.append(button,resultText)
    return box
  }

  function renderDetails(detail:InventoryAuditLot,focusedCountId?:string) {
    output.replaceChildren()
    const summary=el('div','inv-audit-summary')
    summary.append(
      el('h3','','Lot '+detail.lot.internal_lot),
      el('p','','Supplier lot: '+detail.lot.supplier_lot),
      el('p','','Core currently tracks '+detail.counts.available+' available · '+
        detail.counts.damaged+' damaged · '+detail.counts.missing+' missing.')
    )
    if(detail.counts.reserved||detail.counts.quarantined)
      summary.appendChild(el('p','inv-stock-warning',
        'Reserved and quarantined units are excluded from these two count fields; verify them separately.'))
    output.appendChild(summary)
    const form=el('form','inv-audit-form')
    const grid=el('div','inv-form')
    const available=field('Usable vials physically present',detail.counts.available)
    const damaged=field('Damaged vials physically present',detail.counts.damaged)
    grid.append(available.label,damaged.label)
    const noteLabel=el('label','inv-field')
    noteLabel.appendChild(el('span','','Count notes / discrepancy evidence (optional)'))
    const notes=el('textarea')
    notes.maxLength=500
    notes.rows=2
    notes.placeholder='Location counted; box condition; who verified it'
    noteLabel.appendChild(notes)
    form.append(grid,noteLabel)
    const submit=el('button','primary','Save physical count')
    submit.type='submit'
    form.appendChild(submit)
    const notice=el('p','inv-helper','Saving a count never edits stock.')
    form.appendChild(notice)
    output.appendChild(form)
    let requestId=crypto.randomUUID()
    const resetId=()=>{requestId=crypto.randomUUID()}
    available.input.addEventListener('input',resetId)
    damaged.input.addEventListener('input',resetId)
    notes.addEventListener('input',resetId)
    form.addEventListener('submit',async event=>{
      event.preventDefault()
      const actualAvailable=Number(available.input.value)
      const actualDamaged=Number(damaged.input.value)
      if(!Number.isInteger(actualAvailable)||!Number.isInteger(actualDamaged)||
        actualAvailable<0||actualDamaged<0||actualAvailable>100||actualDamaged>100) {
        notice.textContent='Enter whole numbers from 0 to 100'
        return
      }
      submit.disabled=true
      try{
        const result=await submitLotCount({
          lotId:detail.lot.id,countedAvailable:actualAvailable,
          countedDamaged:actualDamaged,notes:notes.value,requestId,
        })
        notice.textContent=result.audit.status==='matched'?
          'Count matched Core’s tracked stock. Audit saved without an adjustment.':
          'Difference recorded. Investigate before confirming any stock changes.'
        const newer=await loadLotAudit(detail.lot.id)
        if(lotSelected===detail.lot.id)renderDetails(newer,result.audit.count_id)
      }catch(err){
        notice.textContent=err instanceof Error?err.message:'Could not save count'
      }finally{submit.disabled=false}
    })

    const history=el('div','inv-audit-history')
    history.appendChild(el('h3','','Previous counts for this lot'))
    if(!detail.history.length)history.appendChild(el('p','inv-empty','No physical counts recorded yet.'))
    for(const audit of detail.history) {
      const line=el('div','inv-audit-history-line')
      line.append(
        el('strong','',new Date(audit.created_at).toLocaleString()+' · '+audit.status),
        el('small','',
          'Available '+audit.expected_available+' → '+audit.counted_available+
          ' · Damaged '+audit.expected_damaged+' → '+audit.counted_damaged),
      )
      if(audit.notes)line.appendChild(el('small','',audit.notes))
      if(audit.status==='pending'||audit.id===focusedCountId)
        line.appendChild(createResolution(audit,detail))
      if(audit.status==='resolved')
        line.appendChild(el('small','','Corrected tracked unit IDs: '+audit.resolved_unit_ids.length))
      history.appendChild(line)
    }
    output.appendChild(history)
  }

  select.addEventListener('change',()=>{
    if(select.value)void showLot(select.value,true)
    else {lotSelected='';++loadSequence;output.replaceChildren()}
  })
  const onLot=(event:Event)=>{
    const lotId=(event as CustomEvent<string>).detail
    if(typeof lotId==='string')void showLot(lotId,true)
  }
  // Avoid duplicate listeners from an old inventory render.
  const oldListener=(window as typeof window & {__coreAuditLotListener?:EventListener}).__coreAuditLotListener
  if(oldListener)document.removeEventListener('core-inventory-audit-lot',oldListener)
  document.addEventListener('core-inventory-audit-lot',onLot)
  ;(window as typeof window & {__coreAuditLotListener?:EventListener}).__coreAuditLotListener=onLot

  host.replaceChildren(section)
  const lotFromQr=new URLSearchParams(location.hash.split('?')[1]||'').get('lot')
  if(lotFromQr && data.lots.some(l=>l.id===lotFromQr))void showLot(lotFromQr,true)
}
