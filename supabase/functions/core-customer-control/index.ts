import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json"}});

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST") return json({error:"Method not allowed"},405);

  const authHeader=req.headers.get("Authorization");
  if(!authHeader?.startsWith("Bearer ")) return json({error:"Authentication required"},401);

  const url=Deno.env.get("SUPABASE_URL")!;
  const publishableKeys=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
  const secretKeys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
  const userClient=createClient(url,publishableKeys.default,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false,autoRefreshToken:false}});
  const admin=createClient(url,secretKeys.nexus_rotation_20261023,{auth:{persistSession:false,autoRefreshToken:false}});

  const {data:{user},error:userError}=await userClient.auth.getUser();
  if(userError||!user) return json({error:"Invalid session"},401);
  const role=String(user.app_metadata?.role||"").trim().toLowerCase();
  if(!["owner","admin"].includes(role)) return json({error:"Core administrator access required"},403);

  let body:Record<string,unknown>;
  try{body=await req.json();}catch{return json({error:"Invalid JSON body"},400);}

  const action=String(body.action||"");
  const customerId=String(body.customerId||"").trim();
  if(!customerId) return json({error:"Customer ID is required"},400);

  const {data:before,error:readError}=await admin.from("profiles")
    .select("id,auth_user_id,customer_number,email,first_name,last_name,phone,address_line_1,address_line_2,city,state,postal_code,notes,preferred_contact_method,membership_id,account_status,updated_at")
    .eq("id",customerId).maybeSingle();
  if(readError) return json({error:"Could not load customer"},500);
  if(!before) return json({error:"Customer not found"},404);

  const audit=async(actionName:string,beforeData:Record<string,unknown>,afterData:Record<string,unknown>) =>
    admin.from("core_audit_events").insert({
      actor_user_id:user.id,actor_email:user.email||null,actor_role:role,action:actionName,
      entity_type:"profile",entity_id:customerId,before_data:beforeData,after_data:afterData,
      metadata:{customer_number:before.customer_number},
    });

  if(action==="update_notes"){
    const notes=String(body.notes??"").trim();
    if(notes.length>2000) return json({error:"Notes cannot exceed 2000 characters"},400);
    const next=notes||null;
    const {data:updated,error}=await admin.from("profiles").update({notes:next,updated_at:new Date().toISOString()})
      .eq("id",customerId).select("id,customer_number,notes,preferred_contact_method,membership_id,account_status,updated_at").single();
    if(error) return json({error:"Could not update customer notes"},500);
    const {error:auditError}=await audit("customer.notes.update",{notes:before.notes,updated_at:before.updated_at},{notes:updated.notes,updated_at:updated.updated_at});
    if(auditError){
      await admin.from("profiles").update({notes:before.notes,updated_at:before.updated_at}).eq("id",customerId);
      return json({error:"Update was rolled back because the audit event could not be recorded"},500);
    }
    return json({success:true,customer:updated});
  }

  if(action==="update_contact_preference"){
    const allowed=["email","phone","text","sms"];
    const raw=String(body.preferredContactMethod??"").trim().toLowerCase();
    const next=raw===""?null:raw;
    if(next&&!allowed.includes(next)) return json({error:"Unsupported contact preference"},400);

    const {data:updated,error}=await admin.from("profiles")
      .update({preferred_contact_method:next,updated_at:new Date().toISOString()})
      .eq("id",customerId).select("id,customer_number,notes,preferred_contact_method,membership_id,account_status,updated_at").single();
    if(error) return json({error:"Could not update contact preference"},500);
    const {error:auditError}=await audit("customer.contact_preference.update",
      {preferred_contact_method:before.preferred_contact_method,updated_at:before.updated_at},
      {preferred_contact_method:updated.preferred_contact_method,updated_at:updated.updated_at});
    if(auditError){
      await admin.from("profiles").update({preferred_contact_method:before.preferred_contact_method,updated_at:before.updated_at}).eq("id",customerId);
      return json({error:"Update was rolled back because the audit event could not be recorded"},500);
    }
    return json({success:true,customer:updated});
  }

  if(action==="update_membership"){
    const membershipId=String(body.membershipId||"").trim();
    if(!membershipId) return json({error:"Membership is required"},400);

    const {data:membership,error:membershipError}=await admin.from("memberships")
      .select("id,name,slug").eq("id",membershipId).eq("active",true).maybeSingle();
    if(membershipError) return json({error:"Could not validate membership"},500);
    if(!membership) return json({error:"Membership is inactive or not found"},404);

    const {data:oldMembership}=before.membership_id
      ? await admin.from("memberships").select("id,name,slug").eq("id",before.membership_id).maybeSingle()
      : {data:null};

    const {data:updated,error}=await admin.from("profiles")
      .update({membership_id:membership.id,updated_at:new Date().toISOString()})
      .eq("id",customerId).select("id,customer_number,membership_id,updated_at").single();
    if(error) return json({error:"Could not update membership"},500);

    const {error:auditError}=await audit("customer.membership.update",
      {membership_id:before.membership_id,membership_name:oldMembership?.name||null,updated_at:before.updated_at},
      {membership_id:updated.membership_id,membership_name:membership.name,updated_at:updated.updated_at});
    if(auditError){
      await admin.from("profiles").update({membership_id:before.membership_id,updated_at:before.updated_at}).eq("id",customerId);
      return json({error:"Update was rolled back because the audit event could not be recorded"},500);
    }
    return json({success:true,customer:updated,membership});
  }

  if(action==="update_account_status"){
    const raw=String(body.accountStatus||"").trim().toLowerCase();
    const allowed=new Map([["active","Active"],["suspended","Suspended"]]);
    const next=allowed.get(raw);
    if(!next) return json({error:"Unsupported account status"},400);

    const {data:updated,error}=await admin.from("profiles")
      .update({account_status:next,updated_at:new Date().toISOString()})
      .eq("id",customerId)
      .select("id,customer_number,account_status,updated_at")
      .single();
    if(error) return json({error:"Could not update account status"},500);

    const {error:auditError}=await audit("customer.account_status.update",
      {account_status:before.account_status,updated_at:before.updated_at},
      {account_status:updated.account_status,updated_at:updated.updated_at});

    if(auditError){
      await admin.from("profiles")
        .update({account_status:before.account_status,updated_at:before.updated_at})
        .eq("id",customerId);
      return json({error:"Update was rolled back because the audit event could not be recorded"},500);
    }

    return json({success:true,customer:updated});
  }

  if(action==="update_profile"){
    const clean=(value:unknown,max:number)=>{
      const text=String(value??"").trim();
      return text.slice(0,max)||null;
    };

    const next={
      first_name:clean(body.firstName,80),
      last_name:clean(body.lastName,80),
      phone:clean(body.phone,40),
      address_line_1:clean(body.addressLine1,160),
      address_line_2:clean(body.addressLine2,160),
      city:clean(body.city,100),
      state:clean(body.state,80),
      postal_code:clean(body.postalCode,30),
    };

    const beforeProfile={
      first_name:before.first_name,
      last_name:before.last_name,
      phone:before.phone,
      address_line_1:before.address_line_1,
      address_line_2:before.address_line_2,
      city:before.city,
      state:before.state,
      postal_code:before.postal_code,
      updated_at:before.updated_at,
    };

    const {data:updated,error}=await admin.from("profiles")
      .update({...next,updated_at:new Date().toISOString()})
      .eq("id",customerId)
      .select("id,customer_number,first_name,last_name,phone,address_line_1,address_line_2,city,state,postal_code,updated_at")
      .single();

    if(error) return json({error:"Could not update customer profile"},500);

    const {error:auditError}=await audit("customer.profile.update",
      beforeProfile,
      {
        first_name:updated.first_name,
        last_name:updated.last_name,
        phone:updated.phone,
        address_line_1:updated.address_line_1,
        address_line_2:updated.address_line_2,
        city:updated.city,
        state:updated.state,
        postal_code:updated.postal_code,
        updated_at:updated.updated_at,
      });

    if(auditError){
      await admin.from("profiles")
        .update({
          first_name:before.first_name,
          last_name:before.last_name,
          phone:before.phone,
          address_line_1:before.address_line_1,
          address_line_2:before.address_line_2,
          city:before.city,
          state:before.state,
          postal_code:before.postal_code,
          updated_at:before.updated_at,
        })
        .eq("id",customerId);
      return json({error:"Update was rolled back because the audit event could not be recorded"},500);
    }

    return json({success:true,customer:updated});
  }

  if(action==="update_email"){
    const email=String(body.email||"").trim().toLowerCase();
    const emailOk=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if(!emailOk) return json({error:"Enter a valid email address"},400);
    if(!before.auth_user_id) return json({error:"This customer is not linked to a Supabase Auth user"},409);

    const previousEmail=String(before.email||"").trim().toLowerCase();
    if(email===previousEmail) {
      return json({success:true,customer:{id:before.id,customer_number:before.customer_number,email:before.email,updated_at:before.updated_at},unchanged:true});
    }

    const {data:duplicate,error:duplicateError}=await admin.from("profiles")
      .select("id")
      .ilike("email",email)
      .neq("id",customerId)
      .limit(1);
    if(duplicateError) return json({error:"Could not validate email uniqueness"},500);
    if((duplicate||[]).length) return json({error:"That email is already assigned to another customer profile"},409);

    const {data:authUpdated,error:authError}=await admin.auth.admin.updateUserById(
      String(before.auth_user_id),
      {email}
    );
    if(authError||!authUpdated?.user) {
      return json({error:authError?.message||"Could not update login email"},400);
    }

    const {data:updated,error:profileError}=await admin.from("profiles")
      .update({email,updated_at:new Date().toISOString()})
      .eq("id",customerId)
      .select("id,customer_number,email,updated_at")
      .single();

    if(profileError||!updated){
      await admin.auth.admin.updateUserById(String(before.auth_user_id),{email:previousEmail});
      return json({error:"Profile email update failed; Auth email was rolled back"},500);
    }

    const {error:auditError}=await audit("customer.email.update",
      {email:previousEmail,updated_at:before.updated_at},
      {email:updated.email,updated_at:updated.updated_at});

    if(auditError){
      await admin.from("profiles").update({email:before.email,updated_at:before.updated_at}).eq("id",customerId);
      await admin.auth.admin.updateUserById(String(before.auth_user_id),{email:previousEmail});
      return json({error:"Email change was rolled back because the audit event could not be recorded"},500);
    }

    return json({success:true,customer:updated});
  }

  return json({error:"Unsupported action"},400);
});