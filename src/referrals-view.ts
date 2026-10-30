import { loadCoreReferrals } from './services/referrals'
import { bindDiscountCodesPanel, discountCodesPanelMarkup } from './discount-codes-panel'

type Helpers = {
  escapeHtml: (value: unknown) => string
  dateTime: (value: string | null | undefined) => string
}

export function referralsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">REFERRAL OPERATIONS</span><h1 class="dashboard-title">Referrals</h1>' +
    '<p class="copy">Referral progress, earned rewards, milestone visibility, and automatic membership-upgrade awareness.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section id="referrals-root"><div class="loading">Loading referrals…</div></section>'
}

export async function bindReferralsPage(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#referrals-root')
  if (!root) return

  try {
    const data = await loadCoreReferrals()
    const s = data.summary

    root.innerHTML =
      '<section class="referral-kpis">' +
        '<div><span>Referrals</span><strong>' + s.referrals + '</strong></div>' +
        '<div><span>Qualified</span><strong>' + s.qualified + '</strong><small>' + s.qualification_rate + '% rate</small></div>' +
        '<div><span>Pending</span><strong>' + s.pending + '</strong></div>' +
        '<div><span>Converted</span><strong>' + s.converted + '</strong><small>' + s.conversion_rate + '% rate</small></div>' +
        '<div><span>Available rewards</span><strong>' + s.rewards_available + '</strong></div>' +
        '<div><span>Active milestones</span><strong>' + s.rewards_active + '</strong></div>' +
      '</section>' +

      '<section class="referral-panel">' +
        '<div class="dashboard-section-head"><div><span class="eyebrow">MILESTONES</span><h2>Reward ladder</h2></div></div>' +
        '<div class="referral-milestones">' +
          data.milestones.map(m =>
            '<div><span>' + m.threshold + ' qualified</span><strong>' + helpers.escapeHtml(m.label) + '</strong><small>' +
            helpers.escapeHtml(m.behavior) + '</small></div>'
          ).join('') +
        '</div>' +
        '<p class="referral-warning">The 20-referral milestone automatically changes membership to <strong>Principal Scientist</strong> through the existing reward sync logic.</p>' +
      '</section>' +

      '<section class="referral-panel">' +
        '<div class="dashboard-section-head"><div><span class="eyebrow">REFERRERS</span><h2>Customer progress</h2></div><a href="#customers">Customers →</a></div>' +
        (data.referrers.length
          ? '<div class="referral-list">' + data.referrers.map(item =>
              '<div class="referral-row">' +
                '<span><strong>' + helpers.escapeHtml(item.name) + '</strong><small>' +
                  helpers.escapeHtml(item.customer_number || '') + ' · ' + helpers.escapeHtml(item.membership) + '</small></span>' +
                '<span>' + item.qualified + ' qualified<small>' + item.pending + ' pending · ' + item.converted + ' converted</small></span>' +
                '<span><strong>' + helpers.escapeHtml(item.next_milestone.label) + '</strong><small>' +
                  (item.next_milestone.threshold ? item.next_milestone.remaining + ' remaining' : 'Milestone ladder complete') + '</small></span>' +
                '<span><strong>' + item.available_rewards + '</strong><small>available rewards</small></span>' +
              '</div>'
            ).join('') + '</div>'
          : '<p class="dashboard-muted">No referral activity yet.</p>') +
      '</section>' +

      '<section class="referral-panel">' +
        '<div class="dashboard-section-head"><div><span class="eyebrow">ACTIVITY</span><h2>Referral records</h2></div></div>' +
        (data.referrals.length
          ? '<div class="referral-list">' + data.referrals.map(item =>
              '<div class="referral-row compact">' +
                '<span><strong>' + helpers.escapeHtml(item.referrer_name) + '</strong><small>Referrer</small></span>' +
                '<span><strong>' + helpers.escapeHtml(item.referred_customer_name || item.referred_name || item.referred_email || 'Pending customer') + '</strong><small>Referred</small></span>' +
                '<span><strong>' + helpers.escapeHtml(item.status || 'pending') + '</strong><small>' +
                  (item.qualified_at ? 'Qualified ' + helpers.escapeHtml(helpers.dateTime(item.qualified_at)) : 'Not qualified') + '</small></span>' +
                '<span><strong>' + helpers.escapeHtml(item.qualifying_order_number || '—') + '</strong><small>Qualifying order</small></span>' +
              '</div>'
            ).join('') + '</div>'
          : '<p class="dashboard-muted">No referral records.</p>') +
      '</section>' +
      discountCodesPanelMarkup() +
      '<p class="dashboard-generated">Referrals generated ' + helpers.escapeHtml(helpers.dateTime(data.generated_at)) + '</p>'
    await bindDiscountCodesPanel(helpers)
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load referrals.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
