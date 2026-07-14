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
const { paymentLimiter } = require("../middleware/apiRateLimiters");
const {
  getTenantRazorpayClient,
  getTenantRazorpayCreds,
  NOT_CONFIGURED_MESSAGE,
} = require("../lib/tenantPaymentGateway");

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

// Razorpay clients are now built per-tenant from DB-stored keys via
// lib/tenantPaymentGateway.js (customer → tenant payments). The platform's
// own env keys are reserved for subscription billing in routes/subscriptions.js.

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

async function recomputeTravelInvoiceStatus(prisma, tenantId, invoiceId) {
  if (!Number.isFinite(invoiceId)) return;
  const paidAgg = await prisma.payment.aggregate({
    where: {
      tenantId,
      status: "SUCCESS",
      OR: [
        { invoiceId },
        { metadata: { contains: `"travelInvoiceId":${invoiceId}` } },
      ],
    },
    _sum: { amount: true },
  });
  const inv = await prisma.travelInvoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: { totalAmount: true },
  });
  if (!inv) return;
  const paid = Number(paidAgg._sum.amount || 0);
  const total = Number(inv.totalAmount || 0);
  const newStatus = total > 0 && paid >= total ? "Paid" : paid > 0 ? "Partial" : "Issued";
  const updateData = { status: newStatus };
  if (newStatus === "Paid") updateData.paidAt = new Date();
  await prisma.travelInvoice.update({ where: { id: invoiceId }, data: updateData });
}

