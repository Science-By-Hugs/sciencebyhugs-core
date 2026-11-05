import {
  createMultiInventoryPurchase,receiveMultiInventoryLine,
  type AllocationMethod,type InventorySnapshot,type InventoryPurchaseLine,
  type MultiPurchaseLineInput,
} from './services/inventory'

type DraftLine = {offerId:string;packs:number;shipping:number;fees:number}
const dollars = (n:number) => new Intl.NumberFormat('en-US',{
  style:'currency',currency:'USD',
}).format(n)
const cents = (n:number) => Math.round(n*100)

// Allocate exact cents; the final line absorbs deterministic rounding residual.
export function splitCents(total:number,weights:number[]) {
  const amount=cents(total)
  const weightSum=weights.reduce((sum,w)=>sum+w,0)
  if (!weights.length || weights.some(w=>!Number.isFinite(w)||w<0)||weightSum<=0)
    throw new Error('Allocation weights must be positive')
  let left=amount
  return weights.map((w,index)=>{
    const part=index===weights.length-1?left:Math.round(amount*w/weightSum)
    left-=part
    return part/100
  })
}

export function allocationPreview(
  lines:DraftLine[],offers:InventorySnapshot['offers'],
  method:AllocationMethod,shipping:number,fees:number,
) {
  if(!lines.length) return []
  const priced=lines.map(line=>{
    const offer=offers.find(o=>o.id===line.offerId)
    if(!offer) throw new Error('Choose a valid vendor offering')
    if(!Number.isInteger(line.packs)||line.packs<1||line.packs>1000)
      throw new Error('Kit quantities must be whole numbers between 1 and 1,000')
    return {
      line,offer,productCost:Number(offer.price_per_pack)*line.packs,
      expectedUnits:line.packs*Number(offer.units_per_pack),
    }
  })
  const rawWeights=priced.map(x=>method==='by_cost'?x.productCost:x.line.packs)
  const weights=rawWeights.every(w=>w===0)?priced.map(x=>x.line.packs):rawWeights
  const ship=method==='manual'?lines.map(x=>x.shipping):splitCents(shipping,weights)
  const fee=method==='manual'?lines.map(x=>x.fees):splitCents(fees,weights)
  return priced.map((x,i)=>({
    ...x,shipping:ship[i],fees:fee[i],
    estimatedUnitCost:(x.productCost+ship[i]+fee[i])/x.expectedUnits,
  }))
}

function element<K extends keyof HTMLElementTagNameMap>(tag:K,className='') {
  const node=document.createElement(tag)
  node.className=className
  return node
}
function text(tag:'p'|'h2'|'h3'|'strong'|'span'|'small',value:string,cls='') {
  const node=element(tag,cls)
  node.textContent=value
  return node
}
function addInput(labelText:string,type:string,value:string,extra?:{
  min?:string;max?:string;step?:string;placeholder?:string
}) {
  const label=element('label','inv-field')
  label.appendChild(text('span',labelText))
  const field=element('input')
  field.type=type;field.value=value
  if(extra?.min)field.min=extra.min
  if(extra?.max)field.max=extra.max
  if(extra?.step)field.step=extra.step
  if(extra?.placeholder)field.placeholder=extra.placeholder
  label.appendChild(field)
  return {label,field}
}
function selectField(labelText:string,items:{value:string;label:string}[]) {
  const label=element('label','inv-field')
  label.appendChild(text('span',labelText))
  const select=element('select')
  for(const item of items) {
    const option=element('option')
    option.value=item.value;option.textContent=item.label
    select.appendChild(option)
  }
  label.appendChild(select)
  return {label,select}
}

