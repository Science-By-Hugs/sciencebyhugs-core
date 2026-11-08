const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const read = path => readFileSync(join(__dirname, '..', path), 'utf8')

test('Membership creation uses the same compact button pattern as New product', () => {
  const membership = read('src/memberships-view.ts')
  const catalog = read('src/catalog-view.ts')
  assert.match(catalog, /<summary><span class="primary catalog-create-button">\+ New product<\/span><\/summary>/)
  assert.match(membership, /<details class="membership-create"><summary><span class="primary catalog-create-button membership-create-button">\+ New membership<\/span><\/summary>/)
  assert.match(membership, /membershipForm\(null, e\) \+ '<\/details>'/)
  assert.doesNotMatch(membership, /<summary class="primary">\+ Create membership<\/summary>/)
})

test('Closed membership create control has no oversized bordered card', () => {
  const css = read('src/styles.css')
  assert.match(css, /\.membership-create\{padding:0;border:0;background:transparent;border-radius:0\}/)
  assert.match(css, /\.membership-create\[open\]\{padding:16px;border:1px solid #34383C/)
  assert.match(css, /\.membership-create>summary\{display:inline-flex/)
  assert.match(css, /\.membership-create-button\{min-height:44px;border-radius:14px/)
  assert.match(css, /\.membership-create>summary:focus-visible/)
})
