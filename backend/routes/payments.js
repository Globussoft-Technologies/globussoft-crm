// ─────────────────────────────────────────────────────────────────
// Payments — Stripe + Razorpay multi-tenant gateway integration
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const prisma = require("../lib/prisma");

const router = express.Router();

// ── Lazy SDK loaders ─────────────────────────────────────────────
let stripeClient = null;
function getStripe() {
  if (!stripeClient && process.env.STRIPE_SECRET_KEY) {
    try {
      stripeClient = require("stripe")(process.env.STRIPE_SECRET_KEY);
    } catch (err) {
      console.error("[Payments] Failed to load Stripe SDK:", err.message);
    }
  }
  return stripeClient;
}

let razorpayClient = null;
function getRazorpay() {
  if (!razorpayClient && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    try {
      const Razorpay = require("razorpay");
      razorpayClient = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    } catch (err) {
      console.error("[Payments] Failed to load Razorpay SDK:", err.message);
    }
  }
  return razorpayClient;
}

// ── Helpers ──────────────────────────────────────────────────────
function tenantOf(req) {
  return (req.user && req.user.tenantId) || 1;
}

function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

function serialize(payment) {
  if (!payment) return payment;
  return { ...payment, metadata: safeJsonParse(payment.metadata, {}) };
}

