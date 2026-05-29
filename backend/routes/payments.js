// ─────────────────────────────────────────────────────────────────
// Payments — Stripe + Razorpay multi-tenant gateway integration
// ─────────────────────────────────────────────────────────────────
const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
  override: true,
});

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
  if (
    !razorpayClient &&
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_SECRET
  ) {
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
  if (typeof s !== "string") return s;
  return s.replace(
    /\b(sk|pk|rk|rzp)_(test|live)_[A-Za-z0-9_*]+/g,
    "[redacted]",
  );
}

// Extract a clean, user-facing error from a gateway SDK throw. Razorpay's SDK
// throws `{ statusCode, error: { code, description, field, ... } }`; Stripe's
// SDK throws an Error with `.statusCode`, `.code`, `.type`, and `.raw.message`.
// Bubbling the raw `err.message` to the client surfaces JSON blobs, "Server
// error", or worse — the masked-but-still-leaky API key shape — so we map
// known error classes to user-facing copy before sending anything back.
function parseGatewayError(err, gateway) {
  if (!err)
    return { status: 500, message: "Payment gateway error", code: null };
  const description =
    (err.error && err.error.description) ||
    (err.raw && err.raw.message) ||
    err.message ||
    "Payment gateway error";
  const gatewayCode = (err.error && err.error.code) || err.code || null;
  const gatewayStatus = err.statusCode || (err.raw && err.raw.statusCode) || 0;
  const errType = err.type || (err.raw && err.raw.type) || null;

  // Auth/config failures — Stripe 'StripeAuthenticationError', Razorpay 401,
  // or any "Invalid API Key" message. These are operator-side misconfigurations
  // that the user can't action; surface a friendly "contact support" copy and
  // never echo the key shape back to the browser.
  const looksLikeAuthIssue =
    errType === "StripeAuthenticationError" ||
    gatewayStatus === 401 ||
    /invalid api key|authentication|unauthorized|key_invalid/i.test(
      description,
    );

  if (looksLikeAuthIssue) {
    return {
      status: 503,
      message: `${gateway} isn't available right now. Please contact support — the payment gateway needs to be reconfigured.`,
      code: "GATEWAY_NOT_CONFIGURED",
    };
  }

  const looksLikeAmountIssue =
    /amount|limit|exceeds|maximum|minimum|atleast/i.test(description) ||
    err.field === "amount";

  if (looksLikeAmountIssue) {
    return {
      status: 400,
      message: `This payment can't be processed: ${scrubKeys(description)}. Please use a smaller amount or split the invoice.`,
      code: gatewayCode || "AMOUNT_NOT_ALLOWED",
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
      null,
    );
  } catch (_e) {
    /* best-effort */
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
    if (!stripe)
      return res.status(503).json({ error: "Stripe not configured" });

    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret)
      return res
        .status(503)
        .json({ error: "Stripe webhook secret not configured" });

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
      } else if (event.type === "checkout.session.completed") {
        // Hosted Checkout Session paid out. We store session.id as gatewayId
        // when creating the session, so look up by that.
        const session = event.data.object;
        if (session.payment_status === "paid") {
          const payment = await prisma.payment.findFirst({
            where: { gateway: "stripe", gatewayId: session.id },
          });
          if (payment && payment.status !== "SUCCESS") {
            const updated = await prisma.payment.update({
              where: { id: payment.id },
              data: { status: "SUCCESS", paidAt: new Date() },
            });
            await markInvoicePaid(payment.invoiceId, payment.tenantId);
            emitPaymentCollected(updated);
          }
        }
      }
      return res.json({ received: true });
    } catch (err) {
      console.error("[Payments] Stripe webhook handler error:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/webhook/razorpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret =
      process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    if (!secret)
      return res.status(503).json({ error: "Razorpay not configured" });

    const sig = req.headers["x-razorpay-signature"];
    const bodyStr = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(bodyStr)
      .digest("hex");

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
      const entity =
        event.payload && (event.payload.payment || event.payload.order);
      const ent = entity && entity.entity ? entity.entity : entity;

      if (
        eventName === "payment.captured" ||
        eventName === "payment.authorized"
      ) {
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
  },
);

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATED ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// GET / — list payments for tenant (filter status/gateway/invoiceId/from/to)
//
// #846 — date-range filter. Accepts `from` and `to` as YYYY-MM-DD (or any
// Date-parseable string). Both are optional + independent (caller may pass
// either, neither, or both). Returns 400 with code INVALID_DATE_RANGE when
// either value is unparseable. Mirrors the canonical helper shape used by
// billing.js's accounting/GSTR exports so accountants reconciling across
// the two pages get the same semantics. When `to` is a date-only string
// (no time portion), it's pushed to end-of-day so the range is inclusive
// of that calendar date — matches user expectation for the UI date picker.
router.get("/", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { status, gateway, invoiceId, from, to } = req.query;

    const where = { tenantId };
    if (status) where.status = String(status).toUpperCase();
    if (gateway) where.gateway = String(gateway).toLowerCase();
    if (invoiceId) where.invoiceId = parseInt(invoiceId);

    if (from || to) {
      const createdAt = {};
      if (from) {
        const fromDate = new Date(String(from));
        if (!Number.isFinite(fromDate.getTime())) {
          return res.status(400).json({ error: "invalid from date", code: "INVALID_DATE_RANGE" });
        }
        createdAt.gte = fromDate;
      }
      if (to) {
        const toDate = new Date(String(to));
        if (!Number.isFinite(toDate.getTime())) {
          return res.status(400).json({ error: "invalid to date", code: "INVALID_DATE_RANGE" });
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
          toDate.setHours(23, 59, 59, 999);
        }
        createdAt.lte = toDate;
      }
      where.createdAt = createdAt;
    }

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
      configured: !!(
        process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
      ),
    },
  };

  if (isAdmin) {
    body.stripe.webhookConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
    body.razorpay.keyId = process.env.RAZORPAY_KEY_ID
      ? `${process.env.RAZORPAY_KEY_ID.slice(0, 8)}...`
      : null;
  }
  //
  // Audit the disclosure surface (fire-and-forget; helper never throws).
  writeAudit(
    "PaymentConfig",
    "READ",
    null,
    req.user && req.user.userId,
    req.user && req.user.tenantId,
    {
      role: (req.user && req.user.role) || null,
      disclosed: isAdmin ? "full" : "masked",
    },
  );

  res.json(body);
});

