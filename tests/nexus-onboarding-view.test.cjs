const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/nexus-onboarding-view.ts'), 'utf8')
const service = fs.readFileSync(path.join(__dirname, '../src/services/onboarding.ts'), 'utf8')
const notifications = fs.readFileSync(path.join(__dirname, '../src/notifications-view.ts'), 'utf8')

test('Core Notifications includes an owner-facing beta request queue and adoption counts', () => {
  assert.match(notifications, /nexusOnboardingPanelMarkup\(\)/)
  assert.match(notifications, /bindNexusOnboardingPanel\(helpers\)/)
  assert.match(source, /Beta requests/)
  assert.match(source, /adoptionEvents/)
  assert.match(source, /escape\(request\.email\)/)
})

test('mark invited is explicitly a manual record, not a TestFlight send', () => {
  assert.match(source, /This action will NOT send one/)
  assert.match(service, /does NOT send a TestFlight invitation/)
  assert.match(service, /eq\('status', 'pending'\)/)
  assert.doesNotMatch(service, /sendEmail|sendInvitation|testflight\.apple\.com/)
})
