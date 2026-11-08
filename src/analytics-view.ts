import { loadCoreAnalytics, type AnalyticsDay, type AnalyticsPeriod, type CoreAnalyticsPayload } from './services/analytics'

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

const pct = (value: number, max: number) =>
  value > 0 && max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0

type AnalyticsRange='7'|'30'|'90'|'all'
const ANALYTICS_RANGE_KEY='core-reports-analytics-range'
function storedAnalyticsRange():AnalyticsRange {
  try{
    const value=sessionStorage.getItem(ANALYTICS_RANGE_KEY)
    if(value==='7'||value==='30'||value==='90'||value==='all')return value
  }catch{/* storage optional */}
  return '30'
}

function trendMarkup(days: AnalyticsDay[], helpers: Helpers) {
  const maxRevenue = Math.max(0, ...days.map(day => day.revenue))
  const maxOrders = Math.max(0, ...days.map(day => day.orders))
  const visible = days.filter(day => day.orders || day.revenue || day.new_customers)
  const rows = visible.length ? visible : days.slice(-7)

  return '<div class="analytics-trend">' +
    rows.map(day =>
      '<div class="analytics-trend-row">' +
        '<span class="analytics-date">' + helpers.escapeHtml(day.label) + '</span>' +
        '<div class="analytics-bars">' +
          '<div class="analytics-bar revenue" style="--bar:' + pct(day.revenue, maxRevenue) + '%" title="' + helpers.money(day.revenue) + ' revenue"></div>' +
          '<div class="analytics-bar orders" style="--bar:' + pct(day.orders, maxOrders) + '%" title="' + day.orders + ' orders"></div>' +
        '</div>' +
        '<strong>' + helpers.money(day.revenue) + '</strong>' +
        '<span>' + day.orders + ' orders</span>' +
        '<span>' + day.new_customers + ' new</span>' +
      '</div>'
    ).join('') +
  '</div>'
}

function periodKpis(period: AnalyticsPeriod, helpers: Helpers) {
  return '<div class="analytics-period-kpis">' +
    '<div><span>Revenue</span><strong>' + helpers.money(period.revenue) + '</strong></div>' +
    '<div><span>Orders</span><strong>' + period.orders + '</strong><small>' + period.paid_orders + ' paid</small></div>' +
    '<div><span>Average order</span><strong>' + helpers.money(period.average_order) + '</strong></div>' +
    '<div><span>New customers</span><strong>' + period.new_customers + '</strong></div>' +
    '<div><span>Purchasing customers</span><strong>' + period.purchasing_customers + '</strong></div>' +
    '<div><span>Repeat customers</span><strong>' + period.repeat_customers + '</strong></div>' +
  '</div>'
}

function rankRows(
  rows: Array<{ label: string; sub?: string; value: string; count?: string }>,
) {
  if (!rows.length) return '<p class="dashboard-muted">Not enough data yet.</p>'
  return rows.map((row, index) =>
    '<div class="analytics-rank-row">' +
      '<b>' + (index + 1) + '</b>' +
      '<span><strong>' + row.label + '</strong>' + (row.sub ? '<small>' + row.sub + '</small>' : '') + '</span>' +
      (row.count ? '<span>' + row.count + '</span>' : '') +
      '<strong>' + row.value + '</strong>' +
    '</div>'
  ).join('')
}

export function analyticsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">BUSINESS INTELLIGENCE</span><h1 class="dashboard-title">Analytics</h1>' +
    '<p class="copy">Revenue, customer growth, order behavior, referrals, memberships, and product performance from live Core data.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section class="analytics-root" id="analytics-root"><div class="loading">Loading analytics…</div></section>'
}

