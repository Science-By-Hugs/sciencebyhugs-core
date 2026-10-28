import { deliveryEstimateEditor, bindDeliveryEstimateEditors } from './delivery-estimate'
import { listCoreOrders, type CoreOrder } from './services/orders'
import { deleteOrder } from './services/records'

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

function statusClass(status: string) {
  return ['processing', 'ordered', 'shipped', 'delivered', 'delayed', 'cancelled'].includes(status)
    ? status
    : ''
}

export function deleteZone(title: string, note: string, placeholder: string, kind: string, escapeHtml: Helpers['escapeHtml']) {
  return '<details class="danger-zone">' +
    '<summary>' + escapeHtml(title) + '</summary>' +
    '<p>' + escapeHtml(note) + '</p>' +
    '<div class="danger-zone-row">' +
      '<input class="' + kind + '-confirm" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(placeholder) + '">' +
      '<button class="danger ' + kind + '-button" type="button">' + escapeHtml(title) + '</button>' +
    '</div>' +
    '<p class="card-message ' + kind + '-message" aria-live="polite"></p>' +
  '</details>'
}

function orderCard(order: CoreOrder, helpers: Helpers) {
  const { escapeHtml, money, dateTime } = helpers
  const customerName =
    [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Customer'

  const items = order.items.map(item =>
    '<div class="order-line">' +
      '<div><strong>' + escapeHtml(item.product_name) + '</strong>' +
      '<span>' + escapeHtml(item.product_code || '') + '</span></div>' +
      '<span>' + item.quantity + ' × ' + money(item.unit_price) + '</span>' +
      '<strong>' + money(item.line_total) + '</strong>' +
    '</div>'
  ).join('')

  const timeline: Array<[string, string | null]> = [
    ['Submitted', order.submitted_at || order.created_at],
    ['Paid', order.paid_at],
    ['Ordered', order.ordered_at],
    ['Shipped', order.shipped_at],
    ['Delivered', order.delivered_at],
  ]

  const timelineHtml = timeline
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) =>
      '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(dateTime(value)) + '</strong></div>'
    ).join('')

  return '<article class="order-card" data-order-id="' + escapeHtml(order.id) + '">' +
    '<div class="order-card-head">' +
      '<div>' +
        '<span class="eyebrow">' + escapeHtml(order.order_number || 'UNNUMBERED ORDER') + '</span>' +
        '<h2>' + escapeHtml(customerName) + (order.customer?.deleted ? ' <span class="deleted-tag">Deleted customer</span>' : '') + '</h2>' +
        '<p>' + escapeHtml(order.customer?.customer_number || 'No customer number') + ' · ' +
          escapeHtml(order.customer?.email || '') + '</p>' +
      '</div>' +
      '<div class="order-status-stack">' +
        '<span class="status-pill ' + escapeHtml(statusClass(order.status)) + '">' + escapeHtml(order.status) + '</span>' +
        '<span class="payment-badge ' + (order.payment_status === 'paid' ? 'paid' : '') + '">' +
          escapeHtml(order.payment_status) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="order-meta-grid">' +
      '<div><span>Total</span><strong>' + money(order.total) + '</strong></div>' +
      '<div><span>Payment</span><strong>' + escapeHtml(order.payment_method || order.payment?.provider || '—') + '</strong></div>' +
      '<div><span>Contact</span><strong>' + escapeHtml(order.contact_method || order.customer?.preferred_contact_method || '—') + '</strong></div>' +
      '<div><span>Updated</span><strong>' + escapeHtml(dateTime(order.updated_at)) + '</strong></div>' +
    '</div>' +
    deliveryEstimateEditor(order.id, order.estimated_delivery_date, escapeHtml) +
    '<div class="order-lines">' + (items || '<p class="muted">No line items available.</p>') + '</div>' +
    '<div class="order-timeline">' + timelineHtml + '</div>' +
    (order.fulfillment_note
      ? '<div class="order-note"><span>Fulfillment note</span><p>' + escapeHtml(order.fulfillment_note) + '</p></div>'
      : '') +
    (order.admin_notes
      ? '<div class="order-note"><span>Admin note</span><p>' + escapeHtml(order.admin_notes) + '</p></div>'
      : '') +
    '<div class="invoice-actions">' +
      (order.invoice?.pdf_url
        ? '<a class="button secondary" href="' + escapeHtml(order.invoice.pdf_url) + '" target="_blank" rel="noreferrer">Open Invoice PDF</a>'
        : '') +
      '<a class="button secondary" href="#operations">Open Operations</a>' +
    '</div>' +
    deleteZone(
      'Delete order',
      'Permanently deletes this order, its items and its payment record. It disappears from Orders and Finance. A full copy is kept in the Audit Log.',
      'Type ' + (order.order_number || order.id) + ' to confirm',
      'delete-order',
      escapeHtml,
    ) +
  '</article>'
}

