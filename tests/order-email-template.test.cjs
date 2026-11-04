const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const file = path.join(__dirname, '../supabase/functions/_shared/order-email-template.ts')
const src = fs.readFileSync(file, 'utf8')
const compiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const out = {}
vm.runInNewContext(compiled, { exports: out, Intl, Date, Number, String })

test('order received has transactional subject and existing app link', () => {
  const message = out.composeOrderEmail({ event_type: 'received', order_number: 'SBH-1042', order_status: 'ordered', delivery_date: null }, 'Jamie')
  assert.match(message.subject, /SBH-1042 received/i)
  assert.match(message.htmlContent, /We received your order/)
  assert.match(message.htmlContent, /nexus\.sciencebyhugs\.com/)
  assert.match(message.htmlContent, /Account → Notifications/)
  assert.doesNotMatch(message.htmlContent, /discount|special offer|promotion code/i)
})

test('local delivery status avoids parcel-shipping promises', () => {
  assert.equal(out.orderStatusText('shipped'), 'out for local delivery')
  assert.equal(out.orderStatusText('delivered'), 'delivered')
  assert.equal(out.orderStatusText('processing'), 'being prepared')
  const message = out.composeOrderEmail({ event_type: 'status_changed', order_number: 'B52', order_status: 'shipped', delivery_date: null }, 'Customer')
  assert.match(message.subject, /out for local delivery/)
  assert.doesNotMatch(message.htmlContent, /tracking number|shipped to your address/i)
})

test('customer and order HTML is escaped, preventing injected markup', () => {
  const message = out.composeOrderEmail({ event_type: 'received', order_number: '<img src=x onerror=alert(1)>', order_status: 'ordered', delivery_date: null }, '<script>bad()</script>')
  assert.doesNotMatch(message.htmlContent, /<script>|<img src=x/)
  assert.match(message.htmlContent, /&lt;script&gt;/)
  assert.match(message.htmlContent, /&lt;img/)
})

test('estimate is informational and not a delivery guarantee', () => {
  const message = out.composeOrderEmail({ event_type: 'delivery_date_changed', order_number: '1042', order_status: 'ordered', delivery_date: '2026-11-09' }, 'Jamie')
  assert.match(message.htmlContent, /Nov 9, 2026/)
  assert.match(message.htmlContent, /not a guaranteed delivery time/)
})
