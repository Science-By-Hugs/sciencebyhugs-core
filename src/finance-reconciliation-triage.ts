import type {MissingCost,PurchaseReview} from './services/reconciliation'

// Review-only grouping: case and whitespace normalization is for sorting,
// never for applying historical product costs or inferring supplier identity.
export type CostReviewGroup={
  id:string;name:string;productCode:string|null;
  lines:MissingCost[];lineCount:number;units:number;
  salesAmount:number;oldestOrderAt:string;distinctOrders:number
}
export type CostReviewSort='largest'|'most_lines'|'oldest'|'product'
const normalized=(name:string)=>String(name||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US')
const finite=(value:unknown)=>Number.isFinite(Number(value))?Number(value):0
export function groupMissingCosts(lines:MissingCost[]):CostReviewGroup[]{
 const groups=new Map<string,CostReviewGroup>()
 for(const line of lines){
  const name=String(line.product_name||'').trim()||'Product name unavailable'
  const sku=String(line.product_code||'').trim()||null
  const normalizedName=normalized(name)
  // Products without an identifiable name must remain individual review items.
  const key=(normalizedName==='product name unavailable'?
   'unnamed:'+line.id:normalizedName+'|sku:'+normalized(sku||''))
  let existing=groups.get(key)
  if(!existing){
   existing={id:key,name,productCode:sku,lines:[],lineCount:0,
    units:0,salesAmount:0,oldestOrderAt:String(line.order_created_at||''),
    distinctOrders:0}
   groups.set(key,existing)
  }
  existing.lines.push(line)
  existing.lineCount++
  existing.units+=Math.max(0,finite(line.quantity))
  existing.salesAmount+=finite(line.sales)
  const date=String(line.order_created_at||'')
  if(date&&(!existing.oldestOrderAt||date<existing.oldestOrderAt))
   existing.oldestOrderAt=date
 }
 return [...groups.values()].map(group=>({
  ...group,distinctOrders:new Set(group.lines.map(line=>line.order_id)).size
 }))
}
export function sortCostGroups(groups:CostReviewGroup[],by:CostReviewSort):CostReviewGroup[]{
 return [...groups].sort((a,b)=>{
  if(by==='most_lines')return b.lineCount-a.lineCount||b.salesAmount-a.salesAmount||
     a.name.localeCompare(b.name)
  if(by==='oldest')return (a.oldestOrderAt||'9999').localeCompare(b.oldestOrderAt||'9999')||
     b.salesAmount-a.salesAmount
  if(by==='product')return a.name.localeCompare(b.name)||b.salesAmount-a.salesAmount
  return b.salesAmount-a.salesAmount||b.lineCount-a.lineCount||a.name.localeCompare(b.name)
 })
}
export type PurchaseReviewStatus={
 label:string;code:'cancelled'|'unlinked'|'planned'|'difference'|'amounts_align';
 caution:string
}
export function purchaseReviewStatus(po:PurchaseReview):PurchaseReviewStatus{
 if(po.status==='cancelled')return {
  code:'cancelled',label:'Cancelled order',
  caution:'Historical purchases are retained for reference only.'
 }
 if(po.linked_expenses.length===0)return {
  code:'unlinked',label:'No expense linked',
  caution:'This purchase order is a commitment. Do not treat it as a paid expense.'
 }
 if(po.paid_total===0)return {
  code:'planned',label:'No paid entry linked',
  caution:'Planned or unverified expense entries are not evidence of payment.'
 }
 if(Math.abs(Number(po.difference))>0.005)return {
  code:'difference',label:'Amounts need review',
  caution:'A discrepancy does not establish an unpaid balance: receipts, partial payments, and fees need verification.'
 }
 return {
  code:'amounts_align',label:'Amounts align, not verified',
  caution:'Matching totals are not independent proof of a bank or payment-provider settlement.'
 }
}
