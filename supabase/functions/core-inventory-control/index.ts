import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import QRCode from "npm:qrcode@1.5.4";

// Dedicated inventory API. Never exposed directly to Nexus or public catalog.
// All database tables and RPCs are service-role-only + RLS, with validated
// owner/admin JWT checked BEFORE the service role is used.
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(
  JSON.stringify(body), { status, headers: {...headers, "Content-Type": "application/json"} },
);
const text = (input: unknown, max = 120) => String(input ?? "").trim().slice(0,max);
const cents = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error("Enter a valid nonnegative dollar amount");
  return Math.round(n * 100) / 100;
};
const quantity = (value: unknown, max = 1000) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error("Enter a valid positive whole number");
  return n;
};

function validatedBaseUrl(value: unknown) {
  const url = new URL(String(value || ""));
  const host = url.hostname.toLowerCase();
  const good = host === "core.sciencebyhugs.com"
    || host === "science-by-hugs.github.io"
    || host === "localhost"
    || host === "127.0.0.1";
  if (!good || (url.protocol !== "https:" && host !== "localhost" && host !== "127.0.0.1")) {
    throw new Error("QR code destination must be a verified Core address");
  }
  url.search = "";
  url.hash = "";
  return url;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", {headers});
  if (req.method !== "POST") return json({error:"Method not allowed"},405);
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({error:"Authentication required"},401);

  const url = Deno.env.get("SUPABASE_URL");
  const publicKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!url || !publicKeys || !secretKeys) return json({error:"Inventory service is not configured"},503);
  const pub = JSON.parse(publicKeys).default;
  const secret = JSON.parse(secretKeys).nexus_rotation_20261023;
  if (!pub || !secret) return json({error:"Inventory service is not configured"},503);
  const userClient = createClient(url,pub,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:userError} = await userClient.auth.getUser();
  if (userError || !user) return json({error:"Invalid session"},401);
  const role = text(user.app_metadata?.role).toLowerCase();
  if (!["owner","admin"].includes(role)) return json({error:"Core admin access required"},403);
  const db = createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});

  let body: Record<string,unknown>;
  try { body = await req.json(); }
  catch { return json({error:"Invalid request"},400); }
  const action = text(body.action,50);
  try {
    // Phase 5C: read-only monitoring is *owner-only*, unlike inventory
    // management actions which also admit admins. No customer records or
    // vendor/lot details are sent outside the authenticated Core workspace.
    if (action === "monitor") {
      if (role !== "owner") return json({error:"Owner access required"},403);
      const {data,error} = await db.rpc("core_inventory_monitor_snapshot");
      if (error || !data) {
        console.error("core_inventory_monitor_read_failed",{
          code:error?.code || "empty_snapshot",
        });
        return json({error:"Inventory monitoring is temporarily unavailable"},503);
      }
      return json({success:true,monitor:data});
    }
    if (action === "list") {
      const [vendors,offers,products,orders,lines,lots,settings,receipts] = await Promise.all([
        db.from("inventory_vendors").select("id,code,name,active,notes").order("name"),
        db.from("inventory_vendor_offers").select("id,vendor_id,product_id,vendor_sku,units_per_pack,price_per_pack,estimated_inbound_shipping,lead_time_days,quote_date,active").order("updated_at",{ascending:false}),
        db.from("products").select("id,product_code,name,price,product_type").order("name").limit(250),
        db.from("inventory_purchase_orders").select("id,po_number,vendor_id,status,shipping_actual,fees_actual,ordered_at,received_at,multi_line,allocation_method").order("ordered_at",{ascending:false}).limit(100),
        db.from("inventory_purchase_lines").select("id,purchase_order_id,offer_id,product_id,packs_ordered,units_per_pack_snapshot,pack_price_snapshot,expected_units,shipping_allocated,fees_allocated").limit(100),
        db.from("inventory_lots").select("id,receipt_id,product_id,vendor_id,internal_lot,supplier_lot,expiry_date,accepted_units,damaged_units,landed_unit_cost,cost_finalized,created_at").order("created_at",{ascending:false}).limit(100),
        db.from("inventory_product_settings").select("product_id,supply_mode,reorder_point").limit(250),
        db.from("inventory_receipts").select("id,purchase_order_id,purchase_line_id,accepted_units,damaged_units,received_at").order("received_at",{ascending:false}).limit(1000),
      ]);
      const failed = [vendors,offers,products,orders,lines,lots,settings,receipts].find(x=>x.error);
      if (failed?.error) return json({error:"Inventory database is not yet available: "+failed.error.message},503);
      // Aggregate actual unit statuses for the owner dashboard; never return individual
      // scan tokens, customer data or financial credentials in this summary.
      // PostgREST responses are capped at 1,000 rows by default: page explicitly.
      const counts=new Map<string,{product_id:string;state:string;count:number}>();
      let countsComplete=false;
      for (let page=0;page<100;page++) {
        const {data:units,error:unitError}=await db.from("inventory_units")
          .select("product_id,state").order("id",{ascending:true})
          .range(page*1000,page*1000+999);
        if (unitError) return json({error:"Could not calculate live stock counts"},503);
        for (const unit of units||[]) {
          const key=unit.product_id+":"+unit.state;
          const old=counts.get(key);
          if (old) old.count++;
          else counts.set(key,{product_id:unit.product_id,state:unit.state,count:1});
        }
        if ((units?.length||0)<1000) { countsComplete=true;break; }
      }
      return json({success:true, vendors:vendors.data, offers:offers.data, products:products.data,
        orders:orders.data, lines:lines.data, lots:lots.data, settings:settings.data,receipts:receipts.data,
        unit_counts:[...counts.values()],counts_complete:countsComplete});
    }
    if (action === "add_vendor") {
      const name = text(body.name);
      const code = text(body.code,8).toUpperCase();
      if (name.length < 2 || !/^[A-Z0-9]{2,8}$/.test(code)) return json({error:"Vendor name and 2–8 letter/digit code required"},400);
      const {data,error} = await db.from("inventory_vendors")
        .insert({name,code,notes:text(body.notes,500)||null,created_by:user.id})
        .select("id,name,code").single();
      if (error) return json({error:"Could not add vendor: "+error.message},409);
      return json({success:true,vendor:data});
    }
    if (action === "save_offer") {
      const vendorId = text(body.vendorId,36), productId = text(body.productId,36);
      const units = quantity(body.unitsPerPack);
      const price = cents(body.pricePerPack);
      const shipping = cents(body.estimatedInboundShipping ?? 0);
      const lead = body.leadTimeDays === "" || body.leadTimeDays == null
        ? null : Number(body.leadTimeDays);
      if (lead !== null && (!Number.isInteger(lead) || lead < 0 || lead > 365)) return json({error:"Lead time must be 0–365 days"},400);
      const {data,error} = await db.from("inventory_vendor_offers").upsert({
        vendor_id:vendorId,product_id:productId,units_per_pack:units,price_per_pack:price,
        estimated_inbound_shipping:shipping,lead_time_days:lead,
        vendor_sku:text(body.vendorSku)||null,quote_date:new Date().toISOString().slice(0,10),
        updated_at:new Date().toISOString(),active:true,
      },{onConflict:"vendor_id,product_id,units_per_pack"})
      .select("id,vendor_id,product_id,units_per_pack,price_per_pack").single();
      if (error) return json({error:"Could not save offering: "+error.message},409);
      return json({success:true,offer:data});
    }
    if (action === "classify_product") {
      const productId = text(body.productId,36);
      const mode = text(body.supplyMode,30);
      const reorder = Number(body.reorderPoint ?? 0);
      if (!["unreviewed","physical","vendor"].includes(mode))
        return json({error:"Choose Physical, Vendor-Supplied, or Unreviewed"},400);
      if (!Number.isInteger(reorder) || reorder < 0 || reorder > 100000)
        return json({error:"Reorder point must be a nonnegative whole number"},400);
      const {data,error} = await db.from("inventory_product_settings")
        .upsert({product_id:productId,supply_mode:mode,reorder_point:reorder,
          updated_at:new Date().toISOString()},{onConflict:"product_id"})
        .select("product_id,supply_mode,reorder_point").single();
      if (error) return json({error:"Could not classify product: "+error.message},409);
      return json({success:true,settings:data});
    }
    if (action === "create_purchase") {
      const packs = quantity(body.packs);
      const shipping = cents(body.shipping ?? 0),fees = cents(body.fees ?? 0);
      const request = text(body.requestId,36);
      const {data,error} = await db.rpc("core_inventory_create_purchase",{
        p_offer_id:text(body.offerId,36),p_packs:packs,p_shipping:shipping,p_fees:fees,
        p_request_id:request,p_actor_id:user.id,
      });
      if (error) return json({error:"Could not create purchase order: "+error.message},409);
      return json({success:true,purchase:data});
    }
    if (action === "receive_purchase") {
      const accepted = Number(body.accepted),damaged = Number(body.damaged);
      if (!Number.isInteger(accepted)||accepted<0||!Number.isInteger(damaged)||damaged<0)
        return json({error:"Received counts must be whole numbers"},400);
      const date = text(body.expiryDate,10);
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({error:"Invalid expiration date"},400);
      const {data,error} = await db.rpc("core_inventory_receive_purchase",{
        p_order_id:text(body.orderId,36),p_accepted:accepted,p_damaged:damaged,
        p_supplier_lot:text(body.supplierLot),p_expiry:date||null,
        p_request_id:text(body.requestId,36),p_actor_id:user.id,
      });
      if (error) return json({error:"Could not receive inventory: "+error.message},409);
      return json({success:true,receipt:data});
    }
    if (action === "create_multi_purchase") {
      const vendorId = text(body.vendorId,36);
      const allocationMethod = text(body.allocationMethod,12);
      if (!["per_kit","by_cost","manual"].includes(allocationMethod))
        return json({error:"Select an allocation method"},400);
      if (!Array.isArray(body.lines) || body.lines.length<1 || body.lines.length>25)
        return json({error:"Choose 1 to 25 product offerings"},400);
      const lines=body.lines.map(raw=>{
        if (!raw || typeof raw !== "object") throw new Error("Invalid product line");
        const row=raw as Record<string,unknown>;
        const result:Record<string,unknown>={
          offerId:text(row.offerId,36),packs:quantity(row.packs),
        };
        if (allocationMethod==="manual") {
          result.shipping=cents(row.shipping);
          result.fees=cents(row.fees);
        }
        return result;
      });
      const {data,error}=await db.rpc("core_inventory_create_multi_purchase",{
        p_vendor_id:vendorId,p_lines:lines,p_shipping:cents(body.shipping),
        p_fees:cents(body.fees),p_allocation_method:allocationMethod,
        p_request_id:text(body.requestId,36),p_actor_id:user.id,
      });
      if (error) return json({error:"Could not create multi-product purchase: "+error.message},409);
      return json({success:true,purchase:data});
    }
    if (action === "receive_multi_line") {
      const accepted=Number(body.accepted),damaged=Number(body.damaged);
      if (!Number.isInteger(accepted)||!Number.isInteger(damaged)||
        accepted<0||damaged<0||accepted+damaged<1||accepted+damaged>100)
        return json({error:"Enter 1 to 100 total received units (usable + damaged)"},400);
      const date=text(body.expiryDate,10);
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return json({error:"Invalid expiration date"},400);
      const {data,error}=await db.rpc("core_inventory_receive_multi_line",{
        p_line_id:text(body.lineId,36),p_accepted:accepted,p_damaged:damaged,
        p_supplier_lot:text(body.supplierLot,120),p_expiry:date||null,
        p_request_id:text(body.requestId,36),p_actor_id:user.id,
      });
      if (error) return json({error:"Could not receive purchase line: "+error.message},409);
      return json({success:true,receipt:data});
    }
    if (action === "audit_lot") {
      const lotId=text(body.lotId,36);
      const {data:lot,error:lotError}=await db.from("inventory_lots")
        .select("id,internal_lot,product_id,supplier_lot,accepted_units,damaged_units")
        .eq("id",lotId).maybeSingle();
      if (lotError) return json({error:"Could not read inventory lot"},500);
      if (!lot) return json({error:"Lot not found"},404);
      const [units,counts]=await Promise.all([
        db.from("inventory_units").select("id,ordinal,state")
          .eq("lot_id",lotId).order("ordinal").limit(101),
        db.from("inventory_stock_counts")
          .select("id,status,expected_available,expected_damaged,counted_available,counted_damaged,notes,created_at,resolved_at,resolved_unit_ids")
          .eq("lot_id",lotId).order("created_at",{ascending:false}).limit(20),
      ]);
      if (units.error||counts.error) return json({error:"Could not read physical count history"},500);
      if ((units.data?.length||0)>100)
        return json({error:"Audit currently supports at most 100 tracked units per lot"},409);
      const current={
        available:(units.data||[]).filter(x=>x.state==="available").length,
        damaged:(units.data||[]).filter(x=>x.state==="damaged").length,
        missing:(units.data||[]).filter(x=>x.state==="missing").length,
        reserved:(units.data||[]).filter(x=>x.state==="reserved").length,
        quarantined:(units.data||[]).filter(x=>x.state==="quarantined").length,
      };
      return json({success:true,lot,units:units.data,counts:current,history:counts.data});
    }
    if (action === "submit_lot_count") {
      const available=Number(body.countedAvailable),damaged=Number(body.countedDamaged);
      if (!Number.isInteger(available)||!Number.isInteger(damaged)||
        available<0||damaged<0||available>100||damaged>100)
        return json({error:"Enter a valid 0–100 count for each category"},400);
      const {data,error}=await db.rpc("core_inventory_count_lot",{
        p_lot_id:text(body.lotId,36),
        p_counted_available:available,p_counted_damaged:damaged,
        p_notes:text(body.notes,500),
        p_request_id:text(body.requestId,36),p_actor_id:user.id,
      });
      if (error) return json({error:"Could not save physical count: "+error.message},409);
      return json({success:true,audit:data});
    }
    if (action === "resolve_lot_count") {
      if(!Array.isArray(body.missingUnitIds)||body.missingUnitIds.length>100 ||
        !body.missingUnitIds.every(x=>typeof x==="string"&&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)))
        return json({error:"Provide the tracked identifiers of missing units"},400);
      const {data,error}=await db.rpc("core_inventory_resolve_lot_count",{
        p_count_id:text(body.countId,36),
        p_missing_unit_ids:body.missingUnitIds,
        p_actor_id:user.id,
      });
      if(error) return json({error:"Could not reconcile physical count: "+error.message},409);
      return json({success:true,reconciliation:data});
    }
    if (action === "lookup_unit" || action === "labels_for_lot") {
      const lotId = text(body.lotId,36);
      const token = text(body.token,36);
      let unitQuery = db.from("inventory_units")
        .select("id,lot_id,product_id,ordinal,scan_token,state");
      if (action === "lookup_unit") unitQuery = unitQuery.eq("scan_token",token);
      else unitQuery = unitQuery.eq("lot_id",lotId).order("ordinal").limit(100);
      const {data:units,error} = await unitQuery;
      if (error) return json({error:"Could not read unit tracking"},500);
      if (!units?.length) return json({error:"No matching inventory units"},404);
      const uniqueLots=[...new Set(units.map(x=>x.lot_id))];
      const {data:lots,error:lotError} = await db.from("inventory_lots")
        .select("id,internal_lot,supplier_lot,expiry_date,product_id,accepted_units,damaged_units")
        .in("id",uniqueLots);
      if (lotError) return json({error:"Could not read lot details"},500);
      const {data:products,error:prodError} = await db.from("products")
        .select("id,product_code,name").in("id",[...new Set(units.map(x=>x.product_id))]);
      if (prodError) return json({error:"Could not read product details"},500);
      const result=[];
      const base = action === "labels_for_lot" ? validatedBaseUrl(body.baseUrl) : null;
      for (const u of units) {
        const lot=lots?.find(l=>l.id===u.lot_id);
        const product=products?.find(p=>p.id===u.product_id);
        if (!lot || !product) continue;
        const entry:Record<string,unknown>={unit_id:u.id,scan_token:u.scan_token,state:u.state,
          ordinal:u.ordinal,total_units:lot.accepted_units+lot.damaged_units,
          internal_lot:lot.internal_lot,supplier_lot:lot.supplier_lot,
          product_code:product.product_code,product_name:product.name,expiry_date:lot.expiry_date};
        if (base) {
          const target = new URL(base.toString());
          target.hash = "inventory?unit=" + encodeURIComponent(u.scan_token);
          entry.qr_svg = await QRCode.toString(target.toString(),{
            type:"svg",errorCorrectionLevel:"M",margin:2,width:220,
          });
        }
        result.push(entry);
      }
      if (action === "labels_for_lot" && base) {
        // A lot-level QR for the outer box. This does not identify a single vial.
        const target = new URL(base.toString());
        target.hash = "inventory?lot=" + encodeURIComponent(lotId);
        const boxQrSvg = await QRCode.toString(target.toString(),{
          type:"svg",errorCorrectionLevel:"M",margin:2,width:220,
        });
        return json({success:true,units:result,box_qr_svg:boxQrSvg});
      }
      return json({success:true,units:result});
    }
    return json({error:"Unsupported inventory action"},400);
  } catch (err) {
    console.error("core-inventory-control operation error:",err instanceof Error ? err.message : "unknown");
    return json({error:err instanceof Error ? err.message:"Inventory request failed"},400);
  }
});
