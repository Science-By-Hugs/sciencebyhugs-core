import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const useDist = process.argv.includes('--dist')
const failures = []

const fail = (message) => failures.push(message)
const mustExist = (file) => {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) fail(`Missing required file: ${file}`)
}

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

mustExist('public/CNAME')
mustExist('public/brand/core-app-icon.svg')
mustExist('public/brand/core-icon-192.png')
mustExist('public/brand/core-icon-512.png')
mustExist('public/brand/core-apple-touch-icon.png')

if (fs.existsSync(path.join(root, 'public/CNAME'))) {
  const cname = read('public/CNAME').trim()
  if (cname !== 'core.sciencebyhugs.com') fail(`Unexpected CNAME: ${cname}`)
}

const index = read('index.html')
if (index.includes('\\n')) fail('index.html contains literal \\n escape sequences')
if (!index.includes('noindex,nofollow')) fail('index.html is missing noindex protection')
if (!index.includes('core-apple-touch-icon.png')) fail('index.html is missing the Apple touch icon')

const vite = read('vite.config.ts')
for (const marker of ['core-icon-192.png', 'core-icon-512.png', "short_name: 'core'", "id: '/'"]) {
  if (!vite.includes(marker)) fail(`vite.config.ts is missing: ${marker}`)
}

const scanRoots = ['src', 'public']
const forbidden = [
  ['localhost', /localhost(?::\d+)?/i],
  ['service role key', /service[_-]?role/i],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]+/],
  ['Google Apps Script URL', /script\.google\.com/i],
  ['test account', /test@test\.com/i],
]

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walk(full) : [full]
})

for (const base of scanRoots) {
  for (const file of walk(path.join(root, base))) {
    if (!/\.(ts|css|html|svg|txt|json)$/i.test(file)) continue
    const contents = fs.readFileSync(file, 'utf8')
    for (const [label, pattern] of forbidden) {
      if (pattern.test(contents)) fail(`${label} found in ${path.relative(root, file)}`)
    }
  }
}

if (useDist) {
  for (const file of [
    'dist/index.html',
    'dist/manifest.webmanifest',
    'dist/sw.js',
    'dist/CNAME',
    'dist/brand/core-icon-192.png',
    'dist/brand/core-icon-512.png',
    'dist/brand/core-apple-touch-icon.png',
  ]) mustExist(file)

  if (fs.existsSync(path.join(root, 'dist/CNAME')) && read('dist/CNAME').trim() !== 'core.sciencebyhugs.com') {
    fail('Built CNAME does not match core.sciencebyhugs.com')
  }
}

if (failures.length) {
  console.error('CORE production verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`CORE production verification passed${useDist ? ' for built output' : ''}.`)
