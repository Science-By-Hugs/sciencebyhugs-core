import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Google exit (2026-10-27): Core is the catalog source of truth.
// Actions:
//   list_shipping_rates                       - read shipping rates (no productId)
//   set_shipping_rate / delete_shipping_rate  - edit shipping rates (no productId)
//   create_product                            - create a product (no productId)
//   update_product                            - edit every sellable/display field (expectedUpdatedAt guard)
//   set_availability                          - sell / stop selling on Nexus
//   remove_product                            - archive if ever ordered, otherwise delete
//   set_visibility / update_metadata / delete_product - unchanged from deployed v8
// Every mutation writes core_audit_events.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});
const clean = (value: unknown, max: number) => {
  const text = String(value ?? "").trim();
  return text.slice(0, max) || null;
};

const PRODUCT_COLUMNS =
  "id,name,product_code,sku,research_name,category_id,description,purity,quantity,lot_number,coa_url,price,active,featured,core_hidden,image_url,product_type,shipping_from,storefront_status,source,sync_source,source_key,source_synced_at,created_at,updated_at";

class InputError extends Error {}

function parseUrl(value: unknown, label: string): string | null {
  const text = clean(value, 1000);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("bad");
  } catch {
    throw new InputError(label + " must be a valid http or https URL");
  }
  return text;
}

