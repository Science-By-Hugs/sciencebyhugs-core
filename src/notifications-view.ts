import { pushPanel, bindPushPanel } from './push'
import { loadCoreNotifications, loadNexusPushRecipients, sendNexusPush } from './services/notifications'
import { nexusOnboardingPanelMarkup, bindNexusOnboardingPanel } from './nexus-onboarding-view'

type Helpers = {
  escapeHtml: (value: unknown) => string
  dateTime: (value: string | null | undefined) => string
}

export function notificationsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">CORE COMMUNICATIONS</span><h1 class="dashboard-title">Messages &amp; alerts</h1>' +
    '<p class="copy">Review what needs attention, then manage customer messages and device alerts.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +

    '<section id="notifications-root" aria-label="Core operational alerts">' +
      '<div class="loading">Checking operational alerts…</div></section>' +

    '<section class="comms-workspace-heading" aria-labelledby="comms-actions-title">' +
      '<h2 id="comms-actions-title">Communication tools</h2>' +
      '<p>Customer messages are never sent automatically from this screen.</p>' +
    '</section>' +

    '<details class="comms-disclosure" id="comms-customer-messaging">' +
      '<summary><span><strong>Send a Nexus notification</strong>' +
        '<small>Choose a recipient, preview the message, then confirm</small></span>' +
        '<span class="comms-summary-tag">Manual send</span></summary>' +
      '<div class="comms-disclosure-body">' +
        '<section class="notification-panel nexus-push-composer" aria-labelledby="nexus-push-title">' +
          '<div class="dashboard-section-head"><div><span class="eyebrow">NEXUS MESSAGING</span>' +
            '<h2 id="nexus-push-title">Customer notification</h2>' +
            '<p class="copy">Only Nexus users who enabled push can receive this message. Select the audience carefully.</p>' +
          '</div></div>' +
          '<div class="nexus-push-grid">' +
            '<label><span>Audience</span><select id="nexus-push-mode">' +
              '<option value="individual" selected>One customer</option>' +
              '<option value="all">All Nexus users with push enabled</option></select></label>' +
            '<label id="nexus-push-customer-wrap"><span>Customer</span>' +
              '<select id="nexus-push-customer"><option value="">Choose a customer…</option></select></label>' +
            '<label><span>Title</span><input id="nexus-push-title-input" maxlength="80" value="NEXUS · Science By Hugs"></label>' +
            '<label class="nexus-push-message"><span>Message</span><textarea id="nexus-push-message" maxlength="240" ' +
              'placeholder="Write a clear notification for your customer…"></textarea>' +
              '<small><span id="nexus-push-count">0</span>/240</small></label>' +
          '</div>' +
          '<div class="comms-preview" aria-label="Notification preview">' +
            '<span class="comms-preview-kicker">PREVIEW · NOT SENT</span>' +
            '<strong id="nexus-push-preview-title">NEXUS · Science By Hugs</strong>' +
            '<p id="nexus-push-preview-message">Your message will appear here before you send it.</p>' +
            '<small id="nexus-push-preview-audience">Choose an eligible customer to continue.</small>' +
          '</div>' +
          '<div class="nexus-push-actions"><p id="nexus-push-status" class="form-message" aria-live="polite">' +
            'Loading eligible Nexus recipients…</p>' +
            '<button id="nexus-push-send" class="primary" type="button" disabled>Review &amp; send</button></div>' +
        '</section>' +
      '</div></details>' +

    '<details class="comms-disclosure" id="comms-my-notifications">' +
      '<summary><span><strong>Notifications on this device</strong>' +
        '<small>Control alerts sent to the device you are using</small></span></summary>' +
      '<div class="comms-disclosure-body">' + pushPanel() + '</div></details>' +

    '<details class="comms-disclosure" id="comms-adoption">' +
      '<summary><span><strong>Nexus customer onboarding</strong>' +
        '<small>See customer adoption and beta invitation activity</small></span></summary>' +
      '<div class="comms-disclosure-body">' + nexusOnboardingPanelMarkup() + '</div></details>'
}

