import {
  createCatalogProduct,
  deleteShippingRate,
  listShippingRates,
  loadCoreCatalog,
  removeCatalogProduct,
  setCatalogAvailability,
  setCatalogVisibility,
  setShippingRate,
  updateCatalogProduct,
  type CoreCatalogCategory,
  type CoreCatalogProduct,
  type ProductInput,
} from './services/catalog'
import { bindImportPanel, importPanelMarkup } from './catalog-import-view'

// Google exit (2026-10-27): Core is the source of truth for the Nexus catalog.
// Products are created and edited here; there is no Google Sheet sync.

const CATALOG_VIEW_STATE_KEY = 'sciencebyhugs-core:catalog-view-state'

type CatalogViewState = {
  search: string
  category: string
  state: string
}

function loadCatalogViewState(): CatalogViewState {
  try {
    const raw = sessionStorage.getItem(CATALOG_VIEW_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CatalogViewState>
      return {
        search: typeof parsed.search === 'string' ? parsed.search : '',
        category: typeof parsed.category === 'string' ? parsed.category : 'all',
        state: typeof parsed.state === 'string' ? parsed.state : 'all',
      }
    }
  } catch {
    // Fall back to defaults if session storage is unavailable.
  }
  return { search: '', category: 'all', state: 'all' }
}

function saveCatalogViewState(value: CatalogViewState) {
  try {
    sessionStorage.setItem(CATALOG_VIEW_STATE_KEY, JSON.stringify(value))
  } catch {
    // The current view still works even if storage is unavailable.
  }
}

type Helpers = {
  escapeHtml: (value: unknown) => string
  money: (value: number | string | null | undefined) => string
  dateTime: (value: string | null | undefined) => string
}

const isArchived = (product: CoreCatalogProduct) =>
  String(product.storefront_status || '').toLowerCase() === 'archived'

const isSelling = (product: CoreCatalogProduct) =>
  product.active && String(product.storefront_status || '').toLowerCase() === 'available'

function productForm(
  product: CoreCatalogProduct | null,
  categories: CoreCatalogCategory[],
  rates: Record<string, number>,
  helpers: Helpers,
) {
  const { escapeHtml, money } = helpers
  const v = (value: unknown) => escapeHtml(value ?? '')
  const shippingSources = Object.keys(rates).sort((a, b) => a.localeCompare(b))
  const currentShip = product?.shipping_from || ''
  const shipOptions = ['<option value="">No shipping charge</option>']
    .concat(shippingSources.map(source =>
      '<option value="' + v(source) + '"' + (source === currentShip ? ' selected' : '') + '>' +
      v(source) + ' (' + money(rates[source]) + ')</option>'))
  if (currentShip && !shippingSources.includes(currentShip)) {
    shipOptions.push('<option value="' + v(currentShip) + '" selected>' + v(currentShip) + ' (no rate set)</option>')
  }
  const categoryOptions = ['<option value="">No category</option>']
    .concat(categories.map(category =>
      '<option value="' + v(category.id) + '"' + (category.id === product?.category_id ? ' selected' : '') + '>' +
      v(category.name) + '</option>'))
  const checked = (value: boolean | undefined) => (value ? ' checked' : '')
  const available = product ? isSelling(product) : true

  return '<div class="catalog-editor-grid catalog-product-form">' +
    '<label class="catalog-span-2"><span>Product name *</span><input name="name" maxlength="200" required value="' + v(product?.name) + '"></label>' +
    '<label><span>Price (USD) *</span><input name="price" inputmode="decimal" placeholder="49.99" value="' + v(product ? Number(product.price).toFixed(2) : '') + '"></label>' +
    '<label><span>Category</span><select name="categoryId">' + categoryOptions.join('') + '</select></label>' +
    '<label><span>Product type</span><input name="productType" maxlength="120" placeholder="e.g. Peptide" value="' + v(product?.product_type) + '"></label>' +
    '<label><span>Ships from</span><select name="shippingFrom">' + shipOptions.join('') + '</select></label>' +
    '<label class="catalog-span-2"><span>Description</span><textarea name="description" maxlength="5000" rows="3">' + v(product?.description) + '</textarea></label>' +
    '<label class="catalog-span-2"><span>Image URL</span><input name="imageUrl" type="url" maxlength="1000" placeholder="https://…" value="' + v(product?.image_url) + '"></label>' +
    '<div class="catalog-span-2 catalog-checks">' +
      '<label><input type="checkbox" name="available"' + checked(available) + '> Selling on Nexus</label>' +
      '<label><input type="checkbox" name="featured"' + checked(product?.featured) + '> Featured</label>' +
      '<label><input type="checkbox" name="coreHidden"' + checked(product?.core_hidden) + '> Hide from Resident/New tiers</label>' +
    '</div>' +
    '<label><span>Product code</span><input name="productCode" maxlength="120" value="' + v(product?.product_code) + '"></label>' +
    '<label><span>SKU</span><input name="sku" maxlength="120" value="' + v(product?.sku) + '"></label>' +
    '<label><span>Research name</span><input name="researchName" maxlength="200" value="' + v(product?.research_name) + '"></label>' +
    '<label><span>Purity</span><input name="purity" maxlength="120" value="' + v(product?.purity) + '"></label>' +
    '<label><span>Quantity</span><input name="quantity" maxlength="120" value="' + v(product?.quantity) + '"></label>' +
    '<label><span>Lot number</span><input name="lotNumber" maxlength="120" value="' + v(product?.lot_number) + '"></label>' +
    '<label class="catalog-span-2"><span>COA URL</span><input name="coaUrl" type="url" maxlength="1000" placeholder="https://…" value="' + v(product?.coa_url) + '"></label>' +
  '</div>'
}

