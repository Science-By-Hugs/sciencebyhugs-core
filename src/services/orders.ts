import { supabase } from './supabase'

export type CoreOrderItem = {
  id: string
  order_id: string
  product_id: string | null
  product_code: string | null
  product_name: string
  quantity: number
  unit_price: number
  line_total: number
  created_at: string
}

export type CoreOrderCustomer = {
  id: string | null
  customer_number: string | null
  first_name: string | null
  last_name: string | null
  email: string
  phone: string | null
  account_status: string
  preferred_contact_method: string | null
  deleted?: boolean
}

export type CoreOrderPayment = {
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

export type CoreOrderInvoice = {
  id: string
  invoice_number: string
  order_id: string
  status: string
  pdf_status: string | null
  pdf_url: string | null
  send_status: string
  sent_at: string | null
  created_at: string
}

export type CoreOrder = {
  id: string
  order_number: string | null
  customer_id: string | null
  status: string
  subtotal: number
  discount_total: number
  shipping_total: number
  tax_total: number
  total: number
  payment_method: string | null
  payment_status: string
  customer_notes: string | null
  admin_notes: string | null
  contact_method: string | null
  fulfillment_note: string | null
  estimated_delivery_date: string | null
  submitted_at: string | null
  paid_at: string | null
  ordered_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  delayed_at: string | null
  cancelled_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  customer: CoreOrderCustomer | null
  items: CoreOrderItem[]
  payment: CoreOrderPayment | null
  invoice: CoreOrderInvoice | null
}

export async function listCoreOrders(): Promise<CoreOrder[]> {
  const { data, error } = await supabase.functions.invoke('core-orders', { body: {} })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not load orders')
  return data.orders || []
}

export async function updateEstimatedDelivery(orderId: string, estimatedDeliveryDate: string | null) {
  const { data, error } = await supabase.functions.invoke('core-orders', {
    body: { action: 'set_delivery_estimate', orderId, estimatedDeliveryDate },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not save estimated delivery date')
  return data as { success: true; order: { id: string; estimated_delivery_date: string | null; updated_at: string } }
}


export async function clearCheckoutPending(orderId?: string) {
  const { data, error } = await supabase.functions.invoke('core-orders', {
    body: { action: 'clear_checkout_pending', orderId: orderId || null },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not clear pending checkout')
  return data as { success: true; deleted: number; orderIds: string[] }
}