async function markInvoicePaid(invoiceId, tenantId) {
  if (!invoiceId) return;
  try {
    const where = tenantId
      ? { id: parseInt(invoiceId), tenantId }
      : { id: parseInt(invoiceId) };
    const inv = await prisma.invoice.findFirst({ where });
    if (inv && inv.status !== "PAID") {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: "PAID" },
      });
    }
  } catch (err) {
    console.error("[Payments] markInvoicePaid error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC WEBHOOKS — must be declared BEFORE any auth-aware logic
// because /api/payments/webhook is in the openPaths allowlist.
// Note: Stripe needs raw body. We use express.raw() per-route.
// ─────────────────────────────────────────────────────────────────
router.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "Stripe webhook secret not configured" });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("[Payments] Stripe webhook signature failed:", err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    try {
      if (event.type === "payment_intent.succeeded") {
        const intent = event.data.object;
        const payment = await prisma.payment.findFirst({
          where: { gateway: "stripe", gatewayId: intent.id },
        });
        if (payment) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "SUCCESS", paidAt: new Date() },
          });
          await markInvoicePaid(payment.invoiceId, payment.tenantId);
        }
      } else if (event.type === "payment_intent.payment_failed") {
        const intent = event.data.object;
        const payment = await prisma.payment.findFirst({
          where: { gateway: "stripe", gatewayId: intent.id },
        });
        if (payment) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "FAILED" },
          });
        }
      }
      return res.json({ received: true });
    } catch (err) {
      console.error("[Payments] Stripe webhook handler error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post(
  "/webhook/razorpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    if (!secret) return res.status(503).json({ error: "Razorpay not configured" });

    const sig = req.headers["x-razorpay-signature"];
    const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");

    if (sig !== expected) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(bodyStr);
    } catch (err) {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    try {
      const eventName = event.event;
      const entity = event.payload && (event.payload.payment || event.payload.order);
      const ent = entity && entity.entity ? entity.entity : entity;

      if (eventName === "payment.captured" || eventName === "payment.authorized") {
        const orderId = ent && ent.order_id;
        const paymentId = ent && ent.id;
        if (orderId) {
          const payment = await prisma.payment.findFirst({
            where: { gateway: "razorpay", gatewayId: orderId },
          });
          if (payment) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: "SUCCESS",
                paidAt: new Date(),
                gatewayId: paymentId || orderId,
              },
            });
            await markInvoicePaid(payment.invoiceId, payment.tenantId);
          }
        }
      } else if (eventName === "payment.failed") {
        const orderId = ent && ent.order_id;
        if (orderId) {
          const payment = await prisma.payment.findFirst({
            where: { gateway: "razorpay", gatewayId: orderId },
          });
          if (payment) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: { status: "FAILED" },
            });
          }
        }
      }
      return res.json({ received: true });
    } catch (err) {
      console.error("[Payments] Razorpay webhook handler error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATED ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// GET / — list payments for tenant (filter status/gateway/invoiceId)
router.get("/", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { status, gateway, invoiceId } = req.query;

    const where = { tenantId };
    if (status) where.status = String(status).toUpperCase();
    if (gateway) where.gateway = String(gateway).toLowerCase();
    if (invoiceId) where.invoiceId = parseInt(invoiceId);

    const payments = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(payments.map(serialize));
  } catch (err) {
    console.error("[Payments] list error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /config — surface configuration status (used by Settings UI)
router.get("/config", async (req, res) => {
  res.json({
    stripe: {
      configured: !!process.env.STRIPE_SECRET_KEY,
      webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
    },
    razorpay: {
      configured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      keyId: process.env.RAZORPAY_KEY_ID ? `${process.env.RAZORPAY_KEY_ID.slice(0, 8)}...` : null,
    },
  });
});

// GET /:id — payment details
router.get("/:id", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = parseInt(req.params.id);
    const payment = await prisma.payment.findFirst({ where: { id, tenantId } });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    res.json(serialize(payment));
  } catch (err) {
    console.error("[Payments] get error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /create-stripe-intent
router.post("/create-stripe-intent", async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });

    const tenantId = tenantOf(req);
    const { invoiceId, amount, currency = "USD" } = req.body || {};

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    // Stripe expects integer in smallest currency unit (cents/paise)
    const amountInt = Math.round(Number(amount) * 100);

    const intent = await stripe.paymentIntents.create({
      amount: amountInt,
      currency: String(currency).toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: {
        tenantId: String(tenantId),
        invoiceId: invoiceId ? String(invoiceId) : "",
      },
    });

    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoiceId ? parseInt(invoiceId) : null,
        amount: Number(amount),
        currency: String(currency).toUpperCase(),
        gateway: "stripe",
        gatewayId: intent.id,
        status: "PENDING",
        tenantId,
        metadata: JSON.stringify({
          clientSecret: intent.client_secret,
          intentStatus: intent.status,
        }),
      },
    });

    res.json({
      clientSecret: intent.client_secret,
      paymentId: payment.id,
      intentId: intent.id,
    });
  } catch (err) {
    console.error("[Payments] create-stripe-intent error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /create-razorpay-order
router.post("/create-razorpay-order", async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json({ error: "Razorpay not configured" });

    const tenantId = tenantOf(req);
    const { invoiceId, amount, currency = "INR" } = req.body || {};

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    // Razorpay expects integer in paise
    const amountInt = Math.round(Number(amount) * 100);

    const order = await razorpay.orders.create({
      amount: amountInt,
      currency: String(currency).toUpperCase(),
      receipt: invoiceId ? `inv_${invoiceId}_${Date.now()}` : `pay_${Date.now()}`,
      notes: {
        tenantId: String(tenantId),
        invoiceId: invoiceId ? String(invoiceId) : "",
      },
    });

    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoiceId ? parseInt(invoiceId) : null,
        amount: Number(amount),
        currency: String(currency).toUpperCase(),
        gateway: "razorpay",
        gatewayId: order.id,
        status: "PENDING",
        tenantId,
        metadata: JSON.stringify({
          orderId: order.id,
          orderStatus: order.status,
        }),
      },
    });

    res.json({
      orderId: order.id,
      paymentId: payment.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: amountInt,
      currency: order.currency,
    });
  } catch (err) {
    console.error("[Payments] create-razorpay-order error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /confirm-razorpay
router.post("/confirm-razorpay", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { paymentId, razorpay_payment_id, razorpay_signature, razorpay_order_id } = req.body || {};

    if (!paymentId || !razorpay_payment_id || !razorpay_signature || !razorpay_order_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) return res.status(503).json({ error: "Razorpay not configured" });

    const payment = await prisma.payment.findFirst({
      where: { id: parseInt(paymentId), tenantId },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    // HMAC-SHA256 of `${order_id}|${payment_id}` using key secret
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(400).json({ error: "Signature verification failed" });
    }

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: new Date(),
        gatewayId: razorpay_payment_id,
        metadata: JSON.stringify({
          ...safeJsonParse(payment.metadata, {}),
          razorpay_order_id,
          razorpay_payment_id,
          verifiedAt: new Date().toISOString(),
        }),
      },
    });

    await markInvoicePaid(payment.invoiceId, tenantId);

    res.json({ success: true, payment: serialize(updated) });
  } catch (err) {
    console.error("[Payments] confirm-razorpay error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
