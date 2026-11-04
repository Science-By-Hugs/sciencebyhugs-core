import { supabase } from './supabase'

export type AdoptionEvent =
  | 'invitation_seen' | 'not_now' | 'email_setup_selected'
  | 'push_setup_selected' | 'pwa_guide_opened' | 'pwa_launched'
  | 'beta_text_opened'

export const adoptionEvents: { event: AdoptionEvent; label: string }[] = [
  { event: 'invitation_seen', label: 'Invitation seen' },
  { event: 'email_setup_selected', label: 'Email selected' },
  { event: 'pwa_guide_opened', label: 'Install guide opened' },
  { event: 'pwa_launched', label: 'Home Screen launches' },
  { event: 'push_setup_selected', label: 'Push setup selected' },
  { event: 'beta_text_opened', label: 'Beta text opened' },
  { event: 'not_now', label: 'Not now' },
]

/** Read-only metrics; counts distinct signed-in customers, not SMS messages sent. */
export async function loadAdoptionCounts(): Promise<Record<AdoptionEvent, number>> {
  const rows = await Promise.all(adoptionEvents.map(async item => {
    const { count, error } = await supabase.from('nexus_onboarding_events')
      .select('user_id', { head: true, count: 'exact' }).eq('event_type', item.event)
    if (error) throw error
    return [item.event, count || 0] as const
  }))
  return Object.fromEntries(rows) as Record<AdoptionEvent, number>
}
