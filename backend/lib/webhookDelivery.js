const crypto = require("crypto");
const prisma = require("./prisma");

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

    if (webhooks.length === 0) return;

    // Subscription gate — lead sync only flows for subscribed tenants. When
    // the subscription expires / is cancelled (and no active trial), delivery
    // stops automatically here, without any cron or manual toggle. See
    // lib/webhookEntitlement.js for the live-state policy (paid sub OR trial).
    const { isTenantWebhookEntitled, resolveTenantWebhookSecret } = require("./webhookEntitlement");
    const { entitled, reason } = await isTenantWebhookEntitled(tenantId);
    if (!entitled) {
      console.log(
        `[Webhook] tenant ${tenantId} not entitled (${reason}) — skipping ${webhooks.length} ${event} deliveries`
      );
      return;
    }

    // Resolve the tenant's signing secret ONCE (not per-delivery): the
    // per-tenant WebhookCredential, else the legacy global env secret, else
    // null (→ unsigned). All of this tenant's webhooks share one secret so a
    // partner (GlobusPhone) verifies with a single configured value.
    const { secret } = await resolveTenantWebhookSecret(tenantId);

    for (const wh of webhooks) {
      await deliverSingle(wh.targetUrl, event, payload, tenantId, secret);
    }
  } catch (e) {
    console.error(`[Webhook] Error querying webhooks for ${event}:`, e.message);
  }
}

/**
 * Fire a single outbound webhook HTTP POST.
 *
 * [GP-CRM integration] Task 10 — Stripe-style HMAC signing. When a signing
 * secret is available, the delivery includes:
 *   X-Globussoft-Signature: t=<unix_epoch_sec>,v1=<hmac_sha256_hex>
 * The signed string is "<t>.<bodyStr>" — bodyStr being the exact bytes of the
 * POST body. Partners verify HMAC-SHA256(secret, "<t>.<body>") == v1. When the
 * secret is absent, deliveries are sent unsigned — backwards-compatible with
 * every pre-integration subscriber and with partners that don't yet verify.
 *
 * Secret precedence: the explicit `secret` argument (resolved per-tenant by
 * deliverWebhooks via lib/webhookEntitlement.js) wins; when omitted it falls
 * back to process.env.WEBHOOK_HMAC_SECRET (legacy global path — also what the
 * existing HMAC unit tests exercise by calling the 4-arg form).
 *
 * @param {string}  url       Target URL
 * @param {string}  event     Event name
 * @param {object}  payload   Event data
 * @param {number}  tenantId  Tenant scope
 * @param {string} [secret]   Per-tenant HMAC secret; env fallback when undefined
 */
async function deliverSingle(url, event, payload, tenantId, secret) {
  if (!url) {
    console.warn("[Webhook] No URL provided, skipping delivery");
    return;
  }

  try {
    // Capture one instant and derive both values from it: the epoch-second
    // used in the HMAC signature (t=) and the ISO body timestamp. The body
    // keeps millisecond precision — receivers verify the signature over the
    // raw body bytes + the header's t=, so the body timestamp itself doesn't
    // need to be floored — while t= stays second-granular (Stripe-style).
    const nowMs = Date.now();
    const tSec = Math.floor(nowMs / 1000);
    const bodyStr = JSON.stringify({
      event,
      timestamp: new Date(nowMs).toISOString(),
      data: payload,
    });

    const headers = {
      "Content-Type": "application/json",
      "X-CRM-Event": event,
      "X-CRM-Tenant": String(tenantId),
    };

    // Explicit per-tenant secret wins; fall back to the legacy global env
    // secret when the caller didn't pass one (4-arg legacy invocations).
    const hmacSecret = (secret != null ? secret : process.env.WEBHOOK_HMAC_SECRET) || "";
    if (hmacSecret) {
      const sig = crypto
        .createHmac("sha256", hmacSecret)
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
