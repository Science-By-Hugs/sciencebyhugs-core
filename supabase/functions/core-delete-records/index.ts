import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Core: delete orders and customers (2026-10-28). Owner/admin only.
// delete_order    { orderId, confirm: order number }  -> public.core_delete_order (audited copy, then delete)
// delete_customer { customerId, confirm: email }      -> public.core_delete_customer (orders kept), then removes the login
// Owner/admin logins and your own login can never be deleted here.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rpcFailure = (error: { code?: string; message?: string }, fallback: string) => {
  if (error.code === "P0002") return json({ error: error.message || "Not found" }, 404);
  if (error.code === "22023") return json({ error: error.message || "Confirmation did not match" }, 400);
  return json({ error: fallback }, 500);
};

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
  const action = String(body.action || "");
  const confirm = String(body.confirm ?? "").trim();
  const actor = { p_actor_user_id: user.id, p_actor_email: user.email || null, p_actor_role: role };

  if (action === "delete_order") {
    const orderId = String(body.orderId || "");
    if (!UUID.test(orderId)) return json({ error: "Choose a valid order" }, 400);
    if (!confirm) return json({ error: "Type the order number to confirm" }, 400);
    const { data, error } = await admin.rpc("core_delete_order", { p_order_id: orderId, p_confirm: confirm, ...actor });
    if (error) return rpcFailure(error, "Could not delete the order");
    return json(data);
  }

  if (action === "delete_customer") {
    const customerId = String(body.customerId || "");
    if (!UUID.test(customerId)) return json({ error: "Choose a valid customer" }, 400);
    if (!confirm) return json({ error: "Type the customer's email to confirm" }, 400);

    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("id,auth_user_id,email,customer_number").eq("id", customerId).maybeSingle();
    if (profileError) return json({ error: "Could not load customer" }, 500);
    if (!profile) return json({ error: "Customer not found" }, 404);

    if (profile.auth_user_id) {
      if (profile.auth_user_id === user.id) return json({ error: "You can't delete your own login" }, 409);
      const { data: authUser, error: authLookupError } = await admin.auth.admin.getUserById(profile.auth_user_id);
      if (authLookupError && !/not found/i.test(authLookupError.message || "")) {
        return json({ error: "Could not check this customer's login" }, 500);
      }
      const loginRole = String(authUser?.user?.app_metadata?.role || "").trim().toLowerCase();
      if (["owner", "admin"].includes(loginRole)) {
        return json({ error: "This customer's login is a Core " + loginRole + " account and can't be deleted here" }, 409);
      }
    }

    const { data, error } = await admin.rpc("core_delete_customer", { p_customer_id: customerId, p_confirm: confirm, ...actor });
    if (error) return rpcFailure(error, "Could not delete the customer");

    let loginRemoved = false;
    let warning: string | null = null;
    if (data?.authUserId) {
      const { error: deleteAuthError } = await admin.auth.admin.deleteUser(String(data.authUserId));
      if (deleteAuthError && !/not found/i.test(deleteAuthError.message || "")) {
        warning = "The customer record was deleted, but their login could not be removed (" + deleteAuthError.message + ").";
        await admin.from("core_audit_events").insert({
          actor_user_id: user.id, actor_email: user.email || null, actor_role: role,
          action: "customer.login_delete_failed", entity_type: "auth_user", entity_id: String(data.authUserId),
          before_data: null, after_data: null,
          metadata: { customer_number: data.customerNumber, error: deleteAuthError.message },
        });
      } else {
        loginRemoved = true;
      }
    }
    return json({ ...data, loginRemoved, warning });
  }

  return json({ error: "Unsupported action" }, 400);
});
