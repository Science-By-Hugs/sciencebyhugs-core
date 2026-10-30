import { supabase } from './supabase'

export type MessageTemplate = {
  id: string
  name: string
  message: string
  category: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export type InviteableProfile = {
  id: string
  customer_number: string | null
  first_name: string | null
  last_name: string | null
  email: string
  auth_user_id: string | null
  account_status: string | null
}

export type ActivationProfile = {
  id: string
  customer_number: string | null
  first_name: string | null
  last_name: string | null
  email: string
  account_status: string | null
}

export async function loadAdminTools(): Promise<{
  templates: MessageTemplate[]
  inviteable_profiles: InviteableProfile[]
  activation_profiles: ActivationProfile[]
}> {
  const [adminToolsResult, customersResult] = await Promise.all([
    supabase.functions.invoke('core-admin-tools', { body: { action: 'list' } }),
    supabase.functions.invoke('core-customers', { body: {} }),
  ])

  if (adminToolsResult.error) throw adminToolsResult.error
  if (!adminToolsResult.data?.success) throw new Error(adminToolsResult.data?.error || 'Could not load admin tools')

  if (customersResult.error) throw customersResult.error
  if (!customersResult.data?.success) throw new Error(customersResult.data?.error || 'Could not load customers')

  const activationProfiles = (customersResult.data.customers || [])
    .filter((customer: ActivationProfile) => String(customer.account_status || '').toLowerCase() === 'active')
    .map((customer: ActivationProfile) => ({
      id: customer.id,
      customer_number: customer.customer_number,
      first_name: customer.first_name,
      last_name: customer.last_name,
      email: customer.email,
      account_status: customer.account_status,
    }))

  return {
    ...adminToolsResult.data,
    activation_profiles: activationProfiles,
  }
}

export async function saveMessageTemplate(input: {
  templateId?: string
  name: string
  category: string
  message: string
  active: boolean
}) {
  const { data, error } = await supabase.functions.invoke('core-admin-tools', {
    body: { action: 'save_template', ...input },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not save template')
  return data.template as MessageTemplate
}

export async function inviteCustomerProfile(customerId: string) {
  const { data, error } = await supabase.functions.invoke('core-admin-tools', {
    body: { action: 'invite_profile', customerId },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not send invite')
  return data as { success: true; customerId: string; email: string }
}


export async function sendCustomerActivationEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) throw new Error('Customer email is required')

  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo: 'https://nexus.sciencebyhugs.com/?mode=invite',
  })

  if (error) throw error
  return { success: true as const, email: normalizedEmail }
}


export type DiscountCustomer = {
  id: string
  first_name: string | null
  last_name: string | null
  customer_number: string | null
  email: string | null
}

export type DiscountCodeRecord = {
  id: string
  code: string
  kind: 'free_shipping' | 'referral_bonus' | 'new_customer' | 'group_buy' | 'custom'
  label?: string | null
  discount_percent: number | null
  shipping_discount: number | null
  one_time: boolean
  permanent: boolean
  active: boolean
  created_at: string
  used_at: string | null
  expires_at?: string | null
  assigned_profile_id?: string | null
  assigned?: DiscountCustomer | null
}

export type CustomDiscountInput = {
  code: string
  label: string
  type: 'percent' | 'shipping'
  amount: string
  oneTime: boolean
  expiresAt: string | null
  assignedProfileId: string | null
}

async function discountControl<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('core-discount-codes', { body })
  if (error) {
    let message = fallback
    try {
      const context = (error as { context?: Response }).context
      const payload = context ? await context.json() : null
      if (payload?.error) message = payload.error
    } catch {
      // keep fallback
    }
    throw new Error(message)
  }
  if (!data?.success) throw new Error(data?.error || fallback)
  return data as T
}

export async function createCustomDiscountCode(input: CustomDiscountInput) {
  return discountControl<{ success: true; code: { id: string; code: string }; codes: DiscountCodeRecord[] }>(
    { action: 'create', ...input }, 'Could not create discount code')
}

export async function setDiscountCodeActive(id: string, active: boolean) {
  const data = await discountControl<{ codes: DiscountCodeRecord[] }>(
    { action: 'set_active', id, active }, 'Could not update discount code')
  return data.codes
}

export async function searchDiscountCustomers(query: string) {
  const data = await discountControl<{ customers: DiscountCustomer[] }>(
    { action: 'customers', query }, 'Could not search customers')
  return data.customers
}

export async function loadDiscountCodes(): Promise<DiscountCodeRecord[]> {
  const { data, error } = await supabase.functions.invoke('core-discount-codes', {
    body: { action: 'list' },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not load discount codes')
  return data.codes || []
}

export async function generateDiscountCode(kind: 'free_shipping' | 'referral_bonus') {
  const { data, error } = await supabase.functions.invoke('core-discount-codes', {
    body: { action: 'generate', kind },
  })
  if (error) throw error
  if (!data?.success || !data?.code) throw new Error(data?.error || 'Could not generate discount code')
  return data as { success: true; code: DiscountCodeRecord; codes: DiscountCodeRecord[] }
}
