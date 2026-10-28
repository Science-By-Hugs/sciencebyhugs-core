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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authentication required" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")!);
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!);

  const userClient = createClient(supabaseUrl, publishableKeys.default, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const admin = createClient(supabaseUrl, secretKeys.nexus_rotation_20261023, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid session" }, 401);

  const role = String(user.app_metadata?.role || "").trim().toLowerCase();
  if (!["owner", "admin"].includes(role)) {
    return json({ error: "Core administrator access required" }, 403);
  }


  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request" }, 400);
  if (body.action === "clear_checkout_pending") {
    const orderId = typeof body.orderId === "string" && body.orderId
      ? body.orderId
      : null;

    if (orderId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      return json({ error: "Choose a valid checkout order" }, 400);
    }

    const { data, error } = await admin.rpc("clear_checkout_pending_orders", {
      p_order_id: orderId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_actor_role: role,
    });

    if (error) return json({ error: "Could not clear checkout pending orders" }, 500);
    return json(data || { success: true, deleted: 0, orderIds: [] });
  }

  if (body.action === "set_delivery_estimate") {
    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    const date = body.estimatedDeliveryDate;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      return json({ error: "Choose a valid order" }, 400);
    }
    if (date !== null) {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) return json({ error: "Enter a valid calendar date" }, 400);
      const parsed = new Date(date + "T00:00:00Z");
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return json({ error: "Enter a valid calendar date" }, 400);
    }
    const { data: order, error } = await admin.from("orders")
      .update({ estimated_delivery_date: date }).eq("id", orderId)
      .select("id,estimated_delivery_date,updated_at").maybeSingle();
    if (error) return json({ error: "Could not save estimated delivery date" }, 500);
    if (!order) return json({ error: "Order not found" }, 404);
    return json({ success: true, order });
  }

  const { data: orders, error: orderError } = await admin
    .from("orders")
    .select("id,order_number,customer_id,deleted_customer,status,subtotal,discount_total,shipping_total,tax_total,total,payment_method,payment_status,customer_notes,admin_notes,contact_method,fulfillment_note,estimated_delivery_date,submitted_at,paid_at,ordered_at,shipped_at,delivered_at,delayed_at,cancelled_at,completed_at,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (orderError) return json({ error: "Could not load orders" }, 500);

  const orderIds = (orders || []).map(order => order.id);
  const customerIds = [...new Set((orders || []).map(order => order.customer_id).filter(Boolean))];

  const [itemsResult, paymentsResult, invoicesResult, profilesResult] = await Promise.all([
    orderIds.length
      ? admin.from("order_items")
          .select("id,order_id,product_id,product_code,product_name,quantity,unit_price,line_total,created_at")
          .in("order_id", orderIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? admin.from("payments")
          .select("id,order_id,provider,payment_reference,amount,status,notes,submitted_at,verified_at,paid_at,created_at,updated_at")
          .in("order_id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? admin.from("invoices")
          .select("id,invoice_number,order_id,status,pdf_status,pdf_url,send_status,sent_at,created_at")
          .in("order_id", orderIds)
      : Promise.resolve({ data: [], error: null }),
    customerIds.length
      ? admin.from("profiles")
          .select("id,customer_number,first_name,last_name,email,phone,account_status,preferred_contact_method")
          .in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (itemsResult.error) return json({ error: "Could not load order items" }, 500);
  if (paymentsResult.error) return json({ error: "Could not load payments" }, 500);
  if (invoicesResult.error) return json({ error: "Could not load invoices" }, 500);
  if (profilesResult.error) return json({ error: "Could not load customers" }, 500);

  const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();
  for (const item of itemsResult.data || []) {
    const key = String(item.order_id || "");
    const list = itemsByOrder.get(key) || [];
    list.push(item);
    itemsByOrder.set(key, list);
  }

  const paymentByOrder = new Map((paymentsResult.data || []).map(payment => [String(payment.order_id), payment]));
  const invoiceByOrder = new Map((invoicesResult.data || []).map(invoice => [String(invoice.order_id), invoice]));
  const profileById = new Map((profilesResult.data || []).map(profile => [String(profile.id), profile]));

  // 2026-10-28: orders of a deleted customer keep a snapshot of who they were.
  const customerFor = (order: Record<string, unknown>) => {
    if (order.customer_id) return profileById.get(String(order.customer_id)) || null;
    const snap = order.deleted_customer as Record<string, unknown> | null;
    if (!snap) return null;
    return {
      id: null,
      customer_number: snap.customer_number ?? null,
      first_name: snap.first_name ?? null,
      last_name: snap.last_name ?? null,
      email: snap.email ?? "",
      phone: snap.phone ?? null,
      account_status: "Deleted",
      preferred_contact_method: null,
      deleted: true,
      deleted_at: snap.deleted_at ?? null,
    };
  };

  return json({
    success: true,
    orders: (orders || []).map(({ deleted_customer, ...order }) => ({
      ...order,
      customer: customerFor({ ...order, deleted_customer }),
      items: itemsByOrder.get(String(order.id)) || [],
      payment: paymentByOrder.get(String(order.id)) || null,
      invoice: invoiceByOrder.get(String(order.id)) || null,
    })),
  });
});
