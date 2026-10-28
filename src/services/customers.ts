import { supabase } from './supabase'

export type CoreCustomerOrder = {
  id: string
  order_number: string | null
  status: string
  payment_status: string
  total: number
  created_at: string
  updated_at: string
}

export type CoreCustomerReferral = {
  id: string
  referred_customer_id: string | null
  referred_name: string | null
  referred_email: string | null
  referral_code: string | null
  status: string
  reward_type: string | null
  reward_value: number | null
  referred_at: string
  qualified_at: string | null
  converted_at: string | null
  qualifying_order_number: string | null
}

export type CoreCustomerReward = {
  id: string
  reward_type: string
  reward_value: number | null
  title: string | null
  description: string | null
  status: string
  milestone_threshold: number | null
  reserved_at: string | null
  redeemed_at: string | null
  expires_at: string | null
  created_at: string
}

export type CoreCustomer = {
  id: string
  customer_number: string | null
  first_name: string | null
  last_name: string | null
  email: string
  phone: string | null
  account_status: string
  address_line_1: string | null
  address_line_2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  preferred_contact_method: string | null
  notes: string | null
  original_created_at: string | null
  last_login_at: string | null
  created_at: string
  updated_at: string
  referral_code: string | null
  membership: {
    id: string
    name: string
    slug: string
    description: string | null
    benefits: unknown
  } | null
  metrics: {
    order_count: number
    paid_order_count: number
    lifetime_spend: number
    latest_order_at: string | null
    referral_count: number
    qualified_referral_count: number
    available_reward_count: number
  }
  orders: CoreCustomerOrder[]
  referrals: CoreCustomerReferral[]
  rewards: CoreCustomerReward[]
}

export type CoreMembership = NonNullable<CoreCustomer['membership']>

export type CoreCustomersWorkspace = {
  customers: CoreCustomer[]
  memberships: CoreMembership[]
}

export async function loadCoreCustomers(): Promise<CoreCustomersWorkspace> {
  const { data, error } = await supabase.functions.invoke('core-customers', { body: {} })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not load customers')
  return {
    customers: data.customers || [],
    memberships: data.memberships || [],
  }
}


export async function updateCustomerNotes(customerId: string, notes: string) {
  const { data, error } = await supabase.functions.invoke('core-customer-control', {
    body: {
      action: 'update_notes',
      customerId,
      notes,
    },
  })

  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update customer notes')
  return data.customer as Pick<CoreCustomer, 'id' | 'customer_number' | 'notes' | 'updated_at'>
}


export async function updateCustomerContactPreference(
  customerId: string,
  preferredContactMethod: string | null,
) {
  const { data, error } = await supabase.functions.invoke('core-customer-control', {
    body: {
      action: 'update_contact_preference',
      customerId,
      preferredContactMethod,
    },
  })

  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update contact preference')
  return data.customer as Pick<
    CoreCustomer,
    'id' | 'customer_number' | 'notes' | 'preferred_contact_method' | 'updated_at'
  >
}


export async function updateCustomerMembership(customerId: string, membershipId: string) {
  const { data, error } = await supabase.functions.invoke('core-customer-control', {
    body: {
      action: 'update_membership',
      customerId,
      membershipId,
    },
  })

  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update membership')
  return {
    customer: data.customer as Pick<CoreCustomer, 'id' | 'customer_number' | 'updated_at'> & {
      membership_id: string
    },
    membership: data.membership as CoreMembership,
  }
}


export async function updateCustomerAccountStatus(customerId: string, accountStatus: 'Active' | 'Suspended') {
  const { data, error } = await supabase.functions.invoke('core-customer-control', {
    body: { action: 'update_account_status', customerId, accountStatus },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update account status')
  return data.customer as Pick<CoreCustomer, 'id' | 'customer_number' | 'account_status' | 'updated_at'>
}


export type CustomerProfileUpdate = {
  firstName: string
  lastName: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
}

export async function updateCustomerProfile(customerId: string, profile: CustomerProfileUpdate) {
  const { data, error } = await supabase.functions.invoke('core-customer-control', {
    body: {
      action: 'update_profile',
      customerId,
      ...profile,
    },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update customer profile')
  return data.customer as Pick<
    CoreCustomer,
    'id' | 'customer_number' | 'first_name' | 'last_name' | 'phone' |
    'address_line_1' | 'address_line_2' | 'city' | 'state' | 'postal_code' | 'updated_at'
  >
}


export async function updateCustomerEmail(customerId: string, email: string) {
  const { data, error } = await supabase.functions.invoke('core-customer-control', {
    body: { action: 'update_email', customerId, email },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Could not update customer email')
  return data.customer as Pick<CoreCustomer, 'id' | 'customer_number' | 'email' | 'updated_at'>
}


export type NewCustomerInput = {
  firstName: string
  lastName: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
  preferredContactMethod: string
  membershipId: string
  notes: string
}

// Creates a profile with no login yet. The database assigns the SBH-#### number.
export async function createCustomer(input: NewCustomerInput) {
  const { data, error } = await supabase.functions.invoke('core-customer-create', { body: input })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      const payload = await context.json().catch(() => null)
      if (payload?.error) throw new Error(payload.error)
    }
    throw error
  }
  if (!data?.success) throw new Error(data?.error || 'Could not create customer')
  return data.customer as Pick<CoreCustomer, 'id' | 'customer_number' | 'email' | 'first_name' | 'last_name'>
}
