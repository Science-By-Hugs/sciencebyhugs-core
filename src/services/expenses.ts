import { supabase } from './supabase'

export type FinanceExpenseStatus='planned'|'paid'|'voided'
export type FinanceExpenseCategory=
  'inventory_purchase'|'vendor_shipping'|'fulfillment_shipping'|'processing_fee'|'software'|
  'marketing'|'packaging'|'supplies'|'operations'|'other'
export type FinancePaymentMethod='card'|'bank_transfer'|'paypal'|'zelle'|'cash'|'crypto'|'other'

export type FinanceExpense={
  id:string;expense_date:string;category:FinanceExpenseCategory
  vendor_id:string|null;purchase_order_id:string|null
  payee:string;amount:number;payment_method:FinancePaymentMethod
  reference_number:string|null;notes:string|null;status:FinanceExpenseStatus
  created_at:string;updated_at:string;voided_at:string|null
}
export type VendorPurchaseCommitment={
  id:string;po_number:string;vendor_id:string;status:string
  ordered_at:string;merchandise_total:number;inbound_shipping:number;fees:number
}
export type FinanceExpenseSnapshot={
  success:true;generated_at:string
  expenses:FinanceExpense[]
  vendors:Array<{id:string;name:string;code:string;active:boolean}>
  purchase_orders:VendorPurchaseCommitment[]
  accounting_note:string
}
export type ExpenseInput={
  id?:string;expense_date:string;category:FinanceExpenseCategory
  vendor_id:string|null;purchase_order_id:string|null;payee:string
  amount:string;payment_method:FinancePaymentMethod;reference_number:string
  notes:string;status:'planned'|'paid'
}
async function request<T>(body:Record<string,unknown>):Promise<T>{
  const {data,error}=await supabase.functions.invoke('core-expenses',{body})
  if(error)throw error
  if(!data?.success)throw new Error(data?.error||'Expense operation failed')
  return data as T
}
export async function loadCoreExpenses(){
  return request<FinanceExpenseSnapshot>({action:'list'})
}
export async function saveCoreExpense(payload:ExpenseInput,expectedUpdatedAt?:string){
  return request<{success:true;expense:FinanceExpense}>({
    action:payload.id?'update':'create',
    payload,expectedUpdatedAt:expectedUpdatedAt||null
  })
}
export async function voidCoreExpense(id:string,expectedUpdatedAt:string,confirmation:string){
  return request<{success:true;expense:FinanceExpense}>({
    action:'void',payload:{id},expectedUpdatedAt,confirmation
  })
}
