// Discount codes panel in Referrals (2026-10-30).
// - Quick one-time SBH### codes (Free Shipping / Referral Bonus), unchanged backend action.
// - Custom codes: your own code (or auto SBH###), % off or $ off shipping, one-time or reusable,
//   optional expiry, optional assignment to one customer (shows in their Nexus account and only
//   works for them at checkout).
// - Every code can be turned off and back on. All writes go through core-discount-codes.
import {
  createCustomDiscountCode,
  generateDiscountCode,
  loadDiscountCodes,
  searchDiscountCustomers,
  setDiscountCodeActive,
  type DiscountCodeRecord,
  type DiscountCustomer,
} from './services/admin-tools'

type Helpers = { escapeHtml: (value: unknown) => string }

const customerName = (c: DiscountCustomer | null | undefined) =>
  !c ? '' : ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Customer') +
    (c.customer_number ? ' · ' + c.customer_number : '')

export function discountCodesPanelMarkup() {
  return '<section class="referral-panel discount-admin-panel" id="discount-codes">' +
    '<div class="dashboard-section-head"><div><span class="eyebrow">PROMOTIONS</span><h2>Discount codes</h2></div></div>' +

    '<details class="discount-create" open><summary><strong>Create a discount</strong><small>Custom amount, optional expiry, optionally just for one customer.</small></summary>' +
      '<div class="discount-form">' +
        '<label><span>Code</span><input id="dc-code" maxlength="32" autocomplete="off" placeholder="Leave blank for an SBH### code" spellcheck="false"></label>' +
        '<label><span>Shown to the customer as</span><input id="dc-label" maxlength="80" placeholder="e.g. Thank you · 15% off"></label>' +
        '<label><span>Discount</span><span class="dc-amount-row">' +
          '<select id="dc-type" aria-label="Discount type"><option value="percent">% off products</option><option value="shipping">$ off shipping</option></select>' +
          '<input id="dc-amount" inputmode="decimal" placeholder="15" aria-label="Amount"></span></label>' +
        '<label><span>Uses</span><select id="dc-uses"><option value="one">One time</option><option value="many">Reusable</option></select></label>' +
        '<label><span>Expires (optional)</span><input id="dc-expires" type="date" aria-label="Expiry date (optional)"></label>' +
        '<div class="dc-assign"><span class="dc-field-label">Assign to a customer (optional)</span>' +
          '<div class="dc-assign-picked" hidden><strong></strong><button type="button" class="ghost compact dc-unassign">Remove</button></div>' +
          '<input id="dc-customer-search" type="search" autocomplete="off" placeholder="Search name, email or SBH-####">' +
          '<div class="dc-customer-results" role="listbox" aria-label="Customers"></div>' +
          '<small>Assigned codes appear in that customer’s Nexus account and only work for them.</small></div>' +
      '</div>' +
      '<div class="discount-form-actions"><button id="dc-create" class="primary" type="button">Create Discount</button></div>' +
    '</details>' +

    '<details class="discount-quick"><summary><strong>Quick one-time code</strong><small>Free Shipping ($20 off shipping) or Referral Bonus (10% off).</small></summary>' +
      '<div class="discount-generator-row">' +
        '<label><span>Discount type</span><select id="discount-code-kind"><option value="free_shipping">Free Shipping</option><option value="referral_bonus">Referral Bonus</option></select></label>' +
        '<button id="generate-discount-code" class="secondary" type="button">Create Code</button>' +
      '</div>' +
    '</details>' +

    '<div id="generated-discount-code" class="generated-discount-code" hidden></div>' +
    '<p id="discount-generator-message" class="card-message" aria-live="polite"></p>' +
    '<div class="discount-code-filter" role="group" aria-label="Filter discount codes">' +
      '<button type="button" class="ghost compact active" data-code-filter="all">All</button>' +
      '<button type="button" class="ghost compact" data-code-filter="available">Available</button>' +
      '<button type="button" class="ghost compact" data-code-filter="assigned">Assigned</button>' +
      '<button type="button" class="ghost compact" data-code-filter="used">Used</button>' +
      '<button type="button" class="ghost compact" data-code-filter="off">Off / expired</button>' +
    '</div>' +
    '<div class="discount-code-list" id="discount-code-list"><div class="loading">Loading codes…</div></div>' +
  '</section>'
}

export function discountKindLabel(code: Pick<DiscountCodeRecord, 'kind' | 'discount_percent' | 'shipping_discount'> & { label?: string | null }) {
  const amount = code.shipping_discount != null
    ? '$' + Number(code.shipping_discount).toFixed(2).replace(/\.00$/, '') + ' off shipping'
    : code.discount_percent != null ? Number(code.discount_percent) + '% off' : ''
  if (code.kind === 'custom') return 'Custom · ' + amount
  if (code.kind === 'free_shipping') return 'Free Shipping' + (amount ? ' · ' + amount : '')
  if (code.kind === 'referral_bonus') return 'Referral Bonus · ' + amount
  if (code.kind === 'new_customer') return 'New Customer · ' + amount
  return 'Group Buy · ' + amount
}

