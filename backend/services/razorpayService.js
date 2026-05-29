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

async function createOrder(amount, planId, currency = 'INR') {
  const razorpay = getRazorpay();
  // Razorpay expects the smallest unit of the currency (paise for INR,
  // cents for USD). Both happen to be 1/100 of the major unit, so the
  // *100 multiplier covers both.
  const order = await razorpay.orders.create({
    amount: Math.round(amount * 100),
    currency,
    notes: { planId: planId.toString() }
  });
  return order;
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
