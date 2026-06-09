/**
 * backend/lib/quoteShareToken.js — TravelQuote customer-share JWT helper (C9).
 *
 * PRD_TRAVEL_QUOTE_BUILDER §3.7 — customer-accept landing.
 *
 * Mints + verifies short-lived JWTs that authorize a customer (anonymous,
 * no-auth visitor) to view a single travel quote and submit one of three
 * customer-side decisions (accept / reject / counter) via the public
 * landing page at /p/quote/:shareToken.
 *
 * Why a dedicated JWT helper (vs reusing middleware/auth.js):
 *   - Different secret allowed (`QUOTE_SHARE_JWT_SECRET`) — rotating the
 *     general JWT_SECRET shouldn't force every outstanding share link to
 *     break; conversely, leaking a share link shouldn't grant any other
 *     surface.
 *   - Purpose-bound: payload carries `purpose: 'travel-quote-share'` and
 *     verify() rejects any other purpose with INVALID_PURPOSE. Prevents
 *     replay of (say) a Voyagr API key JWT into the quote endpoint.
 *   - TTL knob lives at mint-time, not config — different sub-brands
 *     might want different link lifetimes (TMC ~14 days, RFU ~7 days);
 *     operator UI passes expiresInDays explicitly.
 *
 * Secret fallback chain:
 *   QUOTE_SHARE_JWT_SECRET → JWT_SECRET → 'dev-quote-share-secret'
 *   The last is for unit-test convenience ONLY. Production deploys MUST
 *   set QUOTE_SHARE_JWT_SECRET; the dev fallback guarantees vitest /
 *   local-stack iteration doesn't crash on missing env.
 *
 * Hard contract (tests pin every assertion):
 *   1. mint → verify round-trip preserves { quoteId, tenantId }.
 *   2. Expired tokens throw (jsonwebtoken's TokenExpiredError).
 *   3. Tampered tokens throw (jsonwebtoken's JsonWebTokenError).
 *   4. Wrong-purpose tokens throw INVALID_PURPOSE.
 *   5. Default TTL is 30 days.
 *   6. Custom TTL is honored.
 *   7. Deterministic for identical inputs + identical JWT_SECRET (jsonwebtoken
 *      omits jti by default, so HS256 + same payload + same iat → same sig).
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET =
  process.env.QUOTE_SHARE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-quote-share-secret';

const PURPOSE = 'travel-quote-share';
const DEFAULT_EXPIRES_IN_DAYS = 30;

/**
 * Mint a quote-share JWT.
 *
 * @param {Object} opts
 * @param {number} opts.quoteId       TravelQuote.id the token authorizes.
 * @param {number} opts.tenantId      TravelQuote.tenantId for scope guard.
 * @param {number} [opts.expiresInDays=30]  TTL in days. Clamped to >=1.
 * @returns {string} signed JWT.
 *
 * Throws if quoteId / tenantId aren't finite numbers — defense against
 * an operator route accidentally passing string ids that would mint a
 * token that fails the integer-coerce branch at verify-time.
 */
function mintShareToken({ quoteId, tenantId, expiresInDays = DEFAULT_EXPIRES_IN_DAYS } = {}) {
  if (!Number.isFinite(quoteId)) {
    throw new Error('quoteId must be a number');
  }
  if (!Number.isFinite(tenantId)) {
    throw new Error('tenantId must be a number');
  }
  const days = Math.max(1, Number.isFinite(expiresInDays) ? expiresInDays : DEFAULT_EXPIRES_IN_DAYS);
  return jwt.sign(
    { quoteId, tenantId, purpose: PURPOSE },
    JWT_SECRET,
    { expiresIn: `${days}d` },
  );
}

/**
 * Verify a quote-share JWT.
 *
 * @param {string} token
 * @returns {{ quoteId: number, tenantId: number }}
 *
 * Throws:
 *   - TokenExpiredError when validUntil < now.
 *   - JsonWebTokenError on tampered / malformed token.
 *   - Error('INVALID_PURPOSE') when purpose !== 'travel-quote-share'.
 *   - Error('INVALID_PAYLOAD') when quoteId / tenantId missing or non-numeric.
 *
 * Route handlers catch on Error.name and map to HTTP envelope:
 *   - TokenExpiredError → 410 GONE (link expired)
 *   - JsonWebTokenError → 401 INVALID_TOKEN
 *   - INVALID_PURPOSE / INVALID_PAYLOAD → 401 INVALID_TOKEN
 */
function verifyShareToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.purpose !== PURPOSE) {
    const err = new Error('INVALID_PURPOSE');
    err.code = 'INVALID_PURPOSE';
    throw err;
  }
  if (!Number.isFinite(payload.quoteId) || !Number.isFinite(payload.tenantId)) {
    const err = new Error('INVALID_PAYLOAD');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  return { quoteId: payload.quoteId, tenantId: payload.tenantId };
}

module.exports = {
  mintShareToken,
  verifyShareToken,
  // exported for test introspection — not part of the public API
  _internal: { PURPOSE, DEFAULT_EXPIRES_IN_DAYS },
};
