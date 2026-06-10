/**
 * backend/lib/flyerShareToken.js — TravelFlyerTemplate public-share JWT helper
 * (PRD_TRAVEL_MARKETING_FLYER #908 slice S18 — `docs/TRAVEL_BIG_SCOPE_BACKLOG.md`).
 *
 * Per PRD FR-3.5.3 / FR-3.5.4 — mints + verifies short-lived JWTs that
 * authorize an anonymous visitor to render a single flyer template through
 * the public landing page at `/p/flyer/:slug` and the matching embed-iframe
 * surface at `/p/flyer/:slug?embed=1`.
 *
 * Mirrors slice C9's `backend/lib/quoteShareToken.js` — same hard-contract
 * shape, same secret fallback chain — but bound to a different purpose so a
 * leaked quote-share JWT can never be replayed against the flyer surface,
 * and vice versa. Both helpers live independently so the operator surface
 * can rotate one secret without breaking the other.
 *
 * Why a dedicated JWT helper (vs reusing middleware/auth.js):
 *   - Different secret allowed (`FLYER_SHARE_JWT_SECRET`) — rotating the
 *     general JWT_SECRET shouldn't force every outstanding share link to
 *     break; leaking a share link shouldn't grant any other surface.
 *   - Purpose-bound: payload carries `purpose: 'travel-flyer-share'` and
 *     verifyShareToken() rejects any other purpose with INVALID_PURPOSE.
 *     Prevents replay of (say) a quote-share JWT into the flyer endpoint.
 *   - TTL knob lives at mint-time, not config — different sub-brands might
 *     want different link lifetimes (TMC ~7 days for a school-trip flyer,
 *     RFU ~14 days for a season campaign); operator UI passes
 *     expiresInSec explicitly.
 *
 * Secret fallback chain:
 *   FLYER_SHARE_JWT_SECRET → JWT_SECRET → 'dev-flyer-share-secret'
 *   The last is for unit-test convenience ONLY. Production deploys MUST
 *   set FLYER_SHARE_JWT_SECRET; the dev fallback guarantees vitest /
 *   local-stack iteration doesn't crash on missing env.
 *
 * Hard contract (tests pin every assertion):
 *   1. mint → verify round-trip preserves { flyerId, tenantId }.
 *   2. Expired tokens throw (jsonwebtoken's TokenExpiredError).
 *   3. Tampered tokens throw (jsonwebtoken's JsonWebTokenError).
 *   4. Wrong-purpose tokens throw INVALID_PURPOSE.
 *   5. Default TTL is 7 days (FR-3.5.3 — marketing flyers are short-shelf-life).
 *   6. Custom TTL via expiresInSec is honored.
 *   7. Deterministic for identical inputs + identical JWT_SECRET + identical iat.
 */

'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET =
  process.env.FLYER_SHARE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-flyer-share-secret';

const PURPOSE = 'travel-flyer-share';
// PRD FR-3.5.3 — flyer share links default to 7 days. Operator UI can
// override per mint; the 7-day default reflects the typical "send the
// link Monday, receive last-minute bookings by Sunday" marketing cadence.
const DEFAULT_EXPIRES_IN_SEC = 7 * 24 * 60 * 60;

/**
 * Mint a flyer-share JWT.
 *
 * @param {Object} opts
 * @param {number} opts.flyerId         TravelFlyerTemplate.id the token authorizes.
 * @param {number} opts.tenantId        TravelFlyerTemplate.tenantId for scope guard.
 * @param {number} [opts.expiresInSec=604800]  TTL in seconds. Clamped to >=60.
 * @returns {string} signed JWT.
 *
 * Throws if flyerId / tenantId aren't finite numbers — defense against a
 * route accidentally passing string ids that would mint a token that
 * fails the integer-coerce branch at verify-time.
 */
function mintShareToken({ flyerId, tenantId, expiresInSec = DEFAULT_EXPIRES_IN_SEC } = {}) {
  if (!Number.isFinite(flyerId)) {
    throw new Error('flyerId must be a number');
  }
  if (!Number.isFinite(tenantId)) {
    throw new Error('tenantId must be a number');
  }
  // Floor at 60s — anything shorter would be operator error (the link can't
  // be sent + opened within the TTL window).
  const seconds = Math.max(
    60,
    Number.isFinite(expiresInSec) ? Math.floor(expiresInSec) : DEFAULT_EXPIRES_IN_SEC,
  );
  return jwt.sign(
    { flyerId, tenantId, purpose: PURPOSE, aud: 'flyer-share' },
    JWT_SECRET,
    { expiresIn: seconds },
  );
}

/**
 * Verify a flyer-share JWT.
 *
 * @param {string} token
 * @returns {{ flyerId: number, tenantId: number, exp: number }}
 *
 * Throws:
 *   - TokenExpiredError when validUntil < now.
 *   - JsonWebTokenError on tampered / malformed token.
 *   - Error('INVALID_PURPOSE') when purpose !== 'travel-flyer-share'.
 *   - Error('INVALID_PAYLOAD') when flyerId / tenantId missing or non-numeric.
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
  if (!Number.isFinite(payload.flyerId) || !Number.isFinite(payload.tenantId)) {
    const err = new Error('INVALID_PAYLOAD');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  return {
    flyerId: payload.flyerId,
    tenantId: payload.tenantId,
    exp: payload.exp,
  };
}

module.exports = {
  mintShareToken,
  verifyShareToken,
  // exported for test introspection — not part of the public API
  _internal: { PURPOSE, DEFAULT_EXPIRES_IN_SEC },
};
