import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

// Google exit (2026-10-27): new checkout orders have no Google invoice row.
// Core can now record/verify payments for invoice-less orders; legacy invoice
// orders keep their original rules. Base: deployed version 14.

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


async function qualifyReferral(
  admin: ReturnType<typeof createClient>,
  customerId: string | null,
  orderNumber: string | null,
) {
  if (!customerId) return;

  const { data: referral } = await admin
    .from("referrals")
    .select("id,referrer_id,qualified_at")
    .eq("referred_customer_id", customerId)
    .maybeSingle();

  if (!referral || referral.qualified_at) return;

  const qualifiedAt = new Date().toISOString();

  const { error: qualifyError } = await admin
    .from("referrals")
    .update({
      status: "qualified",
      qualified_at: qualifiedAt,
      converted_at: qualifiedAt,
      qualifying_order_number: orderNumber || null,
      updated_at: qualifiedAt,
    })
    .eq("id", referral.id)
    .is("qualified_at", null);

  if (qualifyError) return;

  const { count } = await admin
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_id", referral.referrer_id)
    .not("qualified_at", "is", null);

  if ((count || 0) >= 20) {
    const { data: membership } = await admin
      .from("memberships")
      .select("id")
      .eq("name", "Principal Scientist")
      .maybeSingle();

    if (membership?.id) {
      await admin
        .from("profiles")
        .update({ membership_id: membership.id })
        .eq("id", referral.referrer_id);
    }
  }
}

const allowedProviders = new Set(["Zelle", "PayPal", "Venmo"]);

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
    action?: "record" | "verify";
    orderId?: string;
    provider?: string;
    paymentReference?: string;
    notes?: string;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const action = body.action;
  const orderId = String(body.orderId || "").trim();

  if (!orderId || !["record", "verify"].includes(String(action))) {
    return json({ error: "Valid action and order ID are required" }, 400);
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id,customer_id,order_number,total,status,payment_status")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return json({ error: "Order not found" }, 404);
  }

  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .select("id,invoice_number,send_status,status")
    .eq("order_id", order.id)
    .maybeSingle();

  if (invoiceError) {
    return json({ error: "Could not load order records" }, 500);
  }

  if (invoice) {
    // Legacy invoice-based orders: unchanged rule.
    const directCheckout = invoice.status === "direct_checkout";
    if (!directCheckout && invoice.send_status !== "sent") {
      return json({ error: "Invoice must be sent before payment can be recorded" }, 409);
    }
  }

  let orderNumber: string | null = order.order_number || null;
  if (!orderNumber) {
    const { data: assigned } = await admin.rpc("assign_order_number", { p_order_id: order.id });
    orderNumber = assigned ? String(assigned) : null;
  }

  const { data: existingPayment, error: existingError } = await admin
    .from("payments")
    .select("id,provider,payment_reference,amount,status,submitted_at,verified_at,paid_at")
    .eq("order_id", order.id)
    .maybeSingle();

  if (existingError) {
    return json({ error: "Could not load payment record" }, 500);
  }

  if (action === "record") {
    if (existingPayment?.status === "verified") {
      return json({ error: "Verified payments cannot be changed back to submitted" }, 409);
    }

    const provider = String(body.provider || "").trim();
    const paymentReference = String(body.paymentReference || "").trim();
    const notes = String(body.notes || "").trim();

    if (!allowedProviders.has(provider)) {
      return json({ error: "Choose Zelle, PayPal, or Venmo" }, 400);
    }

    const submittedAt = new Date().toISOString();

    const { data: payment, error: paymentError } = await admin
      .from("payments")
      .upsert(
        {
          order_id: order.id,
          customer_id: order.customer_id,
          provider,
          payment_reference: paymentReference || null,
          amount: order.total,
          status: "submitted",
          notes: notes || null,
          submitted_at: submittedAt,
          verified_at: null,
          verified_by: null,
          paid_at: null,
          updated_at: submittedAt,
        },
        { onConflict: "order_id" },
      )
      .select("id,order_id,provider,payment_reference,amount,status,notes,submitted_at,verified_at,paid_at")
      .single();

    if (paymentError || !payment) {
      return json({ error: "Could not record payment submission" }, 500);
    }

    await admin
      .from("orders")
      .update({
        payment_method: provider,
        payment_status: "submitted",
        updated_at: submittedAt,
      })
      .eq("id", order.id);

    if (invoice?.id) {
      await admin
        .from("invoices")
        .update({ payment_method: provider })
        .eq("id", invoice.id);

      await admin
        .from("invoice_events")
        .insert({
          invoice_id: invoice.id,
          event_type: "payment_submitted",
          description: "Payment submission recorded in Science By HUGs Core.",
          metadata: {
            source: "core",
            recordedBy: user.id,
            provider,
          },
        });
    }

    return json({
      success: true,
      action: "record",
      orderId: order.id,
      orderNumber,
      payment,
    });
  }

  if (!existingPayment) {
    return json({ error: "Record the payment before verifying it" }, 409);
  }

  if (existingPayment.status === "verified") {
    return json({
      success: true,
      action: "verify",
      orderId: order.id,
      orderNumber,
      alreadyVerified: true,
    });
  }

  if (existingPayment.status !== "submitted") {
    return json({ error: "Payment must be submitted before it can be verified" }, 409);
  }

  const verifiedAt = new Date().toISOString();

  const { data: payment, error: paymentError } = await admin
    .from("payments")
    .update({
      status: "verified",
      verified_at: verifiedAt,
      verified_by: user.id,
      paid_at: verifiedAt,
      updated_at: verifiedAt,
    })
    .eq("id", existingPayment.id)
    .select("id,order_id,provider,payment_reference,amount,status,notes,submitted_at,verified_at,paid_at")
    .single();

  if (paymentError || !payment) {
    return json({ error: "Could not verify payment" }, 500);
  }

  await admin
    .from("orders")
    .update({
      payment_status: "paid",
      paid_at: verifiedAt,
      status: "processing",
      updated_at: verifiedAt,
    })
    .eq("id", order.id);

  await qualifyReferral(admin, order.customer_id, orderNumber);

  if (invoice?.id) {
    await admin
      .from("invoices")
      .update({ paid_at: verifiedAt })
      .eq("id", invoice.id);

    await admin
      .from("invoice_events")
      .insert({
        invoice_id: invoice.id,
        event_type: "payment_verified",
        description: "Payment verified in Science By HUGs Core and order moved to processing.",
        metadata: {
          source: "core",
          verifiedBy: user.id,
          provider: existingPayment.provider,
        },
      });
  }

  return json({
    success: true,
    action: "verify",
    orderId: order.id,
    orderNumber,
    payment,
  });
});
