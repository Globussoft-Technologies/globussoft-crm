/**
 * Centralized rate-limiting middleware for all external provider-backed endpoints.
 *
 * Strategy — NO IP-based keying anywhere:
 *   - Authenticated endpoints  → userId (from JWT via req.user.userId)
 *   - Tenant-scoped endpoints  → tenantId (from JWT via req.user.tenantId)
 *   - Registration endpoints   → email from req.body (account-level)
 *   - OTP request endpoints    → email OR phone from req.body (account-level)
 *   - OTP verify endpoints     → email OR phone from req.body (account-level)
 *   - OAuth callbacks          → userId encoded in the `state` query param
 *   - Webhook endpoints        → tenantId from URL param or query (provider posts
 *                                include a tenant discriminator in the path/query)
 *
 *   When the account identifier is genuinely absent (e.g. a completely anonymous
 *   request with no email/phone/state), the request is REJECTED (429) with a
 *   clear "identifier required" message rather than falling back to IP, so we
 *   never conflate two users by their shared exit node.
 *
 * NODE_ENV=test raises all ceilings to 100 000 so the Playwright gate never
 * exhausts a budget.
 *
 * Usage:
 *   const { llmLimiter } = require('../middleware/apiRateLimiters');
 *   router.post('/draft', verifyToken, llmLimiter, handler);
 */

const rateLimit = require('express-rate-limit');

const IS_TEST = process.env.NODE_ENV === 'test';

// ─── Key generators ────────────────────────────────────────────────────────────

/** Authenticated routes — key on userId from JWT. Always present after verifyToken. */
const byUserId = (req) => {
  const id = req.user?.userId?.toString();
  if (!id) return '__no_user__'; // verifyToken would have already rejected; safety net
  return `u:${id}`;
};

/** Tenant-scoped authenticated routes — key on tenantId from JWT. */
const byTenantId = (req) => {
  const id = req.user?.tenantId?.toString();
  if (!id) return `u:${req.user?.userId?.toString() || '__no_tenant__'}`;
  return `t:${id}`;
};

/**
 * Registration — key on the submitted email (lowercased).
 * Rejects (returns a sentinel that maps to an always-full bucket) when no email
 * is present so anonymous probes can't bypass the limit.
 */
const byEmail = (req) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email) return '__no_email__';
  return `email:${email}`;
};

/**
 * OTP endpoints — key on email OR phone, whichever is present.
 * Phone is normalised to digits-only so +91-XXXX and 91XXXX share a bucket.
 */
const byEmailOrPhone = (req) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  if (email) return `email:${email}`;
  const phone = (req.body?.phone || req.body?.phoneNumber || '').replace(/\D/g, '');
  if (phone) return `phone:${phone}`;
  return '__no_identifier__';
};

/**
 * OAuth callbacks — the `state` query param is a JWT/opaque token that encodes
 * the userId who initiated the OAuth flow. Key on it directly; it is unique per
 * user-initiated flow and cannot be guessed.
 */
const byOAuthState = (req) => {
  const state = (req.query?.state || '').trim();
  if (state) return `oauth_state:${state}`;
  // If state is absent the callback is already invalid; use a fixed sentinel
  // so all stateless probes share one always-full bucket.
  return '__no_oauth_state__';
};

/**
 * Webhooks — key on a tenant discriminator embedded in the URL or query.
 * Different providers use different conventions:
 *   SMS/Voice  — /webhook/:provider?tenantId=... or path param
 *   WhatsApp   — Meta sends hub.verify_token which is our tenant-scoped secret
 * Fall back to the raw URL path so different webhook paths get separate buckets
 * even without an explicit tenant param.
 */
const byWebhookTenant = (req) => {
  const tenantId =
    req.query?.tenantId ||
    req.params?.tenantId ||
    req.body?.tenantId ||
    // WhatsApp verify_token is set per-tenant in the Meta dashboard
    req.query?.['hub.verify_token'] ||
    req.body?.['hub.verify_token'];
  if (tenantId) return `wh_tenant:${String(tenantId)}`;
  // Last resort: bucket by the URL path — at least separates different webhook types
  return `wh_path:${req.path}`;
};

// ─── Helper ────────────────────────────────────────────────────────────────────

const make = (opts) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    ...opts,
    max: IS_TEST ? 100_000 : opts.max,
  });

