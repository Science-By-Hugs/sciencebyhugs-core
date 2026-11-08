import { loadCoreReferrals, type CoreReferralAdminPayload, type ReferralReferrer } from './services/referrals'
import { bindDiscountCodesPanel, discountCodesPanelMarkup } from './discount-codes-panel'

type Helpers = {
  escapeHtml: (value: unknown) => string
  dateTime: (value: string | null | undefined) => string
}

type MarketingFilter = 'all' | 'pending' | 'rewards' | 'near'
const FILTER_KEY = 'core-marketing-progress-filter'

const count = (value: number) => Number.isFinite(value) ? value.toLocaleString('en-US') : '0'
const valueOf = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}
const rewardTitle = (record: Record<string, unknown>) =>
  valueOf(record, 'title') || valueOf(record, 'description') || valueOf(record, 'reward_type') || 'Reward'
const rewardRecipient = (record: Record<string, unknown>) =>
  valueOf(record, 'customer_name') || valueOf(record, 'referrer_name') ||
  valueOf(record, 'customer_number') || 'Customer reward'

export function referralsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">CUSTOMER GROWTH</span><h1 class="dashboard-title">Marketing</h1>' +
    '<p class="copy">Referral progress, earned rewards, and customer promotions in one place.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section id="referrals-root" aria-label="Marketing overview"><div class="loading">Loading marketing…</div></section>'
}

