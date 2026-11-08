import { supabase } from './supabase'

export type CoreMembership = {
  id: string
  name: string
  slug: string
  description: string | null
  benefits: string[]
  sort_order: number
  active: boolean
  assigned_customers: number
  updated_at: string
  created_at: string
}

export type MembershipInput = {
  id?: string
  expectedUpdatedAt?: string
  name: string
  slug: string
  description: string
  benefits: string[]
  sortOrder: number
  active: boolean
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('core-memberships', { body })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Membership operation failed')
  return data as T
}

export async function listCoreMemberships() {
  const result = await invoke<{ success: boolean; memberships: CoreMembership[] }>({ action: 'list' })
  return result.memberships
}

export async function saveCoreMembership(input: MembershipInput) {
  const result = await invoke<{ success: boolean; membership: CoreMembership }>({
    action: input.id ? 'update' : 'create',
    ...input,
  })
  return result.membership
}
