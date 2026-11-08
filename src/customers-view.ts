import { inviteCustomerProfile } from './services/admin-tools'
import { deleteZone } from './delete-zone'
import { presetOrdersSelection } from './orders-hub'
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
  const id = escapeHtml(customer.id)
  const orders = [...(customer.orders || [])].sort((a,b) => b.created_at.localeCompare(a.created_at))
  const referrals = customer.referrals || []
  const rewards = customer.rewards || []
  const tab = (step: string, label: string) =>
    '<button type="button" role="tab" class="customer-profile-tab" data-customer-tab="' + step +
    '" id="customer-tab-' + id + '-' + step + '" aria-controls="customer-panel-' + id + '-' + step +
    '" aria-selected="false" tabindex="-1">' + label + '</button>'
  const panel = (step: string, html: string) =>
    '<section class="customer-profile-panel" role="tabpanel" data-customer-panel="' + step +
    '" id="customer-panel-' + id + '-' + step + '" aria-labelledby="customer-tab-' + id + '-' + step +
    '" hidden>' + html + '</section>'
  const name = nameFor(customer)

  const overview =
    '<div class="customer-section-title"><h3>Customer at a glance</h3>' +
      '<button type="button" class="customer-jump" data-customer-jump="profile">Edit profile</button></div>' +
    '<div class="customer-overview-facts">' +
      '<div><span>Email</span><strong>' + escapeHtml(customer.email) + '</strong></div>' +
      '<div><span>Phone</span><strong>' + escapeHtml(customer.phone || 'Not provided') + '</strong></div>' +
      '<div><span>Preferred contact</span><strong>' + escapeHtml(customer.preferred_contact_method || 'Not set') + '</strong></div>' +
      '<div><span>Last login</span><strong>' + escapeHtml(dateTime(customer.last_login_at)) + '</strong></div>' +
      '<div><span>Latest order</span><strong>' + escapeHtml(dateTime(customer.metrics.latest_order_at)) + '</strong></div>' +
      '<div><span>Referral code</span><strong>' + escapeHtml(customer.referral_code || '—') + '</strong></div>' +
    '</div>' +
    '<div class="customer-overview-next">' +
      '<button type="button" class="customer-overview-link" data-customer-jump="orders">View orders (' +
        customer.metrics.order_count + ')</button>' +
      '<button type="button" class="customer-overview-link" data-customer-jump="rewards">Referrals & rewards</button>' +
    '</div>'

  const orderHistory =
    '<div class="customer-section-title"><h3>Purchase history</h3><small>' +
      orders.length + ' record' + (orders.length === 1 ? '' : 's') + ' available</small></div>' +
    (orders.length ? '<div class="customer-order-history">' +
      orders.map(order =>
        '<a href="#orders" class="customer-order-row" data-customer-order-id="' + escapeHtml(order.id) + '">' +
          '<span class="customer-order-main"><strong>' + escapeHtml(order.order_number || 'Order') + '</strong>' +
            '<small>' + escapeHtml(dateTime(order.created_at)) + ' · Payment: ' +
              escapeHtml(order.payment_status || 'Not available') + '</small></span>' +
          '<span class="customer-order-end"><strong>' + money(order.total) + '</strong>' +
            '<small>' + escapeHtml(order.status) + '</small></span>' +
        '</a>'
      ).join('') + '</div>' :
      '<p class="customer-blank">No order history is available for this customer.</p>') +
    '<p class="customer-footnote">Select an order to open that exact order in Core.</p>'

  const referralHistory =
    '<div class="customer-section-title"><h3>Referrals</h3><small>' +
      customer.metrics.qualified_referral_count + ' qualified</small></div>' +
    '<p class="customer-footnote">Referral code: <strong>' + escapeHtml(customer.referral_code || '—') + '</strong></p>' +
    (referrals.length ? '<div class="customer-history-list">' +
      referrals.map(ref =>
        '<div class="customer-history-item">' +
          '<div><strong>' + escapeHtml(ref.referred_name || ref.referred_email || 'Referred customer') + '</strong>' +
            '<small>' + escapeHtml(dateTime(ref.referred_at)) +
              (ref.qualifying_order_number ? ' · Order ' + escapeHtml(ref.qualifying_order_number) : '') + '</small></div>' +
          '<span class="customer-history-status">' + escapeHtml(ref.status) + '</span>' +
        '</div>').join('') + '</div>' :
      '<p class="customer-blank">No referrals recorded.</p>')
  const rewardHistory =
    '<div class="customer-section-title"><h3>Rewards</h3><small>' +
      customer.metrics.available_reward_count + ' available</small></div>' +
    (rewards.length ? '<div class="customer-history-list">' +
      rewards.map(reward =>
        '<div class="customer-history-item">' +
          '<div><strong>' + escapeHtml(reward.title || reward.description || reward.reward_type || 'Reward') + '</strong>' +
            '<small>' + escapeHtml(dateTime(reward.created_at)) +
            (reward.reward_value == null ? '' : ' · Value ' + escapeHtml(reward.reward_value)) +
            '</small></div>' +
          '<span class="customer-history-status">' + escapeHtml(reward.status) + '</span>' +
        '</div>').join('') + '</div>' :
      '<p class="customer-blank">No rewards recorded.</p>')
  const rewardOverview =
    '<div class="customer-membership-summary">' +
      '<span>Current membership</span><strong>' + escapeHtml(customer.membership?.name || 'No membership') + '</strong>' +
      (customer.membership?.description ? '<p>' + escapeHtml(customer.membership.description) + '</p>' : '') +
    '</div>' + referralHistory + rewardHistory

  const profileEditors =
    '<div class="customer-section-title"><h3>Contact & profile</h3><small>Changes are audited</small></div>' +
    '<div class="contact-preference-control customer-inline-field"><label><span>Preferred contact</span>' +
        '<select class="customer-contact-preference" aria-label="Preferred contact method">' +
          '<option value=""' + (!customer.preferred_contact_method ? ' selected' : '') + '>Not set</option>' +
          '<option value="email"' + (customer.preferred_contact_method?.toLowerCase() === 'email' ? ' selected' : '') + '>Email</option>' +
          '<option value="phone"' + (customer.preferred_contact_method?.toLowerCase() === 'phone' ? ' selected' : '') + '>Phone</option>' +
          '<option value="text"' + (['text','sms'].includes(customer.preferred_contact_method?.toLowerCase() || '') ? ' selected' : '') + '>Text</option>' +
        '</select></label>' +
        '<p class="card-message contact-preference-message" aria-live="polite"></p>' +
    '</div>' +
    '<details class="customer-profile-editor" open><summary>Contact details & address</summary>' +
      '<div class="customer-profile-grid">' +
        '<label><span>First name</span><input class="profile-first-name" maxlength="80" value="' + escapeHtml(customer.first_name || '') + '"></label>' +
        '<label><span>Last name</span><input class="profile-last-name" maxlength="80" value="' + escapeHtml(customer.last_name || '') + '"></label>' +
        '<label><span>Phone</span><input class="profile-phone" maxlength="40" value="' + escapeHtml(customer.phone || '') + '"></label>' +
        '<label class="profile-email-field"><span>Email / login</span><div class="profile-email-row">' +
          '<input class="profile-email" type="email" maxlength="254" value="' + escapeHtml(customer.email) + '">' +
          '<button class="secondary save-customer-email" type="button">Change Email</button>' +
        '</div><small>Changes the Supabase Auth and customer profile email together, after confirmation.</small>' +
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
    '<details class="customer-admin-settings"><summary>Membership & account controls</summary>' +
      '<p class="customer-footnote">Changes to membership, account access, or login are audited. Account status and membership changes require confirmation.</p>' +
      '<div class="customer-admin-grid">' +
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
      deleteZone(
        'Delete customer',
        'Permanently deletes this customer and their Nexus login (which may also be their Pulse login). Their past orders stay in Core, labelled as a deleted customer. A full copy is kept in the Audit Log.',
        'Type ' + customer.email + ' to confirm',
        'delete-customer',
        escapeHtml,
      ) +
    '</details>'

  return '<article class="customer-card customer-champagne" data-customer-id="' + id + '">' +
    '<header class="customer-card-head customer-profile-heading">' +
      '<div class="customer-profile-ident"><span class="eyebrow">' +
        escapeHtml(customer.customer_number || 'CUSTOMER') + '</span>' +
        '<h2>' + escapeHtml(name) + '</h2>' +
        '<p>' + escapeHtml(customer.email) + '</p></div>' +
      '<div class="customer-status-pills"><span class="customer-status-pill">' +
        escapeHtml(customer.membership?.name || 'No membership') + '</span>' +
        '<span class="customer-status-pill' +
          (customer.account_status.toLowerCase() === 'suspended' ? ' suspended' : '') +
        '">' + escapeHtml(customer.account_status) + '</span></div>' +
    '</header>' +
    '<div class="customer-metrics customer-champagne-metrics">' +
      '<div><span>Orders</span><strong>' + customer.metrics.order_count + '</strong></div>' +
      '<div><span>Lifetime spend</span><strong>' + money(customer.metrics.lifetime_spend) + '</strong></div>' +
      '<div><span>Referrals</span><strong>' + customer.metrics.referral_count + '</strong></div>' +
      '<div><span>Rewards</span><strong>' + customer.metrics.available_reward_count + '</strong></div>' +
    '</div>' +
    '<div class="customer-profile-tabs" role="tablist" aria-label="Customer profile sections">' +
      tab('overview','Overview') + tab('orders','Orders') + tab('rewards','Rewards') + tab('profile','Profile') +
    '</div>' +
    panel('overview',overview) +
    panel('orders',orderHistory) +
    panel('rewards',rewardOverview) +
    panel('profile',profileEditors) +
  '</article>'
}

