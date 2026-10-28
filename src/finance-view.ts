import { loadCoreFinance, loadProfitReport } from './services/finance'
import { pct } from './pricing'

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

export function financePageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">FINANCE</span><h1 class="dashboard-title">Finance</h1>' +
    '<p class="copy">Operational revenue, verified payments, receivables, and open cash exposure. This is internal reporting, not bank reconciliation.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section id="finance-profit" class="finance-panel"><div class="loading">Loading profit…</div></section>' +
    '<section id="finance-root"><div class="loading">Loading finance…</div></section>'
}

const rows = (items: string[]) => items.length ? items.join('') : '<p class="dashboard-muted">Nothing to show.</p>'

type ProfitPeriod = 'all' | 'this-month' | 'last-month' | 'last-90' | 'this-year'

function periodRange(period: ProfitPeriod): { from: string | null; to: string | null } {
  const now = new Date()
  const start = (y: number, m: number) => new Date(y, m, 1).toISOString()
  switch (period) {
    case 'this-month': return { from: start(now.getFullYear(), now.getMonth()), to: null }
    case 'last-month': return { from: start(now.getFullYear(), now.getMonth() - 1), to: start(now.getFullYear(), now.getMonth()) }
    case 'last-90': return { from: new Date(now.getTime() - 90 * 86400000).toISOString(), to: null }
    case 'this-year': return { from: start(now.getFullYear(), 0), to: null }
    default: return { from: null, to: null }
  }
}

async function renderProfit(helpers: Helpers, period: ProfitPeriod = 'all') {
  const el = document.querySelector<HTMLElement>('#finance-profit')
  if (!el) return
  const { escapeHtml, money } = helpers
  const options: Array<[ProfitPeriod, string]> = [
    ['all', 'All time'], ['this-month', 'This month'], ['last-month', 'Last month'], ['last-90', 'Last 90 days'], ['this-year', 'This year'],
  ]
  const head = (body: string) =>
    '<div class="dashboard-section-head finance-profit-head"><div><span class="eyebrow">PROFIT · CORE ONLY</span><h2>Vendor cost & profit</h2></div>' +
    '<select id="finance-profit-period" aria-label="Profit period">' +
      options.map(([value, label]) => '<option value="' + value + '"' + (value === period ? ' selected' : '') + '>' + label + '</option>').join('') +
    '</select></div>' + body

  el.innerHTML = head('<div class="loading">Loading profit…</div>')
  try {
    const range = periodRange(period)
    const r = await loadProfitReport(range.from, range.to)
    const t = r.totals
    const signed = (value: number | null) => value === null ? '—' : money(value)
    const productRows = r.by_product.slice(0, 25).map(line =>
      '<div class="finance-row' + (line.profit !== null && line.profit < 0 ? ' loss' : '') + '"><span><strong>' + escapeHtml(line.name) + '</strong><small>' +
      line.units + ' sold · ' + money(line.sales) + ' sales' + (line.uncosted_lines ? ' · ' + line.uncosted_lines + ' line(s) without cost' : '') +
      '</small></span><span>' + pct(line.margin_pct) + ' margin<small>' + pct(line.markup_pct) + ' markup</small></span><strong>' + signed(line.profit) + '</strong></div>'
    ).join('')
    const monthRows = r.by_month.map(month =>
      '<div class="finance-row"><span><strong>' + escapeHtml(month.month) + '</strong><small>' + money(month.sales) + ' sales · ' +
      signed(month.vendor_cost) + ' cost</small></span><span>' + pct(month.margin_pct) + ' margin</span><strong>' + signed(month.profit) + '</strong></div>'
    ).join('')
    const belowCost = r.catalog.below_cost.map(item =>
      '<div class="finance-row loss"><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(item.product_code || '') +
      '</small></span><span>price ' + money(item.price) + '</span><strong>cost ' + money(item.vendor_cost) + '</strong></div>'
    ).join('')

    el.innerHTML = head(
      '<section class="finance-kpis">' +
        '<div><span>Sales</span><strong>' + money(t.sales) + '</strong><small>' + t.orders + ' paid orders · ' + t.lines + ' lines</small></div>' +
        '<div><span>Discounts given</span><strong>' + money(t.discounts) + '</strong><small>Net sales ' + money(t.net_sales) + '</small></div>' +
        '<div><span>Vendor cost</span><strong>' + money(t.vendor_cost) + '</strong><small>Cost at time of sale</small></div>' +
        '<div><span>Gross profit</span><strong>' + money(t.gross_profit) + '</strong><small>On ' + money(t.costed_sales) + ' costed sales</small></div>' +
        '<div><span>Margin</span><strong>' + pct(t.margin_pct) + '</strong><small>Profit ÷ sales</small></div>' +
        '<div><span>Markup</span><strong>' + pct(t.markup_pct) + '</strong><small>Profit ÷ cost</small></div>' +
      '</section>' +
      (t.uncosted_lines
        ? '<p class="finance-note warn">' + t.uncosted_lines + ' sold line(s) (' + money(t.uncosted_sales) +
          ' of sales) had no vendor cost on file when they sold, so they are left out of profit. Orders from before vendor pricing was added fall in this group.</p>'
        : '') +
      '<p class="finance-note">Profit uses each item\'s vendor cost captured at the moment of sale, so later cost changes never rewrite past profit. ' +
      'Sales are line totals before order discounts; discounts, shipping, processing fees and tax are shown or handled separately. ' +
      'Catalog: ' + r.catalog.with_cost + ' of ' + r.catalog.products + ' products have a vendor cost' +
      (r.catalog.avg_margin_pct !== null ? ' · average list margin ' + pct(r.catalog.avg_margin_pct) : '') +
      (r.catalog.selling_without_cost ? ' · <strong>' + r.catalog.selling_without_cost + ' selling without a cost</strong> (Catalog → filter “Missing vendor cost”)' : '') + '.</p>' +
      '<div class="finance-columns">' +
        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">BY PRODUCT</span><h2>Profit by product</h2></div></div>' +
          rows(productRows ? [productRows] : []) + '</section>' +
        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">BY MONTH</span><h2>Monthly profit</h2></div></div>' +
          rows(monthRows ? [monthRows] : []) + '</section>' +
      '</div>' +
      (belowCost
        ? '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">ATTENTION</span><h2>Priced below vendor cost</h2></div><a href="#catalog">Catalog →</a></div>' + belowCost + '</section>'
        : '')
    )
  } catch (error) {
    el.innerHTML = head('<div class="empty-state error-state"><h2>Could not load profit.</h2><p>' +
      escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>')
  }
  el.querySelector<HTMLSelectElement>('#finance-profit-period')?.addEventListener('change', event => {
    void renderProfit(helpers, (event.currentTarget as HTMLSelectElement).value as ProfitPeriod)
  })
}

export async function bindFinancePage(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#finance-root')
  if (!root) return
  void renderProfit(helpers)

  try {
    const data = await loadCoreFinance()
    const s = data.summary

    root.innerHTML =
      '<section class="finance-kpis">' +
        '<div><span>Paid revenue</span><strong>' + helpers.money(s.paid_revenue) + '</strong><small>' + s.paid_orders + ' paid orders</small></div>' +
        '<div><span>Open order value</span><strong>' + helpers.money(s.open_order_value) + '</strong><small>Not recorded as paid</small></div>' +
        '<div><span>Sent unpaid invoices</span><strong>' + helpers.money(s.sent_unpaid_invoice_value) + '</strong><small>Invoice receivables</small></div>' +
        '<div><span>Payment review</span><strong>' + helpers.money(s.payment_review_value) + '</strong><small>' + s.payment_review_count + ' submissions</small></div>' +
        '<div><span>Paid / unfulfilled</span><strong>' + s.unfulfilled_paid_orders + '</strong><small>' + s.delivered_paid_orders + ' delivered</small></div>' +
        '<div><span>Verified records</span><strong>' + helpers.money(s.verified_payment_total) + '</strong><small>' + s.verified_payment_records + ' payment records</small></div>' +
      '</section>' +

      '<div class="finance-columns">' +
        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">RECEIVABLES</span><h2>Invoice aging</h2></div><a href="#operations">Operations →</a></div>' +
          rows(data.aging.map(item =>
            '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.invoice_number) + '</strong><small>' +
            helpers.escapeHtml(item.customer_name) + '</small></span><span>' + helpers.escapeHtml(item.bucket) +
            '<small>' + item.age_days + ' days</small></span><strong>' + helpers.money(item.total) + '</strong></div>'
          )) +
        '</section>' +

        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">PAYMENT REVIEW</span><h2>Submitted, not verified</h2></div><a href="#operations">Review →</a></div>' +
          rows(data.payment_review.map(item =>
            '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.customer_name) + '</strong><small>' +
            helpers.escapeHtml(item.provider || 'Unspecified') + '</small></span><span>' +
            helpers.escapeHtml(helpers.dateTime(item.submitted_at)) + '</span><strong>' + helpers.money(item.amount) + '</strong></div>'
          )) +
        '</section>' +
      '</div>' +

      '<div class="finance-columns">' +
        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">COLLECTIONS</span><h2>Payment method mix</h2></div></div>' +
          rows(data.payment_mix.map(item =>
            '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.method) + '</strong></span><span>' +
            item.count + ' paid orders</span><strong>' + helpers.money(item.amount) + '</strong></div>'
          )) +
        '</section>' +

        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">CUSTOMERS</span><h2>Outstanding order value</h2></div><a href="#customers">Customers →</a></div>' +
          rows(data.unpaid_customers.map(item =>
            '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.name) + '</strong></span><span>' +
            item.count + ' open orders</span><strong>' + helpers.money(item.total) + '</strong></div>'
          )) +
        '</section>' +
      '</div>' +

      '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">HISTORY</span><h2>Monthly paid revenue</h2></div></div>' +
        rows(data.monthly.map(item =>
          '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.month) + '</strong></span><span>' +
          item.orders + ' paid orders</span><strong>' + helpers.money(item.revenue) + '</strong></div>'
        )) +
      '</section>' +
      '<p class="dashboard-generated">Finance generated ' + helpers.escapeHtml(helpers.dateTime(data.generated_at)) + '</p>'
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load finance.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