// ────────────────────────────────────────────────────────────────
// GET /api/payments/stats
//
// CRM polish — first /stats aggregate for the Payment CRUD route.
// Read-only tenant-wide KPI surface backing the finance dashboard's
// gateway-by-channel + collections tile. Mirrors billing/stats +
// travel-suppliers/stats posture — anodyne aggregate, NO audit row.
//
// Schema notes — actual Payment columns: amount (Float), status
// (default PENDING; live values PENDING/SUCCESS/FAILED/REFUNDED per
// schema.prisma:2426), gateway (stripe/razorpay/manual — populated
// from the gateway provider name; the schema does NOT have a separate
// `method` column, `gateway` IS the method axis), paidAt, createdAt.
// `successfulAmount` aggregates over status='SUCCESS' (the schema's
// success terminal; NOT 'COMPLETED' which is not a real Payment enum
// value here — that's an Invoice-side enum).
//
// Auth: explicit verifyToken on the new endpoint (existing payments.js
// handlers rely on the global server.js auth guard; new /stats follows
// the billing/stats + travel_suppliers/stats convention of attaching
// the middleware explicitly so the auth surface is grep-visible).
//
// Query params:
//   ?from / ?to — optional ISO date bounds on createdAt. Invalid → 400
//                 INVALID_DATE. Both optional and independent.
//
// Response envelope:
//   { total, byStatus, byMethod, totalAmount, successfulAmount,
//     lastPaymentAt }
// ────────────────────────────────────────────────────────────────
const { verifyToken } = require("../middleware/auth");
router.get("/stats", verifyToken, async (req, res) => {
  try {
    // Validate optional date bounds. Independent validation so a bad
    // ?from doesn't get masked by a missing ?to and vice-versa.
    const createdAtClause = {};
    if (req.query.from !== undefined) {
      const fromDate = new Date(req.query.from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ error: "invalid from date", code: "INVALID_DATE" });
      }
      createdAtClause.gte = fromDate;
    }
    if (req.query.to !== undefined) {
      const toDate = new Date(req.query.to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: "invalid to date", code: "INVALID_DATE" });
      }
      createdAtClause.lte = toDate;
    }

    const where = { tenantId: tenantOf(req) };
    if (Object.keys(createdAtClause).length > 0) {
      where.createdAt = createdAtClause;
    }

    // Pull just the columns we need to aggregate. Avoids dragging the
    // full row (metadata blob in particular) into memory just to sum.
    const rows = await prisma.payment.findMany({
      where,
      select: { status: true, gateway: true, amount: true, createdAt: true },
    });

    const total = rows.length;
    const byStatus = {};
    const byMethod = {};
    let totalSum = 0;
    let successSum = 0;
    let lastCreatedAt = null;

    for (const r of rows) {
      const status = r.status || "PENDING";
      byStatus[status] = (byStatus[status] || 0) + 1;
      const method = r.gateway || "unknown";
      byMethod[method] = (byMethod[method] || 0) + 1;
      // Defensive: null/undefined amount counts as 0 so a partially-
      // populated row (e.g. a webhook race that wrote status but not yet
      // amount) doesn't NaN the whole aggregate.
      const amt = Number(r.amount) || 0;
      totalSum += amt;
      if (status === "SUCCESS") {
        successSum += amt;
      }
      if (r.createdAt && (lastCreatedAt === null || new Date(r.createdAt) > lastCreatedAt)) {
        lastCreatedAt = new Date(r.createdAt);
      }
    }

    // Half-up 2dp rounding helper. EPSILON tweak collapses JS float noise
    // (0.1+0.2 type artefacts) so 100.555 rounds to 100.56 not 100.55.
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

    res.json({
      total,
      byStatus,
      byMethod,
      totalAmount: round2(totalSum),
      successfulAmount: round2(successSum),
      lastPaymentAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[payments/stats]", err);
    res.status(500).json({ error: "Failed to compute payment stats" });
  }
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
    if (!stripe)
      return res.status(503).json({ error: "Stripe not configured" });

    const tenantId = tenantOf(req);
    const { invoiceId, amount } = req.body || {};
    let { currency } = req.body || {};

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    // Default currency from tenant if not provided
    if (!currency) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { defaultCurrency: true },
      });
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
      console.error(
        "[Payments] Stripe order rejected:",
        parsed.code,
        parsed.message,
      );
      return res
        .status(parsed.status)
        .json({ error: parsed.message, code: parsed.code });
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