async function renderOperationalAlerts(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#notifications-root')
  if (!root) return
  try {
    const data = await loadCoreNotifications()
    if (!root.isConnected) return
    const s = data.summary
    const urgent = s.critical > 0
      ? {title: s.critical + ' critical alert' + (s.critical === 1 ? '' : 's') + ' need attention',
         text: 'Review critical operational issues before sending customer messages.'}
      : s.warning > 0
        ? {title: s.warning + ' warning' + (s.warning === 1 ? '' : 's') + ' to review',
           text: 'Check warning details and follow the relevant Core workflow.'}
        : {title: 'No urgent operational alerts',
           text: s.info > 0 ? 'Informational updates are listed below.' : 'Your current operations queue is clear.'}
    root.innerHTML =
      '<section class="comms-alert-priority" aria-labelledby="comms-alert-title">' +
        '<span class="comms-kicker">CORE · NEEDS ATTENTION</span>' +
        '<h2 id="comms-alert-title">' + helpers.escapeHtml(urgent.title) + '</h2>' +
        '<p>' + helpers.escapeHtml(urgent.text) + '</p></section>' +
      '<section class="notification-kpis comms-kpis" aria-label="Alert counts">' +
        '<div><span>Total alerts</span><strong>' + s.total + '</strong></div>' +
        '<div><span>Critical</span><strong>' + s.critical + '</strong></div>' +
        '<div><span>Warning</span><strong>' + s.warning + '</strong></div>' +
        '<div><span>Info</span><strong>' + s.info + '</strong></div>' +
      '</section>' +
      '<section class="notification-panel comms-alert-panel">' +
        '<div class="comms-section-head"><h2>Operational alerts</h2><small id="comms-alert-visible">' +
          data.notifications.length + ' of ' + data.notifications.length + ' shown</small></div>' +
        '<div class="comms-alert-filter" role="group" aria-label="Filter operational alerts">' +
          '<button type="button" data-alert-filter="all" aria-pressed="true">All</button>' +
          '<button type="button" data-alert-filter="critical" aria-pressed="false">Critical</button>' +
          '<button type="button" data-alert-filter="warning" aria-pressed="false">Warning</button>' +
          '<button type="button" data-alert-filter="info" aria-pressed="false">Info</button>' +
        '</div>' +
        (data.notifications.length
          ? '<div class="notification-list">' + data.notifications.map(item =>
              '<a class="notification-row ' + helpers.escapeHtml(item.severity) +
                '" data-alert-severity="' + helpers.escapeHtml(item.severity) +
                '" href="' + helpers.escapeHtml(item.href) + '">' +
                '<b>' + helpers.escapeHtml(item.severity.toUpperCase()) + '</b>' +
                '<span><strong>' + helpers.escapeHtml(item.title) + '</strong><small>' +
                  helpers.escapeHtml(item.category) + ' · ' + helpers.escapeHtml(item.detail) + '</small></span>' +
                '<time>' + helpers.escapeHtml(helpers.dateTime(item.created_at)) + '</time>' +
                '<i>Open →</i></a>'
            ).join('') + '</div>' +
            '<p class="comms-empty" id="comms-alert-empty" hidden>No alerts match this filter.</p>'
          : '<p class="comms-empty">No active operational alerts.</p>') +
      '</section>' +
      '<p class="dashboard-generated">Notifications generated ' +
        helpers.escapeHtml(helpers.dateTime(data.generated_at)) + '</p>'

    const filters = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-alert-filter]'))
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.notification-row[data-alert-severity]'))
    const visible = root.querySelector<HTMLElement>('#comms-alert-visible')
    const empty = root.querySelector<HTMLElement>('#comms-alert-empty')
    filters.forEach(button => button.addEventListener('click', () => {
      const category = button.dataset.alertFilter || 'all'
      filters.forEach(other => other.setAttribute('aria-pressed', String(other === button)))
      let shown = 0
      rows.forEach(row => {
        row.hidden = category !== 'all' && row.dataset.alertSeverity !== category
        if (!row.hidden) shown++
      })
      if (visible) visible.textContent = shown + ' of ' + rows.length + ' shown'
      if (empty) empty.hidden = shown !== 0
    }))
  } catch (error) {
    if (!root.isConnected) return
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load notifications.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}

