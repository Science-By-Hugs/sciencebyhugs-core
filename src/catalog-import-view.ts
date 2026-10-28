import { csvToObjects, downloadCsv, parseCsv, toCsv } from './csv'
import {
  applyCatalogImport,
  previewCatalogImport,
  type CoreCatalogCategory,
  type CoreCatalogProduct,
  type ImportPreviewResult,
} from './services/catalog'

// Core catalog CSV import / export (2026-10-27).
// Upload -> server preview (nothing saved) -> Apply (one all-or-nothing transaction).
// The CSV is treated as the full catalog: selling products missing from it are taken
// off sale (never deleted). Blank cells leave values unchanged.

export const TEMPLATE_COLUMNS = [
  'product_code', 'name', 'price', 'vendor_cost', 'category', 'product_type', 'ships_from',
  'available', 'featured', 'hide_from_resident_new', 'description', 'image_url',
  'sku', 'research_name', 'purity', 'quantity', 'lot_number', 'coa_url',
]

const MAX_FILE_BYTES = 2 * 1024 * 1024

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
}

type Context = {
  products: CoreCatalogProduct[]
  vendorCosts: Record<string, number>
  categories: CoreCatalogCategory[]
  helpers: Helpers
  reload: () => Promise<void>
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no')
const today = () => new Date().toISOString().slice(0, 10)

export function importPanelMarkup() {
  return '<details class="catalog-editor catalog-create-panel catalog-import-panel">' +
    '<summary><span class="secondary catalog-create-button">Import / Export CSV</span></summary>' +
    '<p class="catalog-editor-note">Upload a CSV to update the whole catalog at once. Nothing is saved until you review the preview and click Apply. ' +
    'The file is treated as your <strong>complete</strong> catalog: products that are selling now but missing from the file are taken off sale (never deleted). ' +
    '<strong>vendor_cost</strong> is Core-only and never shown to customers. Rows match on <strong>product_code</strong>, or on exact <strong>name</strong> when a row has no code; unmatched rows become new products. Blank cells leave values unchanged.</p>' +
    '<div class="catalog-import-actions">' +
      '<button class="secondary compact import-template" type="button">Download template</button>' +
      '<button class="secondary compact import-export" type="button">Export current catalog</button>' +
      '<label class="primary compact catalog-import-upload">Upload CSV<input class="import-file" type="file" accept=".csv,text/csv" hidden></label>' +
    '</div>' +
    '<p class="card-message import-message" aria-live="polite"></p>' +
    '<div class="import-preview"></div>' +
  '</details>'
}

function exportRows(products: CoreCatalogProduct[], categories: CoreCatalogCategory[], vendorCosts: Record<string, number>) {
  const categoryName = new Map(categories.map(category => [category.id, category.name]))
  const live = products
    .filter(product => String(product.storefront_status || '').toLowerCase() !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name))
  return [TEMPLATE_COLUMNS, ...live.map(product => [
    product.product_code, product.name, Number(product.price).toFixed(2),
    Object.prototype.hasOwnProperty.call(vendorCosts, product.id) ? Number(vendorCosts[product.id]).toFixed(2) : '',
    product.category_id ? categoryName.get(product.category_id) || '' : '',
    product.product_type, product.shipping_from,
    yesNo(product.active && String(product.storefront_status || '').toLowerCase() === 'available'),
    yesNo(product.featured), yesNo(product.core_hidden),
    product.description, product.image_url, product.sku, product.research_name,
    product.purity, product.quantity, product.lot_number, product.coa_url,
  ])]
}

function formatValue(value: unknown, field: string, money: Helpers['money']) {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'price' || field === 'vendor_cost') return money(value as number)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  const text = String(value)
  return text.length > 60 ? text.slice(0, 57) + '…' : text
}

