const crypto = require("crypto");
const prisma = require("./prisma");

// Shared HMAC secret for Stripe-style webhook signatures.
// Set WEBHOOK_HMAC_SECRET in .env on the CRM side. Partner receivers (e.g.
// GlobusPhone) configure the same value as their inbound verification secret.
// When the variable is absent, deliveries are still sent but unsigned —
// backwards-compatible with partners that don't yet verify signatures.
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || "";

/**
 * Deliver outbound HTTP POST to all registered Webhooks matching an event.
 *
 * Supports exact match ("deal.won") and wildcard match ("deal.*").
 *
 * Canonical event catalogue (lifecycle webhooks supported by this CRM).
 * Subscribers use exact-match OR glob-match (e.g. `invoice.*`) on these.
 *
 * Sales pipeline:
 *   deal.created / deal.updated / deal.won / deal.lost
 *   contact.created / contact.updated
 *
 * Invoicing + payments (billing.js wave-6a):
 *   invoice.created
 *   invoice.completed
 *   invoice.voided
 *   invoice.refunded
 *   payment.collected
 *
 * Wellness POS / wallet (wave-6a):
 *   wallet.topup
 *   wallet.spent
 *   giftcard.issued
 *   giftcard.redeemed
 *   cashback.credited
 *   membership.plan_created
 *   membership.enrolled
 *   membership.renewed
 *   membership.benefit_applied
 *   membership.expired
 *   membership.cancelled
 *
 * Attendance (wave-6a):
 *   attendance.checked_in
 *   attendance.checked_out
 *
 * Travel-vertical lifecycle (#929 close-out, 2026-05-23 ticks #36-#38):
 *   visa.status_changed      — VisaApplication PATCH on status transition
 *   quote.sent               — Estimate POST /:id/email on Draft → Sent
 *   itinerary.accepted       — Itinerary POST /:id/accept on customer accept
 *
 * Most emissions are routed through `lib/eventBus.js`'s `emitEvent()`
 * (which fans out to BOTH AutomationRules + Webhooks). Direct
 * `deliverWebhooks()` calls bypass workflow rules — used for events
 * that are intentionally webhook-only (no automation downstream).
 */
async function deliverWebhooks(event, payload, tenantId) {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        tenantId,
        event: { in: [event, event.split(".")[0] + ".*"] },
        isActive: true,
      },
    });

    for (const wh of webhooks) {
      await deliverSingle(wh.targetUrl, event, payload, tenantId);
    }
  } catch (e) {
    console.error(`[Webhook] Error querying webhooks for ${event}:`, e.message);
  }
}

/**
 * Fire a single outbound webhook HTTP POST.
 *
 * Task 10 [GP-CRM integration]: Stripe-style HMAC signing.
 * When WEBHOOK_HMAC_SECRET is set, the delivery includes:
 *   X-Globussoft-Signature: t=<unix_epoch_sec>,v1=<hmac_sha256_hex>
 * where the signed string is `<t>.<body>` (same body bytes sent in the POST).
 * Partners verify: HMAC-SHA256(secret, "<t>.<body>") == hex from header.
 *
 * @param {string} url       Target URL
 * @param {string} event     Event name
 * @param {object} payload   Event data
 * @param {number} tenantId  Tenant scope
 */
async function deliverSingle(url, event, payload, tenantId) {
  if (!url) {
    console.warn("[Webhook] No URL provided, skipping delivery");
    return;
  }

  try {
    // Use a single epoch-second timestamp so the signature and the body
    // timestamp are perfectly consistent.
    const tSec = Math.floor(Date.now() / 1000);
    const bodyObj = {
      event,
      timestamp: new Date(tSec * 1000).toISOString(),
      data: payload,
    };
    const bodyStr = JSON.stringify(bodyObj);

    const headers = {
      "Content-Type": "application/json",
      "X-CRM-Event": event,
      "X-CRM-Tenant": String(tenantId),
    };

    // Compute Stripe-style HMAC when a shared secret is configured.
    // Signed string format: "<tSec>.<bodyStr>" — identical to GP-side verification
    // in backend/app/security/webhook_auth.py.
    if (HMAC_SECRET) {
      const sig = crypto
        .createHmac("sha256", HMAC_SECRET)
        .update(`${tSec}.${bodyStr}`)
        .digest("hex");
      headers["X-Globussoft-Signature"] = `t=${tSec},v1=${sig}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Webhook] ${event} -> ${url}: ${response.status}`);
  } catch (e) {
    console.error(`[Webhook] ${event} -> ${url}: FAILED - ${e.message}`);
  }
}

module.exports = { deliverWebhooks, deliverSingle };
