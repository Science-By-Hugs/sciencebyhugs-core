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

test('new submitted order is explicitly not a payment confirmation', () => {
  const message = out.composeOrderEmail({ event_type: 'received', order_number: 'SBH-1042', order_status: 'ordered', delivery_date: null }, 'Jamie')
  assert.match(message.subject, /SBH-1042 submitted/i)
  assert.match(message.htmlContent, /Processing begins after payment is confirmed/)
  assert.match(message.htmlContent, /nexus\.sciencebyhugs\.com/)
  assert.match(message.htmlContent, /Account → Notifications/)
  assert.doesNotMatch(message.htmlContent, /discount|special offer|promotion code/i)
})

test('each Core status has its own email wording', () => {
  const examples = {
    submitted: 'submitted',
    processing: 'processing',
    ordered: 'ordered',
    shipped: 'shipped',
    out_for_delivery: 'out for delivery',
    delivered: 'delivered',
    on_hold: 'on hold',
    delayed: 'delayed',
    cancelled: 'cancelled',
  }
  for (const [status, label] of Object.entries(examples)) {
    assert.equal(out.orderStatusText(status), label)
    const email = out.composeOrderEmail({
      event_type: 'status_changed', order_number: 'B52',
      order_status: status, delivery_date: null,
    }, 'Customer')
    assert.match(email.subject, /B52/)
    assert.match(email.subject, new RegExp(label, 'i'))
  }
  assert.equal(out.orderStatusText('checkout_pending'), 'submitted')
  assert.equal(out.orderStatusText('pending'), 'submitted')
})

test('shipped never claims the order is already out for delivery', () => {
  const shipped = out.composeOrderEmail({ event_type: 'status_changed', order_number: 'B52', order_status: 'shipped', delivery_date: null }, 'Customer')
  const outForDelivery = out.composeOrderEmail({ event_type: 'status_changed', order_number: 'B52', order_status: 'out_for_delivery', delivery_date: null }, 'Customer')
  assert.match(shipped.subject, /B52: shipped/)
  assert.match(shipped.htmlContent, /not yet out for delivery/)
  assert.doesNotMatch(shipped.htmlContent, /tracking number|shipped to your address/i)
  assert.match(outForDelivery.subject, /out for delivery/)
})

test('processing explicitly confirms payment', () => {
  const email = out.composeOrderEmail({ event_type: 'status_changed', order_number: 'B52', order_status: 'processing', delivery_date: null }, 'Customer')
  assert.match(email.htmlContent, /Payment has been confirmed/)
})

test('customer and order HTML is escaped, preventing injected markup', () => {
  const message = out.composeOrderEmail({ event_type: 'received', order_number: '<img src=x onerror=alert(1)>', order_status: 'ordered', delivery_date: null }, '<script>bad()</script>')
  assert.doesNotMatch(message.htmlContent, /<script>|<img src=x/)
  assert.match(message.htmlContent, /&lt;script&gt;/)
  assert.doesNotMatch(message.subject, /[<>\r\n]/)
  assert.doesNotMatch(message.htmlContent, /<img src=x/)
})

test('estimate is informational and not a delivery guarantee', () => {
  const message = out.composeOrderEmail({ event_type: 'delivery_date_changed', order_number: '1042', order_status: 'ordered', delivery_date: '2026-11-09' }, 'Jamie')
  assert.match(message.htmlContent, /Nov 9, 2026/)
  assert.match(message.htmlContent, /not a guaranteed delivery time/)
})
