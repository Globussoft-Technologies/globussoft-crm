const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Per-user rate limiting for messaging endpoints.
// Uses authenticated userId as the key, falls back to IP (IPv6-safe) for unauthenticated requests.
const userKey = (req, res) =>
  req.user?.userId?.toString() || ipKeyGenerator(req, res);

// Email send: 100 per hour per user
const emailSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many emails sent, please slow down.' },
});

// SMS send: 50 per hour per user
const smsSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'SMS rate limit exceeded.' },
});

// WhatsApp send: 50 per hour per user
const whatsappSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'WhatsApp rate limit exceeded.' },
});

// Push send: 20 per hour per user (these are bulk!)
const pushSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Push notification rate limit exceeded.' },
});

module.exports = { emailSendLimiter, smsSendLimiter, whatsappSendLimiter, pushSendLimiter };
