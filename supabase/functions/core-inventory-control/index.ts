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
    if (action === "list") {
      const [vendors,offers,products,orders,lines,lots,settings] = await Promise.all([
        db.from("inventory_vendors").select("id,code,name,active,notes").order("name"),
        db.from("inventory_vendor_offers").select("id,vendor_id,product_id,vendor_sku,units_per_pack,price_per_pack,estimated_inbound_shipping,lead_time_days,quote_date,active").order("updated_at",{ascending:false}),
        db.from("products").select("id,product_code,name,price,product_type").order("name").limit(250),
        db.from("inventory_purchase_orders").select("id,po_number,vendor_id,status,shipping_actual,fees_actual,ordered_at,received_at").order("ordered_at",{ascending:false}).limit(100),
        db.from("inventory_purchase_lines").select("id,purchase_order_id,offer_id,product_id,packs_ordered,units_per_pack_snapshot,pack_price_snapshot,expected_units").limit(100),
        db.from("inventory_lots").select("id,receipt_id,product_id,vendor_id,internal_lot,supplier_lot,expiry_date,accepted_units,damaged_units,landed_unit_cost,created_at").order("created_at",{ascending:false}).limit(100),
        db.from("inventory_product_settings").select("product_id,supply_mode,reorder_point").limit(250),
      ]);
      const failed = [vendors,offers,products,orders,lines,lots,settings].find(x=>x.error);
      if (failed?.error) return json({error:"Inventory database is not yet available: "+failed.error.message},503);
      return json({success:true, vendors:vendors.data, offers:offers.data, products:products.data,
        orders:orders.data, lines:lines.data, lots:lots.data, settings:settings.data});
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
