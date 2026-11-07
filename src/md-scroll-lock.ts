// iPhone Safari can scroll the underlying document despite body overflow:hidden.
// Pin the body at its current scroll offset while a full-screen master-detail
// sheet is open. Restore the original location and inline style on dismissal.
// Shared by Catalog, Orders, and Customers; desktop split-view stays unchanged.
type ScrollLock = { y: number; previousTop: string }
let lock: ScrollLock | null = null

export function lockMasterDetailScroll() {
  if (lock) return
  lock = { y: window.scrollY, previousTop: document.body.style.top }
  document.body.style.top = '-' + lock.y + 'px'
  document.documentElement.classList.add('md-open')
  document.body.classList.add('md-open')
  // Navigating to another page without dismissing the sheet must still unlock.
  window.addEventListener('hashchange', releaseMasterDetailScroll)
}

export function releaseMasterDetailScroll() {
  if (!lock) return
  const { y, previousTop } = lock
  lock = null
  window.removeEventListener('hashchange', releaseMasterDetailScroll)
  document.body.classList.remove('md-open')
  document.documentElement.classList.remove('md-open')
  document.body.style.top = previousTop
  window.scrollTo(0, y)
}