export async function bindAnalyticsPage(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#analytics-root')
  if (!root) return

  try {
    const data: CoreAnalyticsPayload = await loadCoreAnalytics()
    const headline = data.headline

    root.innerHTML =
      '<div class="report-section-heading"><h2>Business performance</h2><span>All-time paid activity</span></div>' +
      '<section class="analytics-headline">' +
        '<div><span>Paid revenue</span><strong>' + helpers.money(headline.paid_revenue) + '</strong><small>All time</small></div>' +
        '<div><span>Paid orders</span><strong>' + headline.paid_orders + '</strong><small>' + helpers.money(headline.average_paid_order) + ' average</small></div>' +
        '<div><span>Customers</span><strong>' + headline.customers + '</strong><small>' + headline.active_customers + ' active</small></div>' +
        '<div><span>Purchasing customers</span><strong>' + headline.purchasing_customers + '</strong><small>' + headline.repeat_customers + ' repeat</small></div>' +
      '</section>' +

      '<section class="analytics-panel">' +
        '<div class="analytics-section-head"><div><span class="eyebrow">PERFORMANCE</span><h2>Revenue & order trend</h2></div>' +
          '<div class="analytics-range" id="analytics-range">' +
            '<button type="button" data-range="7">7D</button>' +
            '<button type="button" class="active" data-range="30">30D</button>' +
            '<button type="button" data-range="90">90D</button>' +
            '<button type="button" data-range="all">ALL</button>' +
          '</div></div>' +
        '<div id="analytics-period-kpis"></div>' +
        '<div id="analytics-trend"></div>' +
        '<div class="analytics-legend"><span><i class="revenue"></i>Revenue</span><span><i class="orders"></i>Orders</span></div>' +
      '</section>' +

      '<div class="analytics-columns">' +
        '<section class="analytics-panel"><div class="analytics-section-head"><div><span class="eyebrow">CUSTOMER VALUE</span><h2>Top customers</h2></div><a href="#customers">Customers →</a></div>' +
          rankRows(data.customers.top_customers.map(customer => ({
            label: helpers.escapeHtml(customer.name),
            sub: helpers.escapeHtml(customer.customer_number || ''),
            count: customer.paid_orders + ' paid orders',
            value: helpers.money(customer.revenue),
          }))) +
        '</section>' +
        '<section class="analytics-panel"><div class="analytics-section-head"><div><span class="eyebrow">PRODUCT PERFORMANCE</span><h2>Top paid product revenue</h2></div><a href="#catalog">Catalog →</a></div>' +
          rankRows(data.products.top_products.map(product => ({
            label: helpers.escapeHtml(product.name),
            sub: helpers.escapeHtml(product.product_code || ''),
            count: product.quantity + ' units · ' + product.orders + ' orders',
            value: helpers.money(product.revenue),
          }))) +
        '</section>' +
      '</div>' +

      '<details class="report-expander report-analytics-more"><summary>Payment mix, membership & referral detail</summary>' +
        '<div class="analytics-columns">' +
        '<section class="analytics-panel"><div class="analytics-section-head"><div><span class="eyebrow">PAYMENTS</span><h2>Paid revenue mix</h2></div></div>' +
          rankRows(data.orders.payment_mix.map(item => ({
            label: helpers.escapeHtml(item.method),
            count: item.count + ' orders',
            value: helpers.money(item.revenue),
          }))) +
        '</section>' +
        '<section class="analytics-panel"><div class="analytics-section-head"><div><span class="eyebrow">MEMBERSHIPS</span><h2>Customer mix</h2></div></div>' +
          rankRows(data.customers.membership_mix.map(item => ({
            label: helpers.escapeHtml(item.membership),
            value: String(item.count),
          }))) +
        '</section>' +
      '</div>' +

      '<div class="analytics-columns">' +
        '<section class="analytics-panel"><div class="analytics-section-head"><div><span class="eyebrow">REFERRALS</span><h2>Referral funnel</h2></div></div>' +
          '<div class="analytics-funnel">' +
            '<div><span>Referrals</span><strong>' + data.referrals.total + '</strong></div>' +
            '<div><span>Qualified</span><strong>' + data.referrals.qualified + '</strong><small>' + data.referrals.qualification_rate + '% rate</small></div>' +
            '<div><span>Converted</span><strong>' + data.referrals.converted + '</strong><small>' + data.referrals.conversion_rate + '% rate</small></div>' +
            '<div><span>Available rewards</span><strong>' + data.referrals.rewards_available + '</strong></div>' +
            '<div><span>Redeemed rewards</span><strong>' + data.referrals.rewards_redeemed + '</strong></div>' +
          '</div>' +
        '</section>' +
        '<section class="analytics-panel"><div class="analytics-section-head"><div><span class="eyebrow">ORDER PIPELINE</span><h2>Status mix</h2></div><a href="#orders">Orders →</a></div>' +
          rankRows(data.orders.status_mix.map(item => ({
            label: helpers.escapeHtml(item.status.replaceAll('_', ' ')),
            value: String(item.count),
          }))) +
        '</section>' +
      '</div>' +
      '</details>' +
      '<p class="dashboard-generated">Analytics generated ' + helpers.escapeHtml(helpers.dateTime(data.generated_at)) + '</p>'

    const renderRange = (range: AnalyticsRange) => {
      const period = data.periods[range]
      const kpis = document.querySelector<HTMLDivElement>('#analytics-period-kpis')
      const trend = document.querySelector<HTMLDivElement>('#analytics-trend')
      if (kpis) kpis.innerHTML = periodKpis(period, helpers)

      const days = range === '7'
        ? data.series.daily_90.slice(-7)
        : range === '30'
          ? data.series.daily_90.slice(-30)
          : data.series.daily_90

      if (trend) {
        trend.innerHTML = trendMarkup(days, helpers) +
          (range === 'all'
            ? '<p class="analytics-note">All-time KPIs shown above; daily trend displays the latest 90 days.</p>'
            : '')
      }

      root.querySelectorAll<HTMLButtonElement>('#analytics-range button').forEach(button => {
        const selected=button.dataset.range===range
        button.classList.toggle('active',selected)
        button.setAttribute('aria-pressed',String(selected))
      })
      try{sessionStorage.setItem(ANALYTICS_RANGE_KEY,range)}catch{/* storage optional */}
    }

    root.querySelectorAll<HTMLButtonElement>('#analytics-range button').forEach(button => {
      button.addEventListener('click', () => {
        const range = button.dataset.range as AnalyticsRange
        renderRange(range)
      })
    })

    renderRange(storedAnalyticsRange())
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load analytics.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
