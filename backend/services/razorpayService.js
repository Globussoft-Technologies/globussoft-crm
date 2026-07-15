const Razorpay = require('razorpay');
const crypto = require('crypto');

let razorpayInstance = null;

function getRazorpay() {
  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayInstance;
}

// ── API Analytics logging ───────────────────────────────────────────
// Fire-and-forget ApiCallLog row per Razorpay API call — request COUNT
// only (per user direction: Razorpay charges a % of the transaction, not a
// per-API-call fee, so costEstimate always stays 0 here; the value of this
// row is purely "how many Razorpay calls, success vs failure").
function logApiCall({ endpoint, status, durationMs, errorMessage }) {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const prisma = require('../lib/prisma');
    prisma.apiCallLog
      .create({
        data: {
          tenantId: 1,
          provider: 'razorpay',
          endpoint,
          status,
          costEstimate: 0,
          durationMs,
          surface: 'razorpayService',
          errorMessage: errorMessage || null,
        },
      })
      .catch((e) => console.error(`[razorpayService] ApiCallLog persist failed (non-fatal): ${e.message}`));
  } catch (e) {
    console.error(`[razorpayService] ApiCallLog require failed (non-fatal): ${e.message}`);
  }
}

async function createOrder(amount, planId, currency = 'INR') {
  const razorpay = getRazorpay();
  const startedAt = Date.now();
  try {
    // Razorpay expects the smallest unit of the currency (paise for INR,
    // cents for USD). Both happen to be 1/100 of the major unit, so the
    // *100 multiplier covers both.
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency,
      notes: { planId: planId.toString() }
    });
    logApiCall({ endpoint: 'orders.create', status: 'success', durationMs: Date.now() - startedAt });
    return order;
  } catch (e) {
    logApiCall({ endpoint: 'orders.create', status: 'failed', durationMs: Date.now() - startedAt, errorMessage: e.message });
    throw e;
  }
}

function verifySignature(orderId, paymentId, signature) {
  try {
    // Create HMAC-SHA256 hash from order_id|payment_id using the secret key
    const message = `${orderId}|${paymentId}`;
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(message);
    const hash = hmac.digest('hex');

    // Compare using timing-safe comparison to prevent timing attacks
    try {
      const isValid = crypto.timingSafeEqual(
        Buffer.from(hash, 'hex'),
        Buffer.from(signature, 'hex')
      );
      return isValid;
    } catch (_bufferErr) {
      // timingSafeEqual throws if buffers are different lengths — signature is invalid
      return false;
    }
  } catch (err) {
    console.error('[razorpayService.verifySignature] Error:', err.message);
    return false;
  }
}

module.exports = {
  createOrder,
  verifySignature,
  getRazorpay
};
