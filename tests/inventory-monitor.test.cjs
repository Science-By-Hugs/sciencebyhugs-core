const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const ts=require('typescript')
const vm=require('node:vm')
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8')

const sql=read('supabase/migrations/20261106031000_core_inventory_monitor_snapshot.sql')
const api=read('supabase/functions/core-inventory-control/index.ts')
const view=read('src/inventory-view.ts')
const service=read('src/services/inventory.ts')
const front=read('src/inventory-monitor.ts')
const css=read('src/inventory.css')

test('monitor is server-only, read-only, and leaves inventory feature flags untouched',()=>{
  assert.match(sql,/CREATE OR REPLACE FUNCTION public\.core_inventory_monitor_snapshot\(\)/)
  assert.match(sql,/LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''/)
  assert.match(sql,/REVOKE ALL ON FUNCTION public\.core_inventory_monitor_snapshot\(\)[\s\S]*FROM PUBLIC,anon,authenticated/)
  assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.core_inventory_monitor_snapshot\(\) TO service_role/)
  assert.doesNotMatch(sql,/\b(?:INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE TABLE)\b/i)
  assert.match(sql,/o\.created_at >= c\.starts_at/)
  assert.match(sql,/sp\.supply_mode='physical'/)
  assert.match(sql,/p\.status='verified'/)
  assert.match(sql,/p\.provider_capture_id/)
  assert.match(sql,/interval '90 minutes'/)
  assert.match(sql,/now\(\)-interval '2 minutes'/)
  for(const code of ['paid_stock_gap','paid_payment_mismatch','stale_no_payment',
    'provider_session_review','inventory_state_conflict','expired_still_held',
    'paid_released_stock','unlinked_reservation'])
    assert(sql.includes("'"+code+"'"),'missing detection '+code)
})

test('owner role is checked before private service-role monitoring query',()=>{
  assert.match(api,/userClient\.auth\.getUser\(\)/)
  assert.match(api,/user\.app_metadata\?\.role/)
  assert.match(api,/if \(action === "monitor"\) \{\s*if \(role !== "owner"\) return json\(\{error:"Owner access required"\},403\)/)
  assert.match(api,/db\.rpc\("core_inventory_monitor_snapshot"\)/)
  assert.match(api,/if \(error \|\| !data\)/)
  assert(!api.includes('action === "recover_abandoned"'))
  assert(!api.includes('action === "enable_inventory"'))
})

test('Core renders an owner-only alert panel, never the Nexus customer catalog',()=>{
  assert.match(view,/mountInventoryMonitor\(monitorSlot,loadInventoryMonitoring\)/)
  assert.match(view,/id="inv-monitor-slot"/)
  assert.match(service,/action:'monitor'/)
  assert.match(front,/textContent/)
  assert.doesNotMatch(front,/innerHTML/)
  assert.match(front,/No payment\/inventory discrepancies detected/)
  assert.match(css,/\.inv-monitor-alert/)
})

test('state model distinguishes blocked activation, actionable alerts and unreadied physical counts',()=>{
  const source=ts.transpileModule(front,{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText
  const out={}
  vm.runInNewContext(source,{exports:out,require:()=>({}),document:{}})
  const clean={
    checked_at:new Date().toISOString(),
    flags:{reservation_enabled:false,deduction_enabled:false,recovery_enabled:false,activated_at:null},
    totals:{total:0,critical:0,warning:0},
    metrics:{held_units:0,committed_units:0,open_physical_lots_without_verified_count:2,pending_reconciliation:0},
    alerts:[],
  }
  const initial=out.monitorDisplayState(clean)
  assert.equal(initial.enabled,false)
  assert.equal(initial.pendingCounts,2)
  assert.match(initial.label,/Counts still need verification/)
  const urgent=out.monitorDisplayState({...clean,
    totals:{total:2,critical:1,warning:1},
    alerts:[{code:'paid_stock_gap',severity:'critical',title:'Paid order not fully allocated',
      order_id:'test',order_number:'TEST',first_seen:new Date().toISOString(),next_action:'Check',
      expected_units:2,actual_units:0}],
  })
  assert.equal(urgent.critical,1)
  assert.equal(urgent.clipped,true)
  assert.match(urgent.label,/Immediate attention/)
})
