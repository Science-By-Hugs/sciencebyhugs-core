import { avatarMarkup, bindAvatars } from './avatar'
import { deliveryEstimateEditor, bindDeliveryEstimateEditors } from './delivery-estimate'
import { disablePush, bindPushPanel, pushPrompt } from './push'
import { accountScreen, bindAccount, accountMutationInProgress } from './account-view'
import './styles.css'
import './brand.css'
import { supabase } from './services/supabase'
import { bindOrdersPage, ordersPageMarkup } from './orders-view'
import { bindCheckoutPendingPage, checkoutPendingPageMarkup } from './checkout-pending-view'
import { bindCustomersPage, customersPageMarkup } from './customers-view'
import { bindCatalogPage, catalogPageMarkup } from './catalog-view'
import { bindDashboardPage, dashboardPageMarkup } from './dashboard-view'
import { bindAuditPage, auditPageMarkup } from './audit-view'
import { bindAnalyticsPage, analyticsPageMarkup } from './analytics-view'
import { bindFinancePage, financePageMarkup } from './finance-view'
import { bindReferralsPage, referralsPageMarkup } from './referrals-view'
import { bindAdminToolsPage, adminToolsPageMarkup } from './admin-tools-view'
import { bindNotificationsPage, notificationsPageMarkup } from './notifications-view'
import {
  listCoreInvoices,
  recordPayment,
  verifyPayment,
  updateFulfillment,
  type CoreInvoice,
} from './services/invoices'
import './slate.css' // loaded last: 2026-10-28 slate redesign

const appRoot = document.querySelector<HTMLDivElement>('#app')
if (!appRoot) throw new Error('App root not found')
const app = appRoot
let accountRecovery = false
const coreLogoUrl = `${import.meta.env.BASE_URL}brand/core.svg`

const money = (value: number | string | null | undefined) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(value || 0))

const dateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : '—'

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const roleFor = (user: any) =>
  String(user?.app_metadata?.role || '').trim().toLowerCase()

const isAdminRole = (role: string) =>
  role === 'owner' || role === 'admin'

type CoreView =
  | 'dashboard'
  | 'operations'
  | 'orders'
  | 'checkout-pending'
  | 'customers'
  | 'catalog'
  | 'analytics'
  | 'finance'
  | 'referrals'
  | 'admin-tools'
  | 'notifications'
  | 'audit'
  | 'account'
  | 'more'

const CORE_VIEWS: CoreView[] = [
  'dashboard',
  'operations',
  'orders',
  'checkout-pending',
  'customers',
  'catalog',
  'analytics',
  'finance',
  'referrals',
  'admin-tools',
  'notifications',
  'audit',
  'account',
  'more',
]

const LAST_CORE_VIEW_KEY = 'sciencebyhugs-core:last-view'

