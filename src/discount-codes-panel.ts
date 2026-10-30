// Discount codes panel (moved from Settings into Referrals, 2026-10-30).
// Uses the existing core-discount-codes Edge Function unchanged: list codes, and generate a
// one-time SBH### code (Free Shipping = $20 off shipping, Referral Bonus = 10% off).
import { generateDiscountCode, loadDiscountCodes, type DiscountCodeRecord } from './services/admin-tools'

type Helpers = { escapeHtml: (value: unknown) => string }

export function discountCodesPanelMarkup() {
  return '<section class="referral-panel discount-admin-panel" id="discount-codes">' +
    '<div class="dashboard-section-head"><div><span class="eyebrow">PROMOTIONS</span><h2>Discount codes</h2></div></div>' +
    '<p class="admin-note">Create a one-time code for Free Shipping ($20 off shipping) or Referral Bonus (10% off). Codes use the SBH### format and are used up after one order.</p>' +
    '<div class="discount-generator-row">' +
      '<label><span>Discount type</span><select id="discount-code-kind"><option value="free_shipping">Free Shipping</option><option value="referral_bonus">Referral Bonus</option></select></label>' +
      '<button id="generate-discount-code" class="primary" type="button">Create Code</button>' +
    '</div>' +
    '<div id="generated-discount-code" class="generated-discount-code" hidden></div>' +
    '<p id="discount-generator-message" class="card-message" aria-live="polite"></p>' +
    '<div class="discount-code-filter" role="group" aria-label="Filter discount codes">' +
      '<button type="button" class="ghost compact active" data-code-filter="all">All</button>' +
      '<button type="button" class="ghost compact" data-code-filter="available">Available</button>' +
      '<button type="button" class="ghost compact" data-code-filter="used">Used</button>' +
    '</div>' +
    '<div class="discount-code-list" id="discount-code-list"><div class="loading">Loading codes…</div></div>' +
  '</section>'
}

export function discountKindLabel(code: Pick<DiscountCodeRecord, 'kind' | 'discount_percent' | 'shipping_discount'>) {
  if (code.kind === 'free_shipping') return 'Free Shipping' + (code.shipping_discount ? ' · $' + Number(code.shipping_discount) + ' off shipping' : '')
  const pct = code.discount_percent != null ? ' · ' + Number(code.discount_percent) + '%' : ''
  if (code.kind === 'referral_bonus') return 'Referral Bonus' + pct
  if (code.kind === 'new_customer') return 'New Customer' + pct
  return 'Group Buy' + pct
}

export function discountStatus(code: Pick<DiscountCodeRecord, 'one_time' | 'used_at' | 'active'>) {
  if (!code.active) return 'INACTIVE'
  if (!code.one_time) return 'ALWAYS ON'
  return code.used_at ? 'USED' : 'AVAILABLE'
}

export async function bindDiscountCodesPanel(helpers: Helpers) {
  const list = document.querySelector<HTMLDivElement>('#discount-code-list')
  if (!list) return
  let codes: DiscountCodeRecord[] = []
  let filter = 'all'

  const render = () => {
    const shown = codes.filter(code => {
      const status = discountStatus(code)
      return filter === 'all' || (filter === 'used' ? status === 'USED' : status === 'AVAILABLE' || status === 'ALWAYS ON')
    })
    list.innerHTML = shown.length
      ? shown.map(code => {
          const status = discountStatus(code)
          return '<div class="discount-code-admin-row">' +
            '<span><strong>' + helpers.escapeHtml(code.code) + '</strong><small>' + helpers.escapeHtml(discountKindLabel(code)) + '</small></span>' +
            '<button type="button" class="ghost compact copy-discount-code" data-code="' + helpers.escapeHtml(code.code) + '" aria-label="Copy ' + helpers.escapeHtml(code.code) + '">Copy</button>' +
            '<b data-status="' + status.toLowerCase().replaceAll(' ', '-') + '">' + status + '</b>' +
          '</div>'
        }).join('')
      : '<p class="dashboard-muted">' + (codes.length ? 'No codes match this filter.' : 'No discount codes yet.') + '</p>'
  }

  const message = document.querySelector<HTMLParagraphElement>('#discount-generator-message')
  const say = (text: string) => { if (message) message.textContent = text }
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); say('Copied ' + code + ' to the clipboard.') }
    catch { say('Could not copy automatically. The code is ' + code + '.') }
  }

  try {
    codes = await loadDiscountCodes()
    render()
  } catch {
    list.innerHTML = '<p class="dashboard-muted">Could not load discount codes.</p>'
  }

  list.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.copy-discount-code')
    if (button?.dataset.code) void copy(button.dataset.code)
  })

  document.querySelectorAll<HTMLButtonElement>('[data-code-filter]').forEach(button => {
    button.addEventListener('click', () => {
      filter = button.dataset.codeFilter || 'all'
      document.querySelectorAll('[data-code-filter]').forEach(b => b.classList.toggle('active', b === button))
      render()
    })
  })

  document.querySelector<HTMLButtonElement>('#generate-discount-code')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    const select = document.querySelector<HTMLSelectElement>('#discount-code-kind')
    const output = document.querySelector<HTMLDivElement>('#generated-discount-code')
    const kind = select?.value === 'referral_bonus' ? 'referral_bonus' : 'free_shipping'
    button.disabled = true
    say('Creating a one-time code…')
    try {
      const result = await generateDiscountCode(kind)
      codes = result.codes
      render()
      if (output) {
        output.hidden = false
        output.innerHTML = '<span>NEW CODE</span><strong>' + helpers.escapeHtml(result.code.code) + '</strong>' +
          '<button type="button" class="secondary" id="copy-generated-code">Copy</button>'
        output.querySelector('#copy-generated-code')?.addEventListener('click', () => void copy(result.code.code))
      }
      say(result.code.code + ' is ready for one-time use. Audit event recorded.')
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not create discount code.')
    } finally {
      button.disabled = false
    }
  })
}
