import { inviteCustomerProfile } from './services/admin-tools'
import { deleteZone } from './delete-zone'
import { mountMasterDetail } from './master-detail'
import { deleteCustomer } from './services/records'
import { createCustomer, loadCoreCustomers, updateCustomerAccountStatus, updateCustomerContactPreference, updateCustomerEmail, updateCustomerMembership, updateCustomerNotes, updateCustomerProfile, type CoreCustomer, type CoreMembership } from './services/customers'

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

function nameFor(customer: CoreCustomer) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer'
}

function customerCard(customer: CoreCustomer, memberships: CoreMembership[], helpers: Helpers) {
  const { escapeHtml, money, dateTime } = helpers
  const recentOrders = customer.orders.slice(0, 3)
  return '<article class="customer-card" data-customer-id="' + escapeHtml(customer.id) + '">' +
    '<div class="customer-card-head">' +
      '<div><span class="eyebrow">' + escapeHtml(customer.customer_number || 'CUSTOMER') + '</span>' +
      '<h2>' + escapeHtml(nameFor(customer)) + '</h2>' +
      '<p>' + escapeHtml(customer.email) + (customer.phone ? ' · ' + escapeHtml(customer.phone) : '') + '</p></div>' +
      '<div class="customer-tags">' +
        '<div class="membership-control"><label><span>Membership</span><select class="customer-membership-select">' +
          memberships.map(membership =>
            '<option value="' + escapeHtml(membership.id) + '"' +
              (customer.membership?.id === membership.id ? ' selected' : '') + '>' +
              escapeHtml(membership.name) + '</option>'
          ).join('') +
        '</select></label><p class="card-message membership-message" aria-live="polite"></p></div>' +
        '<div class="account-status-control"><label><span>Account</span><select class="customer-account-status">' +
          '<option value="Active"' + (customer.account_status.toLowerCase() === 'active' ? ' selected' : '') + '>Active</option>' +
          '<option value="Suspended"' + (customer.account_status.toLowerCase() === 'suspended' ? ' selected' : '') + '>Suspended</option>' +
        '</select></label><p class="card-message account-status-message" aria-live="polite"></p></div>' +
      '</div>' +
    '</div>' +
    '<div class="customer-metrics">' +
      '<div><span>Orders</span><strong>' + customer.metrics.order_count + '</strong></div>' +
      '<div><span>Lifetime spend</span><strong>' + money(customer.metrics.lifetime_spend) + '</strong></div>' +
      '<div><span>Referrals</span><strong>' + customer.metrics.referral_count + '</strong></div>' +
      '<div><span>Rewards</span><strong>' + customer.metrics.available_reward_count + '</strong></div>' +
    '</div>' +
    '<div class="customer-details">' +
      '<div class="contact-preference-control"><span>Preferred contact</span>' +
        '<select class="customer-contact-preference" aria-label="Preferred contact method">' +
          '<option value=""' + (!customer.preferred_contact_method ? ' selected' : '') + '>Not set</option>' +
          '<option value="email"' + (customer.preferred_contact_method?.toLowerCase() === 'email' ? ' selected' : '') + '>Email</option>' +
          '<option value="phone"' + (customer.preferred_contact_method?.toLowerCase() === 'phone' ? ' selected' : '') + '>Phone</option>' +
          '<option value="text"' + (['text','sms'].includes(customer.preferred_contact_method?.toLowerCase() || '') ? ' selected' : '') + '>Text</option>' +
        '</select>' +
        '<p class="card-message contact-preference-message" aria-live="polite"></p>' +
      '</div>' +
      '<div><span>Last login</span><strong>' + escapeHtml(dateTime(customer.last_login_at)) + '</strong></div>' +
      '<div><span>Latest order</span><strong>' + escapeHtml(dateTime(customer.metrics.latest_order_at)) + '</strong></div>' +
      '<div><span>Referral code</span><strong>' + escapeHtml(customer.referral_code || '—') + '</strong></div>' +
    '</div>' +
    (recentOrders.length
      ? '<div class="customer-orders"><span class="section-label">Recent orders</span>' +
        recentOrders.map(order =>
          '<a href="#orders" class="customer-order-row"><span>' +
            escapeHtml(order.order_number || 'Order') + '</span><span>' +
            escapeHtml(order.status) + '</span><strong>' + money(order.total) + '</strong></a>'
        ).join('') + '</div>'
      : '') +
    '<details class="customer-profile-editor"><summary>Edit customer profile</summary>' +
      '<div class="customer-profile-grid">' +
        '<label><span>First name</span><input class="profile-first-name" maxlength="80" value="' + escapeHtml(customer.first_name || '') + '"></label>' +
        '<label><span>Last name</span><input class="profile-last-name" maxlength="80" value="' + escapeHtml(customer.last_name || '') + '"></label>' +
        '<label><span>Phone</span><input class="profile-phone" maxlength="40" value="' + escapeHtml(customer.phone || '') + '"></label>' +
        '<label class="profile-email-field"><span>Email / login</span><div class="profile-email-row">' +
          '<input class="profile-email" type="email" maxlength="254" value="' + escapeHtml(customer.email) + '">' +
          '<button class="secondary save-customer-email" type="button">Change Email</button>' +
        '</div><small>Updates Supabase Auth and the customer profile together.</small>' +
        '<p class="card-message customer-email-message" aria-live="polite"></p></label>' +
        '<label class="profile-span-2"><span>Address line 1</span><input class="profile-address-1" maxlength="160" value="' + escapeHtml(customer.address_line_1 || '') + '"></label>' +
        '<label class="profile-span-2"><span>Address line 2</span><input class="profile-address-2" maxlength="160" value="' + escapeHtml(customer.address_line_2 || '') + '"></label>' +
        '<label><span>City</span><input class="profile-city" maxlength="100" value="' + escapeHtml(customer.city || '') + '"></label>' +
        '<label><span>State</span><input class="profile-state" maxlength="80" value="' + escapeHtml(customer.state || '') + '"></label>' +
        '<label><span>Postal code</span><input class="profile-postal-code" maxlength="30" value="' + escapeHtml(customer.postal_code || '') + '"></label>' +
      '</div>' +
      '<div class="customer-profile-actions"><p class="card-message customer-profile-message" aria-live="polite"></p>' +
      '<button class="secondary save-customer-profile" type="button">Save Profile</button></div>' +
    '</details>' +
    '<div class="customer-notes-editor">' +
      '<label><span>Internal notes</span><textarea class="customer-notes-input" maxlength="2000" placeholder="Add internal customer context…">' +
        escapeHtml(customer.notes || '') +
      '</textarea></label>' +
      '<div class="customer-notes-actions"><p class="card-message customer-notes-message" aria-live="polite"></p>' +
      '<button class="secondary save-customer-notes" type="button">Save Notes</button></div>' +
    '</div>' +
    deleteZone(
      'Delete customer',
      'Permanently deletes this customer and their Nexus login (which may also be their Pulse login). Their past orders stay in Core, labelled as a deleted customer. A full copy is kept in the Audit Log.',
      'Type ' + customer.email + ' to confirm',
      'delete-customer',
      escapeHtml,
    ) +
  '</article>'
}

