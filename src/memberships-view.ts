import { listCoreMemberships, saveCoreMembership, type CoreMembership } from './services/memberships'

type Helpers = { escapeHtml: (value: unknown) => string }
const slugify = (value: string) => value.trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120)

export function membershipsPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">CUSTOMER PROGRAMS</span><h1 class="dashboard-title">Memberships</h1>' +
    '<p class="copy">Manage the membership plans used by customer accounts. No checkout or customer changes happen until you save.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section id="memberships-root" aria-live="polite"><div class="loading">Loading memberships…</div></section>'
}

function membershipForm(plan: CoreMembership | null, escapeHtml: Helpers['escapeHtml']) {
  const e = escapeHtml
  const isFounding = plan?.slug === 'founding-member'
  const benefits = (Array.isArray(plan?.benefits) ? plan.benefits : []).join('\n')
  return '<form class="membership-plan-form" data-plan-id="' + e(plan?.id || '') + '">' +
    '<div class="membership-form-grid">' +
      '<label><span>Membership name</span><input name="name" required maxlength="120" value="' + e(plan?.name || '') + '"' +
        (isFounding ? ' readonly aria-describedby="membership-founders-note"' : '') + '></label>' +
      '<label><span>Stable internal identifier</span><input name="slug" required maxlength="120" value="' + e(plan?.slug || '') + '"' +
        (plan ? ' readonly' : ' placeholder="e.g. premium-researcher"') + '></label>' +
      '<label class="membership-form-wide"><span>Description</span><textarea name="description" maxlength="2000" rows="2">' +
        e(plan?.description || '') + '</textarea></label>' +
      '<label class="membership-form-wide"><span>Benefits (one line per benefit, up to 20)</span>' +
        '<textarea name="benefits" rows="4">' + e(benefits) + '</textarea></label>' +
      '<label><span>Display order</span><input name="sortOrder" type="number" min="0" max="10000" value="' +
        e(plan?.sort_order ?? 10) + '"></label>' +
      '<label class="membership-active-label"><input name="active" type="checkbox"' +
        (plan?.active ?? true ? ' checked' : '') + '> Active plan</label>' +
    '</div>' +
    (isFounding ? '<small class="membership-form-note" id="membership-founders-note">Founding Member is protected because checkout currently uses this exact name for shipping benefits.</small>' : '') +
    '<p class="membership-form-note">Benefit descriptions do not automatically create payment discounts, shipping waivers, subscriptions, or access permissions. Existing customers remain assigned if a plan becomes inactive.</p>' +
    '<div class="membership-form-actions"><button class="primary" type="submit">' +
      (plan ? 'Save membership' : 'Create membership') + '</button>' +
      '<span class="membership-form-status" role="status" aria-live="polite"></span></div>' +
  '</form>'
}

export async function bindMembershipsPage(helpers: Helpers) {
  const root = document.querySelector<HTMLElement>('#memberships-root')
  if (!root) return
  const e = helpers.escapeHtml
  try {
    const memberships = await listCoreMemberships()
    const active = memberships.filter(plan => plan.active).length
    const assigned = memberships.reduce((total, plan) => total + Number(plan.assigned_customers || 0), 0)
    root.innerHTML =
      '<div class="membership-summary">' +
        '<div><small>Plans</small><strong>' + memberships.length + '</strong></div>' +
        '<div><small>Active plans</small><strong>' + active + '</strong></div>' +
        '<div><small>Customer assignments</small><strong>' + assigned + '</strong></div>' +
      '</div>' +
      '<details class="membership-create"><summary class="primary">+ Create membership</summary>' +
        membershipForm(null, e) + '</details>' +
      '<div class="membership-list">' +
      memberships.map(plan =>
        '<article class="membership-card">' +
          '<div class="membership-card-head"><div><small>Membership plan</small><h2>' + e(plan.name) + '</h2>' +
            '<p class="membership-slug">' + e(plan.slug) + '</p></div>' +
            '<div class="membership-card-stats"><span class="' + (plan.active ? 'membership-active' : 'membership-inactive') + '">' +
              (plan.active ? 'Active' : 'Inactive') + '</span><span>' + Number(plan.assigned_customers || 0) + ' customers</span></div>' +
          '</div>' +
          (plan.description ? '<p class="membership-description">' + e(plan.description) + '</p>' : '') +
          '<ul class="membership-benefits">' +
            (Array.isArray(plan.benefits) && plan.benefits.length
              ? plan.benefits.map(benefit => '<li>' + e(benefit) + '</li>').join('')
              : '<li>No benefits listed</li>') +
          '</ul>' +
          '<details class="membership-editor"><summary>Edit membership</summary>' +
            membershipForm(plan, e) + '</details>' +
        '</article>'
      ).join('') +
      '</div>' +
      '<p class="membership-form-note">To assign a customer to an existing membership, use Customers. No membership deletions are offered here so existing customer links remain intact.</p>'

    root.querySelectorAll<HTMLFormElement>('.membership-plan-form').forEach(form => {
      const name = form.querySelector<HTMLInputElement>('[name=name]')
      const slug = form.querySelector<HTMLInputElement>('[name=slug]')
      if (!form.dataset.planId && name && slug) {
        let slugEdited = false
        slug.addEventListener('input', () => { slugEdited = true })
        name.addEventListener('input', () => { if (!slugEdited) slug.value = slugify(name.value) })
      }
      form.addEventListener('submit', async event => {
        event.preventDefault()
        const id = form.dataset.planId || ''
        const prior = memberships.find(plan => plan.id === id)
        const get = (field: string) =>
          form.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="' + field + '"]')?.value.trim() || ''
        const benefits = get('benefits').split('\n').map(line => line.trim()).filter(Boolean)
        const active = form.querySelector<HTMLInputElement>('[name=active]')?.checked === true
        const sortOrder = Number(get('sortOrder'))
        const status = form.querySelector<HTMLElement>('.membership-form-status')
        const button = form.querySelector<HTMLButtonElement>('button[type=submit]')
        if (benefits.length > 20 || benefits.some(benefit => benefit.length > 200)) {
          if (status) status.textContent = 'Use at most 20 benefits, each 200 characters or fewer.'
          return
        }
        if (prior && prior.active && !active && prior.assigned_customers > 0 &&
          !window.confirm('This membership has existing customers. Mark it inactive? Existing assignments and checkout benefits will not be revoked.')) return

        if (button) button.disabled = true
        if (status) status.textContent = 'Saving…'
        try {
          await saveCoreMembership({
            ...(prior ? { id: prior.id, expectedUpdatedAt: prior.updated_at } : {}),
            name: get('name'), slug: get('slug'), description: get('description'),
            benefits, sortOrder, active,
          })
          if (status) status.textContent = 'Saved and audited.'
          await bindMembershipsPage(helpers)
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : 'Could not save membership.'
          if (button) button.disabled = false
        }
      })
    })
  } catch (error) {
    root.innerHTML = '<section class="empty-state error-state"><h2>Memberships unavailable</h2><p>' +
      e(error instanceof Error ? error.message : 'Could not load memberships.') +
      '</p></section>'
  }
}