function bindCustomerProfileTabs(list: HTMLElement) {
  list.querySelectorAll<HTMLElement>('.customer-card').forEach(card=>{
    const tabs = Array.from(card.querySelectorAll<HTMLButtonElement>('[data-customer-tab]'))
    const panels = Array.from(card.querySelectorAll<HTMLElement>('[data-customer-panel]'))
    const activate=(section:string,focus=false)=>{
      const active=tabs.find(t=>t.dataset.customerTab===section)
      if(!active)return
      for(const tab of tabs){
        const selected=tab===active
        tab.setAttribute('aria-selected',String(selected))
        tab.tabIndex=selected?0:-1
      }
      panels.forEach(panel=>{panel.hidden=panel.dataset.customerPanel!==section})
      if(focus)active.focus({preventScroll:true})
    }
    tabs.forEach((tab,index)=>{
      tab.addEventListener('click',()=>activate(tab.dataset.customerTab||'overview'))
      tab.addEventListener('keydown',event=>{
        let next=index
        if(event.key==='ArrowRight')next=(index+1)%tabs.length
        else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length
        else if(event.key==='Home')next=0
        else if(event.key==='End')next=tabs.length-1
        else return
        event.preventDefault()
        activate(tabs[next].dataset.customerTab||'overview',true)
      })
    })
    card.querySelectorAll<HTMLButtonElement>('[data-customer-jump]').forEach(button=>
      button.addEventListener('click',()=>activate(button.dataset.customerJump||'overview',true)))
    activate('overview')
  })
}

