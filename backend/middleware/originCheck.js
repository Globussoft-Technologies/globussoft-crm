// #657 — CSRF defense layer for state-changing browser flows.
//
// ARCHITECTURE REVIEW (why this isn't csurf):
// ───────────────────────────────────────────
// The CRM uses JWT-bearer-Authorization-header auth, not cookies. Tokens
// live in sessionStorage on the SPA and are attached as `Authorization:
// Bearer <jwt>` by frontend/src/utils/api.js. Browsers do NOT auto-attach
// `Authorization` headers to cross-origin requests the way they do with
// cookies — which means the *classic* CSRF surface (a forged form-POST
// from evil.com inheriting the user's session cookie) does not apply.
//
// Verified at landing of #657:
//   $ grep -rn "res\.cookie(" backend/routes/ backend/middleware/  →  ZERO HITS
//   $ grep -rn "req\.cookies"  backend/routes/ backend/middleware/  →  ZERO HITS
//
// Wiring csurf into a pipeline that has no authenticated cookies would add
// developer friction (every form-POST needs a token round-trip) without
// closing a real attack surface. csurf stays in package.json as a defense
// option for the future cookie-auth migration tracked in TODOS.md — but
// is NOT wired today.
//
// WHAT THIS MIDDLEWARE DOES INSTEAD:
// ──────────────────────────────────
// Defense-in-depth for state-changing browser POSTs (POST/PUT/PATCH/DELETE):
// the request's Origin OR Referer header must be in the CORS allowlist when
// either header is present. Non-browser clients (curl, server-to-server,
// Postman, the External Partner API) typically omit BOTH headers, so they
// pass through unchanged — preserving the existing API-consumer contract.
//
// Threat model this closes:
//   - An attacker who has stolen a JWT (via XSS or a logged terminal) AND
//     embeds the token in a browser-side fetch from evil.com. Without this
//     middleware, the bearer auth succeeds. With it, the Origin: evil.com
//     header trips the 403.
//   - Per-tenant subdomain mis-pointing where a stale DNS record routes
//     forms to the wrong tenant — Origin allowlist refuses unknown subdomains.
//
// Threat model this does NOT close (out of scope, tracked separately):
//   - XSS-stolen token used by curl with no Origin/Referer set → out of band
//     (covered by sessionStorage migration #343 + CSP work #654 + token TTL).
//   - Server-to-server API abuse with valid Authorization header → out of band
//     (covered by /v1/external API-key scoping + rate limiting).
//
// IMPLEMENTATION NOTES:
// ─────────────────────
// - Idempotent verbs (GET/HEAD/OPTIONS) skip the check — they have no body and
//   can't mutate state. OPTIONS in particular must pass for CORS preflight.
// - When BOTH Origin and Referer are absent, the request is treated as
//   non-browser (curl / native client / server-side) and passes through.
//   This is the load-bearing pragma: server-to-server consumers including
//   the entire External Partner API (/api/v1/external) MUST keep working.
// - When EITHER Origin or Referer is present, it must match the allowlist.
//   This is the browser case: a real browser ALWAYS sets at least one of the
//   two on a cross-origin fetch, so the absence-passes path is not a bypass
//   vector for a real browser-driven attack.
// - The allowlist is built from the same env-driven list as CORS so they
//   can't drift. Adding an origin to CORS_ALLOWED_ORIGINS extends both.
//
// COOKIE FLAG DISCIPLINE:
// ───────────────────────
// `secureCookie()` is a tiny helper for the future. Today zero routes call
// res.cookie(), but when one is added (portal session, OAuth state cookie,
// SSO nonce) it MUST go through this helper so the HttpOnly/Secure/SameSite
// defaults are inherited automatically. The csrf-defense-api.spec.js spec
// includes a "no res.cookie() calls outside this helper" grep check that
// runs as a structural assertion.

const URL_TOKEN_RE = /^https?:\/\/[^/]+/i;

/**
 * Build the allowlist of origins permitted to make state-changing requests.
 * Mirrors the CORS allowlist build in server.js — same env vars, same fail-safes.
 * Exported so tests can introspect it; route code never calls this directly.
 */
function buildAllowlist() {
  const defaults = [
    "https://crm.globusdemos.com",
    "http://localhost:5173",
    "http://localhost:5000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5000",
    "https://globuscrm.globussoft.com",
  ];
  const envOne = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [];
  const envMany = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return Array.from(new Set([...defaults, ...envOne, ...envMany]));
}

/**
 * Extract the scheme+host (no path, no querystring) from a URL string.
 * Returns null for malformed input — callers treat null as "no origin claim".
 */
