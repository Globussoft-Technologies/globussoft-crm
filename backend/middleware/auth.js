const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

// JWT_SECRET resolution + the dev-fallback warning are centralized in
// config/secrets.js (P1.3 — was duplicated across 6 files).
const { JWT_SECRET } = require("../config/secrets");
// #914 slice 2: cookie name comes from the same helper that SETS the
// cookie on auth-success paths (slice 1). Single-source the name so a
// future rename can't desync read+write sites.
const { TOKEN_COOKIE } = require("../lib/authCookies");

// #537 (PT-05): RFC 7235 semantics — missing/invalid credentials are 401
// (not 403). 403 is reserved for "authenticated but not allowed". Also
// emit the standard WWW-Authenticate response header on every 401 so
// SDKs / SPAs can auto-trigger their token-refresh flow correctly.
// #922 — drop the realm="api" diagnostic qualifier; SDKs auto-refresh
// triggers off the scheme name alone, and the qualifier just gives passive
// scanners free signal about the auth scheme + naming.
const WWW_AUTH = "Bearer";
function unauthorized(res, error) {
  res.set("WWW-Authenticate", WWW_AUTH);
  return res.status(401).json({ error });
}

const verifyToken = async (req, res, next) => {
  // #914 slice 2: cookie-first, header-fallback. Slice 1 began sending
  // an HttpOnly `auth_token` cookie alongside the response-body JWT on
  // every auth-success path; this is the corresponding READ side. Both
  // paths remain valid for the duration of the migration window so
  // existing header-bearing consumers (frontend's localStorage today,
  // every e2e spec, every Playwright API spec, the external API key
  // mirror, SDK consumers) keep working unchanged. Slice 3 drops the
  // SPA's localStorage; slice 4 layers a CSRF token on top of the
  // cookie. Order matters: cookie wins so a fresh login on a browser
  // that still has a stale localStorage token presents the new
  // (cookie-borne) identity rather than reviving the old one.
  const cookieToken = req.cookies && req.cookies[TOKEN_COOKIE];
  let token;
  if (cookieToken) {
    token = cookieToken;
  } else {
    const authHeader = req.headers.authorization;
    if (!authHeader) return unauthorized(res, "Authentication required");
    token = authHeader.split(" ")[1];
  }
  try {
    const verified = jwt.verify(token, JWT_SECRET);

    // Block portal (patient) tokens from reaching staff endpoints.
    // Portal tokens carry `patientId` instead of `userId` — they must not
    // be accepted by this middleware even if signed with the same secret.
    // Guard both ways: presence of patientId, AND absence of userId.
    if (verified.patientId || !verified.userId) {
      return unauthorized(res, "Invalid staff token (portal tokens are not allowed here)");
    }

    // Backwards compat: tokens issued before multi-tenancy lack tenantId — default to 1 (Default Org)
    if (verified.tenantId === undefined || verified.tenantId === null) {
      verified.tenantId = 1;
    }
    // Block awaiting2FA temp tokens from accessing protected resources
    if (verified.awaiting2FA === true) {
      return unauthorized(res, "Two-factor authentication required. Complete 2FA verification first.");
    }

    // Issue #180: token revocation. Tokens issued after this change carry a `jti`
    // claim. If the jti has been added to RevokedToken (logout, admin revoke,
    // password change), reject the request even though the JWT is still
    // cryptographically valid. Old tokens minted before the change have no jti
    // and stay valid until their natural 7-day expiry — no forced re-login.
    // No caching: a stale cache is a security hole.
    if (verified.jti) {
      try {
        const revoked = await prisma.revokedToken.findUnique({
          where: { jti: verified.jti },
          select: { id: true },
        });
        if (revoked) {
          return unauthorized(res, "Session revoked. Please log in again.");
        }
      } catch (dbErr) {
        // If the lookup fails (DB blip, table not yet migrated), fail open so
        // we don't lock everyone out. This still hardens the common case.
        console.error("[auth] revoked-token lookup failed:", dbErr && dbErr.message);
      }
    }

    // #555 (HI-06): explicit tenant switching via X-Active-Tenant header.
    // Today every user belongs to exactly one tenant (User.tenantId is an
    // Int, no UserTenant join table) so the only legal value is the JWT's
    // own tenantId — a no-op affirmation that lets the SPA's tenant
    // switcher round-trip without breaking. Cross-tenant values are
    // silently ignored (no error: a stale localStorage value from a
    // previous session shouldn't 401 the user). When a UserTenant join
    // table lands, this guard widens to "header value must be in the
    // user's accessible-tenants set."
    const activeTenantHeader = req.headers["x-active-tenant"];
    if (activeTenantHeader) {
      const requested = parseInt(activeTenantHeader, 10);
      if (Number.isFinite(requested) && requested === verified.tenantId) {
        verified.activeTenantId = requested;
      }
    }

    req.user = verified;
    next();
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return unauthorized(res, "Session expired, please log in again");
    }
    return unauthorized(res, "Invalid Authentication Token");
  }
};

// #590 / #591: canonical RBAC denial envelope.
//
// Pre-fix, three different denial strings shipped depending on which
// middleware/route fired:
//   - "Insufficient Role Permissions. System Admin Required." (verifyRole)
//   - "Insufficient wellness role"                            (verifyWellnessRole)
//   - "Failed to save"                                        (frontend swallow-and-relabel)
//
// Two problems with that:
//   (a) inconsistent UX — same class of denial, three different strings;
//   (b) information disclosure — "System Admin" / "wellness role" leak
//       the internal role taxonomy, which is enumeration-helpful for
//       social-engineering / JWT-tampering reconnaissance.
//
// Single neutral copy used everywhere now. The stable `code` ("RBAC_DENIED")
// lets the frontend / specs distinguish RBAC from generic 403s without
// pattern-matching the human-facing string.
const RBAC_DENIED_MESSAGE = "You don't have permission to perform this action. Contact your administrator.";
const RBAC_DENIED_CODE = "RBAC_DENIED";

const verifyRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: RBAC_DENIED_MESSAGE,
        code: RBAC_DENIED_CODE,
      });
    }
    next();
  };
};

// #654 — Step-up authentication for destructive admin flows.
//
// THREAT: a session token (legitimate auth) does not prove that the human
// IS PRESENT RIGHT NOW. A 30-minute-old token reused after the user walked
// away from their laptop is enough for an attacker (or curious co-worker)
// to flip GDPR retention policies, rotate provider credentials, or trigger
// destructive operations that the session was never explicitly authorised
// to do.
//
// DESIGN: a short-lived `stepUpToken` JWT (5 min TTL by default) minted by
// POST /api/auth/step-up only after the caller re-presents their password
// (or TOTP if 2FA is enabled). The stepUpToken is supplied to the
// destructive endpoint either as the `x-step-up-token` header or as
// `req.body.stepUpToken`. The middleware below validates it and rejects
// stale / forged tokens with 401 STEP_UP_REQUIRED.
//
// The stepUpToken is BOUND to the user (userId + tenantId in claims) so a
// token minted by one user cannot satisfy another user's step-up gate.
// `kind: 'step-up'` distinguishes it from session tokens at decode time.
//
// REVIEW: a separate STEP_UP_JWT_SECRET could be used to further compartmentalise
// the secret material; today we share JWT_SECRET since the token is short-lived
// and bound to the user. Promote to a separate secret on the next rotation cycle.

function signStepUpToken(payload, ttlSeconds = 300) {
  // payload should contain { userId, tenantId, method } at minimum.
  return jwt.sign(
    { ...payload, kind: 'step-up' },
    JWT_SECRET,
    { expiresIn: ttlSeconds }
  );
}

/**
 * Middleware factory: requires the caller to present a valid stepUpToken
 * matching the current user. Emits 401 STEP_UP_REQUIRED on missing/expired/
 * invalid/wrong-user tokens so the SPA can prompt for re-auth and retry.
 *
 * Must be mounted AFTER verifyToken — relies on req.user being set.
 *
 * @param {object} options
 * @param {number} options.timeoutMs - max age of the step-up token in ms
 *   (default 5 min). Tokens are also bound by the JWT exp claim; this is
 *   a defense-in-depth ceiling.
 */
function requireStepUp(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5 * 60 * 1000;

  return (req, res, next) => {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({
        error: 'Authentication required before step-up check.',
        code: 'STEP_UP_REQUIRED',
      });
    }

    // Accept the token from a dedicated header OR from the body. Header is
    // preferred — keeps the destructive payload clean and survives request
    // logs that scrub body fields.
    const headerToken = req.headers['x-step-up-token'];
    const bodyToken = req.body && req.body.stepUpToken;
    const stepToken = headerToken || bodyToken;

    if (!stepToken) {
      return res.status(401).json({
        error: 'Step-up authentication required. Re-confirm your password or TOTP code.',
        code: 'STEP_UP_REQUIRED',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(stepToken, JWT_SECRET);
    } catch (err) {
      if (err && err.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Step-up confirmation expired. Re-confirm to proceed.',
          code: 'STEP_UP_EXPIRED',
        });
      }
      return res.status(401).json({
        error: 'Invalid step-up token.',
        code: 'STEP_UP_INVALID',
      });
    }

    if (!decoded || decoded.kind !== 'step-up') {
      return res.status(401).json({
        error: 'Token is not a step-up confirmation token.',
        code: 'STEP_UP_INVALID',
      });
    }
    if (decoded.userId !== req.user.userId) {
      return res.status(401).json({
        error: 'Step-up token does not match the current user.',
        code: 'STEP_UP_USER_MISMATCH',
      });
    }
    if (decoded.tenantId !== req.user.tenantId) {
      return res.status(401).json({
        error: 'Step-up token tenant mismatch.',
        code: 'STEP_UP_USER_MISMATCH',
      });
    }

    // Defense-in-depth ceiling on top of JWT exp. `iat` is seconds, Date.now()
    // is ms — normalise.
    if (decoded.iat && timeoutMs > 0) {
      const ageMs = Date.now() - decoded.iat * 1000;
      if (ageMs > timeoutMs) {
        return res.status(401).json({
          error: 'Step-up confirmation expired. Re-confirm to proceed.',
          code: 'STEP_UP_EXPIRED',
        });
      }
    }

    // Make the decoded step-up token available to handlers that want to
    // audit-log the method ("password" vs "totp") that proved presence.
    req.stepUp = {
      method: decoded.method || 'unknown',
      iat: decoded.iat,
      exp: decoded.exp,
    };
    next();
  };
}

module.exports = {
  verifyToken,
  verifyRole,
  // #590 / #591: exported so verifyWellnessRole (and any future RBAC
  // gate) can emit the same canonical denial envelope without
  // re-stating the literal string in two places.
  RBAC_DENIED_MESSAGE,
  RBAC_DENIED_CODE,
  // #654: step-up auth — sign + verify helpers + middleware factory.
  signStepUpToken,
  requireStepUp,
};
