const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/nexus-onboarding-view.ts'), 'utf8')
const service = fs.readFileSync(path.join(__dirname, '../src/services/onboarding.ts'), 'utf8')
const notifications = fs.readFileSync(path.join(__dirname, '../src/notifications-view.ts'), 'utf8')

test('Core Notifications displays aggregate onboarding metrics', () => {
  assert.match(notifications, /nexusOnboardingPanelMarkup\(\)/)
  assert.match(notifications, /bindNexusOnboardingPanel\(helpers\)/)
  assert.match(source, /loadAdoptionCounts/)
  assert.match(service, /beta_text_opened/)
  assert.doesNotMatch(source, /loadBetaAccessRequests|setBetaAccessStatus|data-beta-mark/)
})
test('opening an SMS composer is not counted as a sent message', () => {
  assert.match(source, /not texts actually sent/)
  assert.doesNotMatch(service, /sendInvitation|sendEmail|testflight\.apple\.com/)
})
