// ─────────────────────────────────────────────────────────────────
// Payments — Stripe + Razorpay multi-tenant gateway integration
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

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

// Strip anything that looks like a Stripe/Razorpay key out of a string. The
// SDK error message "Invalid API Key provided: sk_test_...qRsT" leaks key
// shape (prefix + last 4) to the browser, which a tenant user has no business
// seeing. Belt-and-braces — every code path that surfaces a gateway message
// also runs this.
function scrubKeys(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\b(sk|pk|rk|rzp)_(test|live)_[A-Za-z0-9_*]+/g, '[redacted]');
}

// Extract a clean, user-facing error from a gateway SDK throw. Razorpay's SDK
// throws `{ statusCode, error: { code, description, field, ... } }`; Stripe's
// SDK throws an Error with `.statusCode`, `.code`, `.type`, and `.raw.message`.
// Bubbling the raw `err.message` to the client surfaces JSON blobs, "Server
// error", or worse — the masked-but-still-leaky API key shape — so we map
// known error classes to user-facing copy before sending anything back.
function parseGatewayError(err, gateway) {
  if (!err) return { status: 500, message: 'Payment gateway error', code: null };
  const description =
    (err.error && err.error.description) ||
    (err.raw && err.raw.message) ||
    err.message ||
    'Payment gateway error';
  const gatewayCode = (err.error && err.error.code) || err.code || null;
  const gatewayStatus = err.statusCode || (err.raw && err.raw.statusCode) || 0;
  const errType = err.type || (err.raw && err.raw.type) || null;

  // Auth/config failures — Stripe 'StripeAuthenticationError', Razorpay 401,
  // or any "Invalid API Key" message. These are operator-side misconfigurations
  // that the user can't action; surface a friendly "contact support" copy and
  // never echo the key shape back to the browser.
  const looksLikeAuthIssue =
    errType === 'StripeAuthenticationError' ||
    gatewayStatus === 401 ||
    /invalid api key|authentication|unauthorized|key_invalid/i.test(description);

  if (looksLikeAuthIssue) {
    return {
      status: 503,
      message: `${gateway} isn't available right now. Please contact support — the payment gateway needs to be reconfigured.`,
      code: 'GATEWAY_NOT_CONFIGURED',
    };
  }

  const looksLikeAmountIssue =
    /amount|limit|exceeds|maximum|minimum|atleast/i.test(description) ||
    err.field === 'amount';

  if (looksLikeAmountIssue) {
    return {
      status: 400,
      message: `This payment can't be processed: ${scrubKeys(description)}. Please use a smaller amount or split the invoice.`,
      code: gatewayCode || 'AMOUNT_NOT_ALLOWED',
    };
  }

  if (gatewayStatus >= 400 && gatewayStatus < 500) {
    return { status: 400, message: scrubKeys(description), code: gatewayCode };
  }

  return {
    status: 502,
    message: `${gateway} is temporarily unavailable. Please try again in a moment.`,
    code: gatewayCode,
  };
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

// PRD Gap §13 wave-6a — emit payment.collected when a gateway success
// webhook (Stripe/Razorpay) lands. Wrapped in try/catch so workflow rule
// failures never break the webhook handler (which would cause the gateway
// to retry indefinitely). Event payload mirrors the billing.js version
// so workflow rule conditions can be authored once and match either path.
function emitPaymentCollected(payment) {
  try {
    require("../lib/eventBus").emitEvent(
      "payment.collected",
      {
        invoiceId: payment.invoiceId,
        paymentId: payment.id,
        amount: Number(payment.amount),
        method: payment.gateway,
        currency: payment.currency,
        paidAt: payment.paidAt,
      },
      payment.tenantId,
      null
    );
  } catch (_e) { /* best-effort */ }
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
          const updated = await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "SUCCESS", paidAt: new Date() },
          });
          await markInvoicePaid(payment.invoiceId, payment.tenantId);
          emitPaymentCollected(updated);
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
    } catch (_err) {
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
            const updated = await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: "SUCCESS",
                paidAt: new Date(),
                gatewayId: paymentId || orderId,
              },
            });
            await markInvoicePaid(payment.invoiceId, payment.tenantId);
            emitPaymentCollected(updated);
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
//
// #650 — Role-gated disclosure. Previously this returned the razorpay keyId
// prefix (`<8-char>...`) to every authenticated user, leaking credential shape
// to operator-non-staff. Now:
//   - Every authenticated caller sees `{stripe.configured, razorpay.configured}`
//     — enough for the UI to enable/disable payment-method buttons.
//   - ADMIN callers ALSO see `stripe.webhookConfigured` + `razorpay.keyId`
//     prefix for diagnostics.
// A PaymentConfig.READ audit row records the role + disclosure shape on every
// call so the disclosure surface is visible in the audit log.
router.get("/config", async (req, res) => {
  const isAdmin = req.user && req.user.role === "ADMIN";

  const body = {
    stripe: { configured: !!process.env.STRIPE_SECRET_KEY },
    razorpay: {
      configured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    },
  };

  if (isAdmin) {
    body.stripe.webhookConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
    body.razorpay.keyId = process.env.RAZORPAY_KEY_ID
      ? `${process.env.RAZORPAY_KEY_ID.slice(0, 8)}...`
      : null;
  }

  // Audit the disclosure surface (fire-and-forget; helper never throws).
  writeAudit(
    "PaymentConfig",
    "READ",
    null,
    req.user && req.user.userId,
    req.user && req.user.tenantId,
    { role: (req.user && req.user.role) || null, disclosed: isAdmin ? "full" : "masked" }
  );

  res.json(body);
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
    const { invoiceId, amount } = req.body || {};
    let { currency } = req.body || {};

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    // Default currency from tenant if not provided
    if (!currency) {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultCurrency: true } });
      currency = tenant?.defaultCurrency || "USD";
    }

    // Stripe expects integer in smallest currency unit (cents/paise)
    const amountInt = Math.round(Number(amount) * 100);

    let intent;
    try {
      intent = await stripe.paymentIntents.create({
        amount: amountInt,
        currency: String(currency).toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: {
          tenantId: String(tenantId),
          invoiceId: invoiceId ? String(invoiceId) : "",
        },
      });
    } catch (gatewayErr) {
      const parsed = parseGatewayError(gatewayErr, "Stripe");
      console.error("[Payments] Stripe order rejected:", parsed.code, parsed.message);
      return res.status(parsed.status).json({ error: parsed.message, code: parsed.code });
    }

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

    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountInt,
        currency: String(currency).toUpperCase(),
        receipt: invoiceId ? `inv_${invoiceId}_${Date.now()}` : `pay_${Date.now()}`,
        notes: {
          tenantId: String(tenantId),
          invoiceId: invoiceId ? String(invoiceId) : "",
        },
      });
    } catch (gatewayErr) {
      const parsed = parseGatewayError(gatewayErr, "Razorpay");
      console.error("[Payments] Razorpay order rejected:", parsed.code, parsed.message);
      return res.status(parsed.status).json({ error: parsed.message, code: parsed.code });
    }

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
    emitPaymentCollected(updated);

    res.json({ success: true, payment: serialize(updated) });
  } catch (err) {
    console.error("[Payments] confirm-razorpay error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
