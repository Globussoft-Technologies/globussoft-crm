// Webhook subscription-entitlement + per-tenant signing-secret resolution.
//
// Single source of truth for two questions, reused by BOTH the credential-
// management routes (routes/developer.js) and the background delivery path
// (lib/webhookDelivery.js → deliverWebhooks):
//
//   1. isTenantWebhookEntitled(tenantId)  — is this tenant allowed to send
//      webhooks right now? Gate is: a live PAID subscription OR an active
//      (non-expired) free trial. (Trial counts per the product decision.)
//
//   2. resolveTenantWebhookSecret(tenantId) — the raw HMAC secret to sign
//      this tenant's outbound webhooks with: the decrypted secret of the
//      tenant's ACTIVE WebhookCredential, else the legacy global
//      process.env.WEBHOOK_HMAC_SECRET, else null (→ delivered unsigned).
//
// Why compute LIVE state instead of reading User.subscriptionStatus: that
// denormalized column is only re-settled lazily when /subscriptions/status
// is read (reconcileSubscriptions). The background delivery path never hits
// that route, so an elapsed-but-still-"ACTIVE"-flagged user would otherwise
// keep receiving webhooks after their period ended. Querying the Subscription
// window (startDate/endDate) directly is authoritative without needing to run
// the reconcile transaction on every webhook fire.
const prisma = require("./prisma");
const { decrypt } = require("./fieldEncryption");

/**
 * Is the tenant currently entitled to send outbound webhooks?
 *
 * @param {number} tenantId
 * @returns {Promise<{ entitled: boolean, reason: string }>}
 *   reason ∈ 'active_subscription' | 'active_trial' | 'no_active_subscription'
 */
async function isTenantWebhookEntitled(tenantId) {
  if (!tenantId) return { entitled: false, reason: "no_active_subscription" };
  const now = new Date();

  // 1. A live PAID subscription: status ACTIVE and now within [startDate, endDate).
  //    endDate null is treated as open-ended coverage.
  const activeSub = await prisma.subscription.findFirst({
    where: {
      tenantId,
      status: "ACTIVE",
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gt: now } }],
    },
    select: { id: true },
  });
  if (activeSub) return { entitled: true, reason: "active_subscription" };

  // 2. Else an active (non-expired) free trial on any user of the tenant.
  //    trialEndsAt null is treated as still-trialing (mirrors checkSubscription,
  //    which only expires a trial once trialEndsAt is set AND has passed).
  const trialUser = await prisma.user.findFirst({
    where: {
      tenantId,
      subscriptionStatus: "TRIAL",
      OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: now } }],
    },
    select: { id: true },
  });
  if (trialUser) return { entitled: true, reason: "active_trial" };

  return { entitled: false, reason: "no_active_subscription" };
}

/**
 * Resolve the raw HMAC signing secret for a tenant's outbound webhooks.
 *
 * Precedence:
 *   1. The tenant's ACTIVE WebhookCredential (decrypted) — the new model.
 *   2. process.env.WEBHOOK_HMAC_SECRET — legacy global fallback, kept so the
 *      single pre-migration GlobusPhone integration keeps working until it
 *      has generated a per-tenant credential.
 *   3. null — no secret available → deliverSingle sends the webhook UNSIGNED.
 *
 * A REVOKED credential resolves to NO tenant secret (it is intentionally not
 * matched); the caller then falls back to env-or-null. Combined with the
 * entitlement gate in deliverWebhooks, a revoked credential effectively stops
 * signed delivery to a verifying receiver.
 *
 * @param {number} tenantId
 * @returns {Promise<{ secret: (string|null), source: ('credential'|'env'|'none') }>}
 */
async function resolveTenantWebhookSecret(tenantId) {
  if (tenantId) {
    const cred = await prisma.webhookCredential.findFirst({
      where: { tenantId, status: "ACTIVE" },
      select: { secret: true },
    });
    if (cred && cred.secret) {
      // decrypt() is a no-op for plaintext (no ENC:v1: prefix) and for the
      // key-unset case, so this works whether or not WELLNESS_FIELD_KEY is set.
      return { secret: decrypt(cred.secret), source: "credential" };
    }
  }

  const envSecret = process.env.WEBHOOK_HMAC_SECRET;
  if (envSecret) return { secret: envSecret, source: "env" };

  return { secret: null, source: "none" };
}

module.exports = { isTenantWebhookEntitled, resolveTenantWebhookSecret };