function previewMarkup(preview: ImportPreviewResult, categories: CoreCatalogCategory[], helpers: Helpers) {
  const { escapeHtml, money } = helpers
  const categoryName = new Map(categories.map(category => [category.id, category.name]))
  const label = (field: string) => ({
    category_id: 'category', shipping_from: 'ships from', core_hidden: 'hide from Resident/New',
    product_type: 'type', image_url: 'image', coa_url: 'COA', lot_number: 'lot', research_name: 'research name',
    product_code: 'product code', vendor_cost: 'vendor cost',
  } as Record<string, string>)[field] || field
  const show = (field: string, value: unknown) =>
    escapeHtml(field === 'category_id' ? (categoryName.get(String(value)) || formatValue(value, field, money)) : formatValue(value, field, money))
  const s = preview.summary
  const blocked = preview.errors.length > 0
  const nothing = !s.create && !s.update && !s.takeOffSale

  const chip = (text: string, count: number, tone = '') =>
    '<span class="import-chip ' + tone + '"><strong>' + count + '</strong> ' + text + '</span>'

  let html = '<div class="import-summary">' +
    chip('rows', s.rows) + chip('new', s.create, s.create ? 'good' : '') + chip('updated', s.update, s.update ? 'good' : '') +
    chip('unchanged', s.unchanged) + chip('taken off sale', s.takeOffSale, s.takeOffSale ? 'warn' : '') +
    chip('errors', s.errors, s.errors ? 'bad' : '') +
  '</div>'

  if (preview.warnings.length) {
    html += '<div class="import-box warn">' + preview.warnings.map(w => '<p>' + escapeHtml(w) + '</p>').join('') + '</div>'
  }
  if (blocked) {
    html += '<div class="import-box bad"><strong>Fix these in the CSV and upload it again. Nothing has been saved.</strong><ul>' +
      preview.errors.slice(0, 100).map(e => '<li>Row ' + e.row + ': ' + escapeHtml(e.message) + '</li>').join('') +
      (preview.errors.length > 100 ? '<li>…and ' + (preview.errors.length - 100) + ' more</li>' : '') + '</ul></div>'
  }
  if (preview.creates.length) {
    html += '<details class="import-section" open><summary>New products (' + preview.creates.length + ')</summary><ul>' +
      preview.creates.map(c => '<li><span>Row ' + c.row + '</span> <strong>' + escapeHtml(c.name) + '</strong>' +
        (c.product_code ? ' · ' + escapeHtml(c.product_code) : '') + ' · ' + money(c.price) +
        (c.vendor_cost !== null ? ' (cost ' + money(c.vendor_cost) + ')' : '') +
        ' · ' + (c.available ? 'selling' : 'not selling') + '</li>').join('') + '</ul></details>'
  }
  if (preview.updates.length) {
    html += '<details class="import-section" open><summary>Changes to existing products (' + preview.updates.length + ')</summary><ul>' +
      preview.updates.map(u => '<li><span>Row ' + u.row + '</span> <strong>' + escapeHtml(u.name) + '</strong>' +
        (u.matchedBy === 'name' ? ' <em>(matched by name)</em>' : '') +
        '<div class="import-changes">' + u.changes.map(c =>
          '<span>' + escapeHtml(label(c.field)) + ': ' + show(c.field, c.from) + ' → <b>' + show(c.field, c.to) + '</b></span>').join('') +
        '</div></li>').join('') + '</ul></details>'
  }
  if (preview.takeoffs.length) {
    html += '<details class="import-section warn" ' + (preview.takeoffs.length <= 15 ? 'open' : '') + '><summary>Taken off sale — not in this file (' +
      preview.takeoffs.length + ' of ' + s.currentlySelling + ' selling)</summary><ul>' +
      preview.takeoffs.map(t => '<li><strong>' + escapeHtml(t.name) + '</strong>' + (t.product_code ? ' · ' + escapeHtml(t.product_code) : '') + '</li>').join('') +
      '</ul></details>'
  }

  if (!blocked) {
    html += '<div class="import-apply">' +
      (preview.takeoffs.length
        ? '<label class="import-confirm"><input type="checkbox" class="import-confirm-takeoffs"> Yes, take the ' +
          preview.takeoffs.length + ' product(s) above off sale</label>'
        : '') +
      (nothing
        ? '<p class="copy">This file matches the current catalog. There is nothing to apply.</p>'
        : '<button class="primary import-apply-button" type="button"' + (preview.takeoffs.length ? ' disabled' : '') + '>Apply ' +
          (s.create + s.update + s.takeOffSale) + ' change(s)</button>') +
      '<button class="ghost compact import-cancel" type="button">Cancel</button>' +
    '</div>'
  }
  return html
}