function viewFromHash(hash = location.hash): CoreView | null {
  const value = hash.replace(/^#/, '') as CoreView
  return CORE_VIEWS.includes(value) ? value : null
}

function rememberCoreView(view: CoreView) {
  try {
    sessionStorage.setItem(LAST_CORE_VIEW_KEY, view)
  } catch {
    // Storage can be unavailable in hardened/private browser modes.
  }
}

function resolveCoreView(): CoreView {
  const explicitView = viewFromHash()
  if (explicitView) {
    rememberCoreView(explicitView)
    return explicitView
  }

  try {
    const remembered = sessionStorage.getItem(LAST_CORE_VIEW_KEY) as CoreView | null
    if (remembered && CORE_VIEWS.includes(remembered)) return remembered
  } catch {
    // Fall through to the dashboard when storage is unavailable.
  }

  return 'dashboard'
}

function keepCoreViewInUrl(view: CoreView) {
  if (location.hash === '#' + view) return
  history.replaceState(null, '', '#' + view)
}

const ICONS: Record<string, string> = {
  today: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  orders: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  fulfillment: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
  customers: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-6"/>',
  catalog: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  finance: '<path d="M3 20h18M6 16v-6M11 16V6M16 16v-8M21 16V4"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
}
const svg = (name: string) =>
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>'

// 2026-10-28 redesign: five main destinations; everything else lives under More.
const MAIN_NAV: Array<[CoreView, string, string]> = [
  ['dashboard', 'Today', 'today'],
  ['orders', 'Orders', 'orders'],
  ['operations', 'Fulfillment', 'fulfillment'],
  ['customers', 'Customers', 'customers'],
  ['catalog', 'Catalog', 'catalog'],
  ['finance', 'Finance', 'finance'],
]
const MORE_NAV: Array<[CoreView, string]> = [
  ['checkout-pending', 'Unpaid checkouts'],
  ['referrals', 'Referrals'],
  ['analytics', 'Analytics'],
  ['notifications', 'Alerts'],
  ['audit', 'Audit log'],
  ['admin-tools', 'Settings'],
  ['account', 'Account'],
]
const TAB_VIEWS: CoreView[] = ['dashboard', 'orders', 'customers', 'catalog']

function moreScreen(email: string) {
  // Phone "More": everything that isn't a bottom tab, plus account and sign out.
  const links: Array<[CoreView, string]> = [['operations', 'Fulfillment'], ['finance', 'Finance'], ...MORE_NAV.filter(([v]) => v !== 'account')]
  return '<section class="dashboard-head"><h1 class="dashboard-title">More</h1></section>' +
    '<a class="more-account" href="#account">' + avatarMarkup() + '<span><strong>Account</strong><small>' + escapeHtml(email) + '</small></span></a>' +
    '<nav class="more-list" aria-label="More sections">' +
      links.map(([view, label]) => '<a href="#' + view + '">' + escapeHtml(label) + '</a>').join('') +
    '</nav>' +
    '<button class="more-signout" id="more-sign-out" type="button">Sign out</button>'
}

function shell(content: string, signedIn = false) {
  const activeView = resolveCoreView()

  if (!signedIn) {
    app.innerHTML = `
      <a class="skip-link" href="#core-content">Skip to content</a>
      <main class="shell login-shell">
        <header class="commandbar login-commandbar">
          <div class="core-brand">
            <img class="core-brand-lockup" src="${coreLogoUrl}" alt="Core — Science By Hugs" />
          </div>
        </header>
        <div id="core-content" tabindex="-1">${content}</div>
      </main>
    `
    return
  }

  const link = (view: CoreView, label: string, icon?: string) =>
    '<a href="#' + view + '" class="' + (activeView === view ? 'active' : '') + '"' +
    (activeView === view ? ' aria-current="page"' : '') + '>' + (icon ? svg(icon) : '') + '<span>' + label + '</span></a>'

  const moreActive = activeView === 'more' || !TAB_VIEWS.includes(activeView)
  const tab = (view: CoreView, label: string, icon: string, active: boolean) =>
    '<a href="#' + view + '" class="' + (active ? 'active' : '') + '"' + (active ? ' aria-current="page"' : '') + '>' + svg(icon) + label + '</a>'

  app.innerHTML = `
    <a class="skip-link" href="#core-content">Skip to content</a>
    <div class="app">
      <aside class="app-side" aria-label="Core navigation">
        <a class="app-wordmark" href="#dashboard" aria-label="core. home">core<span>.</span></a>
        <nav class="app-nav" aria-label="Main">${MAIN_NAV.map(([v, l, i]) => link(v, l, i)).join('')}</nav>
        <div class="app-nav-sep"></div>
        <span class="app-nav-label">More</span>
        <nav class="app-nav app-nav-more" aria-label="More">${MORE_NAV.filter(([v]) => v !== 'account').map(([v, l]) => link(v, l)).join('')}</nav>
        <div class="app-side-foot">
          <a class="app-me core-account-shortcut" href="#account" title="Account">${avatarMarkup()}<span>Account</span></a>
          <button class="app-signout secondary" id="sign-out" type="button">Sign out</button>
        </div>
      </aside>
      <div class="app-main">
        <header class="app-topbar">
          <a class="app-topbar-mark" href="#dashboard" aria-label="core. home">core<span>.</span></a>
          <a class="app-me core-account-shortcut" href="#account" aria-label="Account">${avatarMarkup()}</a>
        </header>
        <main class="app-content core-content-shell" id="core-content" tabindex="-1">${pushPrompt()}${content}</main>
      </div>
      <nav class="app-tabs" aria-label="Core sections">
        ${tab('dashboard', 'Today', 'today', activeView === 'dashboard')}
        ${tab('orders', 'Orders', 'orders', activeView === 'orders')}
        ${tab('customers', 'Customers', 'customers', activeView === 'customers')}
        ${tab('catalog', 'Catalog', 'catalog', activeView === 'catalog')}
        ${tab('more', 'More', 'more', moreActive)}
      </nav>
    </div>
  `

  void bindPushPanel()
  void bindAvatars('', activeView === 'account')

  document.querySelectorAll<HTMLButtonElement>('#sign-out, #account-sign-out, #more-sign-out').forEach(button=>button.addEventListener('click', async () => {
    button.disabled=true
    try {
      await disablePush()
      const {error}=await supabase.auth.signOut()
      if(error) throw error
    } catch (error) {
      const status=document.querySelector('#account-signout-status')
      const message=error instanceof Error ? error.message : 'Could not sign out. Try again.'
      if(status) status.textContent=message; else alert(message)
      button.disabled=false
    }
  }))
}

function renderLogin(message = '') {
  shell(`
    <section class="login-wrap">
      <div class="login-card">
        <img class="core-login-lockup" src="${coreLogoUrl}" alt="Core — Science By Hugs" />
        <span class="eyebrow">AUTHORIZED PERSONNEL</span>
        <h1 class="login-title">CORE</h1>
        <p class="tagline">Control. Operate. Manage.</p>
        <p class="copy">Sign in with an authorized Science By Hugs administrator account.</p>
        <form id="login-form" class="login-form">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary wide" type="submit">Enter Core</button>
        </form>
        <p class="form-message" id="login-message">${escapeHtml(message)}</p>
      </div>
    </section>
  `)

  document.querySelector<HTMLFormElement>('#login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formElement = event.currentTarget as HTMLFormElement
    const form = new FormData(formElement)
    const email = String(form.get('email') || '').trim()
    const password = String(form.get('password') || '')
    const messageEl = document.querySelector<HTMLParagraphElement>('#login-message')
    const button = formElement.querySelector<HTMLButtonElement>('button[type="submit"]')

    if (messageEl) messageEl.textContent = 'Authenticating…'
    if (button) button.disabled = true

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      if (messageEl) messageEl.textContent = error.message
      if (button) button.disabled = false
    }
  })
}

