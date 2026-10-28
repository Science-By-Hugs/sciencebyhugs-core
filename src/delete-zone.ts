// Typed-confirmation delete block used by Orders and Customers (2026-10-28).
type Escape = (value: unknown) => string

export function deleteZone(title: string, note: string, placeholder: string, kind: string, escapeHtml: Escape) {
  return '<details class="danger-zone">' +
    '<summary>' + escapeHtml(title) + '</summary>' +
    '<p>' + escapeHtml(note) + '</p>' +
    '<div class="danger-zone-row">' +
      '<input class="' + kind + '-confirm" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(placeholder) + '">' +
      '<button class="danger ' + kind + '-button" type="button">' + escapeHtml(title) + '</button>' +
    '</div>' +
    '<p class="card-message ' + kind + '-message" aria-live="polite"></p>' +
  '</details>'
}
