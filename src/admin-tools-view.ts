import { inviteCustomerProfile, loadAdminTools, saveMessageTemplate, sendCustomerActivationEmail, type MessageTemplate } from './services/admin-tools'

type Helpers = {
  escapeHtml: (value: unknown) => string
}

export function adminToolsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">ADMINISTRATION</span><h1 class="dashboard-title">Admin Tools</h1>' +
    '<p class="copy">Customer account invitations and reusable support/message templates with controlled, audited actions.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section id="admin-tools-root"><div class="loading">Loading admin tools…</div></section>'
}

function templateEditor(template: MessageTemplate | null, helpers: Helpers) {
  return '<div class="admin-template-editor" data-template-id="' + helpers.escapeHtml(template?.id || '') + '">' +
    '<div class="admin-template-grid">' +
      '<label><span>Name</span><input class="admin-template-name" maxlength="120" value="' + helpers.escapeHtml(template?.name || '') + '"></label>' +
      '<label><span>Category</span><input class="admin-template-category" maxlength="80" value="' + helpers.escapeHtml(template?.category || '') + '" placeholder="Support, Orders, General…"></label>' +
      '<label class="admin-span-2"><span>Message</span><textarea class="admin-template-message" maxlength="5000">' + helpers.escapeHtml(template?.message || '') + '</textarea></label>' +
      '<label class="admin-template-active"><input class="admin-template-active-input" type="checkbox" ' + (template?.active !== false ? 'checked' : '') + '> Active</label>' +
    '</div>' +
    '<div class="admin-template-actions"><p class="card-message admin-template-message-state"></p>' +
      '<button type="button" class="secondary save-admin-template">' + (template ? 'Save Template' : 'Create Template') + '</button></div>' +
  '</div>'
}

export async function bindAdminToolsPage(helpers: Helpers) {
  const root = document.querySelector<HTMLDivElement>('#admin-tools-root')
  if (!root) return

  const render = async () => {
    const data = await loadAdminTools()
    const unclaimedIds = new Set(data.inviteable_profiles.map(profile => profile.id))

    root.innerHTML =
      '<div class="admin-columns">' +
        '<section class="admin-panel"><div class="dashboard-section-head"><div><span class="eyebrow">ACCOUNT ACCESS</span><h2>Nexus invitations & activation</h2></div></div>' +
          '<p class="admin-note">Send a first-time invitation to unclaimed profiles or resend an activation/password link to an existing Nexus account. Resends keep the customer on the same Auth account.</p>' +
          (data.activation_profiles.length
            ? '<div class="admin-invite-list">' + data.activation_profiles.map(profile => {
                const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email
                const isUnclaimed = unclaimedIds.has(profile.id)
                const label = isUnclaimed ? 'Send Invite' : 'Resend Activation'
                const status = isUnclaimed ? 'UNCLAIMED' : 'AUTH LINKED'
                return '<div class="admin-invite-row" data-customer-id="' + helpers.escapeHtml(profile.id) + '" data-email="' + helpers.escapeHtml(profile.email) + '" data-unclaimed="' + (isUnclaimed ? 'true' : 'false') + '">' +
                  '<span><strong>' + helpers.escapeHtml(name) + '</strong><small>' + helpers.escapeHtml(profile.customer_number || '') + ' · ' + status + '</small></span>' +
                  '<span>' + helpers.escapeHtml(profile.email) + '</span>' +
                  '<button type="button" class="secondary send-customer-activation">' + label + '</button>' +
                  '<p class="card-message admin-invite-message"></p>' +
                '</div>'
              }).join('') + '</div>'
            : '<p class="dashboard-muted">No active customer profiles.</p>') +
        '</section>' +

        '<section class="admin-panel"><div class="dashboard-section-head"><div><span class="eyebrow">QUICK RESPONSE</span><h2>New canned response</h2></div></div>' +
          templateEditor(null, helpers) +
        '</section>' +
      '</div>' +

      '<p class="admin-note">Discount codes moved to <a href="#referrals">Referrals → Discount codes</a>.</p>' +

      '<section class="admin-panel"><div class="dashboard-section-head"><div><span class="eyebrow">MESSAGE LIBRARY</span><h2>Canned responses</h2></div></div>' +
        (data.templates.length
          ? '<div class="admin-template-list">' + data.templates.map(template =>
              '<details class="admin-template-card"><summary><span><strong>' + helpers.escapeHtml(template.name) + '</strong><small>' +
                helpers.escapeHtml(template.category || 'Uncategorized') + '</small></span><b>' + (template.active ? 'ACTIVE' : 'INACTIVE') + '</b></summary>' +
                templateEditor(template, helpers) +
              '</details>'
            ).join('') + '</div>'
          : '<p class="dashboard-muted">No message templates yet.</p>') +
      '</section>'

    document.querySelectorAll<HTMLButtonElement>('.send-customer-activation').forEach(button => {
      button.addEventListener('click', async () => {
        const row = button.closest<HTMLElement>('.admin-invite-row')
        const customerId = row?.dataset.customerId
        const email = row?.dataset.email || ''
        const isUnclaimed = row?.dataset.unclaimed === 'true'
        const message = row?.querySelector<HTMLParagraphElement>('.admin-invite-message')
        if (!customerId || !email) return

        const verb = isUnclaimed ? 'Send a Science By HUGs account invitation' : 'Send a fresh Nexus activation/password link'
        if (!window.confirm(verb + ' to ' + email + '?\n\nThis sends a real authentication email.')) return

        button.disabled = true
        if (message) message.textContent = isUnclaimed ? 'Sending invite…' : 'Sending activation link…'
        try {
          if (isUnclaimed) {
            await inviteCustomerProfile(customerId)
          } else {
            await sendCustomerActivationEmail(email)
          }
          if (message) message.textContent = isUnclaimed
            ? 'Invite sent.'
            : 'Fresh activation/password link sent.'
          await render()
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not send account email.'
        } finally {
          button.disabled = false
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.save-admin-template').forEach(button => {
      button.addEventListener('click', async () => {
        const editor = button.closest<HTMLElement>('.admin-template-editor')
        if (!editor) return
        const value = (selector: string) => editor.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value.trim() || ''
        const state = editor.querySelector<HTMLParagraphElement>('.admin-template-message-state')
        const active = editor.querySelector<HTMLInputElement>('.admin-template-active-input')?.checked !== false

        button.disabled = true
        if (state) state.textContent = 'Saving…'
        try {
          await saveMessageTemplate({
            templateId: editor.dataset.templateId || undefined,
            name: value('.admin-template-name'),
            category: value('.admin-template-category'),
            message: value('.admin-template-message'),
            active,
          })
          if (state) state.textContent = 'Saved. Audit event recorded.'
          await render()
        } catch (error) {
          if (state) state.textContent = error instanceof Error ? error.message : 'Could not save template.'
        } finally {
          button.disabled = false
        }
      })
    })
  }

  try {
    await render()
  } catch (error) {
    root.innerHTML = '<div class="empty-state error-state"><h2>Could not load admin tools.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
