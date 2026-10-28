import { loadCoreDashboard, type CoreDashboard } from './services/dashboard'

// 2026-10-28 redesign: "Today" replaces the old dashboard hero.
// What needs you first (each row has one action), then a few numbers, then the latest orders.

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

type Todo = { title: string; detail: string; tone: 'warn' | 'error' | 'go' | 'muted'; href: string; action: string }

const plural = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many)

export function dashboardPageMarkup(_email: string, _escapeHtml: Helpers['escapeHtml']) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  return '<section class="dashboard-head"><h1 class="dashboard-title">Today</h1></section>' +
    '<p class="today-sub" id="today-sub">' + today + '</p>' +
    '<section id="executive-dashboard"><div class="loading">Loading…</div></section>'
}

function todos(data: CoreDashboard): Todo[] {
  const { attention, operations } = data
  const f = operations.fulfillment || {}
  const toShip = (f.processing || 0) + (f.ordered || 0)
  const list: Todo[] = []
  if (attention.payment_submitted > 0) list.push({
    title: plural(attention.payment_submitted, 'payment') + ' to verify',
    detail: 'Customers submitted payment. Verify it so the order can ship.',
    tone: 'warn', href: '#operations', action: 'Review',
  })
  if (attention.delayed_orders > 0) list.push({
    title: plural(attention.delayed_orders, 'delayed order'),
    detail: 'Update the customer or the delivery estimate.',
    tone: 'error', href: '#operations', action: 'Open',
  })
  if (toShip > 0) list.push({
    title: plural(toShip, 'order') + ' to ship',
    detail: 'Paid or ordered, not yet shipped.',
    tone: 'go', href: '#operations', action: 'Open',
  })
  if (attention.active_unpaid_orders > 0) list.push({
    title: plural(attention.active_unpaid_orders, 'unpaid order'),
    detail: 'Checkouts that were started but not paid.',
    tone: 'muted', href: '#checkout-pending', action: 'View',
  })
  if (attention.missing_coa > 0) list.push({
    title: plural(attention.missing_coa, 'product') + ' without a COA link',
    detail: 'Add COA links in Catalog.',
    tone: 'muted', href: '#catalog', action: 'Fix',
  })
  if (attention.uncategorized_products > 0) list.push({
    title: plural(attention.uncategorized_products, 'product') + ' without a category',
    detail: 'Pick a category in Catalog.',
    tone: 'muted', href: '#catalog', action: 'Fix',
  })
  return list
}

function orderTone(order: CoreDashboard['operations']['recent_orders'][number]): [string, string] {
  const status = String(order.status || '').toLowerCase()
  if (String(order.payment_status || '').toLowerCase() !== 'paid') return ['warn', 'Awaiting payment']
  if (status === 'delayed') return ['error', 'Delayed']
  if (status === 'delivered') return ['muted', 'Delivered']
  if (status === 'shipped') return ['go', 'Shipped']
  if (status === 'cancelled') return ['muted', 'Cancelled']
  return ['go', 'Paid · to ship']
}

export async function bindDashboardPage(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#executive-dashboard')
  if (!root) return
  const { escapeHtml, money } = helpers

  try {
    const data = await loadCoreDashboard()
    const items = todos(data)
    const sub = document.querySelector<HTMLParagraphElement>('#today-sub')
    if (sub) sub.textContent = items.length
      ? (items.length === 1 ? '1 thing needs you.' : items.length + ' things need you.')
      : 'Nothing needs you right now.'

    const b = data.business
    const attention = '<section class="today-section" aria-labelledby="today-attention">' +
      '<h2 id="today-attention">Needs attention</h2>' +
      (items.length
        ? items.map(t =>
            '<a class="today-row" href="' + t.href + '">' +
              '<span class="today-dot ' + t.tone + '" aria-hidden="true"></span>' +
              '<span class="today-row-main"><strong>' + escapeHtml(t.title) + '</strong><small>' + escapeHtml(t.detail) + '</small></span>' +
              '<span class="today-action">' + escapeHtml(t.action) + '</span>' +
            '</a>').join('')
        : '<p class="today-empty">All caught up.</p>') +
    '</section>'

    const stat = (label: string, value: string, sub: string) =>
      '<div class="today-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong><small>' + escapeHtml(sub) + '</small></div>'
    const stats = '<section class="today-stats" aria-label="Key numbers">' +
      stat('Revenue, last 30 days', money(b.revenue_30d), plural(b.orders_30d, 'order')) +
      stat('Average order', money(b.average_paid_order), 'All paid orders') +
      stat('Customers', String(b.customers), b.new_customers_30d + ' new in 30 days') +
      stat('Revenue, all time', money(b.paid_revenue), plural(b.paid_orders, 'paid order')) +
    '</section>'

    const recent = data.operations.recent_orders.slice(0, 6)
    const latest = '<section class="today-section" aria-labelledby="today-latest">' +
      '<h2 id="today-latest">Latest orders <a href="#orders">All orders</a></h2>' +
      (recent.length
        ? recent.map(order => {
            const [tone, label] = orderTone(order)
            return '<a class="today-order" href="#orders">' +
              '<b>' + escapeHtml(order.order_number || 'Order') + '</b>' +
              '<span class="meta">' + escapeHtml((order.payment_method || 'Payment') + ' · ' +
                new Date(order.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</span>' +
              '<span class="num">' + money(order.total) + '</span>' +
              '<span class="tone ' + tone + '">' + escapeHtml(label) + '</span>' +
            '</a>'
          }).join('')
        : '<p class="today-empty">No orders yet.</p>') +
    '</section>'

    root.innerHTML = attention + stats + latest
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load Today.</h2><p>' +
      escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p>' +
      '<button class="secondary" id="retry-dashboard" type="button">Try again</button></div>'
    root.querySelector('#retry-dashboard')?.addEventListener('click', () => {
      root.innerHTML = '<div class="loading">Loading…</div>'
      void bindDashboardPage(helpers)
    })
  }
}
