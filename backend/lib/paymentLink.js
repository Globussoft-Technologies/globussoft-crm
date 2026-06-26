// Gateway-agnostic hosted payment-link generator.
//
// Produces a single "click and pay" URL the customer can open from an email
// — no app login required — backed by either Razorpay Payment Links or Stripe
// Checkout Sessions. The MODE (test vs live) is whatever the configured API
// keys are (rzp_test… / sk_live…), so this transparently supports both.
//
// A PENDING Payment row is created with gatewayId set to the gateway's id
// (Razorpay payment-link id / Stripe session id) so the existing webhooks in
// routes/payments.js reconcile it to PAID when the customer completes payment.
//
// Returns { url, gateway, paymentId } on success, or { error } if no gateway
// is configured / the gateway rejects. Never throws for config issues.

const prisma = require("./prisma");
const { getTenantRazorpayClient } = require("./tenantPaymentGateway");

// ── Lazy Stripe loader (platform key — Stripe is not BYOK yet) ──────
let _stripe = null;
function getStripe() {
  if (!_stripe && process.env.STRIPE_SECRET_KEY) {
    try {
      _stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    } catch (err) {
      console.error("[paymentLink] Stripe SDK load failed:", err.message);
    }
  }
  return _stripe;
}

// Razorpay is BYOK — always loaded per-tenant from DB, not cached globally.

function gatewayAvailability() {
  return { stripe: !!getStripe(), razorpay: true }; // razorpay availability checked per-tenant at call time
}

// Resolve which gateway to use. `pref` ∈ {auto, razorpay, stripe}.
//   auto → INR → razorpay (tenant BYOK); else Stripe.
function resolveGateway(pref, currency) {
  const want = (pref || "auto").toLowerCase();
  if (want === "razorpay") return "razorpay";
  if (want === "stripe" && getStripe()) return "stripe";
  if (String(currency).toUpperCase() === "INR") return "razorpay";
  if (getStripe()) return "stripe";
  return "razorpay";
}

/**
 * Create a hosted payment link for an invoice.
 * @param {Object} opts
 * @param {number} opts.tenantId
 * @param {Object} opts.invoice    - { id, invoiceNum, amount }
 * @param {Object} [opts.contact]  - { name, email, phone }
 * @param {string} [opts.currency] - ISO 4217 (defaults USD)
 * @param {string} [opts.gatewayPref] - auto | razorpay | stripe
 * @param {string} [opts.tenantName]  - org display name shown on the payment page
 * @param {Object} [opts.travelContext] - { scheduleId, travelInvoiceId }. When
 *   present this is a TRAVEL-vertical link: the Payment row is tagged
 *   kind='travel-milestone' (in notes + metadata) and its invoiceId is left
 *   NULL so the generic markInvoicePaid() can't mis-reconcile against a
 *   same-numbered generic Invoice. The Razorpay webhook's travel-milestone
 *   branch reconciles it back to the TravelPaymentSchedule + TravelInvoice.
 * @returns {Promise<{url, gateway, paymentId}|{error, code}>}
 */
async function createInvoicePaymentLink({ tenantId, invoice, contact, contactId, currency, gatewayPref, tenantName, travelContext }) {
  const amount = Number(invoice?.amount);
  if (!invoice?.id || !amount || isNaN(amount) || amount <= 0) {
    return { error: "Invoice with a positive amount is required", code: "BAD_INVOICE" };
  }
  const cur = String(currency || "USD").toUpperCase();
  const gateway = resolveGateway(gatewayPref, cur);
  if (!gateway) {
    return { error: "No payment gateway configured", code: "NO_GATEWAY" };
  }
  const frontendBase = process.env.FRONTEND_URL || "http://localhost:5173";
  const amountMinor = Math.round(amount * 100);
  const invoiceLabel = invoice.invoiceNum || `Invoice #${invoice.id}`;
  const label = tenantName ? `${tenantName} — ${invoiceLabel}` : invoiceLabel;

  try {
    if (gateway === "razorpay") {
      const tenantGateway = await getTenantRazorpayClient(tenantId);
      if (!tenantGateway) {
        return { error: "Razorpay is not configured for this account. Please add your keys in Settings → Payment.", code: "NO_GATEWAY" };
      }
      const razorpay = tenantGateway.client;
      const link = await razorpay.paymentLink.create({
        amount: amountMinor,
        currency: cur,
        accept_partial: false,
        description: label,
        customer: {
          name: contact?.name || undefined,
          email: contact?.email || undefined,
          contact: contact?.phone || undefined,
        },
        // We send our own branded email; don't double-notify from Razorpay.
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: travelContext
          ? {
              tenantId: String(tenantId),
              kind: travelContext.kind || "travel-milestone",
              ...(travelContext.scheduleId != null
                ? { scheduleId: String(travelContext.scheduleId) }
                : {}),
              travelInvoiceId: String(travelContext.travelInvoiceId),
            }
          : { tenantId: String(tenantId), invoiceId: String(invoice.id) },
        callback_url: `${frontendBase}/p/payment/success`,
        callback_method: "get",
      });
      const payment = await prisma.payment.create({
        data: {
          // Travel links leave invoiceId NULL so the generic markInvoicePaid()
          // can't grab a same-numbered generic Invoice; the webhook's
          // travel-milestone branch reconciles via the metadata instead.
          invoiceId: travelContext ? null : invoice.id,
          contactId: contactId ? Number(contactId) : null,
          amount,
          currency: cur,
          gateway: "razorpay",
          gatewayId: link.id, // plink_… — matched by the payment_link.paid webhook
          status: "PENDING",
          tenantId,
          metadata: JSON.stringify(
            travelContext
              ? {
                  mode: "payment_link",
                  url: link.short_url,
                  plinkId: link.id,
                  kind: travelContext.kind || "travel-milestone",
                  scheduleId: travelContext.scheduleId,
                  travelInvoiceId: travelContext.travelInvoiceId,
                }
              : { mode: "payment_link", url: link.short_url, plinkId: link.id },
          ),
        },
      });
      return { url: link.short_url, gateway: "razorpay", paymentId: payment.id };
    }

    // Stripe hosted Checkout Session.
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: cur.toLowerCase(),
            product_data: { name: label },
            unit_amount: amountMinor,
          },
          quantity: 1,
        },
      ],
      success_url: `${frontendBase}/invoices?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendBase}/invoices?stripe=cancel`,
      metadata: { tenantId: String(tenantId), invoiceId: String(invoice.id) },
    });
    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amount,
        currency: cur,
        gateway: "stripe",
        gatewayId: session.id, // matched by the checkout.session.completed webhook
        status: "PENDING",
        tenantId,
        metadata: JSON.stringify({ mode: "checkout", sessionUrl: session.url }),
      },
    });
    return { url: session.url, gateway: "stripe", paymentId: payment.id };
  } catch (err) {
    console.error(`[paymentLink] ${gateway} link creation failed:`, err.message);
    return { error: err.message, code: "GATEWAY_ERROR", gateway };
  }
}

module.exports = { createInvoicePaymentLink, resolveGateway, gatewayAvailability };