function originOf(urlString) {
  if (!urlString || typeof urlString !== "string") return null;
  const m = urlString.match(URL_TOKEN_RE);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Middleware: reject state-changing browser POSTs whose Origin/Referer header
 * is outside the CORS allowlist. Non-browser callers (no Origin AND no
 * Referer) pass through. GET/HEAD/OPTIONS always pass through.
 *
 * Mounted EARLY in server.js — before route handlers — so a 403 short-circuits
 * the entire pipeline. Order: helmet → cors → originCheck → auth.
 */
function originCheck(req, res, next) {
  // Idempotent verbs cannot mutate state — let them through unconditionally.
  // OPTIONS in particular must pass for CORS preflight.
  const method = (req.method || "").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  // Public-internet POST endpoints that accept calls from third parties
  // (Twilio, Mailgun, Razorpay, marketplace lead vendors, SSO providers,
  // External Partner API, public booking + portal). These callers do not
  // set Origin/Referer to anything we can allowlist, and they authenticate
  // via signature / HMAC / API-key / OTP instead. Mirrors the same path
  // set as the global auth guard's `openPaths` in server.js.
  const fullPath = req.path || req.originalUrl || "";
  // Normalise to the path the auth guard sees (no querystring, no mount
  // prefix difference — top-level mount means req.path is the full URL path).
  const PUBLIC_PATH_PREFIXES = [
    "/api/auth/login",
    "/api/auth/signup",
    "/api/auth/register",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/2fa/verify",
    "/api/health",
    "/health",
    "/api/marketplace-leads/webhook",
    "/api/sms/webhook",
    "/api/whatsapp/webhook",
    "/api/telephony/webhook",
    "/api/push/subscribe/visitor",
    "/api/push/vapid-key",
    "/api/communications/track/",
    "/api/sso/google/callback",
    "/api/sso/microsoft/callback",
    "/api/sso/google/start",
    "/api/sso/microsoft/start",
    "/api/email/inbound",
    "/api/calendar/google/callback",
    "/api/calendar/outlook/callback",
    "/api/voice/webhook",
    "/api/portal/login",
    "/api/portal/forgot",
    "/api/portal/reset",
    "/api/signatures/sign",
    "/api/surveys/respond",
    "/api/surveys/public",
    "/api/chatbots/chat",
    "/api/web-visitors/track",
    "/api/payments/webhook",
    "/api/accounting/webhook",
    "/api/scim/v2",
    "/api/booking-pages/public",
    "/api/knowledge-base/public",
    "/api/live-chat/visitor",
    "/api/document-views/track",
    "/api/zapier/webhook",
    "/api/marketing/submit",
    "/api/v1/external",
    "/api/wellness/public",
    "/api/wellness/portal",
    "/api/attendance/biometric/webhook",
    "/api/travel/itineraries/public/",
    "/p/itinerary",
    "/p/payment",
  ];
  if (PUBLIC_PATH_PREFIXES.some((p) => fullPath.startsWith(p))) {
    return next();
  }

  const originHeader = req.headers["origin"];
  const refererHeader = req.headers["referer"] || req.headers["referrer"];

  // No Origin AND no Referer — non-browser caller (curl, Postman, server-to-
  // server, native mobile client). Bearer auth still gates the request via
  // verifyToken. Pass through.
  if (!originHeader && !refererHeader) {
    return next();
  }

  const allowlist = buildAllowlist();
  const allowedSet = new Set(allowlist.map((s) => s.toLowerCase()));

  // Origin is more reliable than Referer (Referer-Policy strips it; Origin
  // is unconditional on POST). Check Origin first if present; only fall back
  // to Referer when Origin is missing.
  const claimedOrigin = originHeader
    ? originHeader.toLowerCase()
    : originOf(refererHeader);

  if (!claimedOrigin) {
    // Header was present but unparseable — treat as suspicious browser caller.
    return res.status(403).json({
      error: "Request origin could not be verified",
      code: "INVALID_ORIGIN",
    });
  }

  if (!allowedSet.has(claimedOrigin)) {
    return res.status(403).json({
      error: "Request origin not in allowlist",
      code: "ORIGIN_NOT_ALLOWED",
    });
  }

  return next();
}

// ──────────────────────────────────────────────────────────────────────────
// Secure-cookie default helper.
//
// Wraps res.cookie() so any future caller inherits HttpOnly + Secure (prod
// only) + SameSite=Lax flags automatically. Today no caller exists; this is
// preventive scaffolding for the next cookie-auth route that lands (portal
// session, SSO state, OAuth nonce).
//
// USAGE:
//   const { setSecureCookie } = require('../middleware/originCheck');
//   setSecureCookie(res, 'portal_session', token, { maxAge: 7 * 24 * 3600_000 });
//
// Caller-supplied options OVERRIDE the secure defaults — but only on purpose
// (e.g. a public booking cookie that legitimately needs SameSite=None for
// embed iframes). The default path keeps the secure flags.
// ──────────────────────────────────────────────────────────────────────────
function setSecureCookie(res, name, value, options = {}) {
  const secureDefaults = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
  return res.cookie(name, value, { ...secureDefaults, ...options });
}

module.exports = {
  originCheck,
  setSecureCookie,
  buildAllowlist,
  originOf,
};
