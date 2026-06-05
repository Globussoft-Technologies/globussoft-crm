// ─────────────────────────────────────────────────────────────────
// Per-tenant payment-gateway credential loader (#848 minimal slice).
//
// BYOK model: each tenant brings its OWN Razorpay merchant keys so that
// payments made by THEIR customers (invoices, memberships, gift cards)
// settle into the TENANT's Razorpay account — not Globussoft's platform
// account. The platform's own RAZORPAY_KEY_* env vars are reserved for
// SUBSCRIPTION billing (tenant → Globussoft) and are NOT consulted here.
//
// Consumers (routes/payments.js customer endpoints, routes/wellness.js
// membership + gift-card flows) call getTenantRazorpayClient(tenantId).
// When a tenant hasn't configured + activated its keys, these return null
// and the caller surfaces a clear "ask your admin to configure Razorpay"
// message instead of silently charging into the wrong account.
// ─────────────────────────────────────────────────────────────────
const prisma = require("./prisma");
const { decryptCredential } = require("./credentialMasking");

const PROVIDER = "razorpay";

// User-facing copy reused by every customer-payment call-site so the
// message stays consistent across invoices / memberships / gift cards.
const NOT_CONFIGURED_MESSAGE =
  "Online payments aren't set up yet. Ask your administrator to add this organisation's Razorpay keys in Settings → Payment Gateway.";

/**
 * Load + decrypt a tenant's Razorpay credentials.
 *
 * Only Key ID + Key Secret are used — the same two values present in the
 * platform `.env` (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). There is no
 * separate webhook secret: webhook verification reuses the Key Secret, which
 * mirrors the platform handler's `RAZORPAY_WEBHOOK_SECRET || RAZORPAY_KEY_SECRET`
 * fallback.
 *
 * @returns {Promise<{ keyId, keySecret }|null>} null when the tenant has no
 *   row, the row is inactive, or the keyId/keySecret pair is incomplete (a
 *   half-configured row can't take money).
 */
async function getTenantRazorpayCreds(tenantId) {
  if (!tenantId) return null;
  const row = await prisma.paymentGatewayConfig.findFirst({
    where: { tenantId, provider: PROVIDER },
  });
  if (!row || !row.isActive) return null;
  const keyId = row.keyId || null;
  const keySecret = decryptCredential(row.keySecret) || null;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

/**
 * Build a Razorpay SDK client bound to the tenant's own keys.
 * @returns {Promise<{ client, keyId, keySecret, webhookSecret }|null>}
 */
async function getTenantRazorpayClient(tenantId) {
  const creds = await getTenantRazorpayCreds(tenantId);
  if (!creds) return null;
  try {
    const Razorpay = require("razorpay");
    const client = new Razorpay({
      key_id: creds.keyId,
      key_secret: creds.keySecret,
    });
    return { client, ...creds };
  } catch (err) {
    console.error(
      "[tenantPaymentGateway] Failed to instantiate Razorpay SDK:",
      err.message,
    );
    return null;
  }
}

module.exports = {
  PROVIDER,
  NOT_CONFIGURED_MESSAGE,
  getTenantRazorpayCreds,
  getTenantRazorpayClient,
};