const CUSTOMER_DIRECTORY_STATE_KEY='core-customers-directory'
type CustomerDirectoryState = {search:string;membership:string;account:string;activity:string}
function customerDirectoryState():CustomerDirectoryState {
  const fallback={search:'',membership:'all',account:'all',activity:'all'}
  try {
    const saved=JSON.parse(sessionStorage.getItem(CUSTOMER_DIRECTORY_STATE_KEY)||'{}')
    return {
      search:typeof saved.search==='string'?saved.search.slice(0,200):'',
      membership:typeof saved.membership==='string'?saved.membership:'all',
      account: saved.account==='active'||saved.account==='suspended'?saved.account:'all',
      activity: saved.activity==='ordered'||saved.activity==='no-orders'?saved.activity:'all',
    }
  } catch {return fallback}
}
function saveCustomerDirectoryState(state:CustomerDirectoryState){
  try{sessionStorage.setItem(CUSTOMER_DIRECTORY_STATE_KEY,JSON.stringify(state))}catch{/* convenience only */}
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
    '<details class="customer-filter-menu" id="customer-filter-menu">' +
      '<summary aria-label="Show or hide customer search and filters">' +
        '<span class="customer-filter-icon" aria-hidden="true">☰</span><strong>Search & filters</strong>' +
        '<span class="customer-filter-count" id="customer-filter-count" hidden></span></summary>' +
      '<div class="customers-toolbar customer-filter-fields">' +
        '<label class="queue-search"><span class="sr-only">Search customers</span>' +
          '<input id="customers-search" type="search" placeholder="Name, email, phone, customer number…" autocomplete="off"></label>' +
        '<label><span>Membership</span><select id="customers-membership" aria-label="Filter customers by membership">' +
          '<option value="all">All memberships</option></select></label>' +
        '<label><span>Account</span><select id="customers-account" aria-label="Filter customers by account status">' +
          '<option value="all">All accounts</option><option value="active">Active</option>' +
          '<option value="suspended">Suspended</option></select></label>' +
        '<label><span>Orders</span><select id="customers-activity" aria-label="Filter customers by order activity">' +
          '<option value="all">Any activity</option><option value="ordered">Has orders</option>' +
          '<option value="no-orders">No orders yet</option></select></label>' +
      '</div></details>' +
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

    const searchInput=document.querySelector<HTMLInputElement>('#customers-search')
    const accountSelect=document.querySelector<HTMLSelectElement>('#customers-account')
    const activitySelect=document.querySelector<HTMLSelectElement>('#customers-activity')
    const menu=document.querySelector<HTMLDetailsElement>('#customer-filter-menu')
    const filterCount=document.querySelector<HTMLElement>('#customer-filter-count')
    const state=customerDirectoryState()
    if(!memberships.some(m=>m.slug===state.membership))state.membership='all'
    if(searchInput)searchInput.value=state.search
    if(membershipSelect)membershipSelect.value=state.membership
    if(accountSelect)accountSelect.value=state.account
    if(activitySelect)activitySelect.value=state.activity
    const filtersActive=()=>Number(Boolean(state.search))+Number(state.membership!=='all')+
      Number(state.account!=='all')+Number(state.activity!=='all')
    if(menu)menu.open=filtersActive()>0

    const apply=()=>{
      let shown=0
      const byId=new Map(customers.map(customer=>[customer.id,customer]))
      list.querySelectorAll<HTMLElement>('.customer-card').forEach(card=>{
        const customer=byId.get(card.dataset.customerId||'')
        if(!customer)return
        const haystack=[
          nameFor(customer),customer.customer_number,customer.email,customer.phone,
          customer.referral_code,customer.membership?.name,
        ].filter(Boolean).join(' ').toLowerCase()
        const visible=(state.membership==='all'||customer.membership?.slug===state.membership) &&
          (state.account==='all'||customer.account_status.toLowerCase()===state.account) &&
          (state.activity==='all'||(state.activity==='ordered'?customer.metrics.order_count>0:customer.metrics.order_count===0)) &&
          (!state.search||haystack.includes(state.search))
        card.hidden=!visible
        if(visible)shown++
      })
      const summary=document.querySelector<HTMLParagraphElement>('#customers-summary')
      if(summary)summary.textContent=shown+' of '+customers.length+' customers shown.'
      const count=filtersActive()
      if(filterCount){filterCount.hidden=count===0;filterCount.textContent=count+' active'}
      saveCustomerDirectoryState(state)
    }
    searchInput?.addEventListener('input',()=>{
      state.search=searchInput.value.trim().toLowerCase()
      apply()
    })
    membershipSelect?.addEventListener('change',()=>{
      state.membership=membershipSelect.value
      apply()
    })
    accountSelect?.addEventListener('change',()=>{
      state.account=accountSelect.value
      apply()
    })
    activitySelect?.addEventListener('change',()=>{
      state.activity=activitySelect.value
      apply()
    })
    bindCustomerProfileTabs(list)
    list.querySelectorAll<HTMLAnchorElement>('.customer-order-row[data-customer-order-id]').forEach(link=>{
      link.addEventListener('click',()=>presetOrdersSelection(link.dataset.customerOrderId||''))
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
