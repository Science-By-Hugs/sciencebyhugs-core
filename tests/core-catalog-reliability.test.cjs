const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const ts=require('typescript')
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')
const edge=read('supabase/functions/core-catalog/index.ts')
const ui=read('src/catalog-view.ts')
const inv=read('src/inventory-view.ts')
const types=read('src/services/catalog.ts')

async function runCatalog({role='owner',supply=[{product_id:'b',supply_mode:'vendor'}],settingsError=null}={}){
  const db={
    products:[
      {id:'a',name:'Manual unclassified',price:20,active:true,core_hidden:false,
        storefront_status:'Available',sync_source:'core_manual',updated_at:'2026-11-07T01:00:00Z',
        source_synced_at:null,product_code:'SBH-A',category_id:'cat',last_sync_run_id:null},
      {id:'b',name:'Vendor classified',price:25,active:true,core_hidden:false,
        storefront_status:'Available',sync_source:'core_manual',updated_at:'2026-11-07T02:00:00Z',
        source_synced_at:null,product_code:'SBH-B',category_id:'cat',last_sync_run_id:null},
    ],
    product_categories:[{id:'cat',name:'Other',slug:'other',active:true}],
    catalog_sync_runs:[{id:'old',source:'google_catalog',status:'completed',
      received_count:120,upserted_count:119,deactivated_count:87,
      started_at:'2026-10-24T00:15:20Z',completed_at:'2026-10-24T00:15:22Z'}],
    inventory_product_settings:supply,
  }
  const calls=[]
  const query=(table)=>{
    const result={data:db[table],error:table==='inventory_product_settings'?settingsError:null}
    const chain={}
    for(const method of ['select','order','limit','in'])chain[method]=()=>chain
    chain.then=(resolve,reject)=>Promise.resolve(result).then(resolve,reject)
    return chain
  }
  let handle
  const createClient=(url,key)=>key==='public'
    ? {auth:{getUser:async()=>({data:{user:{id:'operator',app_metadata:{role}}},error:null})}}
    : {from:(table)=>{calls.push(table);if(!db[table])throw Error('Unexpected table '+table);return query(table)}}
  const compiled=ts.transpileModule(edge.replace(/^import .*;\s*$/gm,''),{
    compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}
  }).outputText
  const context={
    createClient,Response,console,Date,Promise,JSON,Map,Set,Number,String,Math,
    Deno:{env:{get:k=>k==='SUPABASE_URL'?'https://example.test':
      k==='SUPABASE_PUBLISHABLE_KEYS'?'{"default":"public"}':'{"nexus_rotation_20261023":"secret"}'},
    serve:fn=>{handle=fn}},
  }
  vm.runInNewContext(compiled,context)
  assert.equal(typeof handle,'function')
  const response=await handle({method:'POST',headers:{get:()=> 'Bearer mock-token'}})
  return {http:response.status,body:await response.json(),calls}
}

test('Core manual catalog ignores retired Google freshness without hiding legacy run history',async()=>{
  const {http,body}=await runCatalog()
  assert.equal(http,200)
  assert.equal(body.success,true)
  assert.equal(body.operations.feed.mode,'core_manual')
  assert.equal(body.operations.feed.status,'healthy')
  assert.equal(body.operations.feed.stale,false)
  assert.equal(body.operations.feed.latest_sync_at,null)
  assert.equal(body.operations.feed.age_minutes,null)
  assert.equal(body.operations.feed.legacy_last_sync_at,'2026-10-24T00:15:22Z')
  assert.equal(body.operations.feed.last_product_updated_at,'2026-11-07T02:00:00Z')
  assert.equal(body.sync_runs.length,1)
  assert.equal(body.sync_runs[0].source,'google_catalog')
})

test('Core shows unclassified product as needing action while preserving all product listings',async()=>{
  const {body,calls}=await runCatalog()
  assert.equal(body.metrics.active,2)
  assert.equal(body.metrics.needs_supply_classification,1)
  assert.equal(body.products.find(p=>p.id==='a').supply_mode,'unreviewed')
  assert.equal(body.products.find(p=>p.id==='b').supply_mode,'vendor')
  assert.ok(body.operations.discrepancies.some(p=>p.product_id==='a' &&
    p.issues.some(issue=>issue.includes('unavailable in Nexus'))))
  assert.ok(!body.operations.discrepancies.some(p=>p.issues.some(issue=>issue.includes('never synced'))))
  assert.deepEqual(calls,['products','product_categories','catalog_sync_runs','inventory_product_settings'])
})

test('Catalog fails closed if Core supply settings cannot be read',async()=>{
  const result=await runCatalog({settingsError:{message:'restricted'}})
  assert.equal(result.http,503)
  assert.equal(result.body.error,'Could not check product supply classification')
})

test('Only verified Core owner/admin may read supply classification',async()=>{
  const result=await runCatalog({role:'viewer'})
  assert.equal(result.http,403)
  assert.equal(result.body.error,'Core administrator access required')
  assert.equal(result.calls.length,0)
})

test('New Core Catalog availability banner and exact Inventory product deep-link are read-only',()=>{
  assert.match(types,/supply_mode: 'physical' \| 'vendor' \| 'unreviewed'/)
  assert.match(types,/needs_supply_classification: number/)
  assert.match(ui,/id="catalog-supply-review"/)
  assert.match(ui,/product\.active && product\.supply_mode === 'unreviewed'/)
  assert.match(ui,/Nexus keeps them unavailable until you choose physical stock or vendor-supplied/)
  assert.match(ui,/Listed for sale in Core/)
  assert.match(ui,/section=inventory&classify=/)
  assert.match(inv,/const classifyId=new URLSearchParams\(location\.hash\.split\('\?'\)\[1\]\|\|''\)\.get\('classify'\)/)
  assert.match(inv,/data\.products\.some\(p=>p\.id===classifyId\)/)
  assert.match(inv,/if\(canDeepLink && classifiedProduct && classifyId\)classifiedProduct\.value=classifyId/)
  assert.match(inv,/form\('inv-classify-product',async f=>\{/)
  assert.doesNotMatch(ui,/classifyInventoryProduct\(|setCatalogAvailability\(product\.id, product\.updated_at, true\)/)
})
