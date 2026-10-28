import { clearCheckoutPending, listCoreOrders, type CoreOrder } from './services/orders'
import { recordPayment, updateFulfillment, verifyPayment } from './services/invoices'
import { deleteOrder } from './services/records'
import { bindDeliveryEstimateEditors, deliveryEstimateEditor } from './delivery-estimate'
import { deleteZone } from './delete-zone'
import { mountMasterDetail } from './master-detail'

// 2026-10-28 redesign, stage 2: ONE Orders page.
// Replaces the separate Orders, Fulfillment (operations) and Checkout Pending pages.
// List with filters; the selected order opens in a side panel (desktop) or sheet (phone)
// with its one next step: record/verify payment, update fulfillment, set delivery date,
// clear an unpaid checkout, or delete.

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

export type OrdersFilter = 'action' | 'ship' | 'shipped' | 'delivered' | 'unpaid' | 'all'
const FILTERS: Array<[OrdersFilter, string]> = [
  ['action', 'Needs action'], ['ship', 'To ship'], ['shipped', 'Shipped'],
  ['delivered', 'Delivered'], ['unpaid', 'Unpaid checkouts'], ['all', 'All'],
]
const FILTER_KEY = 'core-orders-filter'

export function presetOrdersFilter(filter: OrdersFilter) {
  try { sessionStorage.setItem(FILTER_KEY, filter) } catch { /* convenience */ }
}
function storedFilter(): OrdersFilter | null {
  try {
    const value = sessionStorage.getItem(FILTER_KEY) as OrdersFilter | null
    return value && FILTERS.some(([f]) => f === value) ? value : null
  } catch { return null }
}

type State = {
  paid: boolean; submitted: boolean; unpaidCheckout: boolean; toShip: boolean
  label: string; tone: 'warn' | 'error' | 'go' | 'muted'; needsAction: boolean
}

function classify(order: CoreOrder): State {
  const status = String(order.status || '').toLowerCase()
  const paid = String(order.payment_status || '').toLowerCase() === 'paid'
  const submitted = !paid && order.payment?.status === 'submitted'
  const cancelled = status === 'cancelled'
  const unpaidCheckout = !paid && !submitted && status === 'checkout_pending'
  const toShip = paid && (status === 'processing' || status === 'ordered')
  const delayed = status === 'delayed'
  let label: string, tone: State['tone']
  if (submitted) { label = 'Payment to review'; tone = 'warn' }
  else if (unpaidCheckout) { label = 'Unpaid checkout'; tone = 'muted' }
  else if (cancelled) { label = 'Cancelled'; tone = 'muted' }
  else if (!paid) { label = 'Awaiting payment'; tone = 'warn' }
  else if (delayed) { label = 'Delayed'; tone = 'error' }
  else if (status === 'ordered') { label = 'Ordered · to ship'; tone = 'go' }
  else if (status === 'shipped') { label = 'Shipped'; tone = 'go' }
  else if (status === 'delivered') { label = 'Delivered'; tone = 'muted' }
  else { label = 'Paid · to order'; tone = 'go' }
  const needsAction = submitted || toShip || delayed || (!paid && !unpaidCheckout && !cancelled)
  return { paid, submitted, unpaidCheckout, toShip, label, tone, needsAction }
}

function matches(order: CoreOrder, s: State, filter: OrdersFilter) {
  const status = String(order.status || '').toLowerCase()
  if (filter === 'action') return s.needsAction
  if (filter === 'ship') return s.toShip
  if (filter === 'shipped') return s.paid && status === 'shipped'
  if (filter === 'delivered') return status === 'delivered'
  if (filter === 'unpaid') return s.unpaidCheckout
  return true
}

