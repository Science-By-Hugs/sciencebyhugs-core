import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2.117.1";

// Core owner/admin only. Operational P&L: read-only reporting, never payments.
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
 const bearer=req.headers.get("Authorization")||"";
 if(!bearer.startsWith("Bearer "))return json({error:"Authentication required"},401);
 try{
  const url=Deno.env.get("SUPABASE_URL")!;
  const pub=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");
  const sec=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
  if(!url||!pub.default||!sec.nexus_rotation_20261023)
    return json({error:"Monthly reporting service configuration unavailable"},503);
  const userClient=createClient(url,pub.default,{
    global:{headers:{Authorization:bearer}},
    auth:{persistSession:false,autoRefreshToken:false}
  });
  const {data:{user},error:authError}=await userClient.auth.getUser();
  if(authError||!user)return json({error:"Invalid session"},401);
  const role=String(user.app_metadata?.role||"").toLowerCase().trim();
  if(!["owner","admin"].includes(role))return json({error:"Core administrator access required"},403);
  let body:Record<string,unknown>={};
  try{body=await req.json()}catch{return json({error:"Invalid report request"},400)}
  const year=body.year==null?null:Number(body.year);
  if(year!==null&&(!Number.isInteger(year)||year<2020||year>2100))
    return json({error:"Choose a valid reporting year"},400);
  const admin=createClient(url,sec.nexus_rotation_20261023,{
    auth:{persistSession:false,autoRefreshToken:false}
  });
  let result=await admin.rpc("core_monthly_profit_loss",{p_year:year});
  // A transient PostgREST service-key JWT validation can affect one read.
  // Retry only this read-only RPC, never a financial mutation.
  if(result.error?.code==="PGRST303"){
    console.warn("core_monthly_pnl_read_auth_retry",result.error.code);
    result=await admin.rpc("core_monthly_profit_loss",{p_year:year});
  }
  if(result.error||!result.data){
    console.error("core_monthly_pnl_error",result.error?.code||"empty");
    return json({error:"Monthly financial report temporarily unavailable. Try again."},503);
  }
  return json({success:true,...result.data});
 }catch(err){
  console.error("core_monthly_pnl_failure",err instanceof Error?err.message:"unknown");
  return json({error:"Monthly reporting temporarily unavailable"},503);
 }
});
