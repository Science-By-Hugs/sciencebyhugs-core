import {FunctionsHttpError} from '@supabase/supabase-js'
import {supabase} from './supabase'

export type MonthlyPnlRow={
 month:string;paid_orders:number;paid_order_total:number
 product_gross:number;product_discounts:number;customer_shipping:number
 buyer_processing_fees:number;tax_collected:number;revenue_ex_tax:number
 recorded_cogs:number;item_lines:number;original_cost_lines:number
 evidenced_cost_lines:number;missing_cost_lines:number;uncosted_sales:number
 orders_without_items:number;mismatched_product_subtotals:number
 mismatched_order_totals:number
 processor_expenses:number;outbound_shipping_expenses:number
 other_operating_expenses:number;excluded_inventory_cash:number
 planned_expenses:number;paid_expense_records:number
 purchase_orders:number;po_commitments:number
 recorded_operating_expenses:number;recorded_operating_result:number|null
 coverage_status:'no_sales'|'incomplete'|'costs_recorded'
}
export type MonthlyPnlReport={
 success:true;generated_at:string;timezone:string;year:number;years:number[]
 months:MonthlyPnlRow[]
 undated:{paid_orders:number;order_total:number}
 definitions:{
  revenue:string;cogs:string;operating_expenses:string;excluded:string;result:string
 }
}
export async function loadMonthlyPnl(year?:number):Promise<MonthlyPnlReport>{
 const {data,error}=await supabase.functions.invoke('core-monthly-pnl',{
  body:{year:year??null}
 })
 if(error instanceof FunctionsHttpError){
  let message='Could not load monthly financial reporting. Please retry.'
  try{
   const json=await error.context.json() as {error?:string}
   if(typeof json?.error==='string'&&json.error.length<240)message=json.error
  }catch{/* Keep a safe actionable message. */}
  throw new Error(message)
 }
 if(error)throw error
 if(!data?.success)throw new Error(data?.error||'Could not load monthly financial reporting')
 return data as MonthlyPnlReport
}