export function ordersPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact">' +
    '<div><span class="eyebrow">ORDER MANAGEMENT</span>' +
      '<h1 class="dashboard-title">Orders</h1>' +
      '<p class="copy">Search customer activity, payment state, invoice access, and fulfillment history.</p>' +
    '</div>' +
    '<div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div>' +
  '</section>' +
  '<section class="orders-toolbar orders-toolbar-v2">' +
    '<label class="queue-search"><span class="sr-only">Search orders</span>' +
      '<input id="orders-search" type="search" placeholder="Search order, customer, email…" autocomplete="off"></label>' +
    '<select id="orders-status" aria-label="Filter orders by status">' +
      '<option value="all">All statuses</option>' +
      '<option value="processing">Processing</option>' +
      '<option value="ordered">Ordered</option>' +
      '<option value="shipped">Shipped</option>' +
      '<option value="delayed">Delayed</option>' +
      '<option value="delivered">Delivered</option>' +
      '<option value="cancelled">Cancelled</option>' +
    '</select>' +
  '</section>' +
  '<p class="queue-summary" id="orders-summary" aria-live="polite"></p>' +
  '<section class="orders-list" id="orders-list"><div class="loading">Loading orders…</div></section>'
}

export async function bindOrdersPage(helpers: Helpers) {
  const { escapeHtml } = helpers
  const list = document.querySelector<HTMLDivElement>('#orders-list')
  if (!list) return

  try {
    const orders = await listCoreOrders()
    list.innerHTML = orders.length
      ? orders.map(order => orderCard(order, helpers)).join('')
      : '<div class="empty-state"><h2>No orders yet.</h2><p>Orders will appear here as they are created.</p></div>'

    bindDeliveryEstimateEditors()

    let search = ''
    let status = 'all'

    const apply = () => {
      let shown = 0

      document.querySelectorAll<HTMLElement>('.order-card').forEach(card => {
        const order = orders.find(item => item.id === card.dataset.orderId)
        if (!order) return

        const customerName =
          [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ')

        const haystack = [
          order.order_number,
          customerName,
          order.customer?.customer_number,
          order.customer?.email,
          order.customer?.phone,
          order.payment_method,
          order.payment?.payment_reference,
        ].filter(Boolean).join(' ').toLowerCase()

        const visible =
          (status === 'all' || order.status === status) &&
          (!search || haystack.includes(search))

        card.hidden = !visible
        if (visible) shown += 1
      })

      const summary = document.querySelector<HTMLParagraphElement>('#orders-summary')
      if (summary) summary.textContent = shown + ' of ' + orders.length + ' orders shown.'

      const existing = document.querySelector('#orders-empty-filter')
      if (shown === 0 && orders.length) {
        if (!existing) {
          list.insertAdjacentHTML(
            'beforeend',
            '<div class="empty-state" id="orders-empty-filter"><h2>No matching orders.</h2><p>Change the status filter or clear your search.</p></div>',
          )
        }
      } else {
        existing?.remove()
      }
    }

    document.querySelectorAll<HTMLButtonElement>('.delete-order-button').forEach(button => {
      button.addEventListener('click', async () => {
        const card = button.closest<HTMLElement>('.order-card')
        const order = orders.find(item => item.id === card?.dataset.orderId)
        const input = card?.querySelector<HTMLInputElement>('.delete-order-confirm')
        const message = card?.querySelector<HTMLParagraphElement>('.delete-order-message')
        if (!card || !order || !input) return
        const expected = order.order_number || order.id
        const say = (text: string) => { if (message) message.textContent = text }
        if (input.value.trim().toUpperCase() !== expected.toUpperCase()) {
          say('Type ' + expected + ' exactly to confirm.')
          return
        }
        if (!window.confirm('Permanently delete order ' + expected + '?\n\nThis cannot be undone. A copy is kept in the Audit Log.')) return
        button.disabled = true
        button.textContent = 'Deleting…'
        say('Deleting…')
        try {
          await deleteOrder(order.id, input.value.trim())
          orders.splice(orders.indexOf(order), 1)
          card.remove()
          apply()
          const summary = document.querySelector<HTMLParagraphElement>('#orders-summary')
          if (summary) summary.textContent = 'Deleted order ' + expected + '. Copy saved in the Audit Log. ' + summary.textContent
        } catch (error) {
          say(error instanceof Error ? error.message : 'Could not delete the order.')
          button.disabled = false
          button.textContent = 'Delete order'
        }
      })
    })

    document.querySelector<HTMLInputElement>('#orders-search')?.addEventListener('input', event => {
      search = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase()
      apply()
    })

    document.querySelector<HTMLSelectElement>('#orders-status')?.addEventListener('change', event => {
      status = (event.currentTarget as HTMLSelectElement).value
      apply()
    })

    apply()
  } catch (error) {
    list.innerHTML =
      '<div class="empty-state error-state"><h2>Could not load orders.</h2><p>' +
      escapeHtml(error instanceof Error ? error.message : 'Unknown error') +
      '</p></div>'
  }
}
