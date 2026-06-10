// #917 slice S1 — Per-request CSP nonce minting.
//
// Why this helper exists
// ----------------------
// The transitional CSP shipped today (middleware/security.js helmetMiddleware)
// allows 'unsafe-inline' on script-src + style-src because the Vite-built SPA
// emits inline scripts (the FOUC-prevention bootstrap in index.html, plus a
// number of legacy React-emitted inline style attributes). 'unsafe-inline'
// defeats one of the strongest XSS mitigations the browser offers — a single
// un-escaped contact / itinerary / supplier description becomes immediate
// account-takeover when combined with the JWT in sessionStorage (#914).
//
// The strict Report-Only CSP (helmetStrictReportOnlyMiddleware) was the first
// step: emit a SECOND header WITHOUT 'unsafe-inline' so browsers log
// violations to devtools / `report-uri` (slice 2b) without blocking. Slice S1
// adds the next ingredient: a per-request cryptographic nonce that the strict
// CSP advertises as `'nonce-<base64>'`. The HTML template echoes the same
// nonce on each `<script>` / `<style>` it ships. Inline scripts/styles
// carrying the matching nonce are allowed; everything else is blocked.
//
// Promotion path (per FR-3.2 + FR-3.7 in PRD_TRAVEL_SECURITY_ARCHITECTURE.md):
//   1. (shipped, slice 1) emit strict Report-Only CSP — observe violations.
//   2. (shipped, slice 2b) wire report-uri to /api/csp/report — persist.
//   3. (this slice, S1)   mint nonce per request + advertise it in the
//                          strict Report-Only CSP. The HTML template gets a
//                          `<meta name="csp-nonce" content="__CSP_NONCE__">`
//                          placeholder; production substitution lives in
//                          the deploy/Nginx layer (deferred follow-up).
//   4. (future)            flip strict CSP from Report-Only to enforce mode
//                          once violation reports are clean — gated on the
//                          CSP_ENFORCE env var.
//
// Contract
// --------
// generateNonce()            -> base64 string from 16 cryptographically-random
//                                bytes (24 chars including padding). Each call
//                                returns a distinct value. Length is fixed so
//                                downstream length-based assertions are stable.
// attachNonce(req, res, next) -> sets `res.locals.cspNonce` to a freshly-minted
//                                nonce. Defensive: if `res.locals` is missing
//                                (a non-Express handler context), it creates
//                                the object before assigning. Always calls
//                                `next()`.
//
// This module is intentionally tiny + side-effect-free so it can be unit-tested
// without mocking Express, and so the CSP middleware can read
// `res.locals.cspNonce` directly from a `function` directive at header-build
// time.

const crypto = require('crypto');

/**
 * Generate a fresh per-request CSP nonce.
 *
 * Uses 16 bytes of `crypto.randomBytes` entropy encoded as base64. 16 bytes
 * (128 bits) is the size CSP3 recommends — large enough that an attacker
 * cannot brute-force a valid nonce within the lifetime of a single response.
 * Base64 encoding yields a fixed 24-character string (including the trailing
 * `==` padding), which is safe to drop directly into a CSP `'nonce-<value>'`
 * source-list entry and into an HTML `nonce="..."` attribute.
 *
 * @returns {string} base64-encoded 16-byte nonce (24 chars)
 */
function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Express middleware: attach a per-request nonce to `res.locals.cspNonce`.
 *
 * Mount BEFORE any helmet/CSP middleware so the CSP function-directives can
 * read `res.locals.cspNonce` at header-build time. Helmet's
 * `contentSecurityPolicy.directives.scriptSrc` accepts function entries of
 * the shape `(req, res) => string` — those functions are invoked per request
 * with access to `res.locals`.
 *
 * Defensive: if `res.locals` is missing (e.g. a test harness or a non-Express
 * caller passes a bare object), this initialises it before assignment so the
 * call doesn't throw. The middleware always calls `next()`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function attachNonce(req, res, next) {
  if (!res.locals) {
    // Defensive: Express always populates res.locals to {}, but a test
    // harness or a non-Express caller might not. Initialise so the
    // assignment below cannot throw.
    res.locals = {};
  }
  res.locals.cspNonce = generateNonce();
  next();
}

module.exports = { generateNonce, attachNonce };
