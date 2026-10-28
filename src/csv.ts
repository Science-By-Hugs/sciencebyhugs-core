// Minimal RFC 4180 CSV reader/writer for the Core catalog import/export.
// Handles quoted fields, escaped quotes (""), commas and newlines inside quotes,
// CRLF/LF line endings, and a UTF-8 byte-order mark (Excel exports).

export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1 }
        else inQuotes = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') { inQuotes = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (inQuotes) throw new Error('The CSV has an unclosed quote. Check that every " has a matching ".')
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(cell => cell.trim() !== ''))
}

/** Turns a parsed CSV (first row = headers) into objects keyed by header. */
export function csvToObjects(rows: string[][]): Array<Record<string, string>> {
  if (!rows.length) return []
  const headers = rows[0].map(h => h.trim())
  if (!headers.some(Boolean)) throw new Error('The first row of the CSV must be the column headers.')
  return rows.slice(1).map(cells => {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => { if (header) record[header] = (cells[index] ?? '').trim() })
    return record
  })
}

const needsQuotes = /[",\r\n]|^\s|\s$/

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map(row => row.map(value => {
    const text = value === null || value === undefined ? '' : String(value)
    return needsQuotes.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }).join(',')).join('\r\n') + '\r\n'
}

export function downloadCsv(fileName: string, csv: string) {
  // BOM so Excel opens UTF-8 (e.g. µ, ±) correctly.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
