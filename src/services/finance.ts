import { supabase } from './supabase'

export type CoreFinancePayload = {
  generated_at: string
  summary: {
    paid_revenue: number
    paid_orders: number
    verified_payment_records: number
    verified_payment_total: number
    open_order_value: number
    sent_unpaid_invoice_value: number
    payment_review_value: number
    payment_review_count: number
    delivered_paid_orders: number
    unfulfilled_paid_orders: number
  }
  payment_mix: Array<{ method: string; count: number; amount: number }>
  monthly: Array<{ month: string; orders: number; revenue: number }>
  aging: Array<{
    invoice_id: string
    invoice_number: string
    customer_id: string | null
    customer_name: string
    total: number
    age_days: number
    bucket: string
    created_at: string
  }>
  unpaid_customers: Array<{ customer_id: string; name: string; total: number; count: number }>
  payment_review: Array<{
    id: string
    order_id: string
    provider: string | null
    amount: number
    submitted_at: string
    customer_name: string
  }>
}

export async function loadCoreFinance(): Promise<CoreFinancePayload> {
  const { data, error } = await supabase.functions.invoke('core-finance', { body: {} })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not load finance')
  return data as CoreFinancePayload
}

// ---------- Profit report (2026-10-27): Core-only, reads locked cost tables ----------
export type ProfitLine = {
  name: string
  product_code: string | null
  units: number
  sales: number
  vendor_cost: number | null
  profit: number | null
  margin_pct: number | null
  markup_pct: number | null
  uncosted_lines: number
}

export type ProfitReport = {
  totals: {
    orders: number
    lines: number
    sales: number
    discounts: number
    net_sales: number
    vendor_cost: number
    costed_sales: number
    uncosted_sales: number
    uncosted_lines: number
    gross_profit: number
    margin_pct: number | null
    markup_pct: number | null
  }
  by_product: ProfitLine[]
  by_month: Array<{ month: string; sales: number; vendor_cost: number | null; profit: number | null; margin_pct: number | null; uncosted_lines: number }>
  catalog: {
    products: number
    with_cost: number
    selling_without_cost: number
    avg_margin_pct: number | null
    below_cost: Array<{ name: string; product_code: string | null; price: number; vendor_cost: number }>
  }
  generated_at: string
}

export async function loadProfitReport(from: string | null, to: string | null): Promise<ProfitReport> {
  const { data, error } = await supabase.functions.invoke('core-profit-report', { body: { from, to } })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not load the profit report')
  return data as ProfitReport
}
