import { supabase } from './supabase'

// Core: permanent deletes (2026-10-28). The backend keeps a full copy in the Audit Log.

async function call(body: Record<string, unknown>, fallback: string) {
  const { data, error } = await supabase.functions.invoke('core-delete-records', { body })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      const payload = await context.json().catch(() => null)
      if (payload?.error) throw new Error(payload.error)
    }
    throw error
  }
  if (!data?.success) throw new Error(data?.error || fallback)
  return data
}

export async function deleteOrder(orderId: string, confirm: string) {
  return call({ action: 'delete_order', orderId, confirm }, 'Could not delete the order') as
    Promise<{ success: true; orderId: string; orderNumber: string | null }>
}

export async function deleteCustomer(customerId: string, confirm: string) {
  return call({ action: 'delete_customer', customerId, confirm }, 'Could not delete the customer') as
    Promise<{ success: true; customerNumber: string | null; ordersKept: number; loginRemoved: boolean; warning: string | null }>
}
