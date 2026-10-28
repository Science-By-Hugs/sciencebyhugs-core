import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Google exit (2026-10-27): new checkout orders have no invoice row. Besides paid
// orders (deployed v16 behavior), Core must also see invoice-less orders that are
// awaiting payment verification (submitted payments and Zelle checkouts) so staff
// can record/verify them. Base: deployed version 16.

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

  const { data: invoices, error: invoiceError } = await admin
    .from("invoices")
    .select("id,invoice_number,order_id,customer_id,status,subtotal,shipping_total,discount_total,tax_total,total,payment_method,google_sheet_name,google_sheet_url,pdf_status,pdf_url,pdf_created_at,created_at,contact_method,customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,send_status,sent_at,sent_to")
    .order("created_at", { ascending: false })
    .limit(100);

  if (invoiceError) {
    return json({ error: "Could not load invoices" }, 500);
  }

  const orderIds = [...new Set((invoices || []).map(i => i.order_id).filter(Boolean))];

  let items: Array<Record<string, unknown>> = [];
  let orders: Array<Record<string, unknown>> = [];
  let payments: Array<Record<string, unknown>> = [];

  if (orderIds.length) {
    const [itemsResult, ordersResult, paymentsResult] = await Promise.all([
      admin
        .from("order_items")
        .select("order_id,product_id,product_code,product_name,quantity,unit_price,line_total")
        .in("order_id", orderIds)
        .order("created_at", { ascending: true }),
      admin
        .from("orders")
        .select("id,order_number,status,payment_status,payment_method,paid_at,ordered_at,shipped_at,delivered_at,estimated_delivery_date,delayed_at,cancelled_at,completed_at,updated_at")
        .in("id", orderIds),
      admin
        .from("payments")
        .select("id,order_id,provider,payment_reference,amount,status,notes,submitted_at,verified_at,paid_at,created_at,updated_at")
        .in("order_id", orderIds),
    ]);

    if (itemsResult.error) return json({ error: "Could not load invoice items" }, 500);
    if (ordersResult.error) return json({ error: "Could not load orders" }, 500);
    if (paymentsResult.error) return json({ error: "Could not load payments" }, 500);

    items = itemsResult.data || [];
    orders = ordersResult.data || [];
    payments = paymentsResult.data || [];
  }

  const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items) {
    const orderId = String(item.order_id || "");
    const list = itemsByOrder.get(orderId) || [];
    list.push(item);
    itemsByOrder.set(orderId, list);
  }

  const orderById = new Map(orders.map(order => [String(order.id), order]));
  const paymentByOrder = new Map(payments.map(payment => [String(payment.order_id), payment]));

  // Invoice-less orders that Core must operate on:
  //  - paid orders (fulfillment)
  //  - submitted payments awaiting verification (any provider)
  //  - Zelle checkouts awaiting the customer's payment
  // These are read-only operational entries, NOT invoice records in the database.
  const { data: operationalOrders, error: operationalOrderError } = await admin
    .from("orders")
    .select("id,order_number,customer_id,status,payment_status,payment_method,paid_at,ordered_at,shipped_at,delivered_at,estimated_delivery_date,delayed_at,cancelled_at,completed_at,updated_at,created_at,subtotal,shipping_total,discount_total,tax_total,total,contact_method")
    .or("payment_status.eq.paid,payment_status.eq.submitted,and(payment_method.eq.Zelle,status.eq.checkout_pending)")
    .order("created_at", { ascending: false })
    .limit(150);

  if (operationalOrderError) return json({ error: "Could not load orders for operations" }, 500);

  const operationalOrderIds = (operationalOrders || []).map(order => order.id);
  let fulfillmentOnly: Array<Record<string, unknown>> = [];
  if (operationalOrderIds.length) {
    // Check all matching invoice rows, not just the 100 most recent invoices
    // fetched above, to prevent duplicate entries for older invoices.
    const { data: operationalInvoices, error: operationalInvoiceError } = await admin
      .from("invoices")
      .select("order_id")
      .in("order_id", operationalOrderIds);
    if (operationalInvoiceError) return json({ error: "Could not reconcile orders" }, 500);

    const invoiced = new Set((operationalInvoices || []).map(row => row.order_id).filter(Boolean));
    const missing = (operationalOrders || []).filter(order => !invoiced.has(order.id));

    if (missing.length) {
      const missingIds = missing.map(order => order.id);
      const customerIds = [...new Set(missing.map(order => order.customer_id).filter(Boolean))];
      const [missingItems, missingPayments, missingProfiles] = await Promise.all([
        admin.from("order_items")
          .select("order_id,product_id,product_code,product_name,quantity,unit_price,line_total")
          .in("order_id", missingIds).order("created_at", { ascending: true }),
        admin.from("payments")
          .select("id,order_id,provider,payment_reference,amount,status,notes,submitted_at,verified_at,paid_at,created_at,updated_at")
          .in("order_id", missingIds),
        customerIds.length
          ? admin.from("profiles").select("id,first_name,last_name,email,phone").in("id", customerIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (missingItems.error || missingPayments.error || missingProfiles.error) {
        return json({ error: "Could not load order details" }, 500);
      }

      const profilesById = new Map((missingProfiles.data || []).map(p => [String(p.id), p]));
      const missingPaymentsById = new Map((missingPayments.data || []).map(p => [String(p.order_id), p]));
      const missingItemsById = new Map<string, Array<Record<string, unknown>>>();
      for (const item of missingItems.data || []) {
        const id = String(item.order_id);
        const list = missingItemsById.get(id) || [];
        list.push(item);
        missingItemsById.set(id, list);
      }

      fulfillmentOnly = missing.map(order => {
        const profile = profilesById.get(String(order.customer_id)) || null;
        return {
          id: "fulfillment:" + order.id,
          invoice_number: order.order_number || "ORDER PENDING",
          order_id: order.id,
          customer_id: order.customer_id,
          status: "direct_checkout",
          subtotal: order.subtotal,
          shipping_total: order.shipping_total,
          discount_total: order.discount_total,
          tax_total: order.tax_total,
          total: order.total,
          payment_method: order.payment_method,
          google_sheet_name: null,
          google_sheet_url: null,
          pdf_status: "not_applicable",
          pdf_url: null,
          pdf_created_at: null,
          created_at: order.created_at,
          contact_method: order.contact_method,
          customer_name_snapshot: profile
            ? [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Customer"
            : "Customer",
          customer_email_snapshot: profile?.email || null,
          customer_phone_snapshot: profile?.phone || null,
          send_status: "not_sent",
          sent_at: null,
          sent_to: null,
          items: missingItemsById.get(String(order.id)) || [],
          order,
          payment: missingPaymentsById.get(String(order.id)) || null,
        };
      });
    }
  }

  return json({
    success: true,
    invoices: [...fulfillmentOnly, ...(invoices || []).map(invoice => ({
      ...invoice,
      items: invoice.order_id
        ? itemsByOrder.get(String(invoice.order_id)) || []
        : [],
      order: invoice.order_id
        ? orderById.get(String(invoice.order_id)) || null
        : null,
      payment: invoice.order_id
        ? paymentByOrder.get(String(invoice.order_id)) || null
        : null,
    }))],
  });
});