function newCustomerPanelMarkup() {
  return '<details class="catalog-create-panel new-customer-panel" id="new-customer-panel">' +
    '<summary><span class="secondary catalog-create-button">+ New customer</span></summary>' +
    '<p class="catalog-editor-note">Creates the customer record now. Core assigns the next customer number automatically. ' +
    'They get a login when they accept an invite, or when they sign up on Nexus with this same email.</p>' +
    '<div class="customer-profile-grid">' +
      '<label><span>First name</span><input class="new-first-name" maxlength="80" autocomplete="off"></label>' +
      '<label><span>Last name</span><input class="new-last-name" maxlength="80" autocomplete="off"></label>' +
      '<label><span>Email (required)</span><input class="new-email" type="email" maxlength="254" autocomplete="off"></label>' +
      '<label><span>Phone</span><input class="new-phone" maxlength="40" autocomplete="off"></label>' +
      '<label class="profile-span-2"><span>Address line 1</span><input class="new-address-1" maxlength="160" autocomplete="off"></label>' +
      '<label class="profile-span-2"><span>Address line 2</span><input class="new-address-2" maxlength="160" autocomplete="off"></label>' +
      '<label><span>City</span><input class="new-city" maxlength="100" autocomplete="off"></label>' +
      '<label><span>State</span><input class="new-state" maxlength="80" autocomplete="off"></label>' +
      '<label><span>Postal code</span><input class="new-postal-code" maxlength="30" autocomplete="off"></label>' +
      '<label><span>Membership</span><select class="new-membership"></select></label>' +
      '<label><span>Preferred contact</span><select class="new-contact">' +
        '<option value="">Not set</option><option value="email">Email</option><option value="phone">Phone</option><option value="text">Text</option>' +
      '</select></label>' +
      '<label class="profile-span-2"><span>Internal notes</span><textarea class="new-notes" maxlength="2000" placeholder="Optional internal context…"></textarea></label>' +
    '</div>' +
    '<label class="import-confirm"><input type="checkbox" class="new-send-invite"> Email them an invite to set up their Nexus login now</label>' +
    '<div class="customer-profile-actions"><p class="card-message new-customer-message" aria-live="polite"></p>' +
    '<button class="primary create-customer" type="button">Create customer</button></div>' +
  '</details>'
}

