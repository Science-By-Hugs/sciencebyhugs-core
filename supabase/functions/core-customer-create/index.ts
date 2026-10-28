import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Core "New customer" (2026-10-27). Owner/admin only.
// Creates a customer profile without a login. The database assigns the next
// SBH-#### customer number (trigger profiles_assign_customer_number). The customer
// gets a login later by accepting a Core invite or by signing up on Nexus with the
// same email and claiming the profile (claim-existing-profile).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});
const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max) || null;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (m) => "\\" + m);

const SELECT = "id,customer_number,first_name,last_name,email,phone,address_line_1,address_line_2,city,state,postal_code,preferred_contact_method,notes,membership_id,account_status,auth_user_id,created_at,updated_at";

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

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "Enter a valid email address" }, 400);
  }
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  if (!firstName && !lastName) return json({ error: "Enter a first or last name" }, 400);

  const contactRaw = String(body.preferredContactMethod ?? "").trim().toLowerCase();
  if (contactRaw && !["email", "phone", "text"].includes(contactRaw)) {
    return json({ error: "Unsupported contact preference" }, 400);
  }
  const notes = String(body.notes ?? "").trim();
  if (notes.length > 2000) return json({ error: "Notes cannot exceed 2000 characters" }, 400);

  // Duplicate email (case-insensitive exact match).
  // (PostgREST also treats * as a wildcard, so such addresses use an exact match.)
  const dupQuery = admin.from("profiles").select("id,customer_number");
  const { data: duplicate, error: duplicateError } = await (email.includes("*")
    ? dupQuery.eq("email", email)
    : dupQuery.ilike("email", escapeLike(email))).limit(1);
  if (duplicateError) return json({ error: "Could not check for an existing customer" }, 500);
  if ((duplicate || []).length) {
    return json({ error: "A customer with that email already exists (" + (duplicate![0].customer_number || "no number") + ")" }, 409);
  }

  // Membership: chosen one, or the standard New Researcher.
  const membershipId = String(body.membershipId || "").trim();
  const membershipQuery = admin.from("memberships").select("id,name,slug").eq("active", true);
  const { data: membership, error: membershipError } = membershipId
    ? await membershipQuery.eq("id", membershipId).maybeSingle()
    : await membershipQuery.eq("slug", "new-researcher").maybeSingle();
  if (membershipError) return json({ error: "Could not validate membership" }, 500);
  if (!membership) return json({ error: "Membership not found" }, 404);

  const { data: created, error: createError } = await admin.from("profiles").insert({
    email,
    first_name: firstName,
    last_name: lastName,
    phone: clean(body.phone, 40),
    address_line_1: clean(body.addressLine1, 160),
    address_line_2: clean(body.addressLine2, 160),
    city: clean(body.city, 100),
    state: clean(body.state, 80),
    postal_code: clean(body.postalCode, 30),
    preferred_contact_method: contactRaw || null,
    notes: notes || null,
    membership_id: membership.id,
    account_status: "Active",
  }).select(SELECT).single();
  if (createError || !created) {
    if (createError?.code === "23505") return json({ error: "A customer with that email or number already exists" }, 409);
    return json({ error: "Could not create customer" }, 500);
  }

  const { error: auditError } = await admin.from("core_audit_events").insert({
    actor_user_id: user.id, actor_email: user.email || null, actor_role: role,
    action: "customer.create", entity_type: "profile", entity_id: created.id,
    before_data: null,
    after_data: {
      customer_number: created.customer_number, email: created.email,
      first_name: created.first_name, last_name: created.last_name,
      membership_name: membership.name,
    },
    metadata: { customer_number: created.customer_number, source: "core" },
  });
  if (auditError) {
    await admin.from("profiles").delete().eq("id", created.id);
    return json({ error: "Customer was not created because the audit event could not be recorded" }, 500);
  }

  return json({ success: true, customer: created, membership });
});
