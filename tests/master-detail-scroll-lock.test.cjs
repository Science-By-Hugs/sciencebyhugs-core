const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const ts=require('typescript')
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8')
const source=read('src/md-scroll-lock.ts')
const compiled=ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
}}).outputText
function fakeDOM(initialScroll=520){
  const classes=()=>({
    active:new Set(),
    add(value){this.active.add(value)},
    remove(value){this.active.delete(value)},
    contains(value){return this.active.has(value)},
  })
  const registered=new Map()
  const scrolled=[]
  const document={body:{classList:classes(),style:{top:'12px'}},
    documentElement:{classList:classes()}}
  const window={scrollY:initialScroll,scrollTo:(x,y)=>scrolled.push([x,y]),
    addEventListener:(name,fn)=>registered.set(name,fn),
    removeEventListener:(name,fn)=>{
      if(registered.get(name)===fn)registered.delete(name)
    }}
  const exports={}
  vm.runInNewContext(compiled,{exports,document,window})
  return {exports,document,window,registered,scrolled}
}
test('opening a phone product detail pins the background at the original scroll position',()=>{
  const {exports,document,registered}=fakeDOM(520)
  exports.lockMasterDetailScroll()
  assert.equal(document.body.style.top,'-520px')
  assert.equal(document.body.classList.contains('md-open'),true)
  assert.equal(document.documentElement.classList.contains('md-open'),true)
  assert.equal(registered.has('hashchange'),true)
  exports.lockMasterDetailScroll() // idempotent while the panel is open
  assert.equal(document.body.style.top,'-520px')
})
test('closing restores the exact scroll offset and existing inline body style',()=>{
  const {exports,document,scrolled,registered}=fakeDOM(430)
  exports.lockMasterDetailScroll()
  exports.releaseMasterDetailScroll()
  assert.equal(document.body.style.top,'12px')
  assert.equal(document.body.classList.contains('md-open'),false)
  assert.equal(document.documentElement.classList.contains('md-open'),false)
  assert.equal(registered.has('hashchange'),false)
  assert.deepEqual(scrolled,[[0,430]])
  exports.releaseMasterDetailScroll()
  assert.deepEqual(scrolled,[[0,430]])
})
test('changing view while the sheet is open releases the lock',()=>{
  const {exports,document,registered,scrolled}=fakeDOM(910)
  exports.lockMasterDetailScroll()
  registered.get('hashchange')()
  assert.equal(document.body.classList.contains('md-open'),false)
  assert.equal(document.documentElement.classList.contains('md-open'),false)
  assert.deepEqual(scrolled,[[0,910]])
})
test('the mobile product detail is accessible and scrolls independently of the document',()=>{
  const master=read('src/master-detail.ts')
  const css=read('src/champagne.css')
  assert.match(master,/lockMasterDetailScroll\(\)/)
  assert.match(master,/releaseMasterDetailScroll\(\)/)
  assert.match(master,/panel\.setAttribute\('aria-modal', 'true'\)/)
  assert.match(master,/const origin = rowById\.get\(previousId\)/)
  assert.match(master,/focusRow\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(css,/body\.md-open\{\s*position:fixed!important/)
  assert.match(css,/body\.md-open \.md-panel\{[\s\S]*?overflow-y:auto!important/)
  assert.match(css,/-webkit-overflow-scrolling:touch/)
})

test('all Core master-detail controllers are disposed on navigation and on a save-driven rerender',()=>{
  const master=read('src/master-detail.ts')
  const main=read('src/main.ts')
  assert.match(master,/export function disposeMasterDetail\(\)/)
  assert.match(master,/disposeMasterDetail\(\)\s*list\.classList\.remove/)
  assert.match(main,/import \{ disposeMasterDetail \} from '\.\/master-detail'/)
  assert.match(main,/function shell\(content: string, signedIn = false\) \{\s*\/\/[^]*?disposeMasterDetail\(\)/)
  assert.match(master,/activeMountTeardown\?\.\(\)/)
  assert.match(master,/const listeners = new AbortController\(\)/)
  assert.match(master,/document\.addEventListener\('keydown', onKey, \{ signal: listeners\.signal \}\)/)
  assert.match(master,/cardObservers\.forEach\(observer => observer\.disconnect\(\)\)/)
  assert.match(master,/listeners\.abort\(\)/)
})

test('phone sheet traps keyboard focus, respects nested dialogs, and reflows with device rotation',()=>{
  const master=read('src/master-detail.ts')
  assert.match(master,/if \(event\.target instanceof Element && event\.target\.closest\('dialog\[open\]'\)\) return/)
  assert.match(master,/event\.key !== 'Tab' \|\| !isPhone\(\)/)
  assert.match(master,/panel\.querySelectorAll<HTMLElement>/)
  assert.match(master,/el\.getClientRects\(\)\.length > 0/)
  assert.match(master,/event\.shiftKey && active === first/)
  assert.match(master,/!event\.shiftKey && active === last/)
  assert.match(master,/!panel\.contains\(active\)/)
  assert.match(master,/window\.addEventListener\('resize', syncPanelForViewport/)
  assert.match(master,/panel\.setAttribute\('aria-modal', 'true'\)/)
  assert.match(master,/panel\.removeAttribute\('aria-modal'\)/)
})

test('closing the mobile sheet restores focus to a visible directory row',()=>{
  const master=read('src/master-detail.ts')
  assert.match(master,/const origin = rowById\.get\(previousId\)/)
  assert.match(master,/origin && !origin\.hidden/)
  assert.match(master,/rows\.querySelector<HTMLButtonElement>\('\.md-row:not\(\[hidden\]\)'\)/)
  assert.match(master,/focusRow\?\.focus\(\{ preventScroll: true \}\)/)
})
