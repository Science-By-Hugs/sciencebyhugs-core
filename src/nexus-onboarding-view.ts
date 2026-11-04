import { adoptionEvents, loadAdoptionCounts, loadBetaAccessRequests, setBetaAccessStatus } from './services/onboarding'
import './onboarding.css'

type Helpers = {
  escapeHtml: (value: unknown) => string
  dateTime: (value: string | null | undefined) => string
}

export function nexusOnboardingPanelMarkup() {
  return '<section class="notification-panel nexus-beta-admin" aria-label="Nexus app adoption">' +
    '<div class="dashboard-section-head"><div><span class="eyebrow">NEXUS ADOPTION</span>' +
    '<h2>Onboarding & iOS Beta</h2>' +
    '<p class="copy">How customers are discovering notifications and who is requesting TestFlight access.</p>' +
    '</div></div>' +
    '<div data-adoption-metrics role="status">Loading adoption metrics…</div>' +
    '<div class="nexus-beta-queue-heading"><h3>Beta requests</h3>' +
    '<p>Invitations are sent manually through Apple TestFlight. Marking a request invited only records that you have sent it.</p></div>' +
    '<div data-beta-queue role="status">Loading beta requests…</div>' +
    '</section>'
}

export async function bindNexusOnboardingPanel(helpers: Helpers) {
  const metrics = document.querySelector<HTMLElement>('[data-adoption-metrics]')
  const queue = document.querySelector<HTMLElement>('[data-beta-queue]')
  if (!metrics || !queue) return

  const escape = helpers.escapeHtml
  try {
    const counts = await loadAdoptionCounts()
    if (!metrics.isConnected) return
    metrics.innerHTML = '<div class="nexus-adoption-metrics">' +
      adoptionEvents.map(item => '<div class="nexus-adoption-card"><span>' +
        escape(item.label) + '</span><strong>' + Number(counts[item.event] || 0) +
        '</strong></div>').join('') + '</div>' +
      '<p class="nexus-adoption-note">Unique signed-in accounts per action. These numbers are not delivery statistics.</p>'
  } catch {
    if (metrics.isConnected) metrics.textContent = 'Adoption metrics are unavailable. Check database access and retry.'
  }

  async function refreshQueue() {
    if (!queue || !queue.isConnected) return
    try {
      const requests = await loadBetaAccessRequests()
      if (!queue.isConnected) return
      if (!requests.length) {
        queue.innerHTML = '<p class="nexus-adoption-note">No beta requests yet.</p>'
        return
      }
      queue.innerHTML = '<div class="nexus-beta-request-list">' +
        requests.map(request => '<article class="nexus-beta-request">' +
          '<div><strong>' + escape(request.email) + '</strong>' +
          '<small>Requested ' + escape(helpers.dateTime(request.requested_at)) + '</small></div>' +
          '<div class="nexus-beta-actions">' +
          '<span class="nexus-beta-state">' + escape(request.status) + '</span>' +
          (request.status === 'pending' ?
            '<button type="button" data-beta-mark="invited" data-beta-id="' + escape(request.user_id) + '">Mark invite sent</button>' +
            '<button type="button" data-beta-mark="declined" data-beta-id="' + escape(request.user_id) + '">Decline</button>'
            : '') + '</div></article>').join('') +
        '</div><p class="nexus-adoption-note">Showing the latest 100 requests.</p>'
    } catch {
      if (queue.isConnected) queue.textContent = 'Could not load beta requests. Check administrator access and retry.'
    }
  }

  queue.addEventListener('click', async (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-beta-mark]')
    if (!button) return
    const status = button.dataset.betaMark
    const userId = button.dataset.betaId
    if (!userId || (status !== 'invited' && status !== 'declined')) return
    const message = status === 'invited'
      ? 'Have you already sent this customer a TestFlight invitation through Apple? This action will NOT send one.'
      : 'Decline this customer’s beta request? This action will not email them.'
    if (!window.confirm(message)) return
    button.disabled = true
    try {
      await setBetaAccessStatus(userId, status)
      await refreshQueue()
    } catch (error) {
      if (queue.isConnected) {
        const note = document.createElement('p')
        note.className = 'nexus-adoption-note'
        note.textContent = error instanceof Error ? error.message : 'Unable to update the request.'
        queue.prepend(note)
      }
      button.disabled = false
    }
  })
  await refreshQueue()
}
