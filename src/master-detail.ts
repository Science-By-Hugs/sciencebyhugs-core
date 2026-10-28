// 2026-10-28 redesign: list + detail for Orders, Customers and Catalog.
// The page's existing cards (with all their editors and listeners) are kept intact:
// they move into a hidden store, a compact row is shown per card, and the selected
// card is moved into a side panel (desktop) or a full-screen sheet (phone).
// Moving a DOM node keeps its event listeners, so every existing control still works.
// Filters that set card.hidden keep working: rows mirror their card's hidden state.

export type RowInfo = {
  title: string
  sub?: string
  meta?: string
  badge?: string
  tone?: 'warn' | 'error' | 'go' | 'muted'
}

type Options = {
  list: HTMLElement
  cardSelector: string
  idOf: (card: HTMLElement) => string
  row: (card: HTMLElement) => RowInfo
  key: string
  backLabel: string
}

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const isPhone = () => window.matchMedia('(max-width: 900px)').matches

// Remember the open item briefly so it stays open after a save reloads the page,
// but a fresh visit on a phone starts on the list.
function remembered(key: string) {
  try {
    const [id, at] = (sessionStorage.getItem('core-md:' + key) || '').split('|')
    if (!id) return null
    return isPhone() && Date.now() - Number(at) > 120_000 ? null : id
  } catch { return null }
}
function remember(key: string, id: string | null) {
  try {
    if (id) sessionStorage.setItem('core-md:' + key, id + '|' + Date.now())
    else sessionStorage.removeItem('core-md:' + key)
  } catch { /* convenience only */ }
}

export function mountMasterDetail(opts: Options) {
  const { list } = opts
  document.body.classList.remove('md-open')
  list.classList.remove('md-has-open')
  const cards = Array.from(list.querySelectorAll<HTMLElement>(opts.cardSelector))
  if (!cards.length) return

  const store = document.createElement('div')
  store.className = 'md-store'
  store.hidden = true
  const rows = document.createElement('div')
  rows.className = 'md-rows'
  const panel = document.createElement('aside')
  panel.className = 'md-panel'
  panel.hidden = true
  panel.setAttribute('aria-label', 'Details')
  panel.innerHTML =
    '<div class="md-panel-bar"><button type="button" class="md-close">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>' +
      '<span>' + esc(opts.backLabel) + '</span></button>' +
      '<button type="button" class="md-close md-close-x" aria-label="Close details">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
    '<div class="md-panel-body"></div>'
  const body = panel.querySelector<HTMLElement>('.md-panel-body')!

  list.classList.add('md-host')
  cards.forEach(card => store.appendChild(card))
  list.replaceChildren(rows, panel, store)

  let openCard: HTMLElement | null = null
  const rowById = new Map<string, HTMLButtonElement>()

  const close = (forget = true) => {
    if (openCard) store.appendChild(openCard)
    openCard = null
    panel.hidden = true
    list.classList.remove('md-has-open')
    document.body.classList.remove('md-open')
    rowById.forEach(r => r.classList.remove('active'))
    if (forget) remember(opts.key, null)
  }

  const open = (id: string, focus = false) => {
    const card = cards.find(c => opts.idOf(c) === id)
    if (!card) return
    if (openCard && openCard !== card) store.appendChild(openCard)
    body.appendChild(card)
    openCard = card
    panel.hidden = false
    list.classList.add('md-has-open')
    if (isPhone()) document.body.classList.add('md-open')
    rowById.forEach((r, rid) => {
      r.classList.toggle('active', rid === id)
      r.setAttribute('aria-expanded', String(rid === id))
    })
    body.scrollTop = 0
    panel.scrollTop = 0
    remember(opts.key, id)
    if (focus) panel.querySelector<HTMLElement>('.md-close')?.focus({ preventScroll: true })
  }

  for (const card of cards) {
    const id = opts.idOf(card)
    const info = opts.row(card)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'md-row'
    row.setAttribute('aria-expanded', 'false')
    row.innerHTML =
      '<span class="md-row-main"><strong>' + esc(info.title) + '</strong>' +
        (info.sub ? '<small>' + esc(info.sub) + '</small>' : '') + '</span>' +
      '<span class="md-row-side">' +
        (info.meta ? '<b>' + esc(info.meta) + '</b>' : '') +
        (info.badge ? '<span class="tone ' + (info.tone || 'muted') + '">' + esc(info.badge) + '</span>' : '') +
      '</span>'
    row.addEventListener('click', () => (openCard === card ? close() : open(id, true)))
    row.hidden = card.hidden
    new MutationObserver(() => { row.hidden = card.hidden }).observe(card, { attributes: true, attributeFilter: ['hidden'] })
    rowById.set(id, row)
    rows.appendChild(row)
  }

  panel.querySelectorAll<HTMLButtonElement>('.md-close').forEach(b => b.addEventListener('click', () => close()))
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && openCard && document.body.contains(panel)) close()
  }
  document.addEventListener('keydown', onKey)

  // Reopen what was open before a reload; on desktop otherwise show the first item.
  const previous = remembered(opts.key)
  if (previous && rowById.has(previous)) open(previous)
  else if (!isPhone()) {
    const first = cards.find(c => !c.hidden)
    if (first) open(opts.idOf(first))
  }
}
