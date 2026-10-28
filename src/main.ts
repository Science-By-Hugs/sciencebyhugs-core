import { avatarMarkup, bindAvatars } from './avatar'
import { disablePush, bindPushPanel, pushPrompt } from './push'
import { accountScreen, bindAccount, accountMutationInProgress } from './account-view'
import './styles.css'
import './brand.css'
import { supabase } from './services/supabase'
import { bindOrdersHub, ordersHubMarkup, presetOrdersFilter } from './orders-hub'
import { bindCustomersPage, customersPageMarkup } from './customers-view'
import { bindCatalogPage, catalogPageMarkup } from './catalog-view'
import { bindDashboardPage, dashboardPageMarkup } from './dashboard-view'
import { bindAuditPage, auditPageMarkup } from './audit-view'
import { bindAnalyticsPage, analyticsPageMarkup } from './analytics-view'
import { bindFinancePage, financePageMarkup } from './finance-view'
import { bindReferralsPage, referralsPageMarkup } from './referrals-view'
import { bindAdminToolsPage, adminToolsPageMarkup } from './admin-tools-view'
import { bindNotificationsPage, notificationsPageMarkup } from './notifications-view'
import './slate.css' // loaded last: 2026-10-28 slate redesign

const appRoot = document.querySelector<HTMLDivElement>('#app')
if (!appRoot) throw new Error('App root not found')
const app = appRoot
let accountRecovery = false
const coreIconUrl = `${import.meta.env.BASE_URL}brand/core-app-icon.svg`

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
  ['customers', 'Customers', 'customers'],
  ['catalog', 'Catalog', 'catalog'],
  ['finance', 'Finance', 'finance'],
]
const MORE_NAV: Array<[CoreView, string]> = [
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
  const links: Array<[CoreView, string]> = [['finance', 'Finance'], ...MORE_NAV.filter(([v]) => v !== 'account')]
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
        <img class="core-login-icon" src="${coreIconUrl}" alt="" width="64" height="64" />
        <h1 class="login-title">core<span>.</span></h1>
        <p class="copy">Sign in with your Science By Hugs administrator account.</p>
        <form id="login-form" class="login-form">
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="primary wide" type="submit">Sign in</button>
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

async function renderOrders(_email: string) {
  shell(ordersHubMarkup(), true)
  await bindOrdersHub({ escapeHtml, money, dateTime })
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
  let activeView = accountRecovery ? 'account' : resolveCoreView()
  if (activeView === 'operations' || activeView === 'checkout-pending') {
    // Fulfillment and Checkout Pending are now filters on the one Orders page.
    presetOrdersFilter(activeView === 'operations' ? 'action' : 'unpaid')
    activeView = 'orders'
    rememberCoreView('orders')
  }
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

  if (activeView === 'orders') {
    await renderOrders(email)
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