export function mountMultiInventory(
  root:HTMLElement,data:InventorySnapshot,onChange:()=>Promise<void>,
) {
  const purchase=element('section','inv-panel inv-multi-workspace')
  const title=element('div','inv-panel-head')
  title.append(text('h2','3. Purchase multiple kits in one order'),
    text('p','Select one vendor. Add different product offerings, then enter shared shipping and fees only once.'))
  purchase.appendChild(title)

  const offerVendors=data.vendors.filter(v=>v.active&&
    data.offers.some(o=>o.active&&o.vendor_id===v.id))
  if(!offerVendors.length) {
    purchase.appendChild(text('p','Create an active vendor offering first.','inv-empty'))
  } else {
    const form=element('form','inv-multi-form')
    const details=element('div','inv-form')
    const vendor=selectField('Vendor',offerVendors.map(v=>({value:v.id,label:v.name})))
    const method=selectField('Allocate inbound costs',[
      {value:'per_kit',label:'Equal per kit (recommended)'},
      {value:'by_cost',label:'Proportional to product cost'},
      {value:'manual',label:'Manual per product line'},
    ])
    const ship=addInput('Total shipping ($)','number','0',{min:'0',step:'0.01'})
    const fees=addInput('Total payment / other fees ($)','number','0',{min:'0',step:'0.01'})
    details.append(vendor.label,method.label,ship.label,fees.label)
    form.appendChild(details)
    form.appendChild(text('h3','Product kits'))
    const rows=element('div','inv-multi-lines')
    form.appendChild(rows)
    const add=element('button')
    add.type='button';add.className='secondary';add.textContent='Add another product kit'
    form.appendChild(add)
    const preview=element('div','inv-multi-preview')
    form.appendChild(preview)
    const message=text('p','','inv-helper')
    form.appendChild(message)
    const submit=element('button')
    submit.type='submit';submit.className='primary';submit.textContent='Create multi-product purchase order'
    form.appendChild(submit)
    purchase.appendChild(form)
    let lines:DraftLine[]=[{offerId:'',packs:1,shipping:0,fees:0}]
    function vendorOffers() {
      return data.offers.filter(o=>o.active&&o.vendor_id===vendor.select.value)
    }
    function previewLines() {
      preview.replaceChildren()
      try {
        const activeMethod=method.select.value as AllocationMethod
        const shipping=Number(ship.field.value),feeTotal=Number(fees.field.value)
        if(!Number.isFinite(shipping)||!Number.isFinite(feeTotal)||
          shipping<0||feeTotal<0||cents(shipping)/100!==shipping||
          cents(feeTotal)/100!==feeTotal)throw new Error('Enter nonnegative shipping and fee amounts in cents')
        if(new Set(lines.map(l=>l.offerId)).size!==lines.length)
          throw new Error('Choose a different offering for each line')
        const costs=allocationPreview(lines,vendorOffers(),activeMethod,shipping,feeTotal)
        if (activeMethod==='manual' &&
          (cents(costs.reduce((s,x)=>s+x.shipping,0))!==cents(shipping) ||
           cents(costs.reduce((s,x)=>s+x.fees,0))!==cents(feeTotal)))
          throw new Error('Manual line allocations must add up to shared shipping and fees')
        const list=element('div','inv-list')
        for(const x of costs) {
          const product=data.products.find(p=>p.id===x.offer.product_id)
          const line=element('div','inv-line')
          line.appendChild(text('span',
            (product?.name||'Product')+' · '+x.line.packs+' kits · '+
            x.expectedUnits+' expected units'))
          line.appendChild(text('strong',dollars(x.productCost+x.shipping+x.fees)+
            ' landed / '+dollars(x.estimatedUnitCost)+' per expected vial'))
          list.appendChild(line)
        }
        const total=costs.reduce((s,x)=>s+x.productCost,0)+shipping+feeTotal
        preview.append(text('h3','Purchase preview'),list,
          text('strong','Total including one shipping charge: '+dollars(total)))
        message.textContent='Landed cost is preliminary until received usable quantities are verified.'
        submit.disabled=false
      } catch(err) {
        preview.appendChild(text('p',err instanceof Error?err.message:'Check product lines','inv-error'))
        message.textContent=''
        submit.disabled=true
      }
    }
    function renderRows() {
      rows.replaceChildren()
      const offers=vendorOffers()
      for(let i=0;i<lines.length;i++) {
        const line=lines[i]
        if(!offers.some(o=>o.id===line.offerId))line.offerId=offers[0]?.id||''
        const div=element('div','inv-multi-line')
        const opts=offers.map(o=>{
          const product=data.products.find(p=>p.id===o.product_id)
          return {value:o.id,label:(product?.name||'Product')+' · '+o.units_per_pack+
            ' per kit @ '+dollars(Number(o.price_per_pack))}
        })
        const chosen=selectField('Product / supplier offering',opts)
        chosen.select.value=line.offerId
        chosen.select.addEventListener('change',()=>{line.offerId=chosen.select.value;previewLines()})
        const count=addInput('Number of kits','number',String(line.packs),{
          min:'1',max:'1000',step:'1',
        })
        count.field.addEventListener('input',()=>{line.packs=Number(count.field.value);previewLines()})
        div.append(chosen.label,count.label)
        const manualShip=addInput('This line: shipping ($)','number',String(line.shipping),{min:'0',step:'0.01'})
        const manualFee=addInput('This line: fees ($)','number',String(line.fees),{min:'0',step:'0.01'})
        const manual=element('div','inv-multi-manual')
        manual.append(manualShip.label,manualFee.label)
        manual.style.display=method.select.value==='manual'?'grid':'none'
        manualShip.field.addEventListener('input',()=>{line.shipping=Number(manualShip.field.value);previewLines()})
        manualFee.field.addEventListener('input',()=>{line.fees=Number(manualFee.field.value);previewLines()})
        div.appendChild(manual)
        const remove=element('button')
        remove.type='button';remove.className='secondary';remove.textContent='Remove'
        remove.disabled=lines.length<=1
        remove.addEventListener('click',()=>{lines.splice(i,1);renderRows()})
        div.appendChild(remove)
        rows.appendChild(div)
      }
      previewLines()
    }
    method.select.addEventListener('change',()=>renderRows())
    vendor.select.addEventListener('change',()=>{
      lines=[{offerId:'',packs:1,shipping:0,fees:0}]
      renderRows()
    })
    ship.field.addEventListener('input',previewLines)
    fees.field.addEventListener('input',previewLines)
    add.addEventListener('click',()=>{
      if(lines.length>=25)return
      const available=vendorOffers().find(o=>!lines.some(l=>l.offerId===o.id))
      if(!available){message.textContent='No additional supplier offerings for this vendor';return}
      lines.push({offerId:available.id,packs:1,shipping:0,fees:0})
      renderRows()
    })
    form.addEventListener('submit',async event=>{
      event.preventDefault()
      if(submit.disabled)return
      const methodValue=method.select.value as AllocationMethod
      const shipping=Number(ship.field.value),feeTotal=Number(fees.field.value)
      try {
        const costs=allocationPreview(lines,vendorOffers(),methodValue,shipping,feeTotal)
        if(costs.some(x=>x.expectedUnits>5000)||
          costs.reduce((sum,x)=>sum+x.expectedUnits,0)>10000)
          throw new Error('Order exceeds the maximum supported units')
        submit.disabled=true
        submit.textContent='Creating purchase order…'
        const requestLines:MultiPurchaseLineInput[]=lines.map(l=>({
          offerId:l.offerId,packs:l.packs,
          ...(methodValue==='manual'?{shipping:l.shipping,fees:l.fees}:{}),
        }))
        const result=await createMultiInventoryPurchase({
          vendorId:vendor.select.value,lines:requestLines,
          shipping,fees:feeTotal,allocationMethod:methodValue,
          requestId:crypto.randomUUID(),
        })
        message.textContent='Created '+result.purchase.po_number
        await onChange()
      } catch(err) {
        message.textContent=err instanceof Error?err.message:'Could not create purchase order'
      } finally {
        submit.disabled=false
        submit.textContent='Create multi-product purchase order'
      }
    })
    renderRows()
  }

  const receiving=element('section','inv-panel inv-multi-workspace')
  const receivingTitle=element('div','inv-panel-head')
  receivingTitle.append(text('h2','4. Receive multi-product orders'),
    text('Record each product and supplier lot separately. Receive partial deliveries now and the remaining units later; shipping is not charged again.'))
  receiving.appendChild(receivingTitle)
  const pending=data.orders.filter(po=>po.multi_line &&
    (po.status==='ordered'||po.status==='partially_received'))
  if(!pending.length)receiving.appendChild(text('p','No open multi-product purchases.','inv-empty'))
  for(const po of pending) {
    const vendor=data.vendors.find(v=>v.id===po.vendor_id)
    receiving.appendChild(text('h3',po.po_number+' · '+(vendor?.name||'Vendor')+
      ' · '+po.status.replace('_',' ')))
    for(const line of data.lines.filter(x=>x.purchase_order_id===po.id)) {
      const received=data.receipts.filter(r=>r.purchase_line_id===line.id)
        .reduce((sum,r)=>sum+r.accepted_units+r.damaged_units,0)
      const remaining=line.expected_units-received
      if(remaining<=0)continue
      const product=data.products.find(p=>p.id===line.product_id)
      const form=element('form','inv-multi-receive-line')
      form.appendChild(text('strong',(product?.name||'Product')+
        ' · '+received+'/'+line.expected_units+' recorded · '+remaining+' pending'))
      form.appendChild(text('small','Costs: '+dollars(Number(line.pack_price_snapshot)*line.packs_ordered)+
        ' kits + '+dollars(Number(line.shipping_allocated))+' shipping + '+
        dollars(Number(line.fees_allocated))+' fees.'))
      const fields=element('div','inv-form')
      const accepted=addInput('Usable units received','number','0',{min:'0',step:'1'})
      const damaged=addInput('Damaged units received','number','0',{min:'0',step:'1'})
      const supplierLot=addInput('Supplier/manufacturer batch','text','',{
        placeholder:'As printed on packaging',
      })
      const expiry=addInput('Expiration (if printed)','date','')
      supplierLot.field.required=true
      fields.append(accepted.label,damaged.label,supplierLot.label,expiry.label)
      form.appendChild(fields)
      const button=element('button')
      button.type='submit';button.className='primary';button.textContent='Receive this batch'
      form.appendChild(button)
      const message=text('p','','inv-helper')
      form.appendChild(message)
      form.addEventListener('submit',async event=>{
        event.preventDefault()
        const usable=Number(accepted.field.value),bad=Number(damaged.field.value)
        if(!Number.isInteger(usable)||!Number.isInteger(bad)||
          usable<0||bad<0||usable+bad<1||usable+bad>Math.min(remaining,100)){
          message.textContent='Enter 1–'+Math.min(remaining,100)+
            ' total received units (usable plus damaged)'
          return
        }
        button.disabled=true
        try {
          const result=await receiveMultiInventoryLine({
            lineId:line.id,accepted:usable,damaged:bad,
            supplierLot:supplierLot.field.value.trim(),expiryDate:expiry.field.value,
            requestId:crypto.randomUUID(),
          })
          message.textContent='Received as lot '+result.receipt.internal_lot
          await onChange()
        }catch(err){
          message.textContent=err instanceof Error?err.message:'Could not receive batch'
        }finally{button.disabled=false}
      })
      receiving.appendChild(form)
    }
  }
  root.prepend(receiving)
  root.prepend(purchase)
}