// Resolve which Razorpay secret verifies an incoming webhook. Customer
// payments (customer → tenant) are signed with the TENANT's own webhook
// secret; we find the Payment row the event references and load that tenant's
// secret. Platform / subscription payments (no per-tenant config) fall back to
// the env secret. Read-only — no mutation happens here.
async function resolveRazorpayWebhookSecret(event) {
  const envSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || null;
  try {
    const payload = (event && event.payload) || {};
    const paymentEnt =
      payload.payment && (payload.payment.entity || payload.payment);
    const orderEnt = payload.order && (payload.order.entity || payload.order);
    const plinkEnt =
      payload.payment_link &&
      (payload.payment_link.entity || payload.payment_link);
    // Candidate gatewayIds the order was stored under at creation time.
    const candidates = [
      paymentEnt && paymentEnt.order_id,
      orderEnt && orderEnt.id,
      paymentEnt && paymentEnt.id,
      plinkEnt && plinkEnt.id,
    ].filter(Boolean);
    if (candidates.length) {
      const payment = await prisma.payment.findFirst({
        where: { gateway: "razorpay", gatewayId: { in: candidates } },
        select: { tenantId: true },
      });
      if (payment) {
        // No separate webhook secret is collected — verify with the tenant's
        // Key Secret (mirrors the platform's
        // `RAZORPAY_WEBHOOK_SECRET || RAZORPAY_KEY_SECRET` fallback).
        const creds = await getTenantRazorpayCreds(payment.tenantId);
        if (creds && creds.keySecret) return creds.keySecret;
      }
    }

    // Fallback: resolve the tenant from `notes.tenantId` stamped on the entity
    // at creation time. Payment-LINK flows (travel quote advance / milestone /
    // invoice) create NO Payment row upfront, so the candidates lookup above
    // finds nothing — without this, those events fall back to the PLATFORM
    // secret and fail HMAC verification (the link was signed with the tenant's
    // own BYOK keys), silently dropping the customer's payment instead of
    // recording the revenue. The link-create call stamps notes.tenantId for
    // exactly this reconciliation.
    const notes =
      (plinkEnt && plinkEnt.notes) ||
      (paymentEnt && paymentEnt.notes) ||
      (orderEnt && orderEnt.notes) ||
      null;
    const notesTenantId = notes && Number(notes.tenantId);
    if (Number.isFinite(notesTenantId) && notesTenantId > 0) {
      const creds = await getTenantRazorpayCreds(notesTenantId);
      if (creds && creds.keySecret) return creds.keySecret;
    }
  } catch (err) {
    console.error(
      "[Payments] webhook tenant-secret resolution failed, falling back to env:",
      err.message,
    );
  }
  return envSecret;
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

// Reconcile a TRAVEL milestone payment-link back to its TravelPaymentSchedule
// + parent TravelInvoice (the travel-vertical equivalent of markInvoicePaid).
// Driven by the link's notes.kind='travel-milestone' tag. Marks the milestone
// paid (idempotent on retries), then recomputes the invoice: all siblings
// paid/waived → "Paid", otherwise "Partial". Best-effort — never throws.
async function reconcileTravelMilestone(notes, paymentEnt) {
  const scheduleId = Number(notes && notes.scheduleId);
  if (!Number.isFinite(scheduleId)) return;
  const paidPaise = paymentEnt && paymentEnt.amount;
  const paidMajor = paidPaise != null ? paidPaise / 100 : null;
  const capturedAt =
    paymentEnt && paymentEnt.captured_at
      ? new Date(paymentEnt.captured_at * 1000)
      : new Date();

  const schedule = await prisma.travelPaymentSchedule.findFirst({
    where: { id: scheduleId },
  });
  if (!schedule) return;
  if (schedule.status === "paid") return; // idempotent — webhook retries

  await prisma.travelPaymentSchedule.update({
    where: { id: schedule.id },
    data: {
      status: "paid",
      paidAt: capturedAt,
      receivedAmount:
        paidMajor != null ? String(paidMajor) : schedule.expectedAmount,
    },
  });

  // Recompute the parent TravelInvoice status from its sibling milestones.
  const siblings = await prisma.travelPaymentSchedule.findMany({
    where: { invoiceId: schedule.invoiceId, tenantId: schedule.tenantId },
    select: { status: true },
  });
  const allSettled = siblings.every(
    (s) => s.status === "paid" || s.status === "waived",
  );
  await prisma.travelInvoice
    .update({
      where: { id: schedule.invoiceId },
      data: {
        status: allSettled ? "Paid" : "Partial",
        ...(allSettled ? { paidAt: capturedAt } : {}),
      },
    })
    .catch((e) =>
      console.error("[Payments] travel invoice status update failed:", e.message),
    );
}

// Reconcile a full TRAVEL invoice payment-link (notes.kind='travel-invoice').
// Marks the TravelInvoice Paid + flips every open milestone on it to paid so
// the milestone tracker + invoice agree. Idempotent + best-effort.
async function reconcileTravelInvoice(notes, paymentEnt) {
  const travelInvoiceId = Number(notes && notes.travelInvoiceId);
  if (!Number.isFinite(travelInvoiceId)) return;
  const capturedAt =
    paymentEnt && paymentEnt.captured_at
      ? new Date(paymentEnt.captured_at * 1000)
      : new Date();
  const invoice = await prisma.travelInvoice.findFirst({
    where: { id: travelInvoiceId },
  });
  if (!invoice || invoice.status === "Paid") return; // idempotent
  await prisma.travelInvoice.update({
    where: { id: invoice.id },
    data: { status: "Paid", paidAt: capturedAt },
  });
  // Settle any still-open milestones so the tracker matches the invoice.
  await prisma.travelPaymentSchedule
    .updateMany({
      where: {
        invoiceId: invoice.id,
        tenantId: invoice.tenantId,
        status: { in: ["pending", "partial", "overdue"] },
      },
      data: { status: "paid", paidAt: capturedAt },
    })
    .catch((e) =>
      console.error("[Payments] travel invoice milestone settle failed:", e.message),
    );
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
    const sig = req.headers["x-razorpay-signature"];
    const bodyStr = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : JSON.stringify(req.body);

    // Parse FIRST (read-only) so we can resolve which tenant this event
    // belongs to, then verify the HMAC with THAT tenant's webhook secret.
    // No DB mutation happens before signature verification below.
    let event;
    try {
      event = JSON.parse(bodyStr);
    } catch (_err) {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    // Tenant resolution: find the Payment row referenced by the event and use
    // its tenant's webhook secret. Falls back to the platform env secret for
    // subscription / platform payments (no per-tenant config row).
    const secret = await resolveRazorpayWebhookSecret(event);
    if (!secret)
      return res.status(503).json({ error: "Razorpay not configured" });

    const expected = crypto
      .createHmac("sha256", secret)
      .update(bodyStr)
      .digest("hex");

    if (sig !== expected) {
      return res.status(400).json({ error: "Invalid signature" });
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
      } else if (eventName === "payment_link.paid") {
        // Hosted Payment Link (e.g. the auto-generated link a customer pays
        // after signing an estimate). We store the payment-link id (plink_…)
        // as gatewayId at creation, so reconcile on that. Razorpay also fires
        // a sibling payment.captured, but its order_id won't match a link, so
        // this branch owns payment-link reconciliation.
        const plink = event.payload && event.payload.payment_link;
        const plinkEnt = plink && (plink.entity || plink);
        const plinkId = plinkEnt && plinkEnt.id;
        const paymentEnt = event.payload && event.payload.payment &&
          (event.payload.payment.entity || event.payload.payment);
        const paymentId = paymentEnt && paymentEnt.id;
        const notes = plinkEnt && plinkEnt.notes;

        // Travel quote advance link: notes.kind = 'travel-quote-advance'
        // Record paid amount, timestamp, and flip status to advance_paid / fully_paid.
        if (notes && notes.kind === 'travel-quote-advance' && notes.quoteId && paymentId) {
          try {
            const quoteId = Number(notes.quoteId);
            // Razorpay amounts are in paise (smallest unit); convert to major.
            const paidPaise = paymentEnt && paymentEnt.amount;
            const paidMajor = paidPaise != null ? paidPaise / 100 : null;
            const capturedAt = paymentEnt && paymentEnt.captured_at
              ? new Date(paymentEnt.captured_at * 1000)
              : new Date();

            // Fetch quote for status check + contactId + description.
            const quote = await prisma.travelQuote.findFirst({
              where: { id: quoteId },
              select: { totalAmount: true, status: true, contactId: true, subBrand: true },
            });

            // Determine new status: fully_paid if customer paid ≥ total amount.
            let newStatus = 'advance_paid';
            if (paidMajor != null && quote && Number(quote.totalAmount) > 0 && paidMajor >= Number(quote.totalAmount)) {
              newStatus = 'fully_paid';
            }

            await prisma.travelQuote.updateMany({
              where: { id: quoteId },
              data: {
                advancePaymentId: String(paymentId),
                status: newStatus,
              },
            });

            // Reconcile the Payment row. Since createAdvancePaymentLink now
            // creates a pending Payment row with gatewayId = plink_..., we first
            // try to find and update that row. Fallback to the old pay_XXXX path
            // for links created before this change.
            const tenantIdNum = Number(notes.tenantId);
            if (Number.isFinite(tenantIdNum) && paymentId) {
              let paymentRow = null;
              if (plinkId) {
                paymentRow = await prisma.payment.findFirst({
                  where: { gateway: 'razorpay', gatewayId: String(plinkId), tenantId: tenantIdNum },
                });
              }

              // If the quote has already been converted to an invoice, link the
              // payment to it so the invoice status reflects the advance.
              let travelInvoiceId = null;
              try {
                const travelInv = await prisma.travelInvoice.findFirst({
                  where: { quoteId, tenantId: tenantIdNum },
                  select: { id: true },
                });
                if (travelInv) travelInvoiceId = travelInv.id;
              } catch (_e) {}

              const baseMetadata = {
                type: 'travel-quote-advance',
                quoteId,
                subBrand: (quote && quote.subBrand) || null,
                plinkId: plinkId || null,
                razorpayPaymentId: String(paymentId),
              };

              let finalPaymentRow = paymentRow;
              if (paymentRow) {
                await prisma.payment.update({
                  where: { id: paymentRow.id },
                  data: {
                    invoiceId: travelInvoiceId,
                    contactId: (quote && quote.contactId) || paymentRow.contactId,
                    amount: paidMajor != null ? paidMajor : paymentRow.amount,
                    currency: (paymentEnt && paymentEnt.currency ? String(paymentEnt.currency).toUpperCase() : paymentRow.currency),
                    gatewayId: String(paymentId),
                    status: 'SUCCESS',
                    paidAt: capturedAt,
                    metadata: JSON.stringify(
                      travelInvoiceId
                        ? { ...baseMetadata, travelInvoiceId }
                        : baseMetadata
                    ),
                  },
                });
              } else {
                const existing = await prisma.payment.findFirst({
                  where: { gateway: 'razorpay', gatewayId: String(paymentId) },
                });
                if (!existing) {
                  finalPaymentRow = await prisma.payment.create({
                    data: {
                      tenantId: tenantIdNum,
                      invoiceId: travelInvoiceId,
                      contactId: (quote && quote.contactId) || null,
                      description: `Quote #${quoteId} advance — ${newStatus === 'fully_paid' ? 'fully paid' : 'advance deposit'}`,
                      amount: paidMajor != null ? paidMajor : 0,
                      currency: (paymentEnt && paymentEnt.currency ? String(paymentEnt.currency).toUpperCase() : 'INR'),
                      gateway: 'razorpay',
                      gatewayId: String(paymentId),
                      status: 'SUCCESS',
                      paidAt: capturedAt,
                      metadata: JSON.stringify(
                        travelInvoiceId
                          ? { ...baseMetadata, travelInvoiceId }
                          : baseMetadata
                      ),
                    },
                  });
                } else {
                  finalPaymentRow = existing;
                }
              }

              // Recompute the invoice status from all SUCCESS payments.
              if (travelInvoiceId) {
                try {
                  await recomputeTravelInvoiceStatus(prisma, tenantIdNum, travelInvoiceId);
                } catch (e) {
                  console.error('[Payments] travel invoice recompute failed:', e.message);
                }
              }

              // Emit automation event so workflow rules and the travel payment
              // admin notification listener can react.
              try {
                require('../lib/eventBus').emitEvent(
                  'payment.collected',
                  {
                    quoteId,
                    paymentId: finalPaymentRow ? finalPaymentRow.id : null,
                    travelInvoiceId: travelInvoiceId || null,
                    amount: paidMajor,
                    method: 'razorpay',
                    currency: (paymentEnt && paymentEnt.currency ? String(paymentEnt.currency).toUpperCase() : 'INR'),
                    paidAt: capturedAt,
                    contactId: (quote && quote.contactId) || null,
                    subBrand: (quote && quote.subBrand) || null,
                  },
                  tenantIdNum,
                  null
                );
              } catch (_e) {}
            }
          } catch (e) {
            console.error('[Payments] travel-quote advance persist failed:', e.message);
          }
        }

        // Travel milestone link: notes.kind = 'travel-milestone'. Marks the
        // TravelPaymentSchedule paid + recomputes the parent TravelInvoice —
        // this is what makes the Milestone Tracker "Notify" pay-link reconcile
        // back to the TRAVEL invoice (not the generic Invoice) when the
        // customer completes payment.
        if (notes && notes.kind === 'travel-milestone' && notes.scheduleId) {
          try {
            await reconcileTravelMilestone(notes, paymentEnt);
          } catch (e) {
            console.error('[Payments] travel-milestone reconcile failed:', e.message);
          }
        } else if (notes && notes.kind === 'travel-invoice' && notes.travelInvoiceId) {
          // Full-invoice travel pay-link (the "Generate payment link" action on
          // the Travel invoice). Marks the whole TravelInvoice + its milestones paid.
          try {
            await reconcileTravelInvoice(notes, paymentEnt);
          } catch (e) {
            console.error('[Payments] travel-invoice reconcile failed:', e.message);
          }
        }

        if (plinkId) {
          const payment = await prisma.payment.findFirst({
            where: { gateway: "razorpay", gatewayId: plinkId },
          });
          if (payment && payment.status !== "SUCCESS") {
            const updated = await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: "SUCCESS",
                paidAt: new Date(),
                gatewayId: paymentId || plinkId,
              },
            });
            await markInvoicePaid(payment.invoiceId, payment.tenantId);
            emitPaymentCollected(updated);
          }
        }
      } else if (eventName === "refund.processed" || eventName === "refund.created") {
        // Confirmation for refunds (incl. async/non-instant). The operator-
        // initiated refund already flips the Payment to REFUNDED synchronously;
        // this makes the webhook path idempotent + also covers refunds issued
        // from the Razorpay dashboard. Match the Payment by the refunded id.
        const refundEnt = event.payload && event.payload.refund && (event.payload.refund.entity || event.payload.refund);
        const refundedPaymentId = refundEnt && refundEnt.payment_id;
        if (refundedPaymentId) {
          const payment = await prisma.payment.findFirst({
            where: { gateway: "razorpay", gatewayId: String(refundedPaymentId) },
          });
          if (payment && payment.status !== "REFUNDED") {
            await require("../lib/refundService").finalizeRefund(payment, {
              refundId: refundEnt.id,
              amount: refundEnt.amount != null ? refundEnt.amount / 100 : Number(payment.amount || 0),
              reason: (refundEnt.notes && refundEnt.notes.reason) || null,
              refundStatus: refundEnt.status || "processed",
              userId: null,
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

    // Batch-fetch contact names for all contactIds in this result set.
    const contactIds = [...new Set(payments.map((p) => p.contactId).filter(Boolean))];
    const contactMap = {};
    if (contactIds.length > 0) {
      const contacts = await prisma.contact.findMany({
        where: { id: { in: contactIds }, tenantId },
        select: { id: true, name: true, email: true, phone: true },
      });
      contacts.forEach((c) => { contactMap[c.id] = c; });
    }

    // For travel payments (invoiceId=null, contactId=null), resolve customer +
    // invoice label from the TravelInvoice referenced in payment metadata.
    const parsedMetaMap = {};
    const travelInvIdsToFetch = [];
    for (const p of payments) {
      if (!p.contactId && !p.invoiceId) {
        let meta = {};
        try { meta = JSON.parse(p.metadata || "{}"); } catch (_) {}
        parsedMetaMap[p.id] = meta;
        if (meta.travelInvoiceId) travelInvIdsToFetch.push(Number(meta.travelInvoiceId));
      }
    }
    const travelInvMap = {};
    if (travelInvIdsToFetch.length > 0) {
      const uniqueTravelIds = [...new Set(travelInvIdsToFetch)];
      const travelInvs = await prisma.travelInvoice.findMany({
        where: { id: { in: uniqueTravelIds }, tenantId },
        select: { id: true, invoiceNum: true, contactId: true, itineraryId: true },
      });
      travelInvs.forEach((ti) => { travelInvMap[ti.id] = ti; });
      // Batch-fetch any contacts we don't already have from travel invoices
      const extraCids = [...new Set(
        travelInvs.map((ti) => ti.contactId).filter((cid) => cid && !contactMap[cid])
      )];
      if (extraCids.length > 0) {
        const extraContacts = await prisma.contact.findMany({
          where: { id: { in: extraCids }, tenantId },
          select: { id: true, name: true, email: true, phone: true },
        });
        extraContacts.forEach((c) => { contactMap[c.id] = c; });
      }
    }

    res.json(payments.map((p) => {
      let contact = p.contactId ? (contactMap[p.contactId] || null) : null;
      let travelInvoiceNum = null;
      let itineraryId = null;
      if (!contact && parsedMetaMap[p.id]) {
        const ti = travelInvMap[Number(parsedMetaMap[p.id].travelInvoiceId)];
        if (ti) {
          travelInvoiceNum = ti.invoiceNum;
          if (ti.contactId) contact = contactMap[ti.contactId] || null;
          if (ti.itineraryId) itineraryId = ti.itineraryId;
        }
      }
      // Also pick up itineraryId stored directly in payment metadata (advance/quote flows)
      if (!itineraryId && parsedMetaMap[p.id] && parsedMetaMap[p.id].itineraryId) {
        itineraryId = Number(parsedMetaMap[p.id].itineraryId) || null;
      }
      return { ...serialize(p), contact, travelInvoiceNum, itineraryId };
    }));
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
router.post("/create-stripe-intent", paymentLimiter, async (req, res) => {
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
router.post("/create-stripe-checkout-session", paymentLimiter, async (req, res) => {
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
router.post("/create-razorpay-order", paymentLimiter, async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    // Customer payment (customer → tenant) — use the TENANT's own Razorpay
    // keys, never the platform env keys (those are subscription-only). No
    // silent fallback: if the tenant hasn't configured keys, money would
    // otherwise land in the wrong account, so we disable with a clear message.
    const rp = await getTenantRazorpayClient(tenantId);
    if (!rp)
      return res
        .status(503)
        .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    const razorpay = rp.client;

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
      key: rp.keyId,
      amount: amountInt,
      currency: order.currency,
    });
  } catch (err) {
    console.error("[Payments] create-razorpay-order error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /confirm-razorpay
router.post("/confirm-razorpay", paymentLimiter, async (req, res) => {
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

    // Verify against the TENANT's own Razorpay secret (same account that
    // created the order), not the platform env secret.
    const creds = await getTenantRazorpayCreds(tenantId);
    const secret = creds && creds.keySecret;
    if (!secret)
      return res
        .status(503)
        .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });

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
router.post("/confirm-stripe-session", paymentLimiter, async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────
// REFUND — real gateway refund via the tenant's own (BYOK) Razorpay keys.
// Delegates to lib/refundService (shared with the itinerary cancellation flow).
// Travel BOOKING payments (advance / milestone / full-invoice) normally refund
// through the booking's CANCELLATION flow so the retention policy applies — the
// Payments page only allows an ADMIN override on them, and a reason is required.
// ─────────────────────────────────────────────────────────────────
const { verifyRole } = require("../middleware/auth");
const refundService = require("../lib/refundService");

// POST /api/payments/:id/refund — { amount?, reason? }. Full refund by default.
router.post("/:id/refund", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid payment id", code: "INVALID_ID" });
    }
    const tenantId = tenantOf(req);
    const payment = await prisma.payment.findFirst({ where: { id, tenantId } });
    if (!payment) {
      return res.status(404).json({ error: "Payment not found", code: "PAYMENT_NOT_FOUND" });
    }

    const meta = safeJsonParse(payment.metadata, {});
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;

    // Travel booking payments → cancellation-flow-first. ADMIN override only,
    // and the override must carry a reason (it bypasses the retention policy).
    if (refundService.isTravelBookingPayment(meta)) {
      if (req.user.role !== "ADMIN") {
        return res.status(403).json({
          error: "Refund this booking through its cancellation flow (Itineraries → cancellation) so the policy applies. Admins can override here.",
          code: "USE_CANCELLATION_FLOW",
        });
      }
      if (!reason) {
        return res.status(400).json({ error: "A reason is required to override the cancellation policy.", code: "REASON_REQUIRED" });
      }
    }

    const r = await refundService.refundCapturedPayment({
      payment,
      amount: req.body && req.body.amount,
      reason,
      userId: req.user.userId,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
    return res.json({ ...serialize(r.payment), refund: r.refund });
  } catch (err) {
    console.error("[Payments] refund error:", err.message);
    res.status(500).json({ error: "Failed to process refund", code: "REFUND_FAILED" });
  }
});

module.exports = router;