export function customersPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">CUSTOMER OPERATIONS</span><h1 class="dashboard-title">Customers</h1>' +
    '<p class="copy">Customer relationships, memberships, order value, referrals, rewards, and internal context.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section class="customers-toolbar"><label class="queue-search"><span class="sr-only">Search customers</span>' +
    '<input id="customers-search" type="search" placeholder="Search name, email, phone, customer number…" autocomplete="off"></label>' +
    '<select id="customers-membership" aria-label="Filter customers by membership"><option value="all">All memberships</option></select></section>' +
    newCustomerPanelMarkup() +
    '<p class="queue-summary" id="customers-summary" aria-live="polite"></p>' +
    '<section class="customers-list" id="customers-list"><div class="loading">Loading customers…</div></section>'
}

function bindNewCustomerPanel(memberships: CoreMembership[], helpers: Helpers, reload?: () => Promise<void>) {
  const panel = document.querySelector<HTMLElement>('#new-customer-panel')
  if (!panel) return
  const select = panel.querySelector<HTMLSelectElement>('.new-membership')
  if (select) {
    select.innerHTML = memberships.map(item =>
      '<option value="' + helpers.escapeHtml(item.id) + '"' + (item.slug === 'new-researcher' ? ' selected' : '') + '>' +
        helpers.escapeHtml(item.name) + '</option>').join('')
  }
  const button = panel.querySelector<HTMLButtonElement>('.create-customer')
  const message = panel.querySelector<HTMLParagraphElement>('.new-customer-message')
  const say = (text: string) => { if (message) message.textContent = text }
  const value = (selector: string) =>
    panel.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)?.value.trim() || ''

  button?.addEventListener('click', async () => {
    const input = {
      firstName: value('.new-first-name'),
      lastName: value('.new-last-name'),
      email: value('.new-email').toLowerCase(),
      phone: value('.new-phone'),
      addressLine1: value('.new-address-1'),
      addressLine2: value('.new-address-2'),
      city: value('.new-city'),
      state: value('.new-state'),
      postalCode: value('.new-postal-code'),
      preferredContactMethod: value('.new-contact'),
      membershipId: value('.new-membership'),
      notes: value('.new-notes'),
    }
    if (!input.firstName && !input.lastName) { say('Enter a first or last name.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) { say('Enter a valid email address.'); return }
    const sendInvite = Boolean(panel.querySelector<HTMLInputElement>('.new-send-invite')?.checked)

    button.disabled = true
    button.textContent = 'Creating…'
    say('Creating customer…')
    try {
      const created = await createCustomer(input)
      let result = 'Created ' + (created.customer_number || 'customer') + ' for ' + created.email + '. Audit event recorded.'
      if (sendInvite) {
        say(result + ' Sending invite…')
        try {
          await inviteCustomerProfile(created.id)
          result += ' Invite emailed.'
        } catch (error) {
          result += ' The invite could not be sent (' + (error instanceof Error ? error.message : 'unknown error') +
            '). You can resend it from Admin Tools.'
        }
      }
      if (reload) {
        await reload()
        const after = document.querySelector<HTMLParagraphElement>('#customers-summary')
        if (after) after.textContent = result + ' ' + after.textContent
      } else {
        say(result)
      }
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not create customer.')
      button.disabled = false
      button.textContent = 'Create customer'
    }
  })
}

export async function bindCustomersPage(helpers: Helpers, reload?: () => Promise<void>) {
  const list = document.querySelector<HTMLDivElement>('#customers-list')
  if (!list) return

  try {
    const { customers, memberships } = await loadCoreCustomers()
    list.innerHTML = customers.length
      ? customers.map(customer => customerCard(customer, memberships, helpers)).join('')
      : '<div class="empty-state"><h2>No customers yet.</h2><p>Customer profiles will appear here.</p></div>'

    const membershipSelect = document.querySelector<HTMLSelectElement>('#customers-membership')
    if (membershipSelect) {
      membershipSelect.insertAdjacentHTML('beforeend', memberships.map(membership =>
        '<option value="' + helpers.escapeHtml(membership.slug) + '">' +
          helpers.escapeHtml(membership.name) + '</option>'
      ).join(''))
    }

    bindNewCustomerPanel(memberships, helpers, reload)

    let search = ''
    let membership = 'all'

    const apply = () => {
      let shown = 0
      document.querySelectorAll<HTMLElement>('.customer-card').forEach(card => {
        const customer = customers.find(item => item.id === card.dataset.customerId)
        if (!customer) return
        const haystack = [
          nameFor(customer), customer.customer_number, customer.email, customer.phone,
          customer.referral_code, customer.membership?.name
        ].filter(Boolean).join(' ').toLowerCase()
        const visible =
          (membership === 'all' || customer.membership?.slug === membership) &&
          (!search || haystack.includes(search))
        card.hidden = !visible
        if (visible) shown += 1
      })
      const summary = document.querySelector<HTMLParagraphElement>('#customers-summary')
      if (summary) summary.textContent = shown + ' of ' + customers.length + ' customers shown.'
    }

    document.querySelector<HTMLInputElement>('#customers-search')?.addEventListener('input', event => {
      search = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase()
      apply()
    })
    membershipSelect?.addEventListener('change', event => {
      membership = (event.currentTarget as HTMLSelectElement).value
      apply()
    })

    document.querySelectorAll<HTMLButtonElement>('.delete-customer-button').forEach(button => {
      button.addEventListener('click', async () => {
        const card = button.closest<HTMLElement>('.customer-card')
        const customer = customers.find(item => item.id === card?.dataset.customerId)
        const input = card?.querySelector<HTMLInputElement>('.delete-customer-confirm')
        const message = card?.querySelector<HTMLParagraphElement>('.delete-customer-message')
        if (!card || !customer || !input) return
        const say = (text: string) => { if (message) message.textContent = text }
        if (input.value.trim().toLowerCase() !== customer.email.trim().toLowerCase()) {
          say('Type ' + customer.email + ' exactly to confirm.')
          return
        }
        const label = nameFor(customer) + (customer.customer_number ? ' (' + customer.customer_number + ')' : '')
        if (!window.confirm('Permanently delete ' + label + ' and their login?\n\nTheir ' + customer.metrics.order_count +
          ' order(s) stay in Core. This cannot be undone. A copy is kept in the Audit Log.')) return
        button.disabled = true
        button.textContent = 'Deleting…'
        say('Deleting…')
        try {
          const result = await deleteCustomer(customer.id, input.value.trim())
          const done = 'Deleted ' + label + '. ' + result.ordersKept + ' order(s) kept. ' +
            (result.warning ? result.warning : result.loginRemoved ? 'Login removed. ' : '') + 'Copy saved in the Audit Log.'
          if (reload) {
            await reload()
            const after = document.querySelector<HTMLParagraphElement>('#customers-summary')
            if (after) after.textContent = done + ' ' + after.textContent
          } else {
            card.remove()
            say(done)
          }
        } catch (error) {
          say(error instanceof Error ? error.message : 'Could not delete the customer.')
          button.disabled = false
          button.textContent = 'Delete customer'
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.save-customer-notes').forEach(button => {
      button.addEventListener('click', async () => {
        const card = button.closest<HTMLElement>('.customer-card')
        const customerId = card?.dataset.customerId
        const textarea = card?.querySelector<HTMLTextAreaElement>('.customer-notes-input')
        const message = card?.querySelector<HTMLParagraphElement>('.customer-notes-message')

        if (!customerId || !textarea) return

        const customer = customers.find(item => item.id === customerId)
        if (!customer) return

        button.disabled = true
        button.textContent = 'Saving…'
        if (message) message.textContent = 'Saving audited note…'

        try {
          const updated = await updateCustomerNotes(customerId, textarea.value)
          customer.notes = updated.notes
          customer.updated_at = updated.updated_at
          textarea.value = updated.notes || ''
          if (message) message.textContent = 'Saved. Audit event recorded.'
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not save notes.'
        } finally {
          button.disabled = false
          button.textContent = 'Save Notes'
        }
      })
    })

    document.querySelectorAll<HTMLSelectElement>('.customer-contact-preference').forEach(select => {
      select.addEventListener('change', async () => {
        const card = select.closest<HTMLElement>('.customer-card')
        const customerId = card?.dataset.customerId
        const message = card?.querySelector<HTMLParagraphElement>('.contact-preference-message')

        if (!customerId) return
        const customer = customers.find(item => item.id === customerId)
        if (!customer) return

        const previous = customer.preferred_contact_method || ''
        const next = select.value || null
        select.disabled = true
        if (message) message.textContent = 'Saving audited preference…'

        try {
          const updated = await updateCustomerContactPreference(customerId, next)
          customer.preferred_contact_method = updated.preferred_contact_method
          customer.updated_at = updated.updated_at
          if (message) message.textContent = 'Saved. Audit event recorded.'
        } catch (error) {
          select.value = previous.toLowerCase() === 'sms' ? 'text' : previous.toLowerCase()
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not save preference.'
        } finally {
          select.disabled = false
        }
      })
    })

    document.querySelectorAll<HTMLSelectElement>('.customer-membership-select').forEach(select => {
      select.addEventListener('change', async () => {
        const card = select.closest<HTMLElement>('.customer-card')
        const customerId = card?.dataset.customerId
        const message = card?.querySelector<HTMLParagraphElement>('.membership-message')
        if (!customerId) return

        const customer = customers.find(item => item.id === customerId)
        const nextMembership = memberships.find(item => item.id === select.value)
        if (!customer || !nextMembership) return

        const previousMembership = customer.membership
        const confirmed = window.confirm(
          'Change ' + nameFor(customer) + ' from ' +
          (previousMembership?.name || 'No membership') + ' to ' +
          nextMembership.name + '?\n\n' +
          'This change is audited. Customers with 20 qualified referrals may be automatically upgraded to Principal Scientist again by the referral system.'
        )

        if (!confirmed) {
          select.value = previousMembership?.id || ''
          return
        }

        select.disabled = true
        if (message) message.textContent = 'Saving audited membership change…'

        try {
          const updated = await updateCustomerMembership(customerId, nextMembership.id)
          customer.membership = updated.membership
          customer.updated_at = updated.customer.updated_at
          if (message) message.textContent = 'Saved. Audit event recorded.'
          apply()
        } catch (error) {
          select.value = previousMembership?.id || ''
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not update membership.'
        } finally {
          select.disabled = false
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.save-customer-email').forEach(button => {
      button.addEventListener('click', async () => {
        const card = button.closest<HTMLElement>('.customer-card')
        const customerId = card?.dataset.customerId
        const input = card?.querySelector<HTMLInputElement>('.profile-email')
        const message = card?.querySelector<HTMLParagraphElement>('.customer-email-message')
        if (!customerId || !input) return

        const customer = customers.find(item => item.id === customerId)
        if (!customer) return

        const nextEmail = input.value.trim().toLowerCase()
        const previousEmail = customer.email

        if (!nextEmail || nextEmail === previousEmail.toLowerCase()) {
          input.value = previousEmail
          if (message) message.textContent = nextEmail ? 'No email change to save.' : 'Enter an email address.'
          return
        }

        const confirmed = window.confirm(
          'Change the login email for ' + nameFor(customer) + '?\n\n' +
          'Current: ' + previousEmail + '\nNew: ' + nextEmail + '\n\n' +
          'This updates both Supabase Auth and the customer profile and is recorded in the Audit Log.'
        )

        if (!confirmed) {
          input.value = previousEmail
          return
        }

        button.disabled = true
        input.disabled = true
        button.textContent = 'Changing…'
        if (message) message.textContent = 'Synchronizing Auth and profile email…'

        try {
          const updated = await updateCustomerEmail(customerId, nextEmail)
          customer.email = updated.email
          customer.updated_at = updated.updated_at
          input.value = updated.email
          if (message) message.textContent = 'Email changed. Auth, profile, and Audit are synchronized.'
          apply()
        } catch (error) {
          input.value = previousEmail
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not change email.'
        } finally {
          button.disabled = false
          input.disabled = false
          button.textContent = 'Change Email'
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.save-customer-profile').forEach(button => {
      button.addEventListener('click', async () => {
        const card = button.closest<HTMLElement>('.customer-card')
        const customerId = card?.dataset.customerId
        const message = card?.querySelector<HTMLParagraphElement>('.customer-profile-message')
        if (!customerId) return

        const customer = customers.find(item => item.id === customerId)
        if (!customer) return

        const value = (selector: string) =>
          card?.querySelector<HTMLInputElement>(selector)?.value.trim() || ''

        const payload = {
          firstName: value('.profile-first-name'),
          lastName: value('.profile-last-name'),
          phone: value('.profile-phone'),
          addressLine1: value('.profile-address-1'),
          addressLine2: value('.profile-address-2'),
          city: value('.profile-city'),
          state: value('.profile-state'),
          postalCode: value('.profile-postal-code'),
        }

        button.disabled = true
        button.textContent = 'Saving…'
        if (message) message.textContent = 'Saving audited profile update…'

        try {
          const updated = await updateCustomerProfile(customerId, payload)
          customer.first_name = updated.first_name
          customer.last_name = updated.last_name
          customer.phone = updated.phone
          customer.address_line_1 = updated.address_line_1
          customer.address_line_2 = updated.address_line_2
          customer.city = updated.city
          customer.state = updated.state
          customer.postal_code = updated.postal_code
          customer.updated_at = updated.updated_at
          if (message) message.textContent = 'Saved. Audit event recorded.'
          apply()
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not update profile.'
        } finally {
          button.disabled = false
          button.textContent = 'Save Profile'
        }
      })
    })

    document.querySelectorAll<HTMLSelectElement>('.customer-account-status').forEach(select => {
      select.addEventListener('change', async () => {
        const card = select.closest<HTMLElement>('.customer-card')
        const customerId = card?.dataset.customerId
        const message = card?.querySelector<HTMLParagraphElement>('.account-status-message')
        if (!customerId) return
        const customer = customers.find(item => item.id === customerId)
        if (!customer) return

        const previous = customer.account_status
        const next = select.value as 'Active' | 'Suspended'
        const confirmed = window.confirm(
          next === 'Suspended'
            ? 'Suspend ' + nameFor(customer) + '?\n\nThis blocks new Nexus checkout and invoice requests. The customer can still sign in and view their account/history.'
            : 'Reactivate ' + nameFor(customer) + '?\n\nThis restores Nexus checkout access.'
        )
        if (!confirmed) {
          select.value = previous.toLowerCase() === 'suspended' ? 'Suspended' : 'Active'
          return
        }

        select.disabled = true
        if (message) message.textContent = 'Saving audited account status…'
        try {
          const updated = await updateCustomerAccountStatus(customerId, next)
          customer.account_status = updated.account_status
          customer.updated_at = updated.updated_at
          if (message) message.textContent = 'Saved. Audit event recorded.'
        } catch (error) {
          select.value = previous.toLowerCase() === 'suspended' ? 'Suspended' : 'Active'
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not update account status.'
        } finally {
          select.disabled = false
        }
      })
    })

    apply()

    // 2026-10-28 redesign: compact list; the full customer card opens in a side panel / phone sheet.
    mountMasterDetail({
      list,
      cardSelector: '.customer-card',
      idOf: card => card.dataset.customerId || '',
      key: 'customers',
      backLabel: 'Customers',
      row: card => {
        const customer = customers.find(item => item.id === card.dataset.customerId)!
        return {
          title: nameFor(customer),
          sub: [customer.customer_number, customer.email].filter(Boolean).join(' · '),
          meta: helpers.money(customer.metrics.lifetime_spend) + ' · ' + customer.metrics.order_count + (customer.metrics.order_count === 1 ? ' order' : ' orders'),
          badge: customer.account_status.toLowerCase() === 'suspended' ? 'Suspended' : customer.membership?.name || 'No membership',
          tone: customer.account_status.toLowerCase() === 'suspended' ? 'error' : 'muted',
        }
      },
    })
  } catch (error) {
    list.innerHTML = '<div class="empty-state error-state"><h2>Could not load customers.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