export function discountStatus(code: Pick<DiscountCodeRecord, 'one_time' | 'used_at' | 'active'> & { expires_at?: string | null }, now = Date.now()) {
  if (!code.active) return 'OFF'
  if (code.one_time && code.used_at) return 'USED'
  if (code.expires_at && new Date(code.expires_at).getTime() <= now) return 'EXPIRED'
  return code.one_time ? 'AVAILABLE' : 'ALWAYS ON'
}

/** End of the chosen day in the browser's time zone, as ISO. */
export function endOfDayIso(dateValue: string) {
  const [y, m, d] = dateValue.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 23, 59, 59).toISOString()
}

export async function bindDiscountCodesPanel(helpers: Helpers) {
  const list = document.querySelector<HTMLDivElement>('#discount-code-list')
  if (!list) return
  const { escapeHtml } = helpers
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
  let codes: DiscountCodeRecord[] = []
  let filter = 'all'
  let picked: DiscountCustomer | null = null

  const message = $('#discount-generator-message')
  const say = (text: string) => { message.textContent = text }
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); say('Copied ' + code + ' to the clipboard.') }
    catch { say('Could not copy automatically. The code is ' + code + '.') }
  }
  const showNew = (code: string) => {
    const output = $('#generated-discount-code')
    output.hidden = false
    output.innerHTML = '<span>NEW CODE</span><strong>' + escapeHtml(code) + '</strong>' +
      '<button type="button" class="secondary" id="copy-generated-code">Copy</button>'
    output.querySelector('#copy-generated-code')?.addEventListener('click', () => void copy(code))
  }

  const render = () => {
    const shown = codes.filter(code => {
      const status = discountStatus(code)
      if (filter === 'available') return status === 'AVAILABLE' || status === 'ALWAYS ON'
      if (filter === 'assigned') return Boolean(code.assigned_profile_id)
      if (filter === 'used') return status === 'USED'
      if (filter === 'off') return status === 'OFF' || status === 'EXPIRED'
      return true
    })
    list.innerHTML = shown.length
      ? shown.map(code => {
          const status = discountStatus(code)
          const meta = [
            code.kind === 'custom' ? (code.one_time ? 'One time' : 'Reusable') : '',
            code.label ? 'Shows as “' + code.label + '”' : '',
            code.assigned ? 'For ' + customerName(code.assigned) : '',
            code.expires_at ? 'Expires ' + new Date(code.expires_at).toLocaleDateString() : '',
          ].filter(Boolean).join(' · ')
          return '<div class="discount-code-admin-row" data-id="' + escapeHtml(code.id) + '">' +
            '<span><strong>' + escapeHtml(code.code) + '</strong><small>' + escapeHtml(discountKindLabel(code)) + '</small>' +
              (meta ? '<small class="dc-meta">' + escapeHtml(meta) + '</small>' : '') + '</span>' +
            '<span class="dc-row-actions">' +
              '<button type="button" class="ghost compact copy-discount-code" data-code="' + escapeHtml(code.code) + '" aria-label="Copy ' + escapeHtml(code.code) + '">Copy</button>' +
              (status === 'USED' ? '' :
                '<button type="button" class="ghost compact toggle-discount-code" data-active="' + (code.active ? 'true' : 'false') + '">' +
                  (code.active ? 'Turn off' : 'Turn on') + '</button>') +
            '</span>' +
            '<b data-status="' + status.toLowerCase().replaceAll(' ', '-') + '">' + status + '</b>' +
          '</div>'
        }).join('')
      : '<p class="dashboard-muted">' + (codes.length ? 'No codes match this filter.' : 'No discount codes yet.') + '</p>'
  }

  try {
    codes = await loadDiscountCodes()
    render()
  } catch {
    list.innerHTML = '<p class="dashboard-muted">Could not load discount codes.</p>'
  }

  list.addEventListener('click', async event => {
    const target = event.target as HTMLElement
    const copyButton = target.closest<HTMLButtonElement>('.copy-discount-code')
    if (copyButton?.dataset.code) { void copy(copyButton.dataset.code); return }
    const toggle = target.closest<HTMLButtonElement>('.toggle-discount-code')
    const id = toggle?.closest<HTMLElement>('.discount-code-admin-row')?.dataset.id
    if (!toggle || !id) return
    const turnOn = toggle.dataset.active !== 'true'
    const code = codes.find(c => c.id === id)?.code || 'this code'
    if (!turnOn && !window.confirm('Turn off ' + code + '? It will stop working at checkout and disappear from any customer’s account. You can turn it back on later.')) return
    toggle.disabled = true
    say((turnOn ? 'Turning on ' : 'Turning off ') + code + '…')
    try {
      codes = await setDiscountCodeActive(id, turnOn)
      render()
      say(code + (turnOn ? ' is on.' : ' is off.') + ' Audit event recorded.')
    } catch (error) {
      toggle.disabled = false
      say(error instanceof Error ? error.message : 'Could not update the code.')
    }
  })

  document.querySelectorAll<HTMLButtonElement>('[data-code-filter]').forEach(button => {
    button.addEventListener('click', () => {
      filter = button.dataset.codeFilter || 'all'
      document.querySelectorAll('[data-code-filter]').forEach(b => b.classList.toggle('active', b === button))
      render()
    })
  })

  // ---- Customer picker ----
  const search = $<HTMLInputElement>('#dc-customer-search')
  const results = $('.dc-customer-results')
  const pickedBox = $('.dc-assign-picked')
  let searchTimer = 0
  let found: DiscountCustomer[] = []
  const setPicked = (customer: DiscountCustomer | null) => {
    picked = customer
    pickedBox.hidden = !customer
    pickedBox.querySelector('strong')!.textContent = customer ? customerName(customer) : ''
    search.hidden = Boolean(customer)
    results.innerHTML = ''
    if (!customer) search.value = ''
  }
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    const q = search.value.trim()
    if (q.length < 2) { results.innerHTML = ''; return }
    searchTimer = window.setTimeout(async () => {
      try {
        found = await searchDiscountCustomers(q)
        results.innerHTML = found.length
          ? found.map((c, i) => '<button type="button" role="option" class="dc-customer" data-i="' + i + '"><strong>' +
              escapeHtml(customerName(c)) + '</strong><small>' + escapeHtml(c.email || '') + '</small></button>').join('')
          : '<p class="dashboard-muted">No customers match.</p>'
      } catch (error) {
        results.innerHTML = '<p class="dashboard-muted">' + escapeHtml(error instanceof Error ? error.message : 'Search failed') + '</p>'
      }
    }, 250)
  })
  results.addEventListener('click', event => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>('.dc-customer')
    if (b) setPicked(found[Number(b.dataset.i)] || null)
  })
  pickedBox.querySelector('.dc-unassign')!.addEventListener('click', () => setPicked(null))

  // iOS Safari leaves an empty date input blank; mark when it has a value so CSS can show a hint.
  const expiresInput = $<HTMLInputElement>('#dc-expires')
  const syncDate = () => expiresInput.classList.toggle('has-value', Boolean(expiresInput.value))
  expiresInput.addEventListener('input', syncDate)
  expiresInput.addEventListener('change', syncDate)

  // ---- Create custom discount ----
  const typeSelect = $<HTMLSelectElement>('#dc-type')
  const amountInput = $<HTMLInputElement>('#dc-amount')
  typeSelect.addEventListener('change', () => { amountInput.placeholder = typeSelect.value === 'percent' ? '15' : '20' })

  $<HTMLButtonElement>('#dc-create').addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    const codeValue = $<HTMLInputElement>('#dc-code').value.trim().toUpperCase()
    const amount = amountInput.value.trim()
    const expires = $<HTMLInputElement>('#dc-expires').value
    if (codeValue && !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(codeValue)) { say('Codes are 3–32 letters, numbers, - or _.'); return }
    if (!amount || !(Number(amount.replace(/[$%]/g, '')) > 0)) { say('Enter how much the discount is worth.'); return }
    if (typeSelect.value === 'percent' && Number(amount.replace(/%/g, '')) > 100) { say('Percent off can be at most 100.'); return }
    button.disabled = true
    say('Creating discount…')
    try {
      const result = await createCustomDiscountCode({
        code: codeValue,
        label: $<HTMLInputElement>('#dc-label').value.trim(),
        type: typeSelect.value === 'shipping' ? 'shipping' : 'percent',
        amount,
        oneTime: $<HTMLSelectElement>('#dc-uses').value === 'one',
        expiresAt: expires ? endOfDayIso(expires) : null,
        assignedProfileId: picked?.id || null,
      })
      codes = result.codes
      render()
      showNew(result.code.code)
      say(result.code.code + ' created' + (picked ? ' for ' + customerName(picked) + '. It now shows in their account.' : '.') + ' Audit event recorded.')
      ;['#dc-code', '#dc-label', '#dc-expires'].forEach(sel => { $<HTMLInputElement>(sel).value = '' })
      syncDate()
      amountInput.value = ''
      setPicked(null)
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not create discount.')
    } finally {
      button.disabled = false
    }
  })

  // ---- Quick SBH### code (existing action) ----
  $<HTMLButtonElement>('#generate-discount-code').addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    const kind = $<HTMLSelectElement>('#discount-code-kind').value === 'referral_bonus' ? 'referral_bonus' : 'free_shipping'
    button.disabled = true
    say('Creating a one-time code…')
    try {
      const result = await generateDiscountCode(kind)
      codes = result.codes
      render()
      showNew(result.code.code)
      say(result.code.code + ' is ready for one-time use. Audit event recorded.')
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not create discount code.')
    } finally {
      button.disabled = false
    }
  })
}
