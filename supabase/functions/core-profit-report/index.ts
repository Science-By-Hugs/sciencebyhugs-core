import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Vendor pricing & profit (2026-10-27): Core Finance profit report.
// Owner/admin only. Reads the locked cost tables through public.core_profit_report().
// Body: { from?: ISO date, to?: ISO date }  (to is exclusive; both optional = all time)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const parseDate = (value: unknown): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("bad date");
  return date.toISOString();
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

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body = all time */ }

  let from: string | null;
  let to: string | null;
  try { from = parseDate(body.from); to = parseDate(body.to); }
  catch { return json({ error: "Dates must be valid, e.g. 2026-10-01" }, 400); }

  const { data, error } = await admin.rpc("core_profit_report", { p_from: from, p_to: to });
  if (error || !data) return json({ error: "Could not build the profit report" }, 500);
  return json({ success: true, ...data });
});
