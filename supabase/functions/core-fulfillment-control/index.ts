import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const transitions: Record<string, string[]> = {
  // Submitted is payment-gated and cannot be advanced through fulfillment.
  submitted: [],
  checkout_pending: [], // Legacy checkout compatibility.
  processing: ["ordered", "on_hold", "delayed", "cancelled"],
  ordered: ["shipped", "on_hold", "delayed", "cancelled"],
  shipped: ["out_for_delivery", "on_hold", "delayed", "cancelled"],
  out_for_delivery: ["delivered", "on_hold", "delayed", "cancelled"],
  on_hold: ["processing", "ordered", "shipped", "out_for_delivery", "delayed", "cancelled"],
  delayed: ["processing", "ordered", "shipped", "out_for_delivery", "on_hold", "cancelled"],
  delivered: [],
  cancelled: [],
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authentication required" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);

  const userClient = createClient(
    supabaseUrl,
    publishableKeys.default,
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  const admin = createClient(
    supabaseUrl,
    secretKeys.nexus_rotation_20261023,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return json({ error: "Invalid session" }, 401);
  }

  const role = String(user.app_metadata?.role || "").trim().toLowerCase();
  if (!["owner", "admin"].includes(role)) {
    return json({ error: "Core administrator access required" }, 403);
  }

  let body: {
    orderId?: string;
    status?: string;
    note?: string;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const orderId = String(body.orderId || "").trim();
  const nextStatus = String(body.status || "").trim().toLowerCase();
  const note = String(body.note || "").trim();

  if (!orderId || !nextStatus) {
    return json({ error: "Order ID and status are required" }, 400);
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id,order_number,status,payment_status,paid_at,ordered_at,shipped_at,delivered_at,delayed_at,cancelled_at")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return json({ error: "Order not found" }, 404);
  }

  if (order.payment_status !== "paid") {
    return json({ error: "Order must be paid before fulfillment changes" }, 409);
  }

  const currentStatus = String(order.status || "").toLowerCase();
  const allowed = transitions[currentStatus] || [];

  if (!allowed.includes(nextStatus)) {
    return json({
      error: `Cannot move order from ${currentStatus || "unknown"} to ${nextStatus}`,
    }, 409);
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: nextStatus,
    fulfillment_note: note || null,
    updated_at: now,
  };

  if (nextStatus === "ordered") update.ordered_at = now;
  if (nextStatus === "shipped") update.shipped_at = now;
  if (nextStatus === "delivered") {
    update.delivered_at = now;
    update.completed_at = now;
  }
  if (nextStatus === "delayed") update.delayed_at = now;
  if (nextStatus === "cancelled") update.cancelled_at = now;

  const { data: updated, error: updateError } = await admin
    .from("orders")
    .update(update)
    .eq("id", order.id)
    .eq("status", currentStatus)
    .eq("payment_status", "paid")
    .select("id,order_number,status,payment_status,ordered_at,shipped_at,delivered_at,delayed_at,cancelled_at,completed_at,updated_at")
    .single();

  if (updateError || !updated) {
    return json({ error: "Could not update fulfillment status" }, 500);
  }

  const { data: invoice } = await admin
    .from("invoices")
    .select("id")
    .eq("order_id", order.id)
    .maybeSingle();

  if (invoice?.id) {
    await admin
      .from("invoice_events")
      .insert({
        invoice_id: invoice.id,
        event_type: `order_${nextStatus}`,
        description: `Order moved to ${nextStatus} in Science By HUGs Core.`,
        metadata: {
          source: "core",
          updatedBy: user.id,
          note: note || null,
        },
      });
  }

  return json({
    success: true,
    order: updated,
  });
});