function readProductForm(root: HTMLElement): ProductInput {
  const text = (name: string) =>
    (root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[name="' + name + '"]')?.value || '').trim()
  const box = (name: string) => Boolean(root.querySelector<HTMLInputElement>('[name="' + name + '"]')?.checked)
  return {
    name: text('name'),
    price: text('price'),
    categoryId: text('categoryId'),
    productType: text('productType'),
    shippingFrom: text('shippingFrom'),
    description: text('description'),
    imageUrl: text('imageUrl'),
    productCode: text('productCode'),
    sku: text('sku'),
    researchName: text('researchName'),
    purity: text('purity'),
    quantity: text('quantity'),
    lotNumber: text('lotNumber'),
    coaUrl: text('coaUrl'),
    featured: box('featured'),
    available: box('available'),
    coreHidden: box('coreHidden'),
  }
}

function validateProductInput(input: ProductInput): string | null {
  if (!input.name) return 'Product name is required.'
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(input.price.replace(/^\$/, ''))) return 'Price must look like 49 or 49.99.'
  return null
}

function productCard(
  product: CoreCatalogProduct,
  categories: CoreCatalogCategory[],
  rates: Record<string, number>,
  helpers: Helpers,
) {
  const { escapeHtml, money, dateTime } = helpers
  const identifier = product.product_code || product.sku || 'No code'
  const archived = isArchived(product)
  const selling = isSelling(product)
  const statusLabel = archived ? 'Archived' : selling ? 'Selling on Nexus' : 'Not selling'
  const statusClass = selling ? 'active' : 'inactive'
  const shipRate = product.shipping_from && Object.prototype.hasOwnProperty.call(rates, product.shipping_from)
    ? ' · ' + money(rates[product.shipping_from])
    : ''

  return '<article class="catalog-card" data-product-id="' + escapeHtml(product.id) + '">' +
    '<div class="catalog-card-head">' +
      '<div><span class="eyebrow">' + escapeHtml(identifier) + '</span>' +
      '<h2>' + escapeHtml(product.name) + '</h2>' +
      '<p>' + escapeHtml(product.product_type || 'Unclassified') + ' · ' +
        escapeHtml(product.category?.name || 'No category') + '</p></div>' +
      '<div class="catalog-tags">' +
        '<span class="catalog-status ' + statusClass + '">' + statusLabel + '</span>' +
        (product.core_hidden ? '<span class="catalog-status inactive">Hidden from Resident/New</span>' : '') +
        (product.featured ? '<span class="catalog-storefront">Featured</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="catalog-meta-grid">' +
      '<div><span>Price</span><strong>' + money(product.price) + '</strong></div>' +
      '<div><span>Ships from</span><strong>' + escapeHtml((product.shipping_from || '—') + shipRate) + '</strong></div>' +
      '<div><span>COA</span><strong>' + (product.coa_url ? 'Available' : 'Missing') + '</strong></div>' +
      '<div><span>Last updated</span><strong>' + escapeHtml(dateTime(product.updated_at)) + '</strong></div>' +
    '</div>' +
    '<div class="catalog-detail-row">' +
      '<span>Research name <strong>' + escapeHtml(product.research_name || '—') + '</strong></span>' +
      '<span>Purity <strong>' + escapeHtml(product.purity || '—') + '</strong></span>' +
      '<span>Quantity <strong>' + escapeHtml(product.quantity || '—') + '</strong></span>' +
      '<span>Lot <strong>' + escapeHtml(product.lot_number || '—') + '</strong></span>' +
    '</div>' +
    '<div class="invoice-actions">' +
      (product.coa_url
        ? '<a class="button secondary" href="' + escapeHtml(product.coa_url) + '" target="_blank" rel="noreferrer">Open COA</a>'
        : '') +
      '<button class="secondary toggle-catalog-availability" type="button">' +
        (selling ? 'Stop selling' : archived ? 'Restore & sell' : 'Start selling') +
      '</button>' +
      (archived ? '' :
        '<button class="secondary toggle-catalog-visibility" type="button">' +
          (product.core_hidden ? 'Unhide from Resident/New' : 'Hide from Resident/New') +
        '</button>' +
        '<button class="danger remove-catalog-product" type="button">Delete</button>') +
      '<span class="card-message catalog-visibility-message" aria-live="polite"></span>' +
    '</div>' +
    '<details class="catalog-editor"><summary>Edit product</summary>' +
      productForm(product, categories, rates, helpers) +
      '<div class="catalog-editor-actions"><p class="card-message catalog-editor-message" aria-live="polite"></p>' +
      '<button class="primary save-catalog-product" type="button">Save Product</button></div>' +
    '</details>' +
  '</article>'
}

function shippingPanel(rates: Record<string, number>, helpers: Helpers) {
  const { escapeHtml, money } = helpers
  const rows = Object.keys(rates).sort((a, b) => a.localeCompare(b)).map(source =>
    '<div class="catalog-rate-row" data-source="' + escapeHtml(source) + '">' +
      '<strong>' + escapeHtml(source) + '</strong>' +
      '<input class="catalog-rate-input" inputmode="decimal" aria-label="Rate for ' + escapeHtml(source) + '" value="' + escapeHtml(Number(rates[source]).toFixed(2)) + '">' +
      '<button class="secondary compact save-rate" type="button">Save</button>' +
      '<button class="ghost compact delete-rate" type="button">Remove</button>' +
    '</div>').join('')
  return '<details class="catalog-ops-panel catalog-shipping-panel"><summary><span class="eyebrow">SHIPPING</span>' +
    '<strong>Shipping rates</strong><small>Charged once per order for each “ships from” source in the cart. Currently ' +
    Object.keys(rates).length + ' sources.</small></summary>' +
    '<div class="catalog-rate-list">' + (rows || '<p class="copy">No shipping sources yet.</p>') + '</div>' +
    '<div class="catalog-rate-row catalog-rate-new">' +
      '<input class="catalog-rate-new-source" maxlength="120" placeholder="New source name, e.g. Shipping - Vendor X">' +
      '<input class="catalog-rate-new-rate" inputmode="decimal" placeholder="Rate e.g. 20">' +
      '<button class="primary compact add-rate" type="button">Add</button>' +
    '</div>' +
    '<p class="card-message catalog-rate-message" aria-live="polite"></p>' +
    '<small class="catalog-rate-hint">Current flat rates: ' + escapeHtml(Object.entries(rates).map(([k, r]) => k + ' ' + money(r)).join(' · ')) + '</small>' +
  '</details>'
}

export function catalogPageMarkup(email: string, escapeHtml: Helpers['escapeHtml']) {
  return '<section class="dashboard-head dashboard-head-compact"><div>' +
    '<span class="eyebrow">PRODUCT OPERATIONS</span><h1 class="dashboard-title">Catalog</h1>' +
    '<p class="copy">Core is the source of truth for the Nexus catalog. Changes here show on Nexus the next time a customer loads the store.</p>' +
    '</div><div class="operator">Signed in as <strong>' + escapeHtml(email) + '</strong></div></section>' +
    '<section class="catalog-create-wrap" id="catalog-create"></section>' +
    '<section class="catalog-metrics" id="catalog-metrics"></section>' +
    '<section class="catalog-ops-grid">' +
      '<div id="catalog-shipping"></div>' +
      '<div class="catalog-ops-panel" id="catalog-metadata-health"></div>' +
    '</section>' +
    '<section class="catalog-queue-panel" id="catalog-action-queue"></section>' +
    '<section class="catalog-toolbar"><label class="queue-search"><span class="sr-only">Search catalog</span>' +
    '<input id="catalog-search" type="search" placeholder="Search product, type, code, category…" autocomplete="off"></label>' +
    '<select id="catalog-category" aria-label="Filter catalog by category"><option value="all">All categories</option></select>' +
    '<select id="catalog-state" aria-label="Filter catalog by state">' +
      '<option value="all">All (not archived)</option><option value="selling">Selling on Nexus</option>' +
      '<option value="not-selling">Not selling</option><option value="hidden">Hidden from Resident/New</option>' +
      '<option value="featured">Featured</option>' +
      '<option value="metadata-incomplete">Metadata incomplete</option><option value="coa-missing">Missing COA</option>' +
      '<option value="uncategorized">Uncategorized</option><option value="archived">Archived</option>' +
    '</select></section>' +
    '<p class="queue-summary" id="catalog-summary" aria-live="polite"></p>' +
    '<section class="catalog-list" id="catalog-list"><div class="loading">Loading catalog…</div></section>'
}

export async function bindCatalogPage(helpers: Helpers) {
  const list = document.querySelector<HTMLDivElement>('#catalog-list')
  if (!list) return

  try {
    const [payload, rates] = await Promise.all([loadCoreCatalog(), listShippingRates()])
    const { products, categories, operations } = payload

    // ---------- New product ----------
    const createEl = document.querySelector<HTMLElement>('#catalog-create')
    if (createEl) {
      createEl.innerHTML =
        '<details class="catalog-editor catalog-create-panel"><summary><span class="primary catalog-create-button">+ New product</span></summary>' +
          '<p class="catalog-editor-note">New products are saved directly to the live catalog. Leave “Selling on Nexus” off to prepare a product before it goes on sale.</p>' +
          productForm(null, categories, rates, helpers) +
          '<div class="catalog-editor-actions"><p class="card-message catalog-create-message" aria-live="polite"></p>' +
          '<button class="primary create-catalog-product" type="button">Create Product</button></div>' +
        '</details>'
      createEl.insertAdjacentHTML('beforeend', importPanelMarkup())
      const importPanel = createEl.querySelector<HTMLElement>('.catalog-import-panel')
      if (importPanel) {
        bindImportPanel(importPanel, {
          products,
          categories,
          helpers,
          reload: () => bindCatalogPage(helpers),
        })
      }
      const createButton = createEl.querySelector<HTMLButtonElement>('.create-catalog-product')
      const createMessage = createEl.querySelector<HTMLElement>('.catalog-create-message')
      createButton?.addEventListener('click', async () => {
        const form = createEl.querySelector<HTMLElement>('.catalog-product-form')
        if (!form) return
        const input = readProductForm(form)
        const problem = validateProductInput(input)
        if (problem) { if (createMessage) createMessage.textContent = problem; return }
        createButton.disabled = true
        createButton.textContent = 'Creating…'
        if (createMessage) createMessage.textContent = 'Saving to the live catalog…'
        try {
          const created = await createCatalogProduct(input)
          if (createMessage) createMessage.textContent = created.name + ' created. Audit event recorded.'
          saveCatalogViewState({ search: created.name.toLowerCase(), category: 'all', state: 'all' })
          await bindCatalogPage(helpers)
        } catch (error) {
          if (createMessage) createMessage.textContent = error instanceof Error ? error.message : 'Could not create product.'
          createButton.disabled = false
          createButton.textContent = 'Create Product'
        }
      })
    }

    // ---------- Metrics ----------
    const live = products.filter(product => !isArchived(product))
    const metricEl = document.querySelector<HTMLDivElement>('#catalog-metrics')
    if (metricEl) {
      metricEl.innerHTML =
        '<div><span>Products</span><strong>' + live.length + '</strong></div>' +
        '<div><span>Selling on Nexus</span><strong>' + live.filter(isSelling).length + '</strong></div>' +
        '<div><span>Not selling</span><strong>' + live.filter(product => !isSelling(product)).length + '</strong></div>' +
        '<div><span>Hidden from Resident/New</span><strong>' + live.filter(product => product.core_hidden).length + '</strong></div>' +
        '<div><span>Featured</span><strong>' + live.filter(product => product.featured).length + '</strong></div>' +
        '<div><span>Archived</span><strong>' + (products.length - live.length) + '</strong></div>' +
        '<div><span>Metadata complete</span><strong>' + operations.metadata.completeness_percent + '%</strong></div>' +
        '<div><span>Work queue</span><strong>' + operations.action_queue.length + '</strong></div>'
    }

    // ---------- Shipping rates ----------
    const shippingEl = document.querySelector<HTMLDivElement>('#catalog-shipping')
    if (shippingEl) {
      shippingEl.innerHTML = shippingPanel(rates, helpers)
      const rateMessage = shippingEl.querySelector<HTMLElement>('.catalog-rate-message')
      const say = (text: string) => { if (rateMessage) rateMessage.textContent = text }
      const keepOpen = async () => {
        await bindCatalogPage(helpers)
        const panel = document.querySelector<HTMLDetailsElement>('.catalog-shipping-panel')
        if (panel) panel.open = true
      }

      shippingEl.querySelectorAll<HTMLButtonElement>('.save-rate').forEach(button => {
        button.addEventListener('click', async () => {
          const row = button.closest<HTMLElement>('.catalog-rate-row')
          const source = row?.dataset.source || ''
          const rate = row?.querySelector<HTMLInputElement>('.catalog-rate-input')?.value.trim() || ''
          button.disabled = true
          say('Saving ' + source + '…')
          try {
            await setShippingRate(source, rate)
            say(source + ' saved. Audit event recorded.')
            await keepOpen()
          } catch (error) {
            say(error instanceof Error ? error.message : 'Could not save rate.')
            button.disabled = false
          }
        })
      })

      shippingEl.querySelectorAll<HTMLButtonElement>('.delete-rate').forEach(button => {
        button.addEventListener('click', async () => {
          const source = button.closest<HTMLElement>('.catalog-rate-row')?.dataset.source || ''
          if (!window.confirm('Remove the shipping source "' + source + '"?')) return
          button.disabled = true
          say('Removing ' + source + '…')
          try {
            await deleteShippingRate(source)
            say(source + ' removed. Audit event recorded.')
            await keepOpen()
          } catch (error) {
            say(error instanceof Error ? error.message : 'Could not remove rate.')
            button.disabled = false
          }
        })
      })

      const addButton = shippingEl.querySelector<HTMLButtonElement>('.add-rate')
      addButton?.addEventListener('click', async () => {
        const source = shippingEl.querySelector<HTMLInputElement>('.catalog-rate-new-source')?.value.trim() || ''
        const rate = shippingEl.querySelector<HTMLInputElement>('.catalog-rate-new-rate')?.value.trim() || ''
        if (!source) { say('Enter a source name.'); return }
        if (Object.prototype.hasOwnProperty.call(rates, source)) { say('That source already exists. Edit its rate above.'); return }
        addButton.disabled = true
        say('Adding ' + source + '…')
        try {
          await setShippingRate(source, rate)
          say(source + ' added. Audit event recorded.')
          await keepOpen()
        } catch (error) {
          say(error instanceof Error ? error.message : 'Could not add rate.')
          addButton.disabled = false
        }
      })
    }

    // ---------- Metadata health + work queue ----------
    const metadataEl = document.querySelector<HTMLDivElement>('#catalog-metadata-health')
    if (metadataEl) {
      const missing = operations.metadata.missing
      metadataEl.innerHTML =
        '<div class="catalog-ops-head"><div><span class="eyebrow">CORE METADATA</span>' +
        '<h2>' + operations.metadata.completeness_percent + '% complete</h2></div>' +
        '<span class="catalog-health-pill">' + operations.metadata.complete_products + '/' +
        operations.metadata.active_products + ' COMPLETE</span></div>' +
        '<div class="catalog-missing-grid">' +
          '<button type="button" data-ops-filter="coa-missing"><span>COA</span><strong>' + (missing.coa_url ?? 0) + '</strong></button>' +
          '<button type="button" data-ops-filter="metadata-incomplete"><span>Product code</span><strong>' + (missing.product_code ?? 0) + '</strong></button>' +
          '<button type="button" data-ops-filter="metadata-incomplete"><span>Research name</span><strong>' + (missing.research_name ?? 0) + '</strong></button>' +
          '<button type="button" data-ops-filter="metadata-incomplete"><span>Purity</span><strong>' + (missing.purity ?? 0) + '</strong></button>' +
          '<button type="button" data-ops-filter="metadata-incomplete"><span>Quantity</span><strong>' + (missing.quantity ?? 0) + '</strong></button>' +
          '<button type="button" data-ops-filter="metadata-incomplete"><span>Lot</span><strong>' + (missing.lot_number ?? 0) + '</strong></button>' +
        '</div>'
    }

    const queueEl = document.querySelector<HTMLDivElement>('#catalog-action-queue')
    if (queueEl) {
      const rows = operations.action_queue.slice(0, 12)
      queueEl.innerHTML =
        '<div class="catalog-queue-head"><div><span class="eyebrow">ACTION QUEUE</span>' +
        '<h2>Metadata work</h2><p>Active products missing lab details.</p></div>' +
        '<strong>' + operations.action_queue.length + ' products</strong></div>' +
        (rows.length
          ? '<div class="catalog-queue-list">' + rows.map(item =>
              '<button type="button" class="catalog-queue-row jump-to-product" data-product-id="' +
              helpers.escapeHtml(item.product_id) + '">' +
                '<span><strong>' + helpers.escapeHtml(item.name) + '</strong><small>' +
                helpers.escapeHtml(item.category_name || 'No category') + '</small></span>' +
                '<span class="catalog-missing-chips">' +
                  item.missing_fields.map(field => '<i>' + helpers.escapeHtml(field.label) + '</i>').join('') +
                '</span>' +
                '<b>' + item.missing_count + '</b>' +
              '</button>'
            ).join('') + '</div>' +
            (operations.action_queue.length > rows.length
              ? '<p class="catalog-queue-more">Showing the first ' + rows.length +
                '. Use “Metadata incomplete” to view the full queue.</p>' : '')
          : '<div class="empty-state compact"><strong>Metadata queue clear.</strong></div>')
    }

    // ---------- Product list ----------
    list.innerHTML = products.length
      ? products.map(product => productCard(product, categories, rates, helpers)).join('')
      : '<div class="empty-state"><h2>No products yet.</h2><p>Use “+ New product” to add one.</p></div>'

    const categorySelect = document.querySelector<HTMLSelectElement>('#catalog-category')
    if (categorySelect) {
      categorySelect.insertAdjacentHTML('beforeend', categories.map(category =>
        '<option value="' + helpers.escapeHtml(category.slug) + '">' + helpers.escapeHtml(category.name) + '</option>'
      ).join(''))
    }

    const savedViewState = loadCatalogViewState()
    let search = savedViewState.search
    let category = savedViewState.category
    let state = savedViewState.state

    const searchInput = document.querySelector<HTMLInputElement>('#catalog-search')
    const stateSelect = document.querySelector<HTMLSelectElement>('#catalog-state')

    if (searchInput) searchInput.value = search
    if (categorySelect && Array.from(categorySelect.options).some(option => option.value === category)) {
      categorySelect.value = category
    } else {
      category = 'all'
      if (categorySelect) categorySelect.value = 'all'
    }
    if (stateSelect && Array.from(stateSelect.options).some(option => option.value === state)) {
      stateSelect.value = state
    } else {
      state = 'all'
      if (stateSelect) stateSelect.value = 'all'
    }
    const metadataQueueIds = new Set(operations.action_queue.map(item => item.product_id))

    const apply = () => {
      let shown = 0
      let pool = 0
      document.querySelectorAll<HTMLElement>('.catalog-card').forEach(card => {
        const product = products.find(item => item.id === card.dataset.productId)
        if (!product) return
        const archived = isArchived(product)
        const haystack = [
          product.name, product.research_name, product.product_code, product.sku,
          product.product_type, product.category?.name, product.shipping_from, product.storefront_status,
        ].filter(Boolean).join(' ').toLowerCase()

        const categoryMatch = category === 'all' || product.category?.slug === category
        const stateMatch = state === 'archived'
          ? archived
          : !archived && (
            state === 'all' ||
            (state === 'selling' && isSelling(product)) ||
            (state === 'not-selling' && !isSelling(product)) ||
            (state === 'hidden' && product.core_hidden) ||
            (state === 'featured' && product.featured) ||
            (state === 'metadata-incomplete' && metadataQueueIds.has(product.id)) ||
            (state === 'coa-missing' && !product.coa_url) ||
            (state === 'uncategorized' && !product.category_id)
          )
        if (state === 'archived' ? archived : !archived) pool += 1
        const visible = categoryMatch && stateMatch && (!search || haystack.includes(search))
        card.hidden = !visible
        if (visible) shown += 1
      })

      const summary = document.querySelector<HTMLParagraphElement>('#catalog-summary')
      if (summary) summary.textContent = shown + ' of ' + pool + (state === 'archived' ? ' archived' : '') + ' products shown.'
    }

    const cardContext = (button: HTMLElement) => {
      const card = button.closest<HTMLElement>('.catalog-card')
      const product = products.find(item => item.id === card?.dataset.productId)
      const message = card?.querySelector<HTMLElement>('.catalog-visibility-message') || null
      return { card, product, message }
    }

    document.querySelectorAll<HTMLButtonElement>('.toggle-catalog-availability').forEach(button => {
      button.addEventListener('click', async () => {
        const { product, message } = cardContext(button)
        if (!product) return
        const next = !isSelling(product)
        button.disabled = true
        if (message) message.textContent = next ? 'Putting on sale…' : 'Taking off sale…'
        try {
          await setCatalogAvailability(product.id, product.updated_at, next)
          if (message) message.textContent = next ? 'Now selling on Nexus.' : 'No longer for sale on Nexus.'
          await bindCatalogPage(helpers)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not change availability.'
          button.disabled = false
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.toggle-catalog-visibility').forEach(button => {
      button.addEventListener('click', async () => {
        const { product, message } = cardContext(button)
        if (!product) return
        const nextHidden = !product.core_hidden
        button.disabled = true
        if (message) message.textContent = nextHidden
          ? 'Hiding product from Resident Scientist and New Researcher…'
          : 'Restoring product for all eligible membership tiers…'
        try {
          await setCatalogVisibility(product.id, nextHidden)
          await bindCatalogPage(helpers)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not update visibility.'
          button.disabled = false
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.remove-catalog-product').forEach(button => {
      button.addEventListener('click', async () => {
        const { product, message } = cardContext(button)
        if (!product) return
        const confirmed = window.confirm(
          'Delete "' + product.name + '"?\n\n' +
          'If it has ever been ordered, it will be archived instead: removed from Nexus and from your list, ' +
          'but kept so past orders and receipts stay intact. Otherwise it is deleted permanently.'
        )
        if (!confirmed) return
        button.disabled = true
        button.textContent = 'Deleting…'
        try {
          const result = await removeCatalogProduct(product.id)
          if (message) message.textContent = result.mode === 'archived'
            ? result.productName + ' archived (it has order history).'
            : result.productName + ' deleted.'
          await bindCatalogPage(helpers)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not delete product.'
          button.disabled = false
          button.textContent = 'Delete'
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.save-catalog-product').forEach(button => {
      button.addEventListener('click', async () => {
        const { card, product } = cardContext(button)
        const message = card?.querySelector<HTMLElement>('.catalog-editor-message')
        const form = card?.querySelector<HTMLElement>('.catalog-product-form')
        if (!product || !form) return
        const input = readProductForm(form)
        const problem = validateProductInput(input)
        if (problem) { if (message) message.textContent = problem; return }
        button.disabled = true
        button.textContent = 'Saving…'
        if (message) message.textContent = 'Saving to the live catalog…'
        try {
          const updated = await updateCatalogProduct(product.id, product.updated_at, input)
          if (message) message.textContent = 'Saved. Audit event recorded.'
          saveCatalogViewState({ search, category, state })
          await bindCatalogPage(helpers)
          const refreshed = document.querySelector<HTMLElement>('.catalog-card[data-product-id="' + updated.id + '"]')
          refreshed?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          refreshed?.classList.add('catalog-card-focus')
          window.setTimeout(() => refreshed?.classList.remove('catalog-card-focus'), 1800)
        } catch (error) {
          if (message) message.textContent = error instanceof Error ? error.message : 'Could not save product.'
          button.disabled = false
          button.textContent = 'Save Product'
        }
      })
    })

    document.querySelectorAll<HTMLButtonElement>('[data-ops-filter]').forEach(button => {
      button.addEventListener('click', () => {
        state = button.dataset.opsFilter || 'all'
        if (stateSelect) stateSelect.value = state
        saveCatalogViewState({ search, category, state })
        apply()
        document.querySelector('#catalog-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })

    document.querySelectorAll<HTMLButtonElement>('.jump-to-product').forEach(button => {
      button.addEventListener('click', () => {
        const productId = button.dataset.productId
        if (!productId) return
        search = ''
        category = 'all'
        state = 'all'
        if (searchInput) searchInput.value = ''
        if (categorySelect) categorySelect.value = 'all'
        if (stateSelect) stateSelect.value = 'all'
        saveCatalogViewState({ search, category, state })
        apply()
        const card = document.querySelector<HTMLElement>('.catalog-card[data-product-id="' + productId + '"]')
        if (!card) return
        const editor = card.querySelector<HTMLDetailsElement>('.catalog-editor')
        if (editor) editor.open = true
        card.scrollIntoView({ behavior: 'smooth', block: 'center' })
        card.classList.add('catalog-card-focus')
        window.setTimeout(() => card.classList.remove('catalog-card-focus'), 1800)
      })
    })

    searchInput?.addEventListener('input', event => {
      search = (event.currentTarget as HTMLInputElement).value.trim().toLowerCase()
      saveCatalogViewState({ search, category, state })
      apply()
    })
    categorySelect?.addEventListener('change', event => {
      category = (event.currentTarget as HTMLSelectElement).value
      saveCatalogViewState({ search, category, state })
      apply()
    })
    stateSelect?.addEventListener('change', event => {
      state = (event.currentTarget as HTMLSelectElement).value
      saveCatalogViewState({ search, category, state })
      apply()
    })
    apply()
  } catch (error) {
    list.innerHTML = '<div class="empty-state error-state"><h2>Could not load catalog.</h2><p>' +
      helpers.escapeHtml(error instanceof Error ? error.message : 'Unknown error') + '</p></div>'
  }
}