export async function bindNotificationsPage(helpers: Helpers) {
  void bindPushPanel()
  void bindNexusOnboardingPanel(helpers)
  // Alert rendering begins immediately; recipient lookup cannot delay urgent signals.
  void renderOperationalAlerts(helpers)

  const mode = document.querySelector<HTMLSelectElement>('#nexus-push-mode')
  const customerWrap = document.querySelector<HTMLElement>('#nexus-push-customer-wrap')
  const customerSelect = document.querySelector<HTMLSelectElement>('#nexus-push-customer')
  const titleInput = document.querySelector<HTMLInputElement>('#nexus-push-title-input')
  const messageInput = document.querySelector<HTMLTextAreaElement>('#nexus-push-message')
  const count = document.querySelector<HTMLElement>('#nexus-push-count')
  const sendButton = document.querySelector<HTMLButtonElement>('#nexus-push-send')
  const pushStatus = document.querySelector<HTMLParagraphElement>('#nexus-push-status')
  const previewTitle = document.querySelector<HTMLElement>('#nexus-push-preview-title')
  const previewMessage = document.querySelector<HTMLElement>('#nexus-push-preview-message')
  const previewAudience = document.querySelector<HTMLElement>('#nexus-push-preview-audience')

  let subscribedCount = 0
  let loadingRecipients = true
  let sending = false

  const sendMode = () => mode?.value === 'all' ? 'all' : 'individual'
  const selectedCustomer = () => customerSelect?.options[customerSelect.selectedIndex]?.text || 'selected customer'

  const updateCompose = () => {
    if (customerWrap) customerWrap.hidden = sendMode() !== 'individual'
    const title = titleInput?.value.trim() || ''
    const message = messageInput?.value.trim() || ''
    if (previewTitle) previewTitle.textContent = title || 'Notification title'
    if (previewMessage) previewMessage.textContent = message || 'Your message will appear here before you send it.'
    if (previewAudience) previewAudience.textContent = sendMode() === 'all'
      ? 'Audience: up to ' + subscribedCount + ' Nexus user' + (subscribedCount === 1 ? '' : 's') + ' with push enabled'
      : customerSelect?.value ? 'Audience: ' + selectedCustomer() : 'Choose an eligible customer to continue.'
    if (count) count.textContent = String(messageInput?.value.length || 0)
    if (sendButton) {
      sendButton.disabled = sending || loadingRecipients || subscribedCount === 0 || !title || !message ||
        (sendMode() === 'individual' && !customerSelect?.value)
    }
  }
  mode?.addEventListener('change', updateCompose)
  customerSelect?.addEventListener('change', updateCompose)
  titleInput?.addEventListener('input', updateCompose)
  messageInput?.addEventListener('input', updateCompose)
  updateCompose()

  if (customerSelect && sendButton && pushStatus) {
    try {
      const data = await loadNexusPushRecipients()
      if (!customerSelect.isConnected) return
      subscribedCount = data.subscribedCount
      customerSelect.insertAdjacentHTML('beforeend', data.recipients.map(recipient => {
        const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || recipient.email
        const label = (recipient.customerNumber ? recipient.customerNumber + ' · ' : '') + name +
          (recipient.pushEnabled ? ' · Push enabled' : ' · Push not enabled')
        return '<option value="' + helpers.escapeHtml(recipient.id) + '"' +
          (recipient.pushEnabled ? '' : ' disabled') + '>' + helpers.escapeHtml(label) + '</option>'
      }).join(''))
      pushStatus.textContent = subscribedCount + ' Nexus user' + (subscribedCount === 1 ? '' : 's') +
        ' currently have push enabled. No messages are sent until you confirm.'
    } catch (error) {
      pushStatus.textContent = error instanceof Error ? error.message : 'Could not load Nexus recipients.'
    } finally {
      loadingRecipients = false
      updateCompose()
    }

    sendButton.addEventListener('click', async () => {
      if (sending || loadingRecipients) return
      const targetMode = sendMode()
      const customerId = customerSelect.value
      const title = titleInput?.value.trim() || ''
      const message = messageInput?.value.trim() || ''
      if (!title || !message) {
        pushStatus.textContent = 'Enter both a title and message.'
        return
      }
      if (targetMode === 'individual' && !customerId) {
        pushStatus.textContent = 'Choose a customer with push enabled.'
        return
      }
      if (subscribedCount <= 0) return

      const audience = targetMode === 'all'
        ? 'ALL ' + subscribedCount + ' eligible Nexus users'
        : selectedCustomer()
      if (!window.confirm('Send this Nexus notification to ' + audience +
        '?\n\nTitle: ' + title + '\nMessage: ' + message + '\n\nThis cannot be undone.')) return

      sending = true
      updateCompose()
      sendButton.textContent = 'Queuing…'
      pushStatus.textContent = 'Queuing Nexus notification…'
      try {
        const result = await sendNexusPush({ mode: targetMode, customerId, title, message })
        pushStatus.textContent = 'Queued for ' + result.queued + ' recipient' +
          (result.queued === 1 ? '' : 's') + '. Delivery will begin shortly.'
        if (messageInput) messageInput.value = ''
      } catch (error) {
        pushStatus.textContent = error instanceof Error ? error.message : 'Could not send Nexus notification.'
      } finally {
        sending = false
        sendButton.textContent = 'Review & send'
        updateCompose()
      }
    })
  }


}
