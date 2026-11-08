import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});
const lower=(v:unknown)=>String(v||"").trim().toLowerCase();
const round=(v:number)=>Math.round(v*100)/100;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST") return json({error:"Method not allowed"},405);
  const authHeader=req.headers.get("Authorization");
  if(!authHeader?.startsWith("Bearer ")) return json({error:"Authentication required"},401);

  const url=Deno.env.get("SUPABASE_URL")!;
  const pub=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
  const sec=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
  const userClient=createClient(url,pub.default,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false,autoRefreshToken:false}});
  const admin=createClient(url,sec.nexus_rotation_20261023,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:userError}=await userClient.auth.getUser();
  if(userError||!user) return json({error:"Invalid session"},401);
  const role=lower(user.app_metadata?.role);
  if(!["owner","admin"].includes(role)) return json({error:"Core administrator access required"},403);

  const [ordersR,invoicesR,paymentsR,profilesR,dateEvidenceR]=await Promise.all([
    admin.from("orders").select("id,order_number,customer_id,status,total,payment_method,payment_status,created_at,submitted_at,paid_at,delivered_at,cancelled_at").order("created_at",{ascending:true}).limit(5000),
    admin.from("invoices").select("id,invoice_number,order_id,customer_id,status,total,send_status,invoice_date,paid_at,created_at,customer_name_snapshot,customer_email_snapshot").order("created_at",{ascending:true}).limit(5000),
    admin.from("payments").select("id,order_id,customer_id,provider,amount,status,submitted_at,verified_at,paid_at,created_at").order("created_at",{ascending:true}).limit(5000),
    admin.from("profiles").select("id,customer_number,first_name,last_name,email").limit(5000),
    admin.from("core_finance_paid_date_evidence").select("order_id,effective_paid_at").limit(5001)
  ]);
  for(const result of [ordersR,invoicesR,paymentsR,profilesR,dateEvidenceR])
    if(result.error)return json({error:"Could not load finance data"},500);
  if((dateEvidenceR.data||[]).length>5000)return json({error:"Finance history pagination required"},503);
  const reconciledPaidDates=new Map((dateEvidenceR.data||[]).map(d=>[String(d.order_id),d.effective_paid_at]));

  const orders=ordersR.data||[];
  const invoices=invoicesR.data||[];
  const payments=paymentsR.data||[];
  const profiles=profilesR.data||[];
  const profileById=new Map(profiles.map(p=>[String(p.id),p]));

  const reportableOrders=orders.filter(o=>lower(o.status)!=="checkout_pending");
  const paidOrders=reportableOrders.filter(o=>lower(o.payment_status)==="paid");
  const openOrders=reportableOrders.filter(o=>lower(o.payment_status)!=="paid" && lower(o.status)!=="cancelled");
  const submittedPayments=payments.filter(p=>lower(p.status)==="submitted");
  const verifiedPayments=payments.filter(p=>lower(p.status)==="verified");
  const sentInvoices=invoices.filter(i=>lower(i.send_status)==="sent"||lower(i.status)==="sent");
  const unpaidSentInvoices=sentInvoices.filter(i=>!i.paid_at && !paidOrders.some(o=>String(o.id)===String(i.order_id)));

  const paidRevenue=round(paidOrders.reduce((s,o)=>s+Number(o.total||0),0));
  const verifiedPaymentTotal=round(verifiedPayments.reduce((s,p)=>s+Number(p.amount||0),0));
  const outstandingOrders=round(openOrders.reduce((s,o)=>s+Number(o.total||0),0));
  const outstandingInvoices=round(unpaidSentInvoices.reduce((s,i)=>s+Number(i.total||0),0));
  const submittedTotal=round(submittedPayments.reduce((s,p)=>s+Number(p.amount||0),0));

  const methodMap=new Map<string,{count:number,amount:number}>();
  for(const order of paidOrders){
    const method=String(order.payment_method||"Unspecified");
    const x=methodMap.get(method)||{count:0,amount:0};
    x.count++; x.amount+=Number(order.total||0); methodMap.set(method,x);
  }

  const monthMap=new Map<string,{orders:number,revenue:number}>();
  let undatedPaidOrders=0;
  for(const order of paidOrders){
    const effectiveDate=order.paid_at||reconciledPaidDates.get(String(order.id));
    // Never guess a payment date from order creation.
    if(!effectiveDate){undatedPaidOrders++;continue}
    const d=new Date(effectiveDate);
    const key=d.toISOString().slice(0,7);
    const x=monthMap.get(key)||{orders:0,revenue:0};
    x.orders++; x.revenue+=Number(order.total||0); monthMap.set(key,x);
  }

  const now=Date.now();
  const aging=unpaidSentInvoices.map(i=>{
    const base=new Date(i.invoice_date||i.created_at).getTime();
    const age=Math.max(0,Math.floor((now-base)/86400000));
    const profile=i.customer_id?profileById.get(String(i.customer_id)):null;
    return {
      invoice_id:i.id,
      invoice_number:i.invoice_number,
      customer_id:i.customer_id,
      customer_name:i.customer_name_snapshot||[profile?.first_name,profile?.last_name].filter(Boolean).join(" ")||profile?.email||"Customer",
      total:Number(i.total||0),
      age_days:age,
      bucket:age>=30?"30+ days":age>=14?"14-29 days":age>=7?"7-13 days":"0-6 days",
      created_at:i.invoice_date||i.created_at
    };
  }).sort((a,b)=>b.age_days-a.age_days);

  const unpaidByCustomer=new Map<string,{name:string,total:number,count:number}>();
  for(const order of openOrders){
    const key=String(order.customer_id||"unknown");
    const p=order.customer_id?profileById.get(String(order.customer_id)):null;
    const name=[p?.first_name,p?.last_name].filter(Boolean).join(" ")||p?.email||"Unknown customer";
    const x=unpaidByCustomer.get(key)||{name,total:0,count:0};
    x.total+=Number(order.total||0); x.count++; unpaidByCustomer.set(key,x);
  }

  return json({
    success:true,
    generated_at:new Date().toISOString(),
    summary:{
      paid_revenue:paidRevenue,
      paid_orders:paidOrders.length,
      undated_paid_orders:undatedPaidOrders,
      verified_payment_records:verifiedPayments.length,
      verified_payment_total:verifiedPaymentTotal,
      open_order_value:outstandingOrders,
      sent_unpaid_invoice_value:outstandingInvoices,
      payment_review_value:submittedTotal,
      payment_review_count:submittedPayments.length,
      delivered_paid_orders:paidOrders.filter(o=>lower(o.status)==="delivered").length,
      unfulfilled_paid_orders:paidOrders.filter(o=>!["delivered","cancelled"].includes(lower(o.status))).length
    },
    payment_mix:[...methodMap.entries()].map(([method,x])=>({method,count:x.count,amount:round(x.amount)})).sort((a,b)=>b.amount-a.amount),
    monthly:[...monthMap.entries()].map(([month,x])=>({month,orders:x.orders,revenue:round(x.revenue)})).sort((a,b)=>a.month.localeCompare(b.month)),
    aging,
    unpaid_customers:[...unpaidByCustomer.entries()].map(([customer_id,x])=>({customer_id,...x,total:round(x.total)})).sort((a,b)=>b.total-a.total),
    payment_review:submittedPayments.map(p=>{
      const profile=p.customer_id?profileById.get(String(p.customer_id)):null;
      return {
        id:p.id,order_id:p.order_id,provider:p.provider,amount:Number(p.amount||0),submitted_at:p.submitted_at||p.created_at,
        customer_name:[profile?.first_name,profile?.last_name].filter(Boolean).join(" ")||profile?.email||"Customer"
      };
    }).sort((a,b)=>new Date(a.submitted_at).getTime()-new Date(b.submitted_at).getTime())
  });
});