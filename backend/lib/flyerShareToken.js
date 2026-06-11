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
 *   1. mint → verify round-trip preserves { flyerId, tenantId, jti }.
 *   2. Expired tokens throw (jsonwebtoken's TokenExpiredError).
 *   3. Tampered tokens throw (jsonwebtoken's JsonWebTokenError).
 *   4. Wrong-purpose tokens throw INVALID_PURPOSE.
 *   5. Default TTL is 7 days (FR-3.5.3 — marketing flyers are short-shelf-life).
 *   6. Custom TTL via expiresInSec is honored.
 *   7. Each mint() returns a UNIQUE jti (crypto.randomUUID()).
 *   8. verifyShareToken() rejects tokens whose jti is in RevokedToken table (REVOKED_TOKEN).
 *   9. DB error on revocation check is fail-soft logged (matches middleware/auth.js
 *      Issue #180 canonical pattern — a stale cache / DB blip must not lock out
 *      legitimate viewers; the JWT signature + purpose checks still hold).
 *
 * --- S80 — Token-revocation surface ---
 *
 * Per S18 + S79 carry-over: operators need to be able to invalidate a flyer
 * share link BEFORE its 7-day TTL natural-expiry (premature publish, error in
 * content, customer asks to take it down). The mint side now embeds a jti
 * (UUIDv4) in every JWT; the verify side checks `prisma.revokedToken` for that
 * jti and rejects with REVOKED_TOKEN if present. Pairs with
 * `POST /api/v1/flyers/:id/revoke-share` in routes/travel_flyer_public.js
 * which writes the RevokedToken row.
 *
 * Why fail-soft on DB error (not fail-closed): mirrors middleware/auth.js#L90
 * — locking everyone out on a transient DB blip is worse than letting a
 * not-yet-revoked token through. The signature + purpose + expiry checks
 * still gate access; only the revocation-list lookup degrades gracefully.
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Lazy require for prisma — the helper file is unit-testable without a live
// DB, and the route's test harness monkey-patches `prisma.revokedToken` to
// return null. Lazy require also lets vitest's CJS singleton-patch pattern
// (see backend/test/lib/flyerShareToken.test.js) intercept the call.
function getPrisma() {
  // eslint-disable-next-line global-require
  return require('./prisma');
}

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
  // S80 — every mint carries a unique jti so the operator (or an admin
  // endpoint) can invalidate a specific token before its TTL elapses.
  // crypto.randomUUID() lands a v4 UUID; the underlying RevokedToken table's
  // `jti String @unique` column accepts arbitrary strings so we use the
  // hyphenated form as-is.
  const jti = crypto.randomUUID();
  return jwt.sign(
    { flyerId, tenantId, purpose: PURPOSE, aud: 'flyer-share', jti },
    JWT_SECRET,
    { expiresIn: seconds },
  );
}

/**
 * Verify a flyer-share JWT.
 *
 * Note: ASYNC since S80 — the revocation check requires a DB lookup against
 * `prisma.revokedToken.findUnique({where: {jti}})`. Callers must `await`.
 * Pre-S80 callers passed a sync return through directly; the route layer
 * (routes/travel_flyer_public.js) was updated in lockstep so this change
 * is contained.
 *
 * @param {string} token
 * @returns {Promise<{ flyerId: number, tenantId: number, jti?: string, exp: number }>}
 *
 * Throws:
 *   - TokenExpiredError when validUntil < now.
 *   - JsonWebTokenError on tampered / malformed token.
 *   - Error('INVALID_PURPOSE') when purpose !== 'travel-flyer-share'.
 *   - Error('INVALID_PAYLOAD') when flyerId / tenantId missing or non-numeric.
 *   - Error('REVOKED_TOKEN') when the jti has been added to RevokedToken.
 *
 * Route handlers catch on Error.name + Error.code and map to HTTP envelope:
 *   - TokenExpiredError → 410 GONE (link expired)
 *   - JsonWebTokenError → 401 INVALID_TOKEN
 *   - INVALID_PURPOSE / INVALID_PAYLOAD → 401 INVALID_TOKEN
 *   - REVOKED_TOKEN → 401 INVALID_TOKEN (operator deliberately killed it)
 *
 * DB lookup failure (table missing, connection blip, transient error) is
 * fail-soft: we log + return as-if-not-revoked. The same pattern as
 * middleware/auth.js Issue #180 — locking everyone out on a stale cache or
 * DB blip is worse than the small revocation-list bypass risk, especially
 * since the signature + purpose + expiry checks still gate access.
 */
async function verifyShareToken(token) {
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
  // S80 — revocation list. Tokens minted before S80 lack jti; treat them as
  // not-revokable (legacy fallback — they'll expire naturally within 7 days
  // of mint, matching the original DEFAULT_EXPIRES_IN_SEC window). Tokens
  // minted at or after S80 always carry a jti via mintShareToken above.
  if (payload.jti) {
    try {
      const prisma = getPrisma();
      const revoked = await prisma.revokedToken.findUnique({
        where: { jti: payload.jti },
        select: { id: true },
      });
      if (revoked) {
        const err = new Error('REVOKED_TOKEN');
        err.code = 'REVOKED_TOKEN';
        throw err;
      }
    } catch (dbErr) {
      // Re-throw the REVOKED_TOKEN we minted above; only swallow DB errors.
      if (dbErr && dbErr.code === 'REVOKED_TOKEN') throw dbErr;
      // Fail-soft on DB error — mirrors middleware/auth.js#L90 Issue #180.
      // eslint-disable-next-line no-console
      console.error('[flyerShareToken] revoked-token lookup failed:', dbErr && dbErr.message);
    }
  }
  return {
    flyerId: payload.flyerId,
    tenantId: payload.tenantId,
    jti: payload.jti || null,
    exp: payload.exp,
  };
}

module.exports = {
  mintShareToken,
  verifyShareToken,
  // exported for test introspection — not part of the public API
  _internal: { PURPOSE, DEFAULT_EXPIRES_IN_SEC },
};