function renderForbidden(email: string) {
  shell(`
    <section class="login-wrap">
      <div class="login-card">
        <span class="eyebrow">ACCESS CONTROL</span>
        <h2>Core access not assigned.</h2>
        <p class="copy"><strong>${escapeHtml(email)}</strong> is authenticated, but this account is not marked as a Core owner or administrator.</p>
      </div>
    </section>
  `, true)
}

function paymentPanel(invoice: CoreInvoice) {
  const directCheckout = invoice.status === 'direct_checkout'
  if (!invoice.order_id || (!directCheckout && invoice.send_status !== 'sent')) return ''

  const payment = invoice.payment
  const verified =
    payment?.status === 'verified' ||
    invoice.order?.payment_status === 'paid'

  const submitted =
    payment?.status === 'submitted' &&
    !verified

  if (verified) {
    return `
      <section class="payment-panel verified">
        <div class="payment-panel-head">
          <div>
            <span class="eyebrow">PAYMENT CONTROL</span>
            <h3>Payment verified</h3>
          </div>
          <span class="payment-badge paid">PAID</span>
        </div>
        <div class="payment-data">
          <div><span>Method</span><strong>${escapeHtml(payment?.provider || invoice.order?.payment_method || '—')}</strong></div>
          <div><span>Reference</span><strong>${escapeHtml(payment?.payment_reference || '—')}</strong></div>
          <div><span>Amount</span><strong>${money(payment?.amount || invoice.total)}</strong></div>
          <div><span>Verified</span><strong>${escapeHtml(dateTime(payment?.verified_at || payment?.paid_at || invoice.order?.paid_at))}</strong></div>
        </div>
        <p class="payment-note">Order moved to <strong>Processing</strong> after payment verification.</p>
      </section>
    `
  }

  if (submitted) {
    return `
      <section class="payment-panel submitted">
        <div class="payment-panel-head">
          <div>
            <span class="eyebrow">PAYMENT CONTROL</span>
            <h3>Payment submitted</h3>
          </div>
          <span class="payment-badge submitted">REVIEW</span>
        </div>
        <div class="payment-data">
          <div><span>Method</span><strong>${escapeHtml(payment?.provider || '—')}</strong></div>
          <div><span>Reference</span><strong>${escapeHtml(payment?.payment_reference || '—')}</strong></div>
          <div><span>Amount</span><strong>${money(payment?.amount || invoice.total)}</strong></div>
          <div><span>Submitted</span><strong>${escapeHtml(dateTime(payment?.submitted_at))}</strong></div>
        </div>
        ${payment?.notes ? `<p class="payment-note">${escapeHtml(payment.notes)}</p>` : ''}
        <button
          class="primary verify-payment-button"
          type="button"
          data-order-id="${escapeHtml(invoice.order_id)}"
          data-number="${escapeHtml(invoice.invoice_number)}"
        >
          Verify Payment & Start Processing
        </button>
      </section>
    `
  }

  return `
    <section class="payment-panel">
      <div class="payment-panel-head">
        <div>
          <span class="eyebrow">PAYMENT CONTROL</span>
          <h3>Waiting for payment</h3>
        </div>
        <span class="payment-badge">UNPAID</span>
      </div>
      <p class="payment-note">Record a payment only after you have a transaction or confirmation to reference. This does not move money.</p>
      <div class="payment-form-grid">
        <label>
          Method
          <select class="payment-provider">
            <option value="">Choose method</option>
            <option value="Zelle">Zelle</option>
            <option value="PayPal">PayPal</option>
            <option value="Venmo">Venmo</option>
          </select>
        </label>
        <label>
          Reference / confirmation
          <input class="payment-reference" type="text" maxlength="120" placeholder="Optional confirmation ID">
        </label>
        <label class="payment-notes-field">
          Notes
          <input class="payment-notes" type="text" maxlength="300" placeholder="Optional internal note">
        </label>
      </div>
      <button
        class="secondary record-payment-button"
        type="button"
        data-order-id="${escapeHtml(invoice.order_id)}"
      >
        Record Payment Submitted
      </button>
    </section>
  `
}

