import { pushPanel, bindPushPanel } from './push'
import { loadCoreNotifications, loadNexusPushRecipients, sendNexusPush } from './services/notifications'
import { nexusOnboardingPanelMarkup, bindNexusOnboardingPanel } from './nexus-onboarding-view'

type Helpers = {
  escapeHtml: (value: unknown) => string
  dateTime: (value: string | null | undefined) => string
}

export function notificationsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">ATTENTION CENTER</span><h1 class="dashboard-title">Notifications</h1>' +
    '<p class="copy">A read-only queue of operational signals that need review across payments, fulfillment, invoices, catalog, accounts, and referrals.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    pushPanel() +
    '<section class="notification-panel nexus-push-composer" aria-labelledby="nexus-push-title">' +
      '<div class="dashboard-section-head"><div><span class="eyebrow">NEXUS MESSAGING</span><h2 id="nexus-push-title">Send Nexus Notification</h2>' +
      '<p class="copy">Send a custom push notification to all eligible Nexus users or one selected customer.</p></div></div>' +
      '<div class="nexus-push-grid">' +
        '<label><span>Audience</span><select id="nexus-push-mode"><option value="all">All Nexus users with push enabled</option><option value="individual">Individual customer</option></select></label>' +
        '<label id="nexus-push-customer-wrap" hidden><span>Customer</span><select id="nexus-push-customer"><option value="">Choose a customer…</option></select></label>' +
        '<label><span>Title</span><input id="nexus-push-title-input" maxlength="80" value="NEXUS · Science By Hugs"></label>' +
        '<label class="nexus-push-message"><span>Message</span><textarea id="nexus-push-message" maxlength="240" placeholder="Type the notification message…"></textarea><small><span id="nexus-push-count">0</span>/240</small></label>' +
      '</div>' +
      '<div class="nexus-push-actions"><p id="nexus-push-status" class="form-message" aria-live="polite">Loading eligible Nexus recipients…</p>' +
      '<button id="nexus-push-send" class="primary" type="button" disabled>Send Notification</button></div>' +
    '</section>' +
    nexusOnboardingPanelMarkup() +
    '<section id="notifications-root"><div class="loading">Loading notifications…</div></section>'
}

export async function bindNotificationsPage(helpers: Helpers) {
  void bindPushPanel()
  void bindNexusOnboardingPanel(helpers)

  const mode = document.querySelector<HTMLSelectElement>('#nexus-push-mode')
  const customerWrap = document.querySelector<HTMLElement>('#nexus-push-customer-wrap')
  const customerSelect = document.querySelector<HTMLSelectElement>('#nexus-push-customer')
  const titleInput = document.querySelector<HTMLInputElement>('#nexus-push-title-input')
  const messageInput = document.querySelector<HTMLTextAreaElement>('#nexus-push-message')
  const count = document.querySelector<HTMLElement>('#nexus-push-count')
  const sendButton = document.querySelector<HTMLButtonElement>('#nexus-push-send')
  const pushStatus = document.querySelector<HTMLParagraphElement>('#nexus-push-status')

  const syncMode = () => {
    if (customerWrap && mode) customerWrap.hidden = mode.value !== 'individual'
  }
  mode?.addEventListener('change', syncMode)
  syncMode()
  messageInput?.addEventListener('input', () => {
    if (count) count.textContent = String(messageInput.value.length)
  })

  if (customerSelect && sendButton && pushStatus) {
    try {
      const data = await loadNexusPushRecipients()
      customerSelect.insertAdjacentHTML('beforeend', data.recipients.map(recipient => {
        const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || recipient.email
        const label = (recipient.customerNumber ? recipient.customerNumber + ' · ' : '') + name +
          (recipient.pushEnabled ? ' · Push enabled' : ' · Push not enabled')
        return '<option value="' + helpers.escapeHtml(recipient.id) + '"' +
          (recipient.pushEnabled ? '' : ' disabled') + '>' + helpers.escapeHtml(label) + '</option>'
      }).join(''))
      pushStatus.textContent = data.subscribedCount + ' Nexus user' + (data.subscribedCount === 1 ? '' : 's') + ' currently have push enabled.'
      sendButton.disabled = data.subscribedCount === 0
    } catch (error) {
      pushStatus.textContent = error instanceof Error ? error.message : 'Could not load Nexus recipients.'
    }

    sendButton.addEventListener('click', async () => {
      const sendMode = mode?.value === 'individual' ? 'individual' : 'all'
      const customerId = customerSelect.value
      const title = titleInput?.value.trim() || ''
      const message = messageInput?.value.trim() || ''

      if (!title || !message) {
        pushStatus.textContent = 'Enter both a title and message.'
        return
      }
      if (sendMode === 'individual' && !customerId) {
        pushStatus.textContent = 'Choose a customer first.'
        return
      }

      const audience = sendMode === 'all'
        ? 'all Nexus users who currently have push notifications enabled'
        : customerSelect.options[customerSelect.selectedIndex]?.text || 'this customer'
      if (!window.confirm('Send this push notification to ' + audience + '?')) return

      sendButton.disabled = true
      sendButton.textContent = 'Queuing…'
      pushStatus.textContent = 'Queuing Nexus notification…'
      try {
        const result = await sendNexusPush({ mode: sendMode, customerId, title, message })
        pushStatus.textContent = 'Queued for ' + result.queued + ' recipient' + (result.queued === 1 ? '' : 's') + '. Delivery will begin shortly.'
        if (messageInput) messageInput.value = ''
        if (count) count.textContent = '0'
      } catch (error) {
        pushStatus.textContent = error instanceof Error ? error.message : 'Could not send Nexus notification.'
      } finally {
        sendButton.disabled = false
        sendButton.textContent = 'Send Notification'
      }
    })
  }
  const root = document.querySelector<HTMLDivElement>('#notifications-root')
  if (!root) return

  try {
    const data = await loadCoreNotifications()
    const s = data.summary
    root.innerHTML =
      '<section class="notification-kpis">' +
        '<div><span>Total</span><strong>' + s.total + '</strong></div>' +
        '<div><span>Critical</span><strong>' + s.critical + '</strong></div>' +
        '<div><span>Warning</span><strong>' + s.warning + '</strong></div>' +
        '<div><span>Info</span><strong>' + s.info + '</strong></div>' +
      '</section>' +
      '<section class="notification-panel">' +
        '<div class="dashboard-section-head"><div><span class="eyebrow">CURRENT SIGNALS</span><h2>' +
          (s.total ? s.total + ' items need review' : 'Queue clear') + '</h2></div></div>' +
        (data.notifications.length
          ? '<div class="notification-list">' + data.notifications.map(item =>
              '<a class="notification-row ' + helpers.escapeHtml(item.severity) + '" href="' + helpers.escapeHtml(item.href) + '">' +
                '<b>' + helpers.escapeHtml(item.severity.toUpperCase()) + '</b>' +
                '<span><strong>' + helpers.escapeHtml(item.title) + '</strong><small>' +
                  helpers.escapeHtml(item.category) + ' · ' + helpers.escapeHtml(item.detail) + '</small></span>' +
                '<time>' + helpers.escapeHtml(helpers.dateTime(item.created_at)) + '</time>' +
                '<i>Open →</i>' +
              '</a>'
            ).join('') + '</div>'
          : '<div class="empty-state compact"><strong>No active operational alerts.</strong></div>') +
      '</section>' +
      '<p class="dashboard-generated">Notifications generated ' + helpers.escapeHtml(helpers.dateTime(data.generated_at)) + '</p>'
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load notifications.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
