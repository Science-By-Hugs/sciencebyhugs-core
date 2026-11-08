import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Private Core-only membership plan administration. No public or customer API.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const publishable = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
    const secrets = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);
    if (!url || !publishable.default || !secrets.nexus_rotation_20261023) {
      return json({ error: "Membership service not configured" }, 503);
    }
    const client = createClient(url, publishable.default, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return json({ error: "Invalid session" }, 401);
    const role = String(user.app_metadata?.role || "").trim().toLowerCase();
    if (!["owner", "admin"].includes(role)) {
      return json({ error: "Core administrator access required" }, 403);
    }

    const admin = createClient(url, secrets.nexus_rotation_20261023, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }
    const action = String(body.action || "");

    if (action === "list") {
      const { data, error } = await admin.from("memberships")
        .select("id,name,slug,description,benefits,sort_order,active,created_at,updated_at")
        .order("sort_order", { ascending: true }).order("name").limit(101);
      if (error) return json({ error: "Could not load memberships" }, 503);
      if ((data || []).length > 100) return json({ error: "Membership pagination required" }, 503);
      // Aggregate counts without returning personal customer information.
      const counts = await Promise.all((data || []).map(plan =>
        admin.from("profiles").select("id", { count: "exact", head: true })
          .eq("membership_id", plan.id)
      ));
      if (counts.some(result => result.error)) return json({ error: "Could not load membership counts" }, 503);
      return json({ success: true, memberships: (data || []).map((plan, i) => ({
        ...plan, assigned_customers: counts[i].count ?? 0,
      })) });
    }

    if (action === "create" || action === "update") {
      const { data, error } = await admin.rpc("core_manage_membership", {
        p_action: action,
        p_id: action === "update" ? String(body.id || "") : null,
        p_name: String(body.name ?? ""),
        p_slug: String(body.slug ?? ""),
        p_description: String(body.description ?? ""),
        p_benefits: body.benefits,
        p_sort_order: body.sortOrder,
        p_active: body.active,
        p_expected_updated_at: action === "update" ? String(body.expectedUpdatedAt || "") : null,
        p_actor_id: user.id,
        p_actor_email: user.email || null,
        p_actor_role: role,
      });
      if (error) {
        const message = String(error.message || "");
        const conflict = /changed elsewhere|duplicate|already exists/i.test(message) || error.code === "23505";
        return json({ error: conflict ? "Membership changed or duplicates an existing plan; refresh and retry" : message || "Could not save membership" }, conflict ? 409 : 400);
      }
      return json({ success: true, membership: data });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("core_memberships_error", error instanceof Error ? error.message : "unknown");
    return json({ error: "Memberships temporarily unavailable" }, 503);
  }
});