function fulfillmentPanel(invoice: CoreInvoice) {
  if (!invoice.order_id || invoice.order?.payment_status !== 'paid') return ''

  const status = invoice.order?.status || 'processing'
  const timestamp =
    status === 'ordered' ? invoice.order?.ordered_at :
    status === 'shipped' ? invoice.order?.shipped_at :
    status === 'delivered' ? invoice.order?.delivered_at :
    status === 'delayed' ? invoice.order?.delayed_at :
    status === 'cancelled' ? invoice.order?.cancelled_at :
    invoice.order?.paid_at

  const options: Record<string, Array<{ value: string; label: string }>> = {
    processing: [
      { value: 'ordered', label: 'Mark Ordered' },
      { value: 'delayed', label: 'Mark Delayed' },
      { value: 'cancelled', label: 'Cancel Order' },
    ],
    ordered: [
      { value: 'shipped', label: 'Mark Shipped' },
      { value: 'delayed', label: 'Mark Delayed' },
      { value: 'cancelled', label: 'Cancel Order' },
    ],
    shipped: [
      { value: 'delivered', label: 'Mark Delivered' },
      { value: 'delayed', label: 'Mark Delayed' },
    ],
    delayed: [
      { value: 'processing', label: 'Return to Processing' },
      { value: 'ordered', label: 'Return to Ordered' },
      { value: 'shipped', label: 'Return to Shipped' },
      { value: 'cancelled', label: 'Cancel Order' },
    ],
  }

  const terminal = status === 'delivered' || status === 'cancelled'
  const actionOptions = options[status] || []

  return `
    <section class="fulfillment-panel ${terminal ? 'terminal' : ''}">
      <div class="payment-panel-head">
        <div>
          <span class="eyebrow">FULFILLMENT CONTROL</span>
          <h3>${escapeHtml(status.replaceAll('_', ' '))}</h3>
        </div>
        <span class="fulfillment-badge ${escapeHtml(status)}">${escapeHtml(status.toUpperCase())}</span>
      </div>
      <p class="payment-note">
        Current stage${timestamp ? ` since <strong>${escapeHtml(dateTime(timestamp))}</strong>` : ''}.
        ${terminal ? 'This order is in a final fulfillment state.' : 'Choose the next operational state below.'}
      </p>
      ${deliveryEstimateEditor(invoice.order_id, invoice.order?.estimated_delivery_date, escapeHtml)}
      ${!terminal ? `
        <div class="fulfillment-controls">
          <select class="fulfillment-status">
            <option value="">Choose next status</option>
            ${actionOptions.map(option => `<option value="${option.value}">${option.label}</option>`).join('')}
          </select>
          <input class="fulfillment-note" type="text" maxlength="300" placeholder="Optional internal note">
          <button class="secondary fulfillment-button" type="button" data-order-id="${escapeHtml(invoice.order_id)}">
            Update Fulfillment
          </button>
        </div>
      ` : ''}
    </section>
  `
}

function invoiceCard(invoice: CoreInvoice) {
  const directCheckout = invoice.status === 'direct_checkout'
  const awaiting = invoice.status === 'awaiting_approval'
  const sent = invoice.status === 'sent' || invoice.send_status === 'sent'
  const ready =
    invoice.status === 'approved' &&
    invoice.pdf_status === 'created' &&
    !sent

  const paid =
    invoice.payment?.status === 'verified' ||
    invoice.order?.payment_status === 'paid'

  const itemRows = invoice.items
    .map(item => `
      <div class="line-item">
        <div>
          <strong>${escapeHtml(item.product_name)}</strong>
          <span>${escapeHtml(item.product_code || '')}</span>
        </div>
        <span>${item.quantity} × ${money(item.unit_price)}</span>
        <strong>${money(item.line_total)}</strong>
      </div>
    `)
    .join('')

  const fulfillmentLabel =
    invoice.order?.status && ['ordered', 'shipped', 'delivered', 'delayed', 'cancelled'].includes(invoice.order.status)
      ? invoice.order.status.replaceAll('_', ' ')
      : 'Paid · Processing'

  const statusText =
    awaiting
      ? 'Awaiting Approval'
      : paid
        ? fulfillmentLabel
        : directCheckout
          ? invoice.payment?.status === 'submitted'
            ? 'Payment Submitted'
            : 'Awaiting Payment'
          : sent
            ? 'Invoice Sent'
            : ready
              ? 'PDF Ready'
              : invoice.status

  return `
    <article class="invoice-card" data-invoice-id="${escapeHtml(invoice.id)}">
      <div class="invoice-top">
        <div>
          <span class="eyebrow">${directCheckout ? 'DIRECT CHECKOUT · ' : ''}${escapeHtml(invoice.invoice_number)}</span>
          <h2>${escapeHtml(invoice.customer_name_snapshot || 'Customer')}</h2>
          <p>${escapeHtml(invoice.customer_email_snapshot || '')}</p>
        </div>
        <span class="status-pill ${awaiting ? 'awaiting' : paid ? 'paid' : sent ? 'sent' : ready ? 'ready' : ''}">
          ${escapeHtml(statusText)}
        </span>
      </div>

      <div class="items">${itemRows || '<p class="muted">No item detail available.</p>'}</div>

      <div class="totals">
        <span>Subtotal <strong>${money(invoice.subtotal)}</strong></span>
        <span>Shipping <strong>${money(invoice.shipping_total)}</strong></span>
        <span>Tax <strong>${money(invoice.tax_total)}</strong></span>
        <span class="grand">Total <strong>${money(invoice.total)}</strong></span>
      </div>

      ${ready ? `
        <div class="send-preview">
          <span class="eyebrow">READY TO SEND</span>
          <p>The approved PDF will be emailed to <strong>${escapeHtml(invoice.customer_email_snapshot || '')}</strong> from <strong>admin@sciencebyhugs.com</strong>.</p>
          <p class="muted">Sending is separate from approval and requires confirmation.</p>
        </div>
      ` : ''}

      ${sent ? `
        <div class="send-preview sent-preview">
          <span class="eyebrow">DELIVERED BY EMAIL</span>
          <p>Sent to <strong>${escapeHtml(invoice.sent_to || invoice.customer_email_snapshot || '')}</strong>${invoice.sent_at ? ` on ${escapeHtml(dateTime(invoice.sent_at))}` : ''}.</p>
        </div>
      ` : ''}

      ${paymentPanel(invoice)}
      ${fulfillmentPanel(invoice)}

      <div class="invoice-actions">
        ${invoice.google_sheet_url ? `<a class="button secondary" href="${escapeHtml(invoice.google_sheet_url)}" target="_blank" rel="noreferrer">Open Sheet</a>` : ''}
        ${invoice.pdf_url ? `<a class="button secondary" href="${escapeHtml(invoice.pdf_url)}" target="_blank" rel="noreferrer">Open PDF</a>` : ''}
      </div>
      <p class="card-message" aria-live="polite"></p>
    </article>
  `
}

