import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Core discount codes (owner/admin only).
// v3 (deployed): list, generate (SBH### one-time Free Shipping / Referral Bonus).
// v4 (2026-10-30): + create (custom code, % off or $ off shipping, optional expiry,
//                    optional assignment to one customer), set_active, customers (search).
// Every write records a core_audit_events row.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const lower = (v: unknown) => String(v || "").trim().toLowerCase();

const CODE_COLUMNS =
  "id,code,kind,label,discount_percent,shipping_discount,one_time,permanent,active,created_at,used_at," +
  "used_by_profile_id,used_order_id,expires_at,assigned_profile_id," +
  "assigned:profiles!discount_codes_assigned_profile_id_fkey(id,first_name,last_name,customer_number,email)";

class InputError extends Error {}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const pub = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
  const sec = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
  const userClient = createClient(url, pub.default, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(url, sec.nexus_rotation_20261023, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid session" }, 401);
  const role = lower(user.app_metadata?.role);
  if (!["owner", "admin"].includes(role)) return json({ error: "Core administrator access required" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body = list */ }
  const action = String(body.action || "list");

  const audit = (auditAction: string, entityId: string, before: unknown, after: unknown) =>
    admin.from("core_audit_events").insert({
      actor_user_id: user.id,
      actor_email: user.email || null,
      actor_role: role,
      action: auditAction,
      entity_type: "discount_code",
      entity_id: entityId,
      before_data: before,
      after_data: after,
      metadata: { source: "core" },
    });

  const listCodes = async () => {
    const { data, error } = await admin.from("discount_codes")
      .select(CODE_COLUMNS)
      .order("permanent", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return data || [];
  };

  if (action === "list") {
    try { return json({ success: true, codes: await listCodes() }); }
    catch { return json({ error: "Could not load discount codes" }, 500); }
  }

  if (action === "customers") {
    const q = String(body.query || "").trim().replace(/[,%()]/g, " ").slice(0, 60);
    let query = admin.from("profiles")
      .select("id,first_name,last_name,customer_number,email,account_status")
      .order("customer_number", { ascending: true, nullsFirst: false })
      .limit(25);
    if (q) {
      const like = `%${q}%`;
      query = query.or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},customer_number.ilike.${like}`);
    }
    const { data, error } = await query;
    if (error) return json({ error: "Could not search customers" }, 500);
    return json({ success: true, customers: data || [] });
  }

  if (action === "generate") {
    const kind = lower(body.kind);
    if (!["free_shipping", "referral_bonus"].includes(kind)) return json({ error: "Choose Free Shipping or Referral Bonus" }, 400);
    for (let attempt = 0; attempt < 30; attempt++) {
      const number = crypto.getRandomValues(new Uint16Array(1))[0] % 1000;
      const code = "SBH" + String(number).padStart(3, "0");
      const payload = kind === "free_shipping"
        ? { code, kind, discount_percent: null, shipping_discount: 20, one_time: true, permanent: false, active: true, created_by: user.id }
        : { code, kind, discount_percent: 10, shipping_discount: null, one_time: true, permanent: false, active: true, created_by: user.id };
      const { data: created, error } = await admin.from("discount_codes").insert(payload).select("id,code,kind").single();
      if (!error && created) {
        await audit("admin.discount_code.create", created.id, null, { code: created.code, kind: created.kind, one_time: true });
        return json({ success: true, code: created, codes: await listCodes() });
      }
      if (error?.code !== "23505") return json({ error: "Could not generate discount code" }, 500);
    }
    return json({ error: "Could not find an unused SBH code. Try again." }, 409);
  }

  if (action === "create") {
    let payload: Record<string, unknown>;
    try {
      const rawCode = String(body.code || "").trim().toUpperCase();
      if (rawCode && !/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(rawCode)) {
        throw new InputError("Codes are 3–32 letters, numbers, - or _.");
      }
      const type = lower(body.type);
      const amount = Number(String(body.amount ?? "").replace(/[$%\s]/g, ""));
      if (type !== "percent" && type !== "shipping") throw new InputError("Choose percent off or $ off shipping.");
      if (!Number.isFinite(amount) || amount <= 0) throw new InputError("Enter an amount greater than 0.");
      if (type === "percent" && amount > 100) throw new InputError("Percent off can be at most 100.");
      if (type === "shipping" && amount > 1000) throw new InputError("Shipping discount can be at most $1000.");
      const label = String(body.label || "").trim().slice(0, 80) || null;

      let expiresAt: string | null = null;
      if (body.expiresAt) {
        const when = new Date(String(body.expiresAt));
        if (Number.isNaN(when.getTime())) throw new InputError("Expiry date is not valid.");
        if (when.getTime() <= Date.now()) throw new InputError("Expiry date must be in the future.");
        expiresAt = when.toISOString();
      }

      let assignedProfileId: string | null = null;
      if (body.assignedProfileId) {
        const id = String(body.assignedProfileId);
        const { data: profile } = await admin.from("profiles").select("id").eq("id", id).maybeSingle();
        if (!profile) throw new InputError("That customer could not be found.");
        assignedProfileId = profile.id;
      }

      payload = {
        code: rawCode,
        kind: "custom",
        label,
        discount_percent: type === "percent" ? Math.round(amount * 100) / 100 : null,
        shipping_discount: type === "shipping" ? Math.round(amount * 100) / 100 : null,
        one_time: body.oneTime === true,
        permanent: false,
        active: true,
        expires_at: expiresAt,
        assigned_profile_id: assignedProfileId,
        created_by: user.id,
      };
    } catch (e) {
      return json({ error: e instanceof InputError ? e.message : "Could not read the discount" }, 400);
    }

    const autoCode = !payload.code;
    for (let attempt = 0; attempt < (autoCode ? 30 : 1); attempt++) {
      if (autoCode) payload.code = "SBH" + String(crypto.getRandomValues(new Uint16Array(1))[0] % 1000).padStart(3, "0");
      const { data: created, error } = await admin.from("discount_codes").insert(payload).select("id,code").single();
      if (!error && created) {
        const { error: auditError } = await audit("admin.discount_code.create", created.id, null, {
          code: created.code, kind: "custom", label: payload.label,
          discount_percent: payload.discount_percent, shipping_discount: payload.shipping_discount,
          one_time: payload.one_time, expires_at: payload.expires_at, assigned_profile_id: payload.assigned_profile_id,
        });
        if (auditError) {
          await admin.from("discount_codes").delete().eq("id", created.id);
          return json({ error: "Code was not saved because the audit event could not be recorded" }, 500);
        }
        return json({ success: true, code: created, codes: await listCodes() });
      }
      if (error?.code !== "23505") return json({ error: "Could not create discount code" }, 500);
      if (!autoCode) return json({ error: `The code ${payload.code} already exists. Pick another.` }, 409);
    }
    return json({ error: "Could not find an unused SBH code. Try again." }, 409);
  }

  if (action === "set_active") {
    const id = String(body.id || "");
    const active = body.active === true;
    const { data: before } = await admin.from("discount_codes").select("id,code,active").eq("id", id).maybeSingle();
    if (!before) return json({ error: "Discount code not found" }, 404);
    if (before.active === active) return json({ success: true, codes: await listCodes() });
    const { error } = await admin.from("discount_codes").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return json({ error: "Could not update discount code" }, 500);
    const { error: auditError } = await audit(
      active ? "admin.discount_code.activate" : "admin.discount_code.deactivate",
      id, { active: before.active }, { active },
    );
    if (auditError) {
      await admin.from("discount_codes").update({ active: before.active }).eq("id", id);
      return json({ error: "Change was rolled back because the audit event could not be recorded" }, 500);
    }
    return json({ success: true, codes: await listCodes() });
  }

  return json({ error: "Unsupported action" }, 400);
});
