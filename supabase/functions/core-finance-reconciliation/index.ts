import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
// Private Core owner/admin reconciliation. Read-only queue and audited evidence RPC.
// Never changes original orders, payments, or order_item_costs.
const cors={
 "Access-Control-Allow-Origin":"*",
 "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
 "Access-Control-Allow-Methods":"POST, OPTIONS"
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
 status,headers:{...cors,"Content-Type":"application/json"}
});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 const token=req.headers.get("Authorization")||"";
 if(!token.startsWith("Bearer "))return json({error:"Authentication required"},401);
 try{
  const url=Deno.env.get("SUPABASE_URL")!;
  const pubs=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");
  const secrets=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
  if(!url||!pubs.default||!secrets.nexus_rotation_20261023)
   return json({error:"Financial review service unavailable"},503);
  const client=createClient(url,pubs.default,{
    global:{headers:{Authorization:token}},
    auth:{persistSession:false,autoRefreshToken:false}
  });
  const {data:{user},error:authError}=await client.auth.getUser();
  if(authError||!user)return json({error:"Invalid session"},401);
  const role=String(user.app_metadata?.role||"").trim().toLowerCase();
  if(!["owner","admin"].includes(role))return json({error:"Core admin access required"},403);
  const admin=createClient(url,secrets.nexus_rotation_20261023,{
    auth:{persistSession:false,autoRefreshToken:false}
  });
  let body:Record<string,unknown>={};
  try{body=await req.json()}catch{return json({error:"Invalid request"},400)}
  const action=String(body.action||"");
  if(action==="record"){
    if(!["historical_cost","payment_date"].includes(String(body.kind||""))||
       !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(body.targetId||"")))
      return json({error:"Choose a valid reconciliation record"},400);
    const evidence=String(body.reference||"").trim();
    if(evidence.length<6||evidence.length>200)return json({error:"Evidence reference (6–200 characters) is required"},400);
    const value=body.kind==="historical_cost"?String(body.unitCost??""):null;
    if(value!==null&&(!/^[0-9]{1,7}([.][0-9]{1,2})?$/.test(value)||Number(value)>1000000))
      return json({error:"Enter a documented two-decimal USD unit cost"},400);
    const paidDate=body.kind==="payment_date"?String(body.paidDate||""):null;
    if(paidDate!==null&&(!paidDate||!Number.isFinite(Date.parse(paidDate))))
      return json({error:"Documented payment timestamp required"},400);
    const {data,error}=await admin.rpc("core_finance_record_evidence",{
      p_kind:body.kind,
      p_target_id:body.targetId,
      p_unit_cost:value===null?null:Number(value),
      p_effective_paid_at:paidDate,
      p_evidence_reference:evidence,
      p_explanation:String(body.notes||"").trim(),
      p_expected_updated_at:body.expectedUpdatedAt||null,
      p_actor_id:user.id
    });
    if(error){
      const msg=String(error.message||"Unable to reconcile record");
      const isConflict=/changed since|missing|original|already|review changed/i.test(msg);
      return json({error:msg},isConflict?409:400);
    }
    return json({success:true,evidence:data});
  }
  if(action!=="list")return json({error:"Unknown operation"},400);
  // A transient PostgREST JWT-claims validation (PGRST303) can occur for
  // individual service-key reads, even while other reads succeed. Retry only
  // this read-only failure (never financial mutations), at most twice.
  // Keep non-auth errors visible to operators instead of masking them.
  const retryRead = async <T extends {error: {code?:string} | null}>(
    label:string, run:()=>PromiseLike<T>
  ):Promise<T> => {
    let result=await run();
    for(let attempt=1; result.error?.code==="PGRST303" && attempt<=2; attempt++){
      console.warn("core_reconciliation_read_auth_retry",label,attempt);
      await new Promise(resolve=>setTimeout(resolve,150*attempt));
      result=await run();
    }
    return result;
  };
  const fetches=await Promise.all([
    retryRead("orders",()=>admin.from("orders").select("id,order_number,payment_status,created_at,paid_at,total")
      .eq("payment_status","paid").limit(5001)),
    retryRead("order_items",()=>admin.from("order_items").select("id,order_id,product_name,product_code,quantity,line_total")
      .limit(10001)),
    retryRead("order_item_costs",()=>admin.from("order_item_costs").select("order_item_id,line_cost").limit(10001)),
    retryRead("cost_evidence",()=>admin.from("core_finance_cost_evidence")
      .select("order_item_id,order_id,unit_cost,line_cost,evidence_reference,explanation,updated_at")
      .limit(10001)),
    retryRead("paid_date_evidence",()=>admin.from("core_finance_paid_date_evidence")
      .select("order_id,effective_paid_at,evidence_reference,explanation,updated_at")
      .limit(5001)),
    retryRead("purchase_orders",()=>admin.from("inventory_purchase_orders")
      .select("id,po_number,vendor_id,status,ordered_at,shipping_actual,fees_actual").limit(1001)),
    retryRead("purchase_lines",()=>admin.from("inventory_purchase_lines")
      .select("purchase_order_id,packs_ordered,pack_price_snapshot").limit(5001)),
    retryRead("vendors",()=>admin.from("inventory_vendors").select("id,name").limit(1001)),
    retryRead("expenses",()=>admin.from("core_finance_expenses")
      .select("id,expense_date,category,vendor_id,purchase_order_id,payee,amount,payment_method,reference_number,notes,status,updated_at")
      .limit(5001))
  ]);
  if(fetches.some(x=>x.error)){
    console.error("core_reconciliation_list_error",fetches.map(x=>x.error?.code||null));
    return json({error:"Financial review data could not be loaded. Please retry.",retryable:true},503);
  }
  const [orders,items,costs,costEvidence,dateEvidence,purchases,purchaseLines,vendors,expenses]=
    fetches.map(x=>x.data||[]);
  if(orders.length>5000||items.length>10000||costs.length>10000||
     costEvidence.length>10000||dateEvidence.length>5000||
     purchases.length>1000||purchaseLines.length>5000||vendors.length>1000||
     expenses.length>5000){
    return json({error:"Financial history exceeds safe reporting limits; pagination required"},503);
  }
  const paidOrders=new Map(orders.map(o=>[o.id,o]));
  const nativeCosts=new Map(costs.map(c=>[c.order_item_id,c.line_cost]));
  const historicalCosts=new Map(costEvidence.map(c=>[c.order_item_id,c]));
  const effectiveDates=new Map(dateEvidence.map(d=>[d.order_id,d]));
  const missingCosts:unknown[]=[];
  const reviewedCosts:unknown[]=[];
  let paidLineCount=0;
  let nativeCostCount=0;
  for(const line of items){
    const order=paidOrders.get(line.order_id);
    if(!order)continue;
    paidLineCount++;
    const nativeCost=nativeCosts.get(line.id);
    if(nativeCost!==null&&nativeCost!==undefined){nativeCostCount++;continue;}
    const item={
      id:line.id,order_id:order.id,order_number:order.order_number||"Unnumbered",
      product_name:line.product_name,product_code:line.product_code,quantity:line.quantity,
      sales:line.line_total,order_created_at:order.created_at
    };
    const evidence=historicalCosts.get(line.id);
    if(evidence)reviewedCosts.push({...item,evidence});
    else missingCosts.push(item);
  }
  const missingDates:unknown[]=[];
  const reviewedDates:unknown[]=[];
  for(const o of orders){
    if(o.paid_at)continue;
    const base={id:o.id,order_number:o.order_number||"Unnumbered",
      created_at:o.created_at,total:o.total};
    const evidence=effectiveDates.get(o.id);
    if(evidence)reviewedDates.push({...base,evidence});
    else missingDates.push(base);
  }
  const poTotals=new Map<string,number>();
  for(const line of purchaseLines){
    const key=String(line.purchase_order_id);
    poTotals.set(key,(poTotals.get(key)||0)+
      Number(line.packs_ordered||0)*Number(line.pack_price_snapshot||0));
  }
  const vendorNames=new Map(vendors.map(v=>[v.id,v.name]));
  const matchedExpenses=expenses.filter(e=>e.status!=="voided");
  const matches=purchases.map(po=>{
    const total=Math.round(((poTotals.get(po.id)||0)+
      Number(po.shipping_actual||0)+Number(po.fees_actual||0))*100)/100;
    const linked=matchedExpenses.filter(e=>e.purchase_order_id===po.id);
    const paid=linked.filter(e=>e.status==="paid");
    const paidTotal=Math.round(paid.reduce((s,e)=>s+Number(e.amount||0),0)*100)/100;
    const plannedTotal=Math.round(linked.filter(e=>e.status==="planned")
      .reduce((s,e)=>s+Number(e.amount||0),0)*100)/100;
    return {id:po.id,number:po.po_number,status:po.status,
      vendor_id:po.vendor_id,vendor_name:vendorNames.get(po.vendor_id)||"Unknown vendor",
      total,paid_total:paidTotal,planned_total:plannedTotal,
      linked_expenses:linked.map(e=>({id:e.id,payee:e.payee,amount:e.amount,status:e.status})),
      difference:Math.round((total-paidTotal)*100)/100};
  });
  return json({success:true,generated_at:new Date().toISOString(),summary:{
    paid_orders:orders.length,paid_lines:paidLineCount,native_cost_lines:nativeCostCount,
    reconciled_cost_lines:reviewedCosts.length,missing_cost_lines:missingCosts.length,
    reconciled_paid_dates:reviewedDates.length,missing_paid_dates:missingDates.length,
    purchase_orders:purchases.length,linked_expenses:matchedExpenses.filter(e=>e.purchase_order_id).length
  },missing_costs:missingCosts,reviewed_costs:reviewedCosts,
    missing_dates:missingDates,reviewed_dates:reviewedDates,purchase_matches:matches,
    unmatched_expenses:matchedExpenses.filter(e=>!e.purchase_order_id),
    accounting_note:"Evidence overlays never rewrite original costs, payment dates or transactions. Purchase order matching is a review aid, not proof of payment or a net-profit calculation."});
 }catch(error){
  console.error("core_reconciliation_error",error instanceof Error?error.message:"unknown");
  return json({error:"Financial reconciliation temporarily unavailable"},503);
 }
});
