import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'
export type EvidenceCost={
  order_item_id:string;order_id:string;unit_cost:number;line_cost:number;
  evidence_reference:string;explanation:string|null;updated_at:string
}
export type EvidenceDate={
  order_id:string;effective_paid_at:string;
  evidence_reference:string;explanation:string|null;updated_at:string
}
export type MissingCost={
  id:string;order_id:string;order_number:string;product_name:string;
  product_code:string|null;quantity:number;sales:number;order_created_at:string;
  evidence?:EvidenceCost
}
export type MissingDate={
  id:string;order_number:string;created_at:string;total:number;
  evidence?:EvidenceDate
}
export type PurchaseReview={
  id:string;number:string;status:string;vendor_id:string;vendor_name:string;
  total:number;paid_total:number;planned_total:number;difference:number;
  linked_expenses:Array<{id:string;payee:string;amount:number;status:string}>
}
export type ReconciliationSnapshot={
  success:true;generated_at:string;
  summary:{
    paid_orders:number;paid_lines:number;native_cost_lines:number;
    reconciled_cost_lines:number;missing_cost_lines:number;
    reconciled_paid_dates:number;missing_paid_dates:number;
    purchase_orders:number;linked_expenses:number
  };
  missing_costs:MissingCost[];reviewed_costs:MissingCost[];
  missing_dates:MissingDate[];reviewed_dates:MissingDate[];
  purchase_matches:PurchaseReview[];
  unmatched_expenses:Array<{
    id:string;expense_date:string;category:string;vendor_id:string|null;
    purchase_order_id:string|null;payee:string;amount:number;
    payment_method:string;reference_number:string|null;notes:string|null;
    status:'planned'|'paid'|'voided';updated_at:string
  }>;
  accounting_note:string
}
type MutateData={
  kind:'historical_cost'|'payment_date';
  targetId:string;unitCost?:string;paidDate?:string;
  reference:string;notes:string;expectedUpdatedAt?:string|null
}
async function call<T>(body:Record<string,unknown>):Promise<T>{
  const {data,error}=await supabase.functions.invoke('core-finance-reconciliation',{body})
  if(error instanceof FunctionsHttpError){
    // Extract the owner's safe API error instead of showing a raw HTTP status.
    let message='Financial review temporarily unavailable. Please retry.'
    try{
      const response=await error.context.json() as {error?:string}
      if(typeof response?.error==='string' && response.error.length<250)message=response.error
    }catch{/* Non-JSON response: retain the safe retry message. */}
    throw new Error(message)
  }
  if(error)throw error
  if(!data?.success)throw new Error(data?.error||'Reconciliation operation failed')
  return data as T
}
export const loadReconciliation=()=>call<ReconciliationSnapshot>({action:'list'})
export const recordReconciliation=(data:MutateData)=>
  call<{success:true;evidence:unknown}>({action:'record',...data})