function marketingMarkup(data: CoreReferralAdminPayload, helpers: Helpers) {
  const { escapeHtml, dateTime } = helpers
  const s = data.summary

  const priority = s.rewards_available > 0
    ? { eyebrow: 'REWARDS TO REVIEW', title: count(s.rewards_available) + ' available reward' +
        (s.rewards_available === 1 ? '' : 's'),
        detail: 'Review earned rewards and customer eligibility. Core keeps the existing redemption rules.',
        action: 'View rewards', target: 'rewards' }
    : s.pending > 0
      ? { eyebrow: 'REFERRALS TO WATCH', title: count(s.pending) + ' pending referral' +
          (s.pending === 1 ? '' : 's'),
          detail: 'See pending referrals and their current status. Qualification is still determined automatically.',
          action: 'Review activity', target: 'records' }
      : { eyebrow: 'NEXT MARKETING MOVE', title: 'Your referral queue is clear',
          detail: 'Review customer growth or prepare a new promotion when you are ready.',
          action: 'Create a discount', target: 'discounts' }

  const metric = (label: string, number: number, subtitle: string) =>
    '<div class="marketing-metric"><span>' + escapeHtml(label) + '</span><strong>' +
    count(number) + '</strong><small>' + escapeHtml(subtitle) + '</small></div>'

  const referrerRow = (item: ReferralReferrer) =>
    '<div class="marketing-customer-row" data-referrer-id="' + escapeHtml(item.customer_id) + '"' +
    ' data-referrer-pending="' + Number(item.pending) + '"' +
    ' data-referrer-rewards="' + Number(item.available_rewards) + '"' +
    ' data-referrer-remaining="' + (item.next_milestone.threshold == null ? '-1' : Number(item.next_milestone.remaining)) + '">' +
    '<div class="marketing-customer-name"><a href="#customers" data-marketing-customer-id="' + escapeHtml(item.customer_id) + '">' +
      escapeHtml(item.name) + '</a><small>' +
      escapeHtml([item.customer_number,item.membership].filter(Boolean).join(' · ')) + '</small></div>' +
    '<div class="marketing-customer-progress"><strong>' + count(item.qualified) + ' qualified</strong>' +
      '<small>' + count(item.pending) + ' pending · ' + count(item.converted) + ' converted</small></div>' +
    '<div class="marketing-customer-next"><strong>' + escapeHtml(item.next_milestone.label) + '</strong><small>' +
      (item.next_milestone.threshold == null ? 'Milestone ladder complete' :
        count(item.next_milestone.remaining) + ' to go') + '</small></div>' +
    '<div class="marketing-customer-reward"><strong>' + count(item.available_rewards) + '</strong><small>rewards available</small></div>' +
    '</div>'

  const referralRow = (item: CoreReferralAdminPayload['referrals'][number]) =>
    '<div class="marketing-referral-row" data-referral-status="' + escapeHtml((item.status || 'pending').toLowerCase()) + '">' +
      '<div class="marketing-record-people"><span>From ' +
        (item.referrer_id
          ? '<a href="#customers" data-marketing-customer-id="' + escapeHtml(item.referrer_id) + '">' +
            escapeHtml(item.referrer_name) + '</a>'
          : '<strong>' + escapeHtml(item.referrer_name) + '</strong>') +
      '</span><span>To ' +
        (item.referred_customer_id
          ? '<a href="#customers" data-marketing-customer-id="' + escapeHtml(item.referred_customer_id) + '">' +
            escapeHtml(item.referred_customer_name || item.referred_name || item.referred_email || 'Customer') + '</a>'
          : '<strong>' + escapeHtml(item.referred_customer_name || item.referred_name || item.referred_email || 'Pending customer') + '</strong>') +
      '</span></div>' +
      '<div class="marketing-record-status"><strong>' + escapeHtml(item.status || 'Pending') + '</strong>' +
        '<small>' + (item.qualified_at ? 'Qualified ' + escapeHtml(dateTime(item.qualified_at)) : 'Not yet qualified') +
        '</small></div>' +
      '<div class="marketing-record-order"><span>Qualifying order</span><strong>' +
        escapeHtml(item.qualifying_order_number || '—') + '</strong></div>' +
    '</div>'

  const rewardRow = (reward: Record<string, unknown>) => {
    const status = valueOf(reward,'status') || 'Recorded'
    const date = valueOf(reward,'created_at')
    const milestone = valueOf(reward,'milestone_threshold')
    const info = [valueOf(reward,'reward_type'), milestone ? milestone + '-referral milestone' : ''].filter(Boolean).join(' · ')
    return '<div class="marketing-reward-row">' +
      '<div><strong>' + escapeHtml(rewardTitle(reward)) + '</strong><small>' +
        escapeHtml(rewardRecipient(reward)) + '</small>' +
        (info ? '<small>' + escapeHtml(info) + '</small>' : '') + '</div>' +
      '<div class="marketing-reward-meta"><span class="marketing-status">' + escapeHtml(status) + '</span>' +
        (date ? '<small>' + escapeHtml(dateTime(date)) + '</small>' : '') + '</div>' +
    '</div>'
  }

  return '<section class="marketing-hero" aria-labelledby="marketing-hero-title">' +
      '<div><span class="marketing-kicker">' + escapeHtml(priority.eyebrow) + '</span>' +
        '<h2 id="marketing-hero-title">' + escapeHtml(priority.title) + '</h2>' +
        '<p>' + escapeHtml(priority.detail) + '</p></div>' +
      '<button type="button" class="marketing-hero-action" data-marketing-target="' + priority.target + '">' +
        escapeHtml(priority.action) + '<span aria-hidden="true">→</span></button>' +
    '</section>' +

    '<section class="marketing-summary" aria-label="Growth snapshot">' +
      metric('Total referrals',s.referrals,'All recorded') +
      metric('Qualified',s.qualified,s.qualification_rate + '% qualification rate') +
      metric('Rewards available',s.rewards_available,'Earned and available') +
    '</section>' +
    '<details class="marketing-disclosure marketing-extra-kpis">' +
      '<summary>More growth numbers</summary><div class="marketing-additional-metrics">' +
        metric('Pending',s.pending,'Awaiting qualification') +
        metric('Converted',s.converted,s.conversion_rate + '% conversion rate') +
        metric('Redeemed rewards',s.rewards_redeemed,'Previously redeemed') +
        metric('Active milestones',s.rewards_active,'Active earned milestones') +
      '</div></details>' +

    '<nav class="marketing-shortcuts" aria-label="Marketing shortcuts">' +
      '<button type="button" data-marketing-target="discounts">Create discount</button>' +
      '<a href="#customers">Customer directory</a>' +
      '<a href="#notifications">Messages &amp; alerts</a>' +
    '</nav>' +

    '<section class="referral-panel marketing-progress" aria-labelledby="marketing-progress-title">' +
      '<div class="marketing-section-head"><div><span class="marketing-kicker">CUSTOMER GROWTH</span>' +
        '<h2 id="marketing-progress-title">Referral progress</h2></div>' +
        '<span class="marketing-record-count" id="marketing-progress-count" aria-live="polite"></span></div>' +
      '<div class="marketing-toolbar">' +
        '<label><span class="sr-only">Search referral customers</span>' +
          '<input id="marketing-progress-search" type="search" placeholder="Search customer, number, membership…" autocomplete="off"></label>' +
        '<label><span class="sr-only">Filter referral customers</span>' +
          '<select id="marketing-progress-filter" aria-label="Filter referral progress">' +
            '<option value="all">All customers</option><option value="pending">Has pending referrals</option>' +
            '<option value="rewards">Has rewards available</option><option value="near">Within 3 of next milestone</option>' +
          '</select></label>' +
      '</div>' +
      (data.referrers.length
        ? '<div class="marketing-customer-list">' + data.referrers.map(referrerRow).join('') + '</div>' +
          '<p id="marketing-progress-empty" class="marketing-empty" hidden>No customers match your filters.</p>'
        : '<p class="marketing-empty">No referral activity yet. Customer referral progress will appear here automatically.</p>') +
    '</section>' +

    '<details class="marketing-disclosure" id="marketing-referrals">' +
      '<summary><span><strong>Referral records</strong><small>Who referred whom, qualifying status and orders</small></span>' +
        '<span class="marketing-count">' + count(data.referrals.length) + '</span></summary>' +
      '<div class="marketing-disclosure-body">' +
        '<label class="marketing-record-filter"><span>Show</span>' +
          '<select id="marketing-record-status" aria-label="Filter referral records">' +
            '<option value="all">All statuses</option><option value="pending">Pending</option>' +
            '<option value="qualified">Qualified</option><option value="converted">Converted</option>' +
          '</select></label>' +
        (data.referrals.length
          ? '<div class="marketing-referral-list">' + data.referrals.map(referralRow).join('') + '</div>' +
            '<p id="marketing-record-empty" class="marketing-empty" hidden>No referral records match this status.</p>'
          : '<p class="marketing-empty">No referral records.</p>') +
      '</div>' +
    '</details>' +

    '<details class="marketing-disclosure" id="marketing-rewards">' +
      '<summary><span><strong>Earned rewards</strong><small>Recorded reward history and status</small></span>' +
        '<span class="marketing-count">' + count(data.rewards.length) + '</span></summary>' +
      '<div class="marketing-disclosure-body">' +
        (data.rewards.length
          ? '<div class="marketing-reward-list">' + data.rewards.map(rewardRow).join('') + '</div>'
          : '<p class="marketing-empty">No reward records yet.</p>') +
        '<p class="marketing-footnote">Reward eligibility and redemption remain controlled by the existing rules. No rewards are issued from this view.</p>' +
      '</div>' +
    '</details>' +

    '<details class="marketing-disclosure" id="marketing-milestones">' +
      '<summary><span><strong>Reward ladder</strong><small>Qualification milestones and automatic benefits</small></span>' +
        '<span class="marketing-count">' + count(data.milestones.length) + '</span></summary>' +
      '<div class="marketing-disclosure-body"><div class="referral-milestones">' +
        data.milestones.map(m =>
          '<div><span>' + count(m.threshold) + ' qualified</span><strong>' +
            escapeHtml(m.label) + '</strong><small>' + escapeHtml(m.behavior) + '</small></div>'
        ).join('') +
      '</div><p class="referral-warning">The 20-referral milestone automatically changes membership to <strong>Principal Scientist</strong> through the existing reward sync logic.</p></div>' +
    '</details>' +

    '<details class="marketing-disclosure marketing-promotions" id="marketing-discounts">' +
      '<summary><span><strong>Discount codes &amp; promotions</strong>' +
        '<small>Create, find and manage existing discount codes</small></span>' +
        '<span class="marketing-count">Manage</span></summary>' +
      '<div class="marketing-disclosure-body">' + discountCodesPanelMarkup() + '</div>' +
    '</details>' +

    '<p class="dashboard-generated">Marketing generated ' + escapeHtml(dateTime(data.generated_at)) + '</p>'
}

