import { supabase } from './supabase'

export type CoreInvoiceItem = {
  order_id: string
  product_id: string | null
  product_code: string | null
  product_name: string
  quantity: number
  unit_price: number
  line_total: number
}

export type CoreOrderSummary = {
  id: string
  order_number: string | null
  status: string
  payment_status: string | null
  payment_method: string | null
  paid_at: string | null
  ordered_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  estimated_delivery_date: string | null
  delayed_at: string | null
  cancelled_at: string | null
  completed_at: string | null
  updated_at: string
}

export type CorePayment = {
  id: string
  order_id: string
  provider: string | null
  payment_reference: string | null
  amount: number
  status: string
  notes: string | null
  submitted_at: string | null
  verified_at: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

export type CoreInvoice = {
  id: string
  invoice_number: string
  order_id: string | null
  customer_id: string
  status: string
  subtotal: number
  shipping_total: number
  discount_total: number
  tax_total: number
  total: number
  payment_method: string | null
  google_sheet_name: string | null
  google_sheet_url: string | null
  pdf_status: string | null
  pdf_url: string | null
  pdf_created_at: string | null
  created_at: string
  contact_method: string | null
  customer_name_snapshot: string | null
  customer_email_snapshot: string | null
  customer_phone_snapshot: string | null
  send_status: string
  sent_at: string | null
  sent_to: string | null
  items: CoreInvoiceItem[]
  order: CoreOrderSummary | null
  payment: CorePayment | null
}

export async function listCoreInvoices(): Promise<CoreInvoice[]> {
  const { data, error } = await supabase.functions.invoke('core-invoices', { body: {} })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not load invoices')
  return data.invoices || []
}

export async function recordPayment(
  orderId: string,
  provider: string,
  paymentReference: string,
  notes: string,
) {
  const { data, error } = await supabase.functions.invoke('core-payment-control', {
    body: {
      action: 'record',
      orderId,
      provider,
      paymentReference,
      notes,
    },
  })

  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not record payment')
  return data
}

export async function verifyPayment(orderId: string) {
  const { data, error } = await supabase.functions.invoke('core-payment-control', {
    body: {
      action: 'verify',
      orderId,
    },
  })

  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not verify payment')
  return data
}


export async function updateFulfillment(
  orderId: string,
  status: 'ordered' | 'shipped' | 'delivered' | 'delayed' | 'cancelled' | 'processing',
  note = '',
) {
  const { data, error } = await supabase.functions.invoke('core-fulfillment-control', {
    body: { orderId, status, note },
  })

  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update fulfillment')
  return data
}
