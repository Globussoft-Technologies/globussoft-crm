// @ts-check
/**
 * Security headers gate (G-25 from docs/E2E_GAPS.md)
 *
 * Pins the Helmet/CSP regression surface. The Helmet config in
 * backend/middleware/security.js is the only thing standing between a
 * misclick on "defaults" (or a sleepy Dependabot major-version bump) and
 * a prod deploy that drops HSTS, leaks `X-Powered-By: Express`, or
 * silently re-enables CSP in a way that breaks the embed widget.
 *
 * What this spec asserts:
 *
 *   1. The "core six" headers helmet must emit on EVERY response:
 *        x-content-type-options:        nosniff
 *        x-frame-options:               SAMEORIGIN  (per security.js xFrameOptions config)
 *        referrer-policy:               strict-origin-when-cross-origin
 *        strict-transport-security:     max-age=31536000; includeSubDomains
 *        permissions-policy:            camera=(), microphone=(), geolocation=(self), interest-cohort=()
 *        cross-origin-resource-policy:  cross-origin     (embed-widget contract — #342 fix)
 *
 *   2. `x-powered-by` is REMOVED. Helmet's hidePoweredBy default strips
 *      Express's default-on `X-Powered-By: Express` fingerprint. A future
 *      misconfiguration that re-enables it (e.g. removing helmetMiddleware
 *      from server.js) trips this assertion.
 *
 *   3. `content-security-policy` is now PRESENT as a TRANSITIONAL CSP
 *      (#654 / 2026-05): backend/middleware/security.js was flipped from
 *      `contentSecurityPolicy: false` to a real directive list that
 *      includes `'unsafe-inline'` on script-src and style-src (legacy
 *      inline event handlers + Vite/React inline styles can't be
 *      eliminated without a build-step change — tracked as a follow-up).
 *      The pinned shape below documents the directive list shipped in
 *      that PR. Tightening to nonces is filed as a separate follow-up
 *      issue. CSP-Report-Only stays ABSENT (we don't ship a separate
 *      report-only header today).
 *
 *   4. Headers are served on BOTH the API root `GET /api/health` AND the
 *      auth gate `POST /api/auth/login` (even on the 401 wrong-password
 *      response). Helmet runs globally via `app.use(...)` in server.js,
 *      so any Express-served path carries the same set. Note: the bare
 *      `GET /` is intentionally NOT probed — on the deployed demo it's
 *      served by Nginx as a static SPA shell and never reaches Express,
 *      so a Helmet check there would assert the wrong contract. See the
 *      PROBE_ROUTES comment below.
 *
 *   5. Snapshot-style toMatchObject assertion captures the FULL current
 *      header set. Adding a new header (e.g. Permissions-Policy gaining a
 *      directive, COOP changing) is fine — the snapshot is intentionally
 *      partial via toMatchObject. REMOVING any of the snapshotted headers
 *      will trip the gate and force a deliberate review.
 *
 * Environment behaviour:
 *
 *   BASE_URL=https://crm.globusdemos.com  (deploy/release validation)
 *     — All assertions enforced including HSTS.
 *
 *   BASE_URL=http://127.0.0.1:5000        (api_tests / coverage CI)
 *     — Helmet 8 emits HSTS regardless of TLS termination (it's the
 *       response that carries the header; the browser decides whether to
 *       honor it). So HSTS is asserted unconditionally — the contract is
 *       "the header is present", not "TLS is in use".
 *
 *   No login required, no fixture cleanup needed. Pure-headers assertions.
 *
 * Revert-and-prove drill:
 *   1. Comment out `app.use(helmetMiddleware)` in backend/server.js → 6
 *      header assertions go red on a re-run.
 *   2. Add `app.enable('x-powered-by')` in server.js → the x-powered-by
 *      assertion goes red.
 *   3. Set `contentSecurityPolicy: false` in security.js → the CSP-present
 *      assertion goes red.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

// The six headers we lock in. Lowercase keys per the Node http module's
// header normalisation. Values are the EXACT strings the current
// security.js config + helmet 8.x defaults emit (verified by booting the
// real middleware and probing the response on 2026-05-03).
const PINNED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-resource-policy': 'cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(self), interest-cohort=()',
};

// Routes that should carry the full helmet header set. Both are unauthenticated
// and cheap; both go through the global helmet + permissions-policy middleware
// chain in server.js.
//
// Why NOT bare `GET /`? On the deployed demo (crm.globusdemos.com), `/` is
// served by Nginx as a static SPA index.html under /var/www and never reaches
// Express, so Helmet's middleware doesn't run for it (Cloudflare + Nginx
// emit their own headers — `server: cloudflare`, no Permissions-Policy, no
// X-Frame-Options at the Express layer). On the local CI backend it DOES hit
// Express because there's no Nginx in front. To keep the spec passing in both
// environments we probe only Express-served routes: `/api/health` (always
// Express, always 200) and `/api/auth/login` (Express, returns 401 with full
// helmet header set still attached).
const PROBE_ROUTES = ['/api/health', '/api/auth/login'];

test.describe('Security headers gate (G-25) — Helmet/CSP regression detection', () => {
  for (const path of PROBE_ROUTES) {
    test(`${path} carries the pinned helmet header set`, async ({ request }) => {
      // /auth/login needs a POST + body to exercise the route; the global
      // helmet middleware runs before the rate-limiter and route handler,
      // so headers are present on the 401 response too.
      const res = path === '/api/auth/login'
        ? await request.post(`${BASE_URL}${path}`, {
            data: { email: `security-headers-probe-${Date.now()}@example.test`, password: 'wrong' },
            headers: { 'Content-Type': 'application/json' },
            timeout: REQUEST_TIMEOUT,
          })
        : await request.get(`${BASE_URL}${path}`, { timeout: REQUEST_TIMEOUT });
      // We don't assert the status — helmet runs before any route logic
      // so headers are present whether the response is 200/401/429/500.
      // The /api/health endpoint may be 'degraded' if MySQL is
      // unreachable on a CI shutdown teardown; it still returns 200 and
      // still has the helmet headers from the global middleware chain.
      // /api/auth/login may 401 (wrong password), 429 (rate limit if the
      // IP burned its budget on a prior run), or 500 (DB unreachable on
      // a sandboxed CI). Headers attach in every case because helmet is
      // wired BEFORE the rate-limiter and route handler.
      expect(res.status(), `${path} should return any response`).toBeGreaterThan(0);

      const headers = res.headers();

      // 1. Pinned exact-match headers (the regression-detection core).
      // Use toMatchObject so future ADDITIONS to the header set don't
      // break us — only REMOVALS or value changes.
      expect(headers).toMatchObject(PINNED_HEADERS);

      // 2. HSTS — helmet 8 emits unconditionally at the response level.
      // We assert presence + max-age >= 1 year (31536000s). includeSubDomains
      // is part of the configured policy.
      const hsts = headers['strict-transport-security'];
      expect(hsts, `${path} HSTS missing — helmetMiddleware regressed?`).toBeTruthy();
      expect(hsts).toMatch(/max-age=(\d+)/);
      const maxAgeMatch = hsts.match(/max-age=(\d+)/);
      const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
      expect(maxAge, `${path} HSTS max-age=${maxAge} below 1 year minimum`).toBeGreaterThanOrEqual(31536000);
      expect(hsts).toMatch(/includeSubDomains/i);

      // 3. X-Powered-By must be ABSENT (helmet's hidePoweredBy default).
      // Express otherwise leaks "Express" as an attack-surface fingerprint.
      // Playwright's res.headers() returns missing headers as undefined.
      expect(
        headers['x-powered-by'],
        'X-Powered-By header leaked — helmet hidePoweredBy regressed (security.js)'
      ).toBeUndefined();

      // 4. CSP must be PRESENT (#654 transitional CSP). The directive list
      // is asserted in the snapshot test below; here we just confirm the
      // header is emitted at all. CSP-Report-Only stays ABSENT because we
      // don't ship a parallel report-only header today.
      expect(
        headers['content-security-policy'],
        'CSP missing — #654 transitional CSP regressed (security.js contentSecurityPolicy turned back off?)'
      ).toBeTruthy();
      expect(
        headers['content-security-policy-report-only'],
        'CSP-Report-Only unexpectedly enabled — was the helmet config silently changed?'
      ).toBeUndefined();
    });
  }

  // 5. Snapshot-style assertion against /api/health: capture EVERY
  // helmet-managed header at the value the current config emits. Adding a
  // new header (helmet 9.x ships X-Future-Header) is fine — toMatchObject
  // is partial. Removing or value-changing any of these is the regression
  // signal we want to detect.
  test('GET /api/health snapshot of full helmet header surface', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    const headers = res.headers();

    // Full snapshot: every helmet-emitted header value pinned at the
    // 2026-05-03 contract. Sourced by booting middleware/security.js
    // standalone and probing the response. If a deliberate config change
    // updates one of these, the developer making the change updates the
    // expected value here in the same PR — the gate enforces the audit
    // trail.
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cross-origin-resource-policy': 'cross-origin',
      'cross-origin-opener-policy': 'same-origin',
      'origin-agent-cluster': '?1',
      'x-dns-prefetch-control': 'off',
      'x-download-options': 'noopen',
      'x-permitted-cross-domain-policies': 'none',
      'x-xss-protection': '0',
      'permissions-policy':
        'camera=(), microphone=(), geolocation=(self), interest-cohort=()',
    });

    // HSTS asserted separately (regex match, not exact equality, because
    // the value is a single string with two semicolon-separated tokens
    // and we want the test to pass regardless of token ordering helmet
    // chooses).
    expect(headers['strict-transport-security']).toMatch(
      /max-age=31536000.*includeSubDomains|includeSubDomains.*max-age=31536000/
    );

    // #654 — CSP is now PRESENT. The directive list is asserted by the
    // dedicated csp-stepup-api.spec.js (which exercises each load-bearing
    // directive — default-src, object-src, frame-ancestors, form-action,
    // base-uri). Here we just confirm presence + that the load-bearing
    // anchors of the transitional config (default-src 'self' and
    // object-src 'none') appear in the header value.
    const csp = headers['content-security-policy'];
    expect(csp, 'CSP missing — #654 transitional CSP regressed').toBeTruthy();
    expect(csp.toLowerCase()).toContain("default-src 'self'");
    expect(csp.toLowerCase()).toContain("object-src 'none'");

    // Negatives — these should NOT be in the snapshot.
    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers['content-security-policy-report-only']).toBeUndefined();
  });
});
