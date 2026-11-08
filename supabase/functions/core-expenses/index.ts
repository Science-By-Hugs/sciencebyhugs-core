import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Owner/admin-only manual expense ledger and read-only vendor PO commitments.
// No API action changes inventory, product costs, checkout, or payments.
const cors={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{
  status,headers:{...cors,"Content-Type":"application/json"}
});
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  const authorization=req.headers.get("Authorization")||"";
  if(!authorization.startsWith("Bearer "))return json({error:"Authentication required"},401);
  try{
    const url=Deno.env.get("SUPABASE_URL")!;
    const pub=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");
    const sec=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
    if(!url||!pub.default||!sec.nexus_rotation_20261023)
      return json({error:"Expense service configuration unavailable"},503);
    const userClient=createClient(url,pub.default,{
      global:{headers:{Authorization:authorization}},
      auth:{persistSession:false,autoRefreshToken:false}
    });
    const {data:{user},error:authError}=await userClient.auth.getUser();
    if(authError||!user)return json({error:"Invalid session"},401);
    const role=String(user.app_metadata?.role||"").toLowerCase().trim();
    if(!["owner","admin"].includes(role))
      return json({error:"Core administrator access required"},403);
    const admin=createClient(url,sec.nexus_rotation_20261023,{
      auth:{persistSession:false,autoRefreshToken:false}
    });
    let body:Record<string,unknown>;
    try {body=await req.json();}
    catch {return json({error:"Invalid request"},400);}
    const action=String(body.action||"");
    if(action==="list"){
      const [expensesR,vendorsR,ordersR,linesR]=await Promise.all([
        admin.from("core_finance_expenses")
          .select("id,expense_date,category,vendor_id,purchase_order_id,payee,amount,payment_method,reference_number,notes,status,created_at,updated_at,voided_at")
          .order("expense_date",{ascending:false}).order("created_at",{ascending:false}).limit(1001),
        admin.from("inventory_vendors").select("id,name,code,active").order("name").limit(501),
        admin.from("inventory_purchase_orders")
          .select("id,po_number,vendor_id,status,shipping_actual,fees_actual,ordered_at")
          .order("ordered_at",{ascending:false}).limit(501),
        admin.from("inventory_purchase_lines")
          .select("id,purchase_order_id,packs_ordered,pack_price_snapshot")
          .limit(2001)
      ]);
      if([expensesR,vendorsR,ordersR,linesR].some(x=>x.error)){
        console.error("finance_expenses_list_failure",[expensesR,vendorsR,ordersR,linesR].map(x=>x.error?.code||null));
        return json({error:"Could not load expense and purchase records"},503);
      }
      const expenses=expensesR.data||[];
      const vendors=vendorsR.data||[];
      const purchaseOrders=ordersR.data||[];
      const purchaseLines=linesR.data||[];
      if(expenses.length>1000||vendors.length>500||purchaseOrders.length>500||purchaseLines.length>2000){
        return json({error:"Expense or purchase history exceeds safe display limit; pagination is required before showing totals"},503);
      }
      const merchandiseByPo=new Map<string,number>();
      for(const line of purchaseLines){
        const key=String(line.purchase_order_id);
        merchandiseByPo.set(key,(merchandiseByPo.get(key)||0)+
          Number(line.packs_ordered||0)*Number(line.pack_price_snapshot||0));
      }
      return json({
        success:true,generated_at:new Date().toISOString(),
        expenses,vendors,
        purchase_orders:purchaseOrders.map(po=>({
          id:po.id,po_number:po.po_number,vendor_id:po.vendor_id,
          status:po.status,ordered_at:po.ordered_at,
          merchandise_total:Math.round((merchandiseByPo.get(String(po.id))||0)*100)/100,
          inbound_shipping:Number(po.shipping_actual||0),
          fees:Number(po.fees_actual||0)
        })),
        accounting_note:"Purchase orders show recorded commitments, not verified payments. Manual expenses are separate; inventory COGS is not deducted a second time."
      });
    }
    if(["create","update","void"].includes(action)){
      if(!body.payload||typeof body.payload!=="object"||Array.isArray(body.payload))
        return json({error:"Valid expense details required"},400);
      const {data,error}=await admin.rpc("core_manage_finance_expense",{
        p_action:action,
        p_payload:body.payload,
        p_expected_updated_at:action==="create"?null:String(body.expectedUpdatedAt||"")||null,
        p_actor_id:user.id,
        p_confirmation:action==="void"?String(body.confirmation||""):null
      });
      if(error){
        const msg=String(error.message||"Expense not saved");
        const conflict=/changed elsewhere|voided|not found|version/i.test(msg);
        return json({error:msg},conflict?409:400);
      }
      return json({success:true,expense:data});
    }
    return json({error:"Unknown action"},400);
  }catch(error){
    console.error("core_expenses_failure",error instanceof Error?error.message:"unknown");
    return json({error:"Expense service temporarily unavailable"},503);
  }
});
