import { loadCoreFinance, loadProfitReport } from './services/finance'
import { pct } from './pricing'

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

export function financePageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">BUSINESS PERFORMANCE</span><h1 class="dashboard-title">Finances</h1>' +
    '<p class="copy">Know what customers have paid, what needs attention, and what your products cost. Operational reporting, not a bank balance or accounting ledger.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section id="finance-root" aria-label="Financial overview"><div class="loading">Loading finance…</div></section>' +
    '<section id="finance-profit" class="finance-panel" aria-label="Profit report"><div class="loading">Loading profit…</div></section>'
}

const rows = (items: string[], empty = 'No records to review.') => items.length ? items.join('') :
  '<p class="finance-empty">' + empty + '</p>'

type ProfitPeriod = 'all' | 'this-month' | 'last-month' | 'last-90' | 'this-year'
const PROFIT_PERIOD_KEY = 'core-reports-profit-period'
const PROFIT_PERIODS:ProfitPeriod[]=['all','this-month','last-month','last-90','this-year']
let profitRequestVersion=0
function storedProfitPeriod():ProfitPeriod {
  try {
    const value=sessionStorage.getItem(PROFIT_PERIOD_KEY) as ProfitPeriod
    if(PROFIT_PERIODS.includes(value))return value
  } catch {/* storage optional */}
  return 'all'
}

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
  const version=++profitRequestVersion
  const { escapeHtml, money } = helpers
  const options: Array<[ProfitPeriod, string]> = [
    ['all', 'All time'], ['this-month', 'This month'], ['last-month', 'Last month'], ['last-90', 'Last 90 days'], ['this-year', 'This year'],
  ]
  const head = (body: string) =>
    '<div class="dashboard-section-head finance-profit-head"><div><span class="eyebrow">COSTED SALES · NOT NET INCOME</span><h2>Product profit & costs</h2></div>' +
    '<select id="finance-profit-period" aria-label="Profit period">' +
      options.map(([value, label]) => '<option value="' + value + '"' + (value === period ? ' selected' : '') + '>' + label + '</option>').join('') +
    '</select></div>' + body

  el.innerHTML = head('<div class="loading">Loading profit…</div>')
  try {
    const range = periodRange(period)
    const r = await loadProfitReport(range.from, range.to)
    if(version!==profitRequestVersion||!el.isConnected)return
    const t = r.totals
    const costedLines = Math.max(0, t.lines - t.uncosted_lines)
    const coverage = t.lines > 0 ? Math.min(100, Math.max(0, Math.round(costedLines / t.lines * 100))) : 0
    const profitDisplay = costedLines > 0 ? money(t.gross_profit) : '—'
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
      '<p class="report-kicker">Profit snapshot · selected period</p>' +
      '<section class="finance-kpis report-finance-featured">' +
        '<div><span>Sales before discounts</span><strong>' + money(t.sales) + '</strong><small>' + t.orders + ' paid orders · ' + t.lines + ' lines</small></div>' +
        '<div class="report-key-figure"><span>Recorded gross profit</span><strong>' + profitDisplay + '</strong><small>Only ' + costedLines + ' of ' + t.lines + ' sales lines have costs</small></div>' +
        '<div><span>Recorded vendor costs</span><strong>' + money(t.vendor_cost) + '</strong><small>Costs captured at the time of sale</small></div>' +
      '</section>' +
      '<section class="finance-quality' + (t.uncosted_lines ? ' finance-quality-partial' : '') + '" aria-label="Cost coverage">' +
        '<div class="finance-quality-head"><div><span class="eyebrow">HISTORICAL COST COVERAGE</span>' +
          '<strong>' + (t.lines ? coverage + '% of sold lines have recorded costs' : 'No sales lines this period') + '</strong>' +
          '<small>' + costedLines + ' costed · ' + t.uncosted_lines + ' missing historical costs</small></div>' +
          '<span class="finance-quality-count">' + costedLines + ' / ' + t.lines + '</span></div>' +
        '<div class="finance-quality-meter" role="progressbar" aria-label="Costed sold lines" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + coverage + '">' +
          '<span style="width:' + coverage + '%"></span></div>' +
        '<p>This gross profit is based only on costed product lines. It is <strong>not total business profit</strong>. Discounts, shipping expense, payment fees, taxes and overhead are not deducted.</p>' +
      '</section>' +
      '<details class="report-expander report-profit-extra"><summary>Discounts, margin & markup</summary>' +
        '<section class="finance-kpis report-finance-extra">' +
          '<div><span>Discounts given</span><strong>' + money(t.discounts) + '</strong><small>Net sales ' + money(t.net_sales) + '</small></div>' +
          '<div><span>Margin</span><strong>' + pct(t.margin_pct) + '</strong><small>Profit ÷ sales</small></div>' +
          '<div><span>Markup</span><strong>' + pct(t.markup_pct) + '</strong><small>Profit ÷ cost</small></div>' +
        '</section>' +
      '</details>' +
      (t.uncosted_lines
        ? '<p class="finance-note warn report-warning"><strong>Profit needs a cost review.</strong> ' +
          t.uncosted_lines + ' sold line(s) (' + money(t.uncosted_sales) +
          ' of sales) had no vendor cost on file when they sold, so they are left out of profit. ' +
          'Earlier orders may not have had costs recorded. <a href="#products?section=catalog">Check the catalog</a></p>'
        : '') +
      '<p class="finance-note">Profit uses recorded vendor-cost snapshots from each sale. Missing historical costs are never estimated automatically. ' +
      'Sales are product-line totals before order discounts; they are not bank deposits. ' +
      'Current catalog: ' + r.catalog.with_cost + ' of ' + r.catalog.products + ' products have a vendor cost' +
      (r.catalog.avg_margin_pct !== null ? ' · average list margin ' + pct(r.catalog.avg_margin_pct) : '') +
      (r.catalog.selling_without_cost ? ' · <strong>' + r.catalog.selling_without_cost + ' selling without a cost</strong> (Catalog → filter “Missing vendor cost”)' : '') + '.</p>' +
      '<p class="finance-note">Date filters use the paid-at timestamp. A paid order without that timestamp can be missing from a selected period even when it appears in all-time results.</p>' +
      '<details class="report-expander report-profit-breakdown"><summary>Product & monthly profit breakdown</summary>' +
        '<div class="finance-columns">' +
          '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">BY PRODUCT</span><h2>Profit by product</h2></div></div>' +
            rows(productRows ? [productRows] : [], 'No paid product lines for this period.') + '</section>' +
          '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">BY MONTH</span><h2>Monthly profit</h2></div></div>' +
            rows(monthRows ? [monthRows] : [], 'No monthly profit entries for this period.') + '</section>' +
        '</div></details>' +
      (belowCost
        ? '<section class="finance-panel report-cost-alert"><div class="dashboard-section-head"><div><span class="eyebrow">ATTENTION</span><h2>Priced below vendor cost</h2></div><a href="#products?section=catalog">Open Catalog</a></div>' + belowCost + '</section>'
        : '')
    )
  } catch (error) {
    if(version!==profitRequestVersion||!el.isConnected)return
    el.innerHTML = head('<div class="empty-state error-state"><h2>Could not load profit.</h2><p>' +
      escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>')
  }
  el.querySelector<HTMLSelectElement>('#finance-profit-period')?.addEventListener('change', event => {
    const selected=(event.currentTarget as HTMLSelectElement).value as ProfitPeriod
    if(!PROFIT_PERIODS.includes(selected))return
    try{sessionStorage.setItem(PROFIT_PERIOD_KEY,selected)}catch{/* storage optional */}
    void renderProfit(helpers, selected)
  })
}