export function bindImportPanel(root: HTMLElement, context: Context) {
  const { helpers } = context
  const message = root.querySelector<HTMLElement>('.import-message')
  const previewEl = root.querySelector<HTMLElement>('.import-preview')
  const fileInput = root.querySelector<HTMLInputElement>('.import-file')
  const say = (text: string) => { if (message) message.textContent = text }

  root.querySelector<HTMLButtonElement>('.import-template')?.addEventListener('click', () => {
    downloadCsv('core-catalog-template.csv', toCsv([TEMPLATE_COLUMNS]))
    say('Template downloaded. Tip: “Export current catalog” gives you the same columns already filled in.')
  })

  root.querySelector<HTMLButtonElement>('.import-export')?.addEventListener('click', () => {
    const rows = exportRows(context.products, context.categories, context.vendorCosts)
    downloadCsv('core-catalog-' + today() + '.csv', toCsv(rows))
    say('Exported ' + (rows.length - 1) + ' products (archived products are left out).')
  })

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file || !previewEl) return
    previewEl.innerHTML = ''
    if (file.size > MAX_FILE_BYTES) { say('That file is larger than 2 MB. Split it into smaller files.'); return }

    let rows: Array<Record<string, string>>
    try {
      rows = csvToObjects(parseCsv(await file.text()))
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not read that CSV.')
      return
    }
    if (!rows.length) { say('That CSV has a header row but no products.'); return }

    say('Checking ' + rows.length + ' rows against the live catalog… (nothing is saved yet)')
    let preview: ImportPreviewResult
    try {
      preview = await previewCatalogImport(rows, file.name)
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not check the CSV.')
      return
    }

    say('Preview of “' + file.name + '”. Review it, then Apply. Nothing has been saved yet.')
    previewEl.innerHTML = previewMarkup(preview, context.categories, helpers)

    const confirmBox = previewEl.querySelector<HTMLInputElement>('.import-confirm-takeoffs')
    const applyButton = previewEl.querySelector<HTMLButtonElement>('.import-apply-button')
    confirmBox?.addEventListener('change', () => { if (applyButton) applyButton.disabled = !confirmBox.checked })
    previewEl.querySelector<HTMLButtonElement>('.import-cancel')?.addEventListener('click', () => {
      previewEl.innerHTML = ''
      say('Import cancelled. Nothing was saved.')
    })

    applyButton?.addEventListener('click', async () => {
      if (preview.takeoffs.length && !confirmBox?.checked) return
      applyButton.disabled = true
      applyButton.textContent = 'Applying…'
      say('Applying all changes together…')
      try {
        const result = await applyCatalogImport(rows, file.name, preview.planHash, Boolean(confirmBox?.checked))
        previewEl.innerHTML = ''
        await context.reload()
        const panel = document.querySelector<HTMLDetailsElement>('.catalog-import-panel')
        if (panel) panel.open = true
        const after = document.querySelector<HTMLElement>('.catalog-import-panel .import-message')
        if (after) after.textContent = result.nothingToDo
          ? 'Nothing to apply.'
          : 'Import complete: ' + result.created + ' created, ' + result.updated + ' updated, ' +
            result.takenOffSale + ' taken off sale. Audit events recorded.'
      } catch (error) {
        say(error instanceof Error ? error.message : 'The import failed and nothing was saved.')
        applyButton.disabled = false
        applyButton.textContent = 'Apply changes'
      }
    })
  })
}
