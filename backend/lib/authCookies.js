/**
 * backend/lib/authCookies.js
 * ──────────────────────────
 * Canonical wrapper around `res.cookie()` for the auth-token cookie.
 *
 * SLICE 1 of GH #914 (Travel Security — JWT/localStorage hardening).
 *
 * What this module does:
 *   - Centralises the cookie name + the cookie option shape used by every
 *     auth-success path (login, signup, register, 2fa-verify).
 *   - Forces httpOnly + sameSite=strict + path=/api so the cookie is NOT
 *     reachable from JS and ONLY rides on /api/* requests.
 *   - Secure flag is conditional on NODE_ENV=production so local dev over
 *     plain HTTP still works (the demo + prod box runs HTTPS via certbot
 *     + Nginx so the production branch is what crm.globusdemos.com sees).
 *   - 15-minute default maxAge: short enough that a stolen cookie has a
 *     small replay window; slice 2+ will pair this with a refresh-token
 *     flow so the SPA can transparently re-mint without forcing re-login.
 *
 * What this module is NOT doing yet (later slices):
 *   - The middleware (backend/middleware/auth.js) does NOT yet read this
 *     cookie. JWT is still consumed from the Authorization header. Slice 2
 *     wires cookie-read into verifyToken.
 *   - The frontend does NOT yet drop localStorage. Token is still also
 *     returned in the response body. Slice 3+ migrates the SPA.
 *   - No CSRF token is issued yet. Slice 4 layers in double-submit CSRF
 *     defense once the cookie is the primary credential.
 *
 * Why this is safe to ship in isolation: setting a cookie that nothing
 * reads is a no-op for every existing consumer. The header-based flow
 * works unchanged. This passes the cross-cutting-shape-change guard
 * because there are zero behavioural changes — only an additive
 * Set-Cookie response header on auth-success paths.
 */

const TOKEN_COOKIE = "auth_token";

/**
 * Write the auth-token cookie onto an Express Response.
 *
 * @param {import('express').Response} res
 * @param {string} token            — the signed JWT to ride in the cookie
 * @param {object} [opts]
 * @param {number} [opts.maxAgeSec=900] — cookie lifetime in seconds.
 *        Default 15 minutes. Short on purpose; slice 2 will pair this
 *        with refresh-token rotation. NOTE: the response body's JWT
 *        still carries its existing 7-day expiry — these two TTLs are
 *        intentionally divergent during the migration window.
 */
function setAuthCookie(res, token, { maxAgeSec = 60 * 15 } = {}) {
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
    maxAge: maxAgeSec * 1000,
  });
}

/**
 * Clear the auth-token cookie. Path MUST match setAuthCookie's path so the
 * browser actually drops the right cookie (a cookie set on /api cannot be
 * cleared by a clearCookie with path=/, RFC 6265 §4.1.2). Used by /logout.
 *
 * @param {import('express').Response} res
 */
function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE, { path: "/api" });
}

module.exports = { TOKEN_COOKIE, setAuthCookie, clearAuthCookie };
