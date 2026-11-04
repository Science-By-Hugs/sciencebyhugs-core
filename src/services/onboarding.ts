import { supabase } from './supabase'

export type BetaAccessRequest = {
  user_id: string
  email: string
  status: 'pending' | 'invited' | 'declined'
  requested_at: string
}

export type AdoptionEvent =
  | 'invitation_seen' | 'not_now' | 'email_setup_selected'
  | 'push_setup_selected' | 'pwa_guide_opened' | 'pwa_launched'
  | 'beta_request_opened' | 'beta_requested'

export const adoptionEvents: { event: AdoptionEvent; label: string }[] = [
  { event: 'invitation_seen', label: 'Invitation seen' },
  { event: 'email_setup_selected', label: 'Email selected' },
  { event: 'pwa_guide_opened', label: 'Install guide opened' },
  { event: 'pwa_launched', label: 'Home Screen launches' },
  { event: 'push_setup_selected', label: 'Push setup selected' },
  { event: 'beta_request_opened', label: 'Beta interest' },
  { event: 'beta_requested', label: 'Beta requests' },
  { event: 'not_now', label: 'Not now' },
]

export async function loadBetaAccessRequests(): Promise<BetaAccessRequest[]> {
  const { data, error } = await supabase.from('nexus_beta_requests')
    .select('user_id,email,status,requested_at')
    .order('requested_at', { ascending: false }).limit(100)
  if (error) throw error
  return (data || []) as BetaAccessRequest[]
}

export async function loadAdoptionCounts(): Promise<Record<AdoptionEvent, number>> {
  const rows = await Promise.all(adoptionEvents.map(async item => {
    const { count, error } = await supabase.from('nexus_onboarding_events')
      .select('user_id', { head: true, count: 'exact' }).eq('event_type', item.event)
    if (error) throw error
    return [item.event, count || 0] as const
  }))
  return Object.fromEntries(rows) as Record<AdoptionEvent, number>
}

/** Records a manual action only. This does NOT send a TestFlight invitation. */
export async function setBetaAccessStatus(userId: string, status: 'invited' | 'declined') {
  const { data, error } = await supabase.from('nexus_beta_requests')
    .update({ status }).eq('user_id', userId).eq('status', 'pending')
    .select('user_id').maybeSingle()
  if (error) throw error
  if (!data) throw new Error('This request was already processed or is not accessible.')
}