const nameOf = (order: CoreOrder) =>
  [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || order.customer?.email || 'Customer'

function paymentSection(order: CoreOrder, s: State, h: Helpers) {
  const { escapeHtml, money, dateTime } = h
  const p = order.payment
  const facts = (rows: Array<[string, string]>) =>
    '<dl class="od-facts">' + rows.map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') + '</dl>'
  if (s.paid) {
    return '<section class="od-section"><h3>Payment</h3>' + facts([
      ['Method', escapeHtml(p?.provider || order.payment_method || '—')],
      ['Reference', escapeHtml(p?.payment_reference || '—')],
      ['Amount', money(p?.amount ?? order.total)],
      ['Verified', escapeHtml(dateTime(p?.verified_at || p?.paid_at || order.paid_at))],
    ]) + '</section>'
  }
  if (s.submitted) {
    return '<section class="od-section od-next"><h3>Payment to review</h3>' + facts([
      ['Method', escapeHtml(p?.provider || order.payment_method || '—')],
      ['Reference', escapeHtml(p?.payment_reference || '—')],
      ['Amount', money(p?.amount ?? order.total)],
      ['Submitted', escapeHtml(dateTime(p?.submitted_at))],
    ]) + (p?.notes ? '<p class="od-note">' + escapeHtml(p.notes) + '</p>' : '') +
      '<p class="od-hint">Verify only after you have confirmed the money arrived. The order then moves to processing.</p>' +
      '<button class="primary od-verify" type="button" data-order-id="' + escapeHtml(order.id) + '">Verify payment</button></section>'
  }
  if (String(order.status).toLowerCase() === 'cancelled') return ''
  return '<section class="od-section"><h3>Waiting for payment</h3>' +
    '<p class="od-hint">Record a payment when you have a confirmation to reference. This does not move money.</p>' +
    '<div class="od-form">' +
      '<label>Method<select class="od-provider"><option value="">Choose method</option><option value="Zelle">Zelle</option><option value="PayPal">PayPal</option><option value="Venmo">Venmo</option></select></label>' +
      '<label>Reference<input class="od-reference" type="text" maxlength="120" placeholder="Optional confirmation ID"></label>' +
      '<label class="od-span">Note<input class="od-pay-note" type="text" maxlength="300" placeholder="Optional internal note"></label>' +
    '</div>' +
    '<button class="secondary od-record" type="button" data-order-id="' + escapeHtml(order.id) + '">Record payment</button></section>'
}

const NEXT: Record<string, Array<[string, string]>> = {
  processing: [['ordered', 'Mark ordered'], ['delayed', 'Mark delayed'], ['cancelled', 'Cancel order']],
  ordered: [['shipped', 'Mark shipped'], ['delayed', 'Mark delayed'], ['cancelled', 'Cancel order']],
  shipped: [['delivered', 'Mark delivered'], ['delayed', 'Mark delayed']],
  delayed: [['processing', 'Back to processing'], ['ordered', 'Back to ordered'], ['shipped', 'Back to shipped'], ['cancelled', 'Cancel order']],
}

function fulfillmentSection(order: CoreOrder, s: State, h: Helpers) {
  if (!s.paid) return ''
  const status = String(order.status || 'processing').toLowerCase()
  const options = NEXT[status] || []
  const terminal = status === 'delivered' || status === 'cancelled'
  if (terminal) return ''
  const primary = options[0]
  return '<section class="od-section od-next"><h3>Fulfillment</h3>' +
    '<div class="od-fulfill">' +
      '<select class="od-status" aria-label="Next status">' +
        options.map(([v, l], i) => '<option value="' + v + '"' + (i === 0 ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select>' +
      '<input class="od-status-note" type="text" maxlength="300" placeholder="Optional note" aria-label="Fulfillment note">' +
      '<button class="primary od-update" type="button" data-order-id="' + h.escapeHtml(order.id) + '">' + h.escapeHtml(primary ? 'Update' : 'Update') + '</button>' +
    '</div>' +
    deliveryEstimateEditor(order.id, order.estimated_delivery_date, h.escapeHtml) +
  '</section>'
}

function orderCard(order: CoreOrder, s: State, h: Helpers) {
  const { escapeHtml, money, dateTime } = h
  const c = order.customer
  const who = [c?.customer_number, c?.email, c?.phone, order.contact_method || c?.preferred_contact_method ? 'prefers ' + (order.contact_method || c?.preferred_contact_method) : '']
    .filter(Boolean).map(escapeHtml).join(' · ')
  const items = order.items.map(item =>
    '<div class="od-line"><span>' + escapeHtml(item.product_name) + ' <small>× ' + item.quantity + '</small></span><b>' + money(item.line_total) + '</b></div>').join('')
  const totals = [
    order.discount_total ? ['Discount', '−' + money(order.discount_total)] : null,
    ['Shipping', money(order.shipping_total)],
    order.tax_total ? ['Tax', money(order.tax_total)] : null,
  ].filter(Boolean) as Array<[string, string]>
  const timeline = ([
    ['Placed', order.submitted_at || order.created_at], ['Paid', order.paid_at], ['Ordered', order.ordered_at],
    ['Shipped', order.shipped_at], ['Delivered', order.delivered_at], ['Delayed', order.delayed_at], ['Cancelled', order.cancelled_at],
  ] as Array<[string, string | null]>).filter(([, v]) => v)
  const notes = ([
    ['Customer note', order.customer_notes], ['Fulfillment note', order.fulfillment_note], ['Admin note', order.admin_notes],
  ] as Array<[string, string | null]>).filter(([, v]) => v)

  return '<article class="order-detail" data-order-id="' + escapeHtml(order.id) + '">' +
    '<header class="od-head">' +
      '<span class="od-number">' + escapeHtml((order.order_number || 'Order') + ' · ' + dateTime(order.created_at)) + '</span>' +
      '<h2>' + escapeHtml(nameOf(order)) + ((c as { deleted?: boolean } | null)?.deleted ? ' <span class="deleted-tag">Deleted customer</span>' : '') + '</h2>' +
      (who ? '<p>' + who + '</p>' : '') +
      '<p class="tone ' + s.tone + ' od-status-line">' + escapeHtml(s.label) + '</p>' +
    '</header>' +
    paymentSection(order, s, h) +
    fulfillmentSection(order, s, h) +
    (s.unpaidCheckout
      ? '<section class="od-section"><h3>Unpaid checkout</h3><p class="od-hint">This checkout was started but never paid. Clearing removes it from Core.</p>' +
        '<button class="secondary od-clear" type="button" data-order-id="' + escapeHtml(order.id) + '">Clear unpaid checkout</button></section>'
      : '') +
    '<section class="od-section"><h3>Items</h3>' + (items || '<p class="od-hint">No items recorded.</p>') +
      totals.map(([k, v]) => '<div class="od-line od-muted"><span>' + k + '</span><b>' + v + '</b></div>').join('') +
      '<div class="od-line od-total"><span>Total</span><b>' + money(order.total) + '</b></div></section>' +
    (timeline.length ? '<section class="od-section"><h3>Timeline</h3>' +
      timeline.map(([k, v]) => '<div class="od-line od-muted"><span>' + k + '</span><b>' + escapeHtml(dateTime(v)) + '</b></div>').join('') + '</section>' : '') +
    (notes.length ? '<section class="od-section"><h3>Notes</h3>' +
      notes.map(([k, v]) => '<p class="od-note"><b>' + k + ':</b> ' + escapeHtml(v) + '</p>').join('') + '</section>' : '') +
    '<p class="card-message od-message" aria-live="polite"></p>' +
    deleteZone('Delete order',
      'Permanently deletes this order, its items and its payment record. It disappears from Orders and Finance. A full copy is kept in the Audit Log.',
      'Type ' + (order.order_number || order.id) + ' to confirm', 'delete-order', escapeHtml) +
  '</article>'
}

export function ordersHubMarkup() {
  return '<section class="dashboard-head orders-head"><h1 class="dashboard-title">Orders</h1>' +
      '<label class="orders-search"><span class="sr-only">Search orders</span>' +
      '<input id="orders-search" type="search" placeholder="Search order, name, email" autocomplete="off"></label></section>' +
    '<div class="orders-chips" id="orders-chips" role="group" aria-label="Order filters"></div>' +
    '<p class="queue-summary" id="orders-summary" aria-live="polite"></p>' +
    '<section id="orders-list"><div class="loading">Loading orders…</div></section>'
}

export async function bindOrdersHub(h: Helpers): Promise<void> {
  const list = document.querySelector<HTMLElement>('#orders-list')
  const chips = document.querySelector<HTMLElement>('#orders-chips')
  const search = document.querySelector<HTMLInputElement>('#orders-search')
  const summary = document.querySelector<HTMLElement>('#orders-summary')
  if (!list || !chips) return
  const reload = () => bindOrdersHub(h)

  let orders: CoreOrder[]
  try {
    orders = await listCoreOrders()
  } catch (error) {
    list.innerHTML = '<div class="empty-state error-state"><h2>Could not load orders.</h2><p>' +
      h.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
    return
  }

  const states = new Map(orders.map(o => [o.id, classify(o)]))
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, orders.filter(o => matches(o, states.get(o.id)!, f)).length])) as Record<OrdersFilter, number>
  let filter: OrdersFilter = storedFilter() || (counts.action ? 'action' : 'all')
  let term = search?.value.trim().toLowerCase() || ''

  list.innerHTML = orders.length
    ? orders.map(o => orderCard(o, states.get(o.id)!, h)).join('')
    : '<div class="empty-state"><h2>No orders yet.</h2><p>Orders appear here as customers check out.</p></div>'

  const renderChips = () => {
    chips.innerHTML = FILTERS.map(([f, label]) =>
      '<button type="button" class="orders-chip' + (f === filter ? ' active' : '') + '" aria-pressed="' + (f === filter) + '" data-filter="' + f + '">' +
        label + ' · ' + counts[f] + '</button>').join('')
    chips.querySelectorAll<HTMLButtonElement>('.orders-chip').forEach(b => b.addEventListener('click', () => {
      filter = b.dataset.filter as OrdersFilter
      presetOrdersFilter(filter)
      renderChips()
      apply()
    }))
  }
  const apply = () => {
    let shown = 0
    list.querySelectorAll<HTMLElement>('.order-detail').forEach(card => {
      const order = orders.find(o => o.id === card.dataset.orderId)
      if (!order) return
      const hay = [order.order_number, nameOf(order), order.customer?.email, order.customer?.phone, order.customer?.customer_number,
        order.payment?.payment_reference, order.payment_method].filter(Boolean).join(' ').toLowerCase()
      const visible = matches(order, states.get(order.id)!, filter) && (!term || hay.includes(term))
      card.hidden = !visible
      if (visible) shown++
    })
    if (summary) summary.textContent = shown
      ? shown + (shown === 1 ? ' order' : ' orders') + (term ? ' match your search.' : '.')
      : 'Nothing here. Try another filter or clear the search.'
  }
  renderChips()
  apply()
  if (search && !search.dataset.bound) {
    search.dataset.bound = 'true'
    search.addEventListener('input', () => { term = search.value.trim().toLowerCase(); apply() })
  }

  // ----- actions (cards stay in the DOM, so bind them all once) -----
  const msg = (el: Element) => el.closest('.order-detail')?.querySelector<HTMLElement>('.od-message')
  const busy = (button: HTMLButtonElement, text: string) => { button.disabled = true; button.dataset.label = button.textContent || ''; button.textContent = text }
  const fail = (button: HTMLButtonElement, error: unknown, fallback: string) => {
    button.disabled = false
    button.textContent = button.dataset.label || button.textContent
    const m = msg(button); if (m) m.textContent = error instanceof Error ? error.message : fallback
  }

  list.querySelectorAll<HTMLButtonElement>('.od-verify').forEach(button => button.addEventListener('click', async () => {
    const order = orders.find(o => o.id === button.dataset.orderId)
    if (!order || !window.confirm('Verify payment for ' + (order.order_number || 'this order') + '?\n\nThis marks it paid and moves it to processing. Only continue once you have confirmed the money arrived.')) return
    busy(button, 'Verifying…')
    try { await verifyPayment(order.id); await reload() } catch (e) { fail(button, e, 'Payment verification failed.') }
  }))

  list.querySelectorAll<HTMLButtonElement>('.od-record').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('.order-detail')!
    const provider = card.querySelector<HTMLSelectElement>('.od-provider')?.value || ''
    const reference = card.querySelector<HTMLInputElement>('.od-reference')?.value.trim() || ''
    const note = card.querySelector<HTMLInputElement>('.od-pay-note')?.value.trim() || ''
    if (!provider) { const m = msg(button); if (m) m.textContent = 'Choose a payment method first.'; return }
    busy(button, 'Recording…')
    try { await recordPayment(button.dataset.orderId!, provider, reference, note); await reload() } catch (e) { fail(button, e, 'Could not record the payment.') }
  }))

  list.querySelectorAll<HTMLButtonElement>('.od-update').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('.order-detail')!
    const status = card.querySelector<HTMLSelectElement>('.od-status')?.value || ''
    const note = card.querySelector<HTMLInputElement>('.od-status-note')?.value.trim() || ''
    if (!status) return
    if ((status === 'delivered' || status === 'cancelled') &&
      !window.confirm(status === 'cancelled' ? 'Cancel this order?' : 'Mark this order delivered?')) return
    busy(button, 'Updating…')
    try {
      await updateFulfillment(button.dataset.orderId!, status as 'ordered' | 'shipped' | 'delivered' | 'delayed' | 'cancelled' | 'processing', note)
      await reload()
    } catch (e) { fail(button, e, 'Could not update the order.') }
  }))

  list.querySelectorAll<HTMLButtonElement>('.od-clear').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm('Clear this unpaid checkout? It is removed from Core.')) return
    busy(button, 'Clearing…')
    try { await clearCheckoutPending(button.dataset.orderId); await reload() } catch (e) { fail(button, e, 'Could not clear the checkout.') }
  }))

  list.querySelectorAll<HTMLButtonElement>('.delete-order-button').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest<HTMLElement>('.order-detail')!
    const order = orders.find(o => o.id === card.dataset.orderId)
    const input = card.querySelector<HTMLInputElement>('.delete-order-confirm')
    const message = card.querySelector<HTMLElement>('.delete-order-message')
    if (!order || !input) return
    const expected = order.order_number || order.id
    if (input.value.trim().toUpperCase() !== expected.toUpperCase()) { if (message) message.textContent = 'Type ' + expected + ' exactly to confirm.'; return }
    if (!window.confirm('Permanently delete order ' + expected + '?\n\nThis cannot be undone. A copy is kept in the Audit Log.')) return
    busy(button, 'Deleting…')
    try {
      await deleteOrder(order.id, input.value.trim())
      await reload()
      if (summary) summary.textContent = 'Deleted order ' + expected + '. A copy is in the Audit Log. ' + summary.textContent
    } catch (e) {
      button.disabled = false; button.textContent = 'Delete order'
      if (message) message.textContent = e instanceof Error ? e.message : 'Could not delete the order.'
    }
  }))

  bindDeliveryEstimateEditors()

  mountMasterDetail({
    list,
    cardSelector: '.order-detail',
    idOf: card => card.dataset.orderId || '',
    key: 'orders',
    backLabel: 'Orders',
    row: card => {
      const order = orders.find(o => o.id === card.dataset.orderId)!
      const s = states.get(order.id)!
      return {
        title: nameOf(order),
        sub: (order.order_number || 'Order') + ' · ' + new Date(order.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
          ' · ' + (order.payment?.provider || order.payment_method || 'Payment'),
        meta: h.money(order.total),
        badge: s.label,
        tone: s.tone,
      }
    },
  })
}
