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

async function createOrder(amount, planId) {
  const razorpay = getRazorpay();
  const order = await razorpay.orders.create({
    amount: amount * 100, // Convert to paise
    currency: 'INR',
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

    console.log('[razorpayService.verifySignature] Message:', message);
    console.log('[razorpayService.verifySignature] Expected hash:', hash);
    console.log('[razorpayService.verifySignature] Received signature:', signature);

    // Compare the calculated hash with the signature provided
    const isValid = hash === signature;
    console.log('[razorpayService.verifySignature] Match:', isValid);

    return isValid;
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
