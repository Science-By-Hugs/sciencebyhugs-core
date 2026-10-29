// Bulk select for the catalog (2026-10-29).
// "Select" puts checkboxes on every product row; the action bar then applies one change to
// every checked product. Each product goes through the same core-catalog-control action the
// single-product buttons use, so validation, stale-edit checks and one audit event per product
// are unchanged. Nothing new runs on the server.
import type { MasterDetailController } from './master-detail'
import {
  removeCatalogProduct,
  setCatalogAvailability,
  setCatalogVisibility,
  updateCatalogProduct,
  type CoreCatalogCategory,
  type CoreCatalogProduct,
} from './services/catalog'

type Helpers = { escapeHtml: (value: unknown) => string; money: (value: number | string | null | undefined) => string }

type BulkOptions = {
  products: CoreCatalogProduct[]
  categories: CoreCatalogCategory[]
  controller: MasterDetailController
  helpers: Helpers
  reload: () => Promise<void>
}

const CONCURRENCY = 3

/** Runs `task` over items a few at a time, reporting progress; never throws. */
async function runAll<T>(
  items: T[],
  task: (item: T) => Promise<unknown>,
  progress: (done: number) => void,
): Promise<Array<{ item: T; error: string }>> {
  const failures: Array<{ item: T; error: string }> = []
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      try { await task(item) } catch (error) {
        failures.push({ item, error: error instanceof Error ? error.message : 'Failed' })
      }
      progress(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return failures
}

export function priceAfter(current: number, mode: 'set' | 'percent', value: number): number | null {
  if (!Number.isFinite(value)) return null
  const next = mode === 'set' ? value : current * (1 + value / 100)
  const rounded = Math.round(next * 100) / 100
  return rounded > 0 && rounded < 1_000_000 ? rounded : null
}

export function bulkToolbarMarkup() {
  return '<button type="button" class="secondary compact catalog-select-toggle" aria-pressed="false">Select</button>'
}

export function bulkBarMarkup(categories: CoreCatalogCategory[], escapeHtml: Helpers['escapeHtml']) {
  const categoryOptions = '<option value="">No category</option>' +
    categories.map(c => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>').join('')
  return '<section class="catalog-bulk-bar" hidden aria-label="Bulk edit selected products">' +
    '<div class="catalog-bulk-head">' +
      '<strong class="catalog-bulk-count" aria-live="polite">0 selected</strong>' +
      '<button type="button" class="ghost compact bulk-select-visible">Select all shown</button>' +
      '<button type="button" class="ghost compact bulk-clear">Clear</button>' +
      '<button type="button" class="ghost compact bulk-done">Done</button>' +
    '</div>' +
    '<div class="catalog-bulk-actions">' +
      '<button type="button" class="secondary compact" data-bulk="sell">Start selling</button>' +
      '<button type="button" class="secondary compact" data-bulk="stop">Stop selling</button>' +
      '<button type="button" class="secondary compact" data-bulk="hide">Hide from Resident/New</button>' +
      '<button type="button" class="secondary compact" data-bulk="unhide">Unhide</button>' +
      '<button type="button" class="secondary compact" data-bulk="feature">Feature</button>' +
      '<button type="button" class="secondary compact" data-bulk="unfeature">Unfeature</button>' +
      '<button type="button" class="danger compact" data-bulk="delete">Delete…</button>' +
    '</div>' +
    '<div class="catalog-bulk-forms">' +
      '<label class="catalog-bulk-field"><span>Category</span><select class="bulk-category">' + categoryOptions + '</select>' +
        '<button type="button" class="secondary compact" data-bulk="category">Set category</button></label>' +
      '<label class="catalog-bulk-field"><span>Price</span>' +
        '<select class="bulk-price-mode" aria-label="How to change the price"><option value="set">Set to $</option><option value="percent">Change by %</option></select>' +
        '<input class="bulk-price-value" inputmode="decimal" placeholder="e.g. 49.99 or -10" aria-label="Price value">' +
        '<button type="button" class="secondary compact" data-bulk="price">Change price</button></label>' +
    '</div>' +
    '<p class="card-message catalog-bulk-message" aria-live="polite"></p>' +
  '</section>'
}

export function bindCatalogBulk(root: HTMLElement, opts: BulkOptions) {
  const { products, categories, controller, helpers, reload } = opts
  const toggle = root.querySelector<HTMLButtonElement>('.catalog-select-toggle')
  const bar = root.querySelector<HTMLElement>('.catalog-bulk-bar')
  if (!toggle || !bar) return
  const count = bar.querySelector<HTMLElement>('.catalog-bulk-count')!
  const message = bar.querySelector<HTMLElement>('.catalog-bulk-message')!
  const actionButtons = Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-bulk]'))
  const say = (text: string) => { message.textContent = text }
  let busy = false

  const chosen = () => {
    const ids = new Set(controller.selectedIds())
    return products.filter(p => ids.has(p.id))
  }
  const refresh = (ids: string[]) => {
    count.textContent = ids.length + ' selected'
    actionButtons.forEach(b => { b.disabled = busy || ids.length === 0 })
  }
  const setMode = (on: boolean) => {
    controller.setSelecting(on)
    toggle.setAttribute('aria-pressed', String(on))
    toggle.textContent = on ? 'Cancel' : 'Select'
    bar.hidden = !on
    say('')
    refresh(controller.selectedIds())
  }

  toggle.addEventListener('click', () => setMode(!controller.isSelecting()))
  bar.querySelector('.bulk-done')!.addEventListener('click', () => setMode(false))
  bar.querySelector('.bulk-clear')!.addEventListener('click', () => controller.clear())
  bar.querySelector('.bulk-select-visible')!.addEventListener('click', () => controller.selectVisible())

  const run = async (
    label: string,
    items: CoreCatalogProduct[],
    task: (p: CoreCatalogProduct) => Promise<unknown>,
  ) => {
    if (!items.length) { say('Nothing to change: every selected product already has that setting.'); return }
    busy = true
    refresh(controller.selectedIds())
    say(label + ' 0 of ' + items.length + '…')
    const failures = await runAll(items, task, done => say(label + ' ' + done + ' of ' + items.length + '…'))
    busy = false
    const ok = items.length - failures.length
    const summary = ok + ' of ' + items.length + ' updated.' +
      (failures.length ? ' Failed: ' + failures.slice(0, 5).map(f => f.item.name + ' (' + f.error + ')').join('; ') +
        (failures.length > 5 ? ' and ' + (failures.length - 5) + ' more.' : '') : '')
    sessionStorage.setItem('core-catalog-bulk-result', summary)
    await reload()
  }

  bar.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-bulk]')
    if (!button || busy) return
    const items = chosen()
    if (!items.length) { say('Select at least one product first.'); return }
    const live = items.filter(p => String(p.storefront_status || '').toLowerCase() !== 'archived')
    const kind = button.dataset.bulk

    if (kind === 'sell') return run('Putting on sale', live.filter(p => !(p.active && p.storefront_status === 'Available')),
      p => setCatalogAvailability(p.id, p.updated_at, true))
    if (kind === 'stop') return run('Taking off sale', live.filter(p => p.active || p.storefront_status === 'Available'),
      p => setCatalogAvailability(p.id, p.updated_at, false))
    if (kind === 'hide') return run('Hiding', live.filter(p => !p.core_hidden), p => setCatalogVisibility(p.id, true))
    if (kind === 'unhide') return run('Unhiding', live.filter(p => p.core_hidden), p => setCatalogVisibility(p.id, false))
    if (kind === 'feature') return run('Featuring', live.filter(p => !p.featured),
      p => updateCatalogProduct(p.id, p.updated_at, { featured: true }))
    if (kind === 'unfeature') return run('Unfeaturing', live.filter(p => p.featured),
      p => updateCatalogProduct(p.id, p.updated_at, { featured: false }))

    if (kind === 'category') {
      const categoryId = bar.querySelector<HTMLSelectElement>('.bulk-category')!.value
      const name = categories.find(c => c.id === categoryId)?.name || 'No category'
      return run('Moving to ' + name, live.filter(p => (p.category_id || '') !== categoryId),
        p => updateCatalogProduct(p.id, p.updated_at, { categoryId }))
    }

    if (kind === 'price') {
      const mode = bar.querySelector<HTMLSelectElement>('.bulk-price-mode')!.value as 'set' | 'percent'
      const raw = bar.querySelector<HTMLInputElement>('.bulk-price-value')!.value.trim().replace(/^\$|%$/g, '')
      const value = Number(raw)
      if (!raw || !Number.isFinite(value)) { say(mode === 'set' ? 'Enter a price like 49.99.' : 'Enter a percent like 10 or -10.'); return }
      const plan = live.map(p => ({ p, next: priceAfter(Number(p.price), mode, value) }))
      const bad = plan.filter(x => x.next === null)
      if (bad.length) { say('That would make ' + bad.length + ' price(s) zero or negative. Nothing was changed.'); return }
      const changes = plan.filter(x => x.next !== Number(x.p.price))
      const sample = changes.slice(0, 3).map(x => x.p.name + ' ' + helpers.money(x.p.price) + ' → ' + helpers.money(x.next)).join('\n')
      if (!window.confirm('Change the price of ' + changes.length + ' product(s)?\n\n' + sample + (changes.length > 3 ? '\n…' : ''))) return
      const nextOf = new Map(changes.map(x => [x.p.id, x.next as number]))
      return run('Repricing', changes.map(x => x.p),
        p => updateCatalogProduct(p.id, p.updated_at, { price: nextOf.get(p.id)!.toFixed(2) }))
    }

    if (kind === 'delete') {
      const names = items.slice(0, 5).map(p => '• ' + p.name).join('\n')
      const ok = window.confirm(
        'Delete ' + items.length + ' product(s)?\n\n' + names + (items.length > 5 ? '\n• …and ' + (items.length - 5) + ' more' : '') +
        '\n\nProducts that have ever been ordered are archived instead (removed from Nexus and your list, ' +
        'kept so past orders and receipts stay intact). The rest are deleted permanently.')
      if (!ok) return
      return run('Deleting', items, p => removeCatalogProduct(p.id))
    }
  })

  // Show the outcome of the last bulk action after the page reloads.
  try {
    const last = sessionStorage.getItem('core-catalog-bulk-result')
    if (last) {
      sessionStorage.removeItem('core-catalog-bulk-result')
      const summary = document.querySelector<HTMLElement>('#catalog-summary')
      if (summary) summary.insertAdjacentHTML('afterend', '<p class="catalog-bulk-result" role="status">' + helpers.escapeHtml(last) + '</p>')
    }
  } catch { /* convenience only */ }

  return refresh
}