function restoreMarketingFilter(): { search: string; filter: MarketingFilter } {
  try {
    const stored = JSON.parse(sessionStorage.getItem(FILTER_KEY) || '{}')
    const filter: MarketingFilter =
      stored.filter === 'pending' || stored.filter === 'rewards' || stored.filter === 'near'
        ? stored.filter : 'all'
    return { search: typeof stored.search === 'string' ? stored.search.slice(0, 160) : '', filter }
  } catch { return { search: '', filter: 'all' } }
}

function bindMarketingControls(root: HTMLElement) {
  const progressSearch = root.querySelector<HTMLInputElement>('#marketing-progress-search')
  const progressFilter = root.querySelector<HTMLSelectElement>('#marketing-progress-filter')
  const progressCount = root.querySelector<HTMLElement>('#marketing-progress-count')
  const progressEmpty = root.querySelector<HTMLElement>('#marketing-progress-empty')
  const state = restoreMarketingFilter()

  if (progressSearch) progressSearch.value = state.search
  if (progressFilter) progressFilter.value = state.filter

  const applyProgress = () => {
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.marketing-customer-row'))
    let visible = 0
    rows.forEach(row => {
      const text = row.textContent?.toLocaleLowerCase() || ''
      const matchesSearch = !state.search || text.includes(state.search)
      const numeric = (key: string) => Number(row.dataset[key] || 0)
      const matchesFilter = state.filter === 'all' ||
        (state.filter === 'pending' && numeric('referrerPending') > 0) ||
        (state.filter === 'rewards' && numeric('referrerRewards') > 0) ||
        (state.filter === 'near' && numeric('referrerRemaining') > 0 && numeric('referrerRemaining') <= 3)
      row.hidden = !(matchesSearch && matchesFilter)
      if (!row.hidden) visible++
    })
    if (progressCount) progressCount.textContent = visible + ' of ' + rows.length + ' shown'
    if (progressEmpty) progressEmpty.hidden = visible > 0
    try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(state)) } catch { /* convenience only */ }
  }
  progressSearch?.addEventListener('input', () => {
    state.search = progressSearch.value.trim().toLocaleLowerCase()
    applyProgress()
  })
  progressFilter?.addEventListener('change', () => {
    state.filter = progressFilter.value as MarketingFilter
    applyProgress()
  })
  applyProgress()

  const recordFilter = root.querySelector<HTMLSelectElement>('#marketing-record-status')
  const recordEmpty = root.querySelector<HTMLElement>('#marketing-record-empty')
  recordFilter?.addEventListener('change', () => {
    let shown = 0
    root.querySelectorAll<HTMLElement>('.marketing-referral-row').forEach(row => {
      row.hidden = recordFilter.value !== 'all' && row.dataset.referralStatus !== recordFilter.value
      if (!row.hidden) shown++
    })
    if (recordEmpty) recordEmpty.hidden = shown > 0
  })

  root.querySelectorAll<HTMLAnchorElement>('[data-marketing-customer-id]').forEach(link => {
    link.addEventListener('click', () => {
      const id = link.dataset.marketingCustomerId
      if (!id) return
      try { sessionStorage.setItem('core-md:customers', id + '|' + Date.now()) }
      catch { /* Customer directory still opens */ }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-marketing-target]').forEach(button => {
    button.addEventListener('click', () => {
      const target = button.dataset.marketingTarget
      const detail = root.querySelector<HTMLDetailsElement>(
        target === 'rewards' ? '#marketing-rewards' :
          target === 'records' ? '#marketing-referrals' : '#marketing-discounts'
      )
      if (!detail) return
      detail.open = true
      if (target === 'discounts') {
        const create = detail.querySelector<HTMLDetailsElement>('.discount-create')
        if (create) create.open = true
      }
      detail.scrollIntoView({ block: 'start', behavior: 'smooth' })
      detail.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
    })
  })
}

export async function bindReferralsPage(helpers: Helpers) {
  const root = document.querySelector<HTMLElement>('#referrals-root')
  if (!root) return
  try {
    const data = await loadCoreReferrals()
    if (!root.isConnected) return
    root.innerHTML = marketingMarkup(data, helpers)
    bindMarketingControls(root)
    await bindDiscountCodesPanel(helpers)
  } catch (error) {
    if (!root.isConnected) return
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load marketing.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