type OperationsQueue = 'attention' | 'approval' | 'payment' | 'fulfillment' | 'all'

const OPERATIONS_QUEUE_KEY = 'sciencebyhugs-core:operations-queue'
const OPERATIONS_QUEUES: OperationsQueue[] = ['attention', 'approval', 'payment', 'fulfillment', 'all']

function resolveOperationsQueue(): OperationsQueue {
  try {
    const stored = sessionStorage.getItem(OPERATIONS_QUEUE_KEY) as OperationsQueue | null
    if (stored && OPERATIONS_QUEUES.includes(stored)) return stored
  } catch {
    // Fall back to the default queue when session storage is unavailable.
  }

  return 'attention'
}

function rememberOperationsQueue(queue: OperationsQueue) {
  try {
    sessionStorage.setItem(OPERATIONS_QUEUE_KEY, queue)
  } catch {
    // Queue persistence is a convenience; the UI still works without storage.
  }
}

async function renderOperations(email: string) {
  let activeQueue = resolveOperationsQueue()

  shell(`
    <section class="dashboard-head dashboard-head-compact">
      <div>
        <span class="eyebrow">OPERATIONS</span>
        <h1 class="dashboard-title">Fulfillment</h1>
        <p class="copy">Work the live queue: invoices, payments, and fulfillment from one operational workspace.</p>
      </div>
      <div class="operator">Signed in as <strong>${escapeHtml(email)}</strong></div>
    </section>
    <section class="stats operations-stats" id="stats"></section>
    <section class="operations-controls" id="operations-controls" aria-label="Operations queue controls">
      <div class="operations-controls-bar">
        <div class="operations-controls-label">
          <span class="eyebrow">WORK QUEUE</span>
          <strong id="operations-current-queue">${activeQueue === 'attention' ? 'Priority' : activeQueue === 'approval' ? 'Invoices' : activeQueue === 'payment' ? 'Payments' : activeQueue === 'fulfillment' ? 'Fulfillment' : 'All activity'}</strong>
        </div>
        <button class="operations-controls-toggle" id="operations-controls-toggle" type="button" aria-expanded="true" aria-controls="operations-controls-body">
          <span class="operations-controls-toggle-icon" aria-hidden="true">☰</span>
          <span class="operations-controls-toggle-text">Hide</span>
        </button>
      </div>
      <div class="operations-controls-body" id="operations-controls-body">
        <div class="operations-controls-top">
          <div>
            <h2>What do you need to work?</h2>
          </div>
          <label class="queue-search operations-search">
            <span class="sr-only">Search operations</span>
            <input id="queue-search" type="search" placeholder="Search customer, invoice, order…" autocomplete="off">
          </label>
        </div>
        <div class="queue-tabs operations-tabs" id="queue-tabs">
          <button class="queue-tab ${activeQueue === 'attention' ? 'active' : ''}" type="button" data-queue="attention">Priority</button>
          <button class="queue-tab ${activeQueue === 'approval' ? 'active' : ''}" type="button" data-queue="approval">Invoices</button>
          <button class="queue-tab ${activeQueue === 'payment' ? 'active' : ''}" type="button" data-queue="payment">Payments</button>
          <button class="queue-tab ${activeQueue === 'fulfillment' ? 'active' : ''}" type="button" data-queue="fulfillment">Fulfillment</button>
          <button class="queue-tab ${activeQueue === 'all' ? 'active' : ''}" type="button" data-queue="all">All activity</button>
        </div>
        <p class="queue-summary" id="queue-summary" aria-live="polite"></p>
      </div>
    </section>
    <section class="invoice-list" id="invoice-list">
      <div class="loading">Loading operations…</div>
    </section>
  `, true)

  const controls = document.querySelector<HTMLElement>('#operations-controls')
  const controlsBody = document.querySelector<HTMLElement>('#operations-controls-body')
  const controlsToggle = document.querySelector<HTMLButtonElement>('#operations-controls-toggle')
  const controlsToggleText = controlsToggle?.querySelector<HTMLElement>('.operations-controls-toggle-text')
  const currentQueueLabel = document.querySelector<HTMLElement>('#operations-current-queue')
  const controlsStorageKey = 'sciencebyhugs-core:operations-controls-collapsed'

  const queueDisplayLabel = (queue: OperationsQueue) =>
    queue === 'attention' ? 'Priority' :
    queue === 'approval' ? 'Invoices' :
    queue === 'payment' ? 'Payments' :
    queue === 'fulfillment' ? 'Fulfillment' :
    'All activity'

  const setControlsCollapsed = (collapsed: boolean) => {
    controls?.classList.toggle('collapsed', collapsed)
    if (controlsBody) controlsBody.hidden = collapsed
    controlsToggle?.setAttribute('aria-expanded', String(!collapsed))
    if (controlsToggleText) controlsToggleText.textContent = collapsed ? 'Show' : 'Hide'
    try {
      sessionStorage.setItem(controlsStorageKey, collapsed ? '1' : '0')
    } catch {
      // Collapsing the queue controls remains functional even without storage.
    }
  }

  let controlsCollapsed = window.matchMedia('(max-width: 760px)').matches
  try {
    const storedControlsState = sessionStorage.getItem(controlsStorageKey)
    if (storedControlsState !== null) controlsCollapsed = storedControlsState === '1'
  } catch {
    // Use the responsive default if storage is unavailable.
  }

  setControlsCollapsed(controlsCollapsed)
  controlsToggle?.addEventListener('click', () => {
    setControlsCollapsed(!controls?.classList.contains('collapsed'))
  })

  try {
    const invoices = await listCoreInvoices()

    const waiting = invoices.filter(invoice => invoice.status === 'awaiting_approval')
    const ready = invoices.filter(invoice =>
      invoice.status === 'approved' &&
      invoice.pdf_status === 'created' &&
      invoice.send_status !== 'sent'
    )
    const paymentSubmitted = invoices.filter(invoice =>
      invoice.payment?.status === 'submitted'
    )
    const paid = invoices.filter(invoice =>
      invoice.payment?.status === 'verified' ||
      invoice.order?.payment_status === 'paid'
    )

    const visible = invoices.slice(0, 50)
    const invoiceById = new Map(visible.map(invoice => [invoice.id, invoice]))

    const stats = document.querySelector<HTMLDivElement>('#stats')
    if (stats) {
      stats.innerHTML = `
        <div><span>Needs approval</span><strong>${waiting.length}</strong><small>Invoices waiting</small></div>
        <div><span>Ready to send</span><strong>${ready.length}</strong><small>Approved PDFs</small></div>
        <div><span>Payments to verify</span><strong>${paymentSubmitted.length}</strong><small>Submitted payments</small></div>
        <div><span>Paid orders</span><strong>${paid.length}</strong><small>Recorded paid</small></div>
      `
    }

    const list = document.querySelector<HTMLDivElement>('#invoice-list')
    if (list) {
      list.innerHTML = visible.length
        ? visible.map(invoiceCard).join('')
        : '<div class="empty-state"><h2>Queue clear.</h2><p>No operations are available.</p></div>'
    }

    let searchTerm = ''

    const matchesQueue = (invoice: CoreInvoice, queue: string) => {
      const awaitingApproval = invoice.status === 'awaiting_approval'
      const readyToSend =
        invoice.status === 'approved' &&
        invoice.pdf_status === 'created' &&
        invoice.send_status !== 'sent'
      const submittedPayment = invoice.payment?.status === 'submitted'
      const isPaid =
        invoice.payment?.status === 'verified' ||
        invoice.order?.payment_status === 'paid'
      const fulfillmentStatus = invoice.order?.status || ''
      const delayed = fulfillmentStatus === 'delayed'
      const activeFulfillment =
        isPaid &&
        fulfillmentStatus !== 'delivered' &&
        fulfillmentStatus !== 'cancelled'

      if (queue === 'approval') return awaitingApproval || readyToSend
      if (queue === 'payment') {
        return submittedPayment || (
          invoice.status === 'direct_checkout' &&
          !isPaid
        )
      }
      if (queue === 'fulfillment') return activeFulfillment
      if (queue === 'attention') {
        return awaitingApproval || readyToSend || submittedPayment || delayed
      }
      return true
    }

    const matchesSearch = (invoice: CoreInvoice, term: string) => {
      if (!term) return true
      const haystack = [
        invoice.invoice_number,
        invoice.customer_name_snapshot,
        invoice.customer_email_snapshot,
        invoice.customer_phone_snapshot,
        invoice.order?.order_number,
        invoice.order?.status,
        invoice.payment?.provider,
        invoice.payment?.payment_reference,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(term)
    }

    const applyQueueView = () => {
      let shown = 0
      document.querySelectorAll<HTMLElement>('.invoice-card').forEach(card => {
        const invoice = invoiceById.get(card.dataset.invoiceId || '')
        const show = Boolean(
          invoice &&
          matchesQueue(invoice, activeQueue) &&
          matchesSearch(invoice, searchTerm),
        )
        card.hidden = !show
        if (show) shown += 1
      })

      const summary = document.querySelector<HTMLParagraphElement>('#queue-summary')
      if (summary) {
        const label =
          activeQueue === 'attention' ? 'needs attention' :
          activeQueue === 'approval' ? 'invoice actions' :
          activeQueue === 'payment' ? 'payment actions' :
          activeQueue === 'fulfillment' ? 'fulfillment actions' :
          'operations'
        summary.textContent = `${shown} ${label}${searchTerm ? ' matching your search' : ''}.`
      }

      const empty = document.querySelector<HTMLElement>('#filtered-empty-state')
      if (shown === 0 && visible.length) {
        if (!empty && list) {
          list.insertAdjacentHTML(
            'beforeend',
            '<div class="empty-state" id="filtered-empty-state"><h2>Nothing in this view.</h2><p>Try another queue or clear the search.</p></div>',
          )
        }
      } else {
        empty?.remove()
      }
    }

    document.querySelectorAll<HTMLButtonElement>('.queue-tab').forEach(button => {
      button.addEventListener('click', () => {
        const nextQueue = button.dataset.queue as OperationsQueue | undefined
        activeQueue = nextQueue && OPERATIONS_QUEUES.includes(nextQueue) ? nextQueue : 'attention'
        rememberOperationsQueue(activeQueue)
        document.querySelectorAll('.queue-tab').forEach(tab => tab.classList.remove('active'))
        button.classList.add('active')
        if (currentQueueLabel) currentQueueLabel.textContent = queueDisplayLabel(activeQueue)
        applyQueueView()
      })
    })

    document.querySelector<HTMLInputElement>('#queue-search')?.addEventListener('input', event => {
      searchTerm = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase()
      applyQueueView()
    })

    applyQueueView()

    document.querySelectorAll<HTMLButtonElement>('.record-payment-button').forEach(button => {
      button.addEventListener('click', async () => {
        const orderId = button.dataset.orderId
        const panel = button.closest<HTMLElement>('.payment-panel')
        const provider = panel?.querySelector<HTMLSelectElement>('.payment-provider')?.value || ''
        const reference = panel?.querySelector<HTMLInputElement>('.payment-reference')?.value.trim() || ''
        const notes = panel?.querySelector<HTMLInputElement>('.payment-notes')?.value.trim() || ''
        const message = button.closest<HTMLElement>('.invoice-card')
          ?.querySelector<HTMLParagraphElement>('.card-message')

        if (!orderId) return

        if (!provider) {
          if (message) message.textContent = 'Choose a payment method first.'
          return
        }

        button.disabled = true
        button.textContent = 'Recording…'
        if (message) message.textContent = 'Recording payment submission…'

        try {
          await recordPayment(orderId, provider, reference, notes)
          await renderOperations(email)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Payment recording failed'
          button.disabled = false
          button.textContent = 'Record Payment Submitted'
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.verify-payment-button').forEach(button => {
      button.addEventListener('click', async () => {
        const orderId = button.dataset.orderId
        const invoiceNumber = button.dataset.number || 'this invoice'
        if (!orderId) return

        const confirmed = window.confirm(
          `Verify payment for ${invoiceNumber}?\n\nThis marks the order PAID and moves it to PROCESSING. Only continue after you have independently confirmed the payment.`
        )
        if (!confirmed) return

        const message = button.closest<HTMLElement>('.invoice-card')
          ?.querySelector<HTMLParagraphElement>('.card-message')

        button.disabled = true
        button.textContent = 'Verifying…'
        if (message) message.textContent = 'Verifying payment and moving the order to processing…'

        try {
          await verifyPayment(orderId)
          await renderOperations(email)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Payment verification failed'
          button.disabled = false
          button.textContent = 'Verify Payment & Start Processing'
        }
      })
    })

    bindDeliveryEstimateEditors()

    document.querySelectorAll<HTMLButtonElement>('.fulfillment-button').forEach(button => {
      button.addEventListener('click', async () => {
        const orderId = button.dataset.orderId
        const panel = button.closest<HTMLElement>('.fulfillment-panel')
        const status = panel?.querySelector<HTMLSelectElement>('.fulfillment-status')?.value || ''
        const note = panel?.querySelector<HTMLInputElement>('.fulfillment-note')?.value.trim() || ''
        const message = button.closest<HTMLElement>('.invoice-card')
          ?.querySelector<HTMLParagraphElement>('.card-message')

        if (!orderId || !status) {
          if (message) message.textContent = 'Choose the next fulfillment status.'
          return
        }

        const highImpact = status === 'delivered' || status === 'cancelled'
        if (highImpact) {
          const confirmed = window.confirm(
            `Move this order to ${status.toUpperCase()}?\n\nThis is a major fulfillment status change.`
          )
          if (!confirmed) return
        }

        button.disabled = true
        button.textContent = 'Updating…'
        if (message) message.textContent = `Updating order to ${status}…`

        try {
          await updateFulfillment(
            orderId,
            status as 'ordered' | 'shipped' | 'delivered' | 'delayed' | 'cancelled' | 'processing',
            note,
          )
          await renderOperations(email)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Fulfillment update failed'
          button.disabled = false
          button.textContent = 'Update Fulfillment'
        }
      })
    })
  } catch (error) {
    const list = document.querySelector<HTMLDivElement>('#invoice-list')
    if (list) {
      list.innerHTML = `
        <div class="empty-state error-state">
          <h2>Could not load Core.</h2>
          <p>${escapeHtml(error instanceof Error ? error.message : 'Unknown error')}</p>
        </div>
      `
    }
  }
}

async function renderOrders(email: string) {
  shell(ordersPageMarkup(email, escapeHtml), true)
  await bindOrdersPage({ escapeHtml, money, dateTime })
}

async function renderCheckoutPending(email: string) {
  shell(checkoutPendingPageMarkup(email, escapeHtml), true)
  await bindCheckoutPendingPage({ escapeHtml, money, dateTime })
}

async function renderCustomers(email: string) {
  shell(customersPageMarkup(email, escapeHtml), true)
  await bindCustomersPage({ escapeHtml, money, dateTime }, () => renderCustomers(email))
}

async function renderCatalog(email: string) {
  shell(catalogPageMarkup(email, escapeHtml), true)
  await bindCatalogPage({ escapeHtml, money, dateTime })
}

async function renderExecutiveDashboard(email: string) {
  shell(dashboardPageMarkup(email, escapeHtml), true)
  await bindDashboardPage({ escapeHtml, money, dateTime })
}

async function renderAnalytics(email: string) {
  shell(analyticsPageMarkup(email, escapeHtml), true)
  await bindAnalyticsPage({ escapeHtml, money, dateTime })
}

async function renderFinance(email: string) {
  shell(financePageMarkup(email, escapeHtml), true)
  await bindFinancePage({ escapeHtml, money, dateTime })
}

async function renderReferrals(email: string) {
  shell(referralsPageMarkup(email, escapeHtml), true)
  await bindReferralsPage({ escapeHtml, dateTime })
}

async function renderAdminTools(email: string) {
  shell(adminToolsPageMarkup(email, escapeHtml), true)
  await bindAdminToolsPage({ escapeHtml })
}

async function renderNotifications(email: string) {
  shell(notificationsPageMarkup(email, escapeHtml), true)
  await bindNotificationsPage({ escapeHtml, dateTime })
}

async function renderAudit(email: string) {
  shell(auditPageMarkup(email, escapeHtml), true)
  await bindAuditPage({ escapeHtml, dateTime })
}

async function render() {
  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession()

    if (sessionError) throw sessionError

    if (!session?.user) {
      renderLogin()
      return
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError) throw userError

    if (!user) {
      renderLogin('Your session could not be verified. Please sign in again.')
      return
    }

    const role = roleFor(user)
  if (!isAdminRole(role)) {
    renderForbidden(user.email || 'Signed-in account')
    return
  }

  const email = user.email || 'Core operator'
  const activeView = accountRecovery ? 'account' : resolveCoreView()
  keepCoreViewInUrl(activeView)

  if (activeView === 'account') {
    shell(accountScreen(email,accountRecovery),true)
    await bindAccount(email,accountRecovery,()=>{accountRecovery=false;location.hash='dashboard'})
    return
  }

  if (activeView === 'more') {
    shell(moreScreen(email), true)
    return
  }

  if (activeView === 'operations') {
    await renderOperations(email)
    return
  }

  if (activeView === 'orders') {
    await renderOrders(email)
    return
  }

  if (activeView === 'checkout-pending') {
    await renderCheckoutPending(email)
    return
  }

  if (activeView === 'customers') {
    await renderCustomers(email)
    return
  }

  if (activeView === 'catalog') {
    await renderCatalog(email)
    return
  }

  if (activeView === 'analytics') {
    await renderAnalytics(email)
    return
  }

  if (activeView === 'finance') {
    await renderFinance(email)
    return
  }

  if (activeView === 'referrals') {
    await renderReferrals(email)
    return
  }

  if (activeView === 'admin-tools') {
    await renderAdminTools(email)
    return
  }

  if (activeView === 'notifications') {
    await renderNotifications(email)
    return
  }

  if (activeView === 'audit') {
    await renderAudit(email)
    return
  }

  await renderExecutiveDashboard(email)
  } catch (error) {
    console.error('Core startup failed', error)
    renderLogin(
      error instanceof Error
        ? 'Core could not verify your session: ' + error.message
        : 'Core could not verify your session. Please sign in again.',
    )
  }
}

supabase.auth.onAuthStateChange((event) => {
  if(event === 'PASSWORD_RECOVERY'){accountRecovery=true;void render();return}
  if(event === 'SIGNED_OUT') accountRecovery=false
  if (accountMutationInProgress && event !== 'SIGNED_OUT') return
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
    void render()
  }
})

window.addEventListener('hashchange', () => void render())

function enablePwaAutoRefresh() {
  if (!('serviceWorker' in navigator)) return

  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller)
  let reloadingForUpdate = false
  let lastUpdateCheck = 0

  const checkForUpdate = async () => {
    const now = Date.now()
    if (now - lastUpdateCheck < 15_000) return
    lastUpdateCheck = now

    try {
      const registration = await navigator.serviceWorker.getRegistration()
      await registration?.update()
    } catch (error) {
      console.warn('PWA update check failed', error)
    }
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerAtBoot || reloadingForUpdate) return
    reloadingForUpdate = true
    window.location.reload()
  })

  window.addEventListener('load', () => void checkForUpdate())
  window.addEventListener('pageshow', () => void checkForUpdate())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  })
}

enablePwaAutoRefresh()

// Always paint a usable screen immediately. Fresh sessions should never wait on
// a remote auth request before the login UI appears.
renderLogin()
void render()