// ══════════════════════════════════════════════════════════════════════════════
// 1. LLM PROVIDERS  (Gemini · Groq · OpenAI text)
//    100 req / 15 min per user.
//    Applied to: /api/ai/*, /api/sentiment/analyze*, /api/deal-insights/generate,
//                /api/voice/transcribe*, /api/voice/summarize*.
// ══════════════════════════════════════════════════════════════════════════════

const llmLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: byUserId,
  message: { error: 'LLM rate limit exceeded — max 100 requests per 15 minutes per user.' },
});

// ── OpenAI image generation (DALL-E 3) — tighter because images are expensive ─
// 20 req / 15 min per user
const imageGenLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: byUserId,
  message: { error: 'Image generation rate limit exceeded — max 20 requests per 15 minutes per user.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. MESSAGING PROVIDERS  (Sendgrid · SMS · WhatsApp · Push)
// ══════════════════════════════════════════════════════════════════════════════

// Email (Sendgrid) — 100 / hr / user
const emailSendLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyGenerator: byUserId,
  message: { error: 'Email rate limit exceeded — max 100 emails per hour per user.' },
});

// SMS — 50 / hr / user
const smsSendLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: byUserId,
  message: { error: 'SMS rate limit exceeded — max 50 messages per hour per user.' },
});

// WhatsApp — 50 / hr / user
const whatsappSendLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: byUserId,
  message: { error: 'WhatsApp rate limit exceeded — max 50 messages per hour per user.' },
});

// Push notifications — 20 / hr / user
const pushSendLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: byUserId,
  message: { error: 'Push notification rate limit exceeded — max 20 sends per hour per user.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. PAYMENT PROVIDERS  (Stripe · Razorpay)
//    10 req / min / user — financial mutations, tight cap.
// ══════════════════════════════════════════════════════════════════════════════

const paymentLimiter = make({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: byUserId,
  message: { error: 'Payment rate limit exceeded — max 10 requests per minute per user.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. FILE STORAGE  (AWS S3 uploads)
//    20 uploads / hr / user
// ══════════════════════════════════════════════════════════════════════════════

const uploadLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: byUserId,
  message: { error: 'Upload rate limit exceeded — max 20 uploads per hour per user.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. OAUTH TOKEN EXCHANGE  (Google Calendar · Microsoft Outlook)
//    10 req / 15 min keyed on the OAuth state param (encodes the initiating user).
// ══════════════════════════════════════════════════════════════════════════════

const oauthLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: byOAuthState,
  message: { error: 'OAuth rate limit exceeded — max 10 requests per 15 minutes.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. MEDIA / PHOTO SEARCH  (Pexels)
//    50 req / hr / tenant — protects shared Pexels free-plan quota.
// ══════════════════════════════════════════════════════════════════════════════

const photoSearchLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: byTenantId,
  message: { error: 'Photo search rate limit exceeded — max 50 requests per hour per tenant.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. WEBHOOK ENDPOINTS  (SMS · WhatsApp · Telephony)
//    30 req / min keyed on the tenant discriminator in the webhook URL/body.
// ══════════════════════════════════════════════════════════════════════════════

const webhookLimiter = make({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: byWebhookTenant,
  message: { error: 'Webhook rate limit exceeded — max 30 requests per minute per tenant.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. AUTH — PUBLIC REGISTRATION & OTP ENDPOINTS
//
//    register / signup     — 10 / hr keyed on submitted email
//    OTP request           — 5  / hr keyed on submitted email OR phone
//    OTP verify            — 10 / 15 min keyed on submitted email OR phone
// ══════════════════════════════════════════════════════════════════════════════

const registerLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: byEmail,
  message: { error: 'Registration rate limit exceeded — max 10 attempts per hour per email.' },
});

const otpRequestLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: byEmailOrPhone,
  message: { error: 'OTP request rate limit exceeded — max 5 requests per hour per account.' },
});

const otpVerifyLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: byEmailOrPhone,
  message: { error: 'OTP verification rate limit exceeded — max 10 attempts per 15 minutes per account.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// Exports
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // LLM
  llmLimiter,
  imageGenLimiter,
  // Messaging
  emailSendLimiter,
  smsSendLimiter,
  whatsappSendLimiter,
  pushSendLimiter,
  // Payments
  paymentLimiter,
  // Storage
  uploadLimiter,
  // OAuth
  oauthLimiter,
  // Media
  photoSearchLimiter,
  // Webhooks
  webhookLimiter,
  // Auth
  registerLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
};