export async function bindFinancePage(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#finance-root')
  if (!root) return
  void renderProfit(helpers,storedProfitPeriod())

  try {
    const data = await loadCoreFinance()
    if (!root.isConnected) return
    const s = data.summary
    // This summary is derived exclusively from the existing authorized finance response.
    const priority = s.payment_review_count > 0
      ? {title:s.payment_review_count+' payment'+(s.payment_review_count===1?'':'s')+' to verify',
         detail:'Confirm the funds arrived before verifying payment in Orders.',action:'Review payments',href:'#orders'}
      : s.unfulfilled_paid_orders > 0
      ? {title:s.unfulfilled_paid_orders+' paid order'+(s.unfulfilled_paid_orders===1?'':'s')+' awaiting fulfillment',
         detail:'Check the next fulfillment action on each paid order.',action:'Review orders',href:'#orders'}
      : data.aging.length > 0
      ? {title:data.aging.length+' unpaid invoice'+(data.aging.length===1?'':'s')+' to review',
         detail:'See outstanding invoices and follow up through the existing workflow.',action:'View invoices',href:'#orders'}
      : {title:'No urgent finance follow-ups',
         detail:'Review collected revenue and product costs below.',action:'View orders',href:'#orders'}

    root.innerHTML =
      '<section class="report-priority" aria-labelledby="finance-next-title">' +
        '<div><span class="report-kicker">FINANCE · NEXT STEP</span>' +
          '<h2 id="finance-next-title">' + helpers.escapeHtml(priority.title) + '</h2>' +
          '<p>' + helpers.escapeHtml(priority.detail) + '</p></div>' +
        '<a href="' + priority.href + '" class="report-priority-action">' + helpers.escapeHtml(priority.action) + ' <span aria-hidden="true">→</span></a>' +
      '</section>' +
      '<div class="report-section-heading"><h2>Money at a glance</h2><span>All-time order values · not bank deposits</span></div>' +
      '<section class="finance-kpis report-finance-featured">' +
        '<div class="report-key-figure"><span>Paid order revenue</span><strong>' + helpers.money(s.paid_revenue) + '</strong><small>' + s.paid_orders + ' orders marked paid</small></div>' +
        '<div><span>Submitted · unverified</span><strong>' + helpers.money(s.payment_review_value) + '</strong><small>' + s.payment_review_count + ' payments need confirmation</small></div>' +
        '<div><span>Open order value</span><strong>' + helpers.money(s.open_order_value) + '</strong><small>Not marked as paid</small></div>' +
      '</section>' +
      '<div class="finance-scope-note"><strong>What these numbers mean:</strong> Paid revenue uses orders marked paid, not bank deposits. Submitted payments are still unverified. Open orders and invoice totals can overlap; never add these cards together as cash.</div>' +
      '<nav class="finance-shortcuts" aria-label="Finance shortcuts">' +
        '<a href="#orders">Orders & payments</a>' +
        '<a href="#products?section=catalog">Product costs</a>' +
        '<a href="#finance-profit" data-finance-profit-link>Profit & cost coverage ↓</a>' +
      '</nav>' +
      '<details class="report-expander report-finance-extra-wrap"><summary>More financial figures</summary>' +
        '<section class="finance-kpis report-finance-extra">' +
          '<div><span>Sent unpaid invoices</span><strong>' + helpers.money(s.sent_unpaid_invoice_value) + '</strong><small>Invoice receivables</small></div>' +
          '<div><span>Paid / unfulfilled</span><strong>' + s.unfulfilled_paid_orders + '</strong><small>' + s.delivered_paid_orders + ' delivered</small></div>' +
          '<div><span>Verified records</span><strong>' + helpers.money(s.verified_payment_total) + '</strong><small>' + s.verified_payment_records + ' payment records</small></div>' +
        '</section>' +
      '</details>' +
      '<div class="report-section-heading"><h2>Needs review</h2><span>Payments and invoices awaiting action</span></div>' +

      '<div class="finance-columns">' +
        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">RECEIVABLES</span><h2>Invoice aging</h2></div><a href="#orders">Open Orders</a></div>' +
          rows(data.aging.map(item =>
            '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.invoice_number) + '</strong><small>' +
            helpers.escapeHtml(item.customer_name) + '</small></span><span>' + helpers.escapeHtml(item.bucket) +
            '<small>' + item.age_days + ' days</small></span><strong>' + helpers.money(item.total) + '</strong></div>'
          ), 'No sent unpaid invoices to follow up.') +
        '</section>' +

        '<section class="finance-panel"><div class="dashboard-section-head"><div><span class="eyebrow">PAYMENT REVIEW</span><h2>Submitted, not verified</h2></div><a href="#orders">Review Orders</a></div>' +
          rows(data.payment_review.map(item =>
            '<div class="finance-row"><span><strong>' + helpers.escapeHtml(item.customer_name) + '</strong><small>' +
            helpers.escapeHtml(item.provider || 'Unspecified') + '</small></span><span>' +
            helpers.escapeHtml(helpers.dateTime(item.submitted_at)) + '</span><strong>' + helpers.money(item.amount) + '</strong></div>'
          ), 'No submitted payments await verification.') +
        '</section>' +
      '</div>' +

      '<details class="report-expander report-finance-history"><summary>Collections, customers & history</summary>' +
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
        ), 'No paid monthly revenue records yet.') +
      '</section>' +
      '</details>' +
      '<p class="dashboard-generated">Finance generated ' + helpers.escapeHtml(helpers.dateTime(data.generated_at)) + '</p>'
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load finance.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