function parsePrice(value: unknown): number {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) {
    throw new InputError("Price must be a number like 49 or 49.99 (at most 2 decimals)");
  }
  const price = Number(text);
  if (price > 100000) throw new InputError("Price must be 100,000 or less");
  return Math.round(price * 100) / 100;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);

  const userClient = createClient(url, publishableKeys.default, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(url, secretKeys.nexus_rotation_20261023, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid session" }, 401);

  const role = String(user.app_metadata?.role || "").trim().toLowerCase();
  if (!["owner", "admin"].includes(role)) return json({ error: "Core administrator access required" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const action = String(body.action || "").trim();

  const audit = (auditAction: string, entityType: string, entityId: string, before: unknown, after: unknown, metadata: Record<string, unknown> = {}) =>
    admin.from("core_audit_events").insert({
      actor_user_id: user.id,
      actor_email: user.email || null,
      actor_role: role,
      action: auditAction,
      entity_type: entityType,
      entity_id: entityId,
      before_data: before,
      after_data: after,
      metadata: { source: "core", ...metadata },
    });

  // ---------- Shipping rates (stored in internal_runtime_config 'checkout') ----------
  const loadCheckoutConfig = async () => {
    const { data, error } = await admin.from("internal_runtime_config").select("value").eq("key", "checkout").single();
    if (error || !data?.value) throw new Error("Checkout configuration unavailable");
    return data.value as Record<string, unknown>;
  };

  if (action === "list_shipping_rates") {
    try {
      const config = await loadCheckoutConfig();
      return json({
        success: true,
        shippingRates: (config.shippingRates as Record<string, number>) || {},
        foundingMemberFreeShippingSource: config.foundingMemberFreeShippingSource || null,
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Could not load shipping rates" }, 500);
    }
  }

  if (action === "set_shipping_rate" || action === "delete_shipping_rate") {
    const source = clean(body.source, 120);
    if (!source) return json({ error: "Shipping source name is required" }, 400);

    let config: Record<string, unknown>;
    try { config = await loadCheckoutConfig(); } catch { return json({ error: "Checkout configuration unavailable" }, 500); }
    const rates = { ...((config.shippingRates as Record<string, number>) || {}) };
    const beforeRate = Object.prototype.hasOwnProperty.call(rates, source) ? rates[source] : null;

    if (action === "set_shipping_rate") {
      let rate: number;
      try { rate = parsePrice(body.rate); } catch (e) { return json({ error: "Shipping " + (e as Error).message.toLowerCase() }, 400); }
      rates[source] = rate;
    } else {
      if (beforeRate === null) return json({ error: "Shipping source not found" }, 404);
      const { count } = await admin.from("products").select("id", { count: "exact", head: true })
        .eq("shipping_from", source).eq("active", true);
      if ((count || 0) > 0) {
        return json({ error: `${count} active product(s) still ship from "${source}". Move them first.` }, 409);
      }
      delete rates[source];
    }

    const { error: updateError } = await admin.from("internal_runtime_config")
      .update({ value: { ...config, shippingRates: rates } }).eq("key", "checkout");
    if (updateError) return json({ error: "Could not save shipping rates" }, 500);

    const { error: auditError } = await audit(
      action === "set_shipping_rate" ? "catalog.shipping_rate.set" : "catalog.shipping_rate.delete",
      "shipping_rate", source,
      { rate: beforeRate },
      { rate: action === "set_shipping_rate" ? rates[source] : null },
    );
    if (auditError) {
      await admin.from("internal_runtime_config").update({ value: config }).eq("key", "checkout");
      return json({ error: "Shipping change was rolled back because the audit event could not be recorded" }, 500);
    }
    return json({ success: true, shippingRates: rates });
  }

  // ---------- Product field parsing shared by create/update ----------
  const readProductFields = async (requireAll: boolean) => {
    const name = clean(body.name, 200);
    if (requireAll && !name) throw new InputError("Product name is required");
    if (!requireAll && body.name !== undefined && !name) throw new InputError("Product name cannot be empty");

    const fields: Record<string, unknown> = {};
    const has = (key: string) => requireAll || body[key] !== undefined;

    if (has("name")) fields.name = name;
    if (has("price")) fields.price = parsePrice(body.price);
    if (has("description")) fields.description = clean(body.description, 5000);
    if (has("productType")) fields.product_type = clean(body.productType, 120);
    if (has("productCode")) fields.product_code = clean(body.productCode, 120);
    if (has("sku")) fields.sku = clean(body.sku, 120);
    if (has("researchName")) fields.research_name = clean(body.researchName, 200);
    if (has("purity")) fields.purity = clean(body.purity, 120);
    if (has("quantity")) fields.quantity = clean(body.quantity, 120);
    if (has("lotNumber")) fields.lot_number = clean(body.lotNumber, 120);
    if (has("imageUrl")) fields.image_url = parseUrl(body.imageUrl, "Image URL");
    if (has("coaUrl")) fields.coa_url = parseUrl(body.coaUrl, "COA URL");
    if (has("featured")) fields.featured = body.featured === true;
    if (has("coreHidden")) fields.core_hidden = body.coreHidden === true;

    if (has("categoryId")) {
      const categoryId = clean(body.categoryId, 64);
      if (categoryId) {
        const { data: category } = await admin.from("product_categories").select("id").eq("id", categoryId).maybeSingle();
        if (!category) throw new InputError("Unknown category");
      }
      fields.category_id = categoryId;
    }

    if (has("shippingFrom")) {
      const shippingFrom = clean(body.shippingFrom, 120);
      if (shippingFrom) {
        const config = await loadCheckoutConfig();
        const rates = (config.shippingRates as Record<string, number>) || {};
        if (!Object.prototype.hasOwnProperty.call(rates, shippingFrom)) {
          throw new InputError(`Unknown shipping source "${shippingFrom}". Add it under Shipping rates first.`);
        }
      }
      fields.shipping_from = shippingFrom;
    }

    if (has("available")) {
      const available = body.available === true;
      fields.active = available;
      fields.storefront_status = available ? "Available" : "Inactive";
    }
    return fields;
  };

  if (action === "create_product") {
    let fields: Record<string, unknown>;
    try { fields = await readProductFields(true); } catch (e) {
      return json({ error: e instanceof InputError ? e.message : "Could not validate product" }, 400);
    }
    const now = new Date().toISOString();
    const { data: created, error: createError } = await admin.from("products")
      .insert({ ...fields, source: "core_manual", sync_source: "core_manual", created_at: now, updated_at: now })
      .select(PRODUCT_COLUMNS).single();
    if (createError || !created) return json({ error: "Could not create product" }, 500);

    const { error: auditError } = await audit("catalog.product.create", "product", created.id, null, created, { product_name: created.name });
    if (auditError) {
      await admin.from("products").delete().eq("id", created.id);
      return json({ error: "Product creation was rolled back because the audit event could not be recorded" }, 500);
    }
    return json({ success: true, product: created });
  }

  // ---------- Everything below acts on one existing product ----------
  const productId = String(body.productId || "").trim();
  if (!productId) return json({ error: "Product ID is required" }, 400);

  const { data: before, error: readError } = await admin.from("products").select(PRODUCT_COLUMNS).eq("id", productId).maybeSingle();
  if (readError) return json({ error: "Could not load product" }, 500);
  if (!before) return json({ error: "Product not found" }, 404);

  const checkFresh = () => {
    const expected = clean(body.expectedUpdatedAt, 64);
    if (expected && new Date(expected).getTime() !== new Date(before.updated_at).getTime()) {
      return json({ error: "This product was changed by someone else since you opened it. Refresh and try again.", conflict: true }, 409);
    }
    return null;
  };

  const applyUpdate = async (fields: Record<string, unknown>, auditAction: string) => {
    const changedKeys = Object.keys(fields).filter(key =>
      JSON.stringify((before as Record<string, unknown>)[key] ?? null) !== JSON.stringify(fields[key] ?? null));
    if (!changedKeys.length) return json({ success: true, product: before, unchanged: true });

    const updatedAt = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: updatedAt };
    for (const key of changedKeys) patch[key] = fields[key];
    if (before.sync_source !== "core_manual") patch.sync_source = "core_manual";

    let query = admin.from("products").update(patch).eq("id", productId);
    // Atomic precondition: only update if nobody changed it in between.
    query = query.eq("updated_at", before.updated_at);
    const { data: updated, error: updateError } = await query.select(PRODUCT_COLUMNS).maybeSingle();
    if (updateError) return json({ error: "Could not update product" }, 500);
    if (!updated) return json({ error: "This product was changed by someone else since you opened it. Refresh and try again.", conflict: true }, 409);

    const beforeDiff: Record<string, unknown> = {};
    const afterDiff: Record<string, unknown> = {};
    for (const key of changedKeys) {
      beforeDiff[key] = (before as Record<string, unknown>)[key] ?? null;
      afterDiff[key] = (updated as Record<string, unknown>)[key] ?? null;
    }
    const { error: auditError } = await audit(auditAction, "product", productId, beforeDiff, afterDiff, { product_name: before.name });
    if (auditError) {
      const revert: Record<string, unknown> = { updated_at: before.updated_at, sync_source: before.sync_source };
      for (const key of changedKeys) revert[key] = (before as Record<string, unknown>)[key] ?? null;
      await admin.from("products").update(revert).eq("id", productId);
      return json({ error: "Update was rolled back because the audit event could not be recorded" }, 500);
    }
    return json({ success: true, product: updated });
  };

  if (action === "update_product") {
    const stale = checkFresh();
    if (stale) return stale;
    let fields: Record<string, unknown>;
    try { fields = await readProductFields(false); } catch (e) {
      return json({ error: e instanceof InputError ? e.message : "Could not validate product" }, 400);
    }
    return await applyUpdate(fields, "catalog.product.update");
  }

  if (action === "set_availability") {
    const stale = checkFresh();
    if (stale) return stale;
    const available = body.available === true;
    return await applyUpdate(
      { active: available, storefront_status: available ? "Available" : "Inactive" },
      available ? "catalog.product.available" : "catalog.product.unavailable",
    );
  }

  if (action === "remove_product") {
    const { data: removed, error: removeError } = await admin.rpc("core_remove_catalog_product", {
      p_product_id: productId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_actor_role: role,
    });
    if (removeError) return json({ error: "Could not remove product" }, 500);
    if (!removed?.success) return json({ error: removed?.error || "Could not remove product" }, 409);
    return json(removed);
  }

  // ---------- Legacy actions (unchanged behavior) ----------
  if (action === "set_visibility") {
    const hidden = body.hidden === true;
    return await applyUpdate({ core_hidden: hidden }, hidden ? "catalog.tier_visibility.hide" : "catalog.tier_visibility.unhide");
  }

  if (action === "delete_product") {
    if (before.active === true || String(before.storefront_status || "").trim().toLowerCase() === "available") {
      return json({ error: "This product is still active on the vendor catalog. Hide it instead of deleting it." }, 409);
    }
    const { data: deleted, error: deleteError } = await admin.rpc("core_delete_catalog_product", {
      p_product_id: productId, p_actor_user_id: user.id, p_actor_email: user.email || null, p_actor_role: role,
    });
    if (deleteError) return json({ error: "Could not delete catalog product" }, 500);
    if (!deleted?.success) return json({ error: deleted?.error || "Could not delete catalog product" }, 409);
    return json(deleted);
  }

  if (action === "update_metadata") {
    let coaUrl: string | null;
    try { coaUrl = parseUrl(body.coaUrl, "COA URL"); } catch (e) { return json({ error: (e as Error).message }, 400); }
    return await applyUpdate({
      product_code: clean(body.productCode, 120),
      research_name: clean(body.researchName, 200),
      purity: clean(body.purity, 120),
      quantity: clean(body.quantity, 120),
      lot_number: clean(body.lotNumber, 120),
      coa_url: coaUrl,
    }, "catalog.metadata.update");
  }

  return json({ error: "Unsupported action" }, 400);
});
