import { adoptionEvents, loadAdoptionCounts } from './services/onboarding'
import './onboarding.css'

export function nexusOnboardingPanelMarkup() {
  return '<section class="notification-panel nexus-beta-admin" aria-label="Nexus app adoption">' +
    '<div class="dashboard-section-head"><div><span class="eyebrow">NEXUS ADOPTION</span>' +
    '<h2>Customer onboarding</h2>' +
    '<p class="copy">See how many signed-in customers chose email, opened the PWA guide, or opened a beta text.</p>' +
    '</div></div>' +
    '<div data-adoption-metrics role="status">Loading adoption metrics…</div>' +
    '<p class="nexus-adoption-note">For iOS beta access, customers text their name and email to (725) 310-7502. The number above counts Messages composer opens only — not texts actually sent. Review incoming messages on your phone.</p>' +
    '</section>'
}

export async function bindNexusOnboardingPanel(helpers: { escapeHtml: (value: unknown) => string }) {
  const metrics = document.querySelector<HTMLElement>('[data-adoption-metrics]')
  if (!metrics) return
  try {
    const counts = await loadAdoptionCounts()
    if (!metrics.isConnected) return
    metrics.innerHTML = '<div class="nexus-adoption-metrics">' +
      adoptionEvents.map(item => '<div class="nexus-adoption-card"><span>' +
        helpers.escapeHtml(item.label) + '</span><strong>' + Number(counts[item.event] || 0) +
        '</strong></div>').join('') + '</div>' +
      '<p class="nexus-adoption-note">Unique signed-in accounts per action; not delivery or enrollment confirmations.</p>'
  } catch {
    if (metrics.isConnected) metrics.textContent = 'Adoption metrics unavailable. Check administrator access and retry.'
  }
}
