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

// Strip anything that looks like a Razorpay key out of a string before it
// reaches the browser — the SDK's own error text sometimes echoes back
// request context that can include key-shaped substrings.
function scrubKeys(s) {
  if (typeof s !== "string") return s;
  return s.replace(/\b(sk|pk|rk|rzp)_(test|live)_[A-Za-z0-9_*]+/g, "[redacted]");
}

/**
 * Map a Razorpay SDK throw to a safe, specific, user-facing message instead
 * of a blanket "please try again". Razorpay's SDK throws
 * `{ statusCode, error: { code, description, field, ... } }` — mirrors the
 * `parseGatewayError` pattern already used for the customer-payment create
 * path in routes/payments.js, reused here so the ADMIN-override refund flow
 * (refundService.js) gives an equally specific reason instead of a generic
 * REFUND_FAILED for every kind of rejection.
 *
 * @returns {{status:number, code:string, message:string}}
 */
function parseRazorpayError(err) {
  if (!err) return { status: 502, code: "GATEWAY_ERROR", message: "Razorpay is temporarily unavailable. Please try again in a moment." };
  const description = (err.error && err.error.description) || err.message || "Razorpay error";
  const gatewayCode = (err.error && err.error.code) || err.code || null;
  const gatewayStatus = err.statusCode || 0;

  const looksLikeAuthIssue =
    gatewayStatus === 401 ||
    /invalid api key|authentication|unauthorized|key_invalid/i.test(description);
  if (looksLikeAuthIssue) {
    return {
      status: 503,
      code: "GATEWAY_NOT_CONFIGURED",
      message: "Razorpay isn't available right now. Please contact support — the payment gateway needs to be reconfigured.",
    };
  }

  // Already-refunded / already-processed on Razorpay's side — our DB thought
  // it wasn't refunded yet (e.g. a webhook hadn't landed), but Razorpay's
  // ledger disagrees. Tell the operator to refresh rather than retry blindly.
  const looksAlreadyRefunded = /refund.*already|already.*refund|fully refunded/i.test(description);
  if (looksAlreadyRefunded) {
    return {
      status: 409,
      code: "ALREADY_REFUNDED_UPSTREAM",
      message: "Razorpay shows this payment as already refunded. Please refresh the page — the status here may be out of date.",
    };
  }

  // Payment isn't in a refundable state on Razorpay's side (e.g. still
  // "authorized" rather than "captured", or voided/failed) — same class of
  // "Razorpay's status disagrees with ours" as the already-refunded case
  // above, just the opposite direction. Tell the operator to check status
  // rather than show them Razorpay's internal "captured" terminology.
  const looksLikeWrongStatus = /status should be captured|not.*captured|payment status/i.test(description);
  if (looksLikeWrongStatus) {
    return {
      status: 409,
      code: "PAYMENT_NOT_CAPTURED",
      message: "This payment isn't eligible for a refund right now. Razorpay doesn't show it as fully captured — please refresh the page and check the payment's current status before retrying.",
    };
  }

  if (gatewayStatus >= 400 && gatewayStatus < 500) {
    return { status: 400, code: gatewayCode || "REFUND_REJECTED", message: scrubKeys(description) };
  }

  return {
    status: 502,
    code: gatewayCode || "GATEWAY_UNAVAILABLE",
    message: "Razorpay is temporarily unavailable. Please try again in a moment.",
  };
}

module.exports = {
  PROVIDER,
  NOT_CONFIGURED_MESSAGE,
  getTenantRazorpayCreds,
  getTenantRazorpayClient,
  parseRazorpayError,
};