// POST /create-stripe-checkout-session — hosted Stripe Checkout (redirect)
// flow. Mirrors /create-stripe-intent's tenant/currency defaulting and
// PENDING-row insertion, but instead of returning a clientSecret for
// frontend Elements, returns a Stripe-hosted Checkout URL. The frontend
// does `window.location.href = url`, Stripe handles the card form, then
// redirects back to FRONTEND_URL/invoices with ?stripe=success&session_id=…
// which the page detects on mount and POSTs to /confirm-stripe-session.
router.post("/create-stripe-checkout-session", async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe)
      return res.status(503).json({ error: "Stripe not configured" });

    const tenantId = tenantOf(req);
    const { invoiceId, amount } = req.body || {};
    let { currency } = req.body || {};

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    if (!currency) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { defaultCurrency: true },
      });
      currency = tenant?.defaultCurrency || "USD";
    }

    const amountInt = Math.round(Number(amount) * 100);
    const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173";

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: String(currency).toLowerCase(),
              product_data: {
                name: invoiceId ? `Invoice #${invoiceId}` : "Payment",
              },
              unit_amount: amountInt,
            },
            quantity: 1,
          },
        ],
        success_url: `${frontendBase}/invoices?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendBase}/invoices?stripe=cancel`,
        metadata: {
          tenantId: String(tenantId),
          invoiceId: invoiceId ? String(invoiceId) : "",
        },
      });
    } catch (gatewayErr) {
      const parsed = parseGatewayError(gatewayErr, "Stripe");
      console.error(
        "[Payments] Stripe checkout session rejected:",
        parsed.code,
        parsed.message,
      );
      return res
        .status(parsed.status)
        .json({ error: parsed.message, code: parsed.code });
    }

    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoiceId ? parseInt(invoiceId) : null,
        amount: Number(amount),
        currency: String(currency).toUpperCase(),
        gateway: "stripe",
        gatewayId: session.id,
        status: "PENDING",
        tenantId,
        metadata: JSON.stringify({
          mode: "checkout",
          sessionUrl: session.url,
        }),
      },
    });

    res.json({
      url: session.url,
      sessionId: session.id,
      paymentId: payment.id,
    });
  } catch (err) {
    console.error("[Payments] create-stripe-checkout-session error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /create-razorpay-order
router.post("/create-razorpay-order", async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay)
      return res.status(503).json({ error: "Razorpay not configured" });

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
        receipt: invoiceId
          ? `inv_${invoiceId}_${Date.now()}`
          : `pay_${Date.now()}`,
        notes: {
          tenantId: String(tenantId),
          invoiceId: invoiceId ? String(invoiceId) : "",
        },
      });
    } catch (gatewayErr) {
      const parsed = parseGatewayError(gatewayErr, "Razorpay");
      console.error(
        "[Payments] Razorpay order rejected:",
        parsed.code,
        parsed.message,
      );
      return res
        .status(parsed.status)
        .json({ error: parsed.message, code: parsed.code });
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
    const {
      paymentId,
      razorpay_payment_id,
      razorpay_signature,
      razorpay_order_id,
    } = req.body || {};

    if (
      !paymentId ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !razorpay_order_id
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret)
      return res.status(503).json({ error: "Razorpay not configured" });

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

// POST /confirm-stripe-session — finalize a Checkout Session after the user
// redirects back from Stripe's hosted page. Idempotent: if the webhook has
// already marked the Payment SUCCESS, returns the existing row. If it hasn't,
// retrieves the session from Stripe and marks SUCCESS when payment_status=paid.
// This means the flow works even when no webhook listener is running locally.
router.post("/confirm-stripe-session", async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe)
      return res.status(503).json({ error: "Stripe not configured" });

    const tenantId = tenantOf(req);
    const { sessionId } = req.body || {};
    if (!sessionId)
      return res.status(400).json({ error: "sessionId is required" });

    const payment = await prisma.payment.findFirst({
      where: { gateway: "stripe", gatewayId: String(sessionId), tenantId },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    if (payment.status === "SUCCESS") {
      return res.json({ success: true, paid: true, payment: serialize(payment) });
    }

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(String(sessionId));
    } catch (gatewayErr) {
      const parsed = parseGatewayError(gatewayErr, "Stripe");
      return res
        .status(parsed.status)
        .json({ error: parsed.message, code: parsed.code });
    }

    if (session.payment_status !== "paid") {
      return res.json({
        success: false,
        paid: false,
        status: session.payment_status,
      });
    }

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: new Date(),
        metadata: JSON.stringify({
          ...safeJsonParse(payment.metadata, {}),
          paymentIntentId: session.payment_intent || null,
          confirmedAt: new Date().toISOString(),
        }),
      },
    });

    await markInvoicePaid(payment.invoiceId, tenantId);
    emitPaymentCollected(updated);

    res.json({ success: true, paid: true, payment: serialize(updated) });
  } catch (err) {
    console.error("[Payments] confirm-stripe-session error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
