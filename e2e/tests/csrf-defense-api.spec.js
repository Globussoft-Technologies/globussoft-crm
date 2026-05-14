// @ts-check
/**
 * CSRF defense layer — #657 gate spec.
 *
 * Pre-#657 grep audit found: zero `csurf` wired into the request pipeline,
 * zero `res.cookie()` calls in any backend/routes/ or backend/middleware/
 * file, every authenticated route reads `Authorization: Bearer <jwt>`. The
 * CRM has a JWT-bearer-in-Authorization-header architecture — which means
 * the *classic* CSRF surface (browser auto-attaches session cookie to
 * cross-origin form-POST from evil.com) does NOT exist here.
 *
 * The genuine residual risk is defense-in-depth:
 *   (a) An attacker who has stolen a JWT (via XSS or a logged terminal)
 *       and embeds the token in a browser-side fetch from evil.com. Bearer
 *       auth alone accepts the request. The Origin allowlist rejects it.
 *   (b) A misconfigured DNS subdomain pointing to the wrong tenant — Origin
 *       allowlist refuses unknown subdomains regardless of auth state.
 *   (c) Cookie flag drift on future cookie-auth surfaces (portal session,
 *       OAuth callback nonces) — `setSecureCookie()` helper enforces
 *       HttpOnly + Secure + SameSite=Lax defaults so a future caller can't
 *       accidentally ship an insecure cookie.
 *
 * This spec pins:
 *   1. POST with Origin: evil.com — 403 ORIGIN_NOT_ALLOWED.
 *   2. POST with Origin in the allowlist — auth-handled normally (401
 *      without token, 200/201 with token).
 *   3. POST with NO Origin and NO Referer (curl-style, server-to-server,
 *      Postman, native mobile) — passes through. Auth still gates it.
 *   4. POST with valid Bearer + bad Origin — STILL 403 (so a stolen-token
 *      attacker can't use it from a browser context). This is the
 *      load-bearing test.
 *   5. GET / HEAD / OPTIONS bypass the check (CORS preflight, idempotent).
 *   6. Webhook paths bypass the check (Twilio, Mailgun, marketplace vendors
 *      do not send Origin headers and would not match the allowlist anyway).
 *   7. /api/health unaffected.
 *   8. Structural: zero `res.cookie(` calls outside the `setSecureCookie`
 *      helper — grep assertion against backend/routes/ + backend/middleware/.
 *
 * Wired into BOTH .github/workflows/deploy.yml (per-push gate) AND
 * .github/workflows/coverage.yml (coverage measurement gate).
 *
 * RUN_TAG: not needed — this spec creates zero DB rows; it's a structural
 * + middleware-shape contract.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const ADMIN = { email: 'admin@globussoft.com', password: 'password123' };

let adminToken = null;

async function login(request) {
  if (adminToken) return adminToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: ADMIN,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        adminToken = j.token;
        return adminToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  throw new Error('Could not login as admin@globussoft.com');
}

// ────────────────────────────────────────────────────────────────────
// 1. Forged Origin → 403 ORIGIN_NOT_ALLOWED
// ────────────────────────────────────────────────────────────────────
test('POST with Origin: evil.com is rejected with 403 ORIGIN_NOT_ALLOWED', async ({ request }) => {
  const token = await login(request);
  const r = await request.post(`${API}/contacts`, {
    data: { name: 'X CSRF Probe', email: `x-csrf-${Date.now()}@example.com` },
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://evil.example.com',
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.status()).toBe(403);
  const body = await r.json();
  expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
});

// ────────────────────────────────────────────────────────────────────
// 2. Allowlisted Origin → auth-handled normally
// ────────────────────────────────────────────────────────────────────
test('POST with allowlisted Origin passes the CSRF gate and reaches auth', async ({ request }) => {
  // No Authorization header → reaches verifyToken → 401.
  // If the originCheck were rejecting (incorrectly), we'd see 403 instead.
  const r = await request.post(`${API}/contacts`, {
    data: { name: 'X CSRF Probe' },
    headers: {
      'Content-Type': 'application/json',
      // BASE_URL is one of the allowlist entries (localhost:5000 or
      // crm.globusdemos.com depending on which gate we're running in).
      'Origin': BASE_URL,
    },
    timeout: REQUEST_TIMEOUT,
  });
  // 401 (auth required) — proves originCheck PASSED. NOT 403.
  expect(r.status()).toBe(401);
});

// ────────────────────────────────────────────────────────────────────
// 3. No Origin AND no Referer (curl-style) → passes through
// ────────────────────────────────────────────────────────────────────
test('POST with no Origin and no Referer (curl / server-to-server) passes through', async ({ request }) => {
  const token = await login(request);
  // Playwright's request fixture by default sets some headers; we pass empty
  // Origin / Referer explicitly to verify the "header absent" branch. Empty
  // string treated as absent by the middleware (no value to validate).
  const r = await request.post(`${API}/contacts`, {
    data: { name: `CSRF curl-probe ${Date.now()}`, email: `csrf-curl-${Date.now()}@example.com` },
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      // Explicit empty values to simulate curl that omits both headers
      'Origin': '',
      'Referer': '',
    },
    timeout: REQUEST_TIMEOUT,
  });
  // Either 201 (created) or 400 (validation failure on missing fields) —
  // BOTH prove the originCheck passed. NOT 403 from originCheck.
  expect([200, 201, 400]).toContain(r.status());
});

// ────────────────────────────────────────────────────────────────────
// 4. LOAD-BEARING: valid Bearer + forged Origin → STILL 403
// ────────────────────────────────────────────────────────────────────
test('valid Bearer token cannot bypass the Origin check from a forged origin', async ({ request }) => {
  const token = await login(request);
  const r = await request.post(`${API}/contacts`, {
    data: { name: 'Stolen-token probe', email: `stolen-${Date.now()}@example.com` },
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://attacker.invalid',
    },
    timeout: REQUEST_TIMEOUT,
  });
  // This is the whole point of the layer: a stolen-token attacker firing
  // from a browser context (which always sends Origin) gets stopped here,
  // BEFORE the bearer auth succeeds at the verifyToken layer.
  expect(r.status()).toBe(403);
  const body = await r.json();
  expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
});

// ────────────────────────────────────────────────────────────────────
// 5. GET / HEAD / OPTIONS bypass — CORS preflight + idempotent reads
// ────────────────────────────────────────────────────────────────────
test('GET requests bypass the Origin check (idempotent)', async ({ request }) => {
  const token = await login(request);
  const r = await request.get(`${API}/contacts?limit=1`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://evil.example.com',
    },
    timeout: REQUEST_TIMEOUT,
  });
  // GET passes through regardless of Origin — they have no body to mutate
  // and CORS itself will fail the cross-origin response read in a real
  // browser. The 200 here means the originCheck did NOT 403.
  expect(r.status()).toBe(200);
});

test('OPTIONS preflight from an allowed Origin gets 204 with CORS headers', async ({ request }) => {
  const r = await request.fetch(`${API}/contacts`, {
    method: 'OPTIONS',
    headers: {
      // Use BASE_URL — guaranteed to be in the CORS allowlist for whichever
      // gate is running (per-push uses 127.0.0.1, e2e-full uses demo).
      'Origin': BASE_URL,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization',
    },
    timeout: REQUEST_TIMEOUT,
  });
  // CORS preflight handled by the `cors` middleware. 204 or 200 are both
  // acceptable success responses. The key contract here: the originCheck
  // layer did NOT 403 on the OPTIONS method.
  expect([200, 204]).toContain(r.status());
  // Allow-Origin response header must echo the request origin for the
  // browser to accept the preflight result.
  const allowOrigin = r.headers()['access-control-allow-origin'];
  expect(allowOrigin).toBe(BASE_URL);
});

test('OPTIONS from a forged origin is NOT 403 from originCheck (CORS handles the rejection)', async ({ request }) => {
  const r = await request.fetch(`${API}/contacts`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://evil.example.com',
      'Access-Control-Request-Method': 'POST',
    },
    timeout: REQUEST_TIMEOUT,
  });
  // originCheck skips OPTIONS unconditionally. Whatever the downstream
  // response is (204 without ACAO header, 401 from the auth guard, 200
  // from the route), it must NOT carry our originCheck 403 code.
  if (r.status() === 403) {
    const body = await r.json().catch(() => ({}));
    expect(body.code).not.toBe('ORIGIN_NOT_ALLOWED');
  }
  // Either way, no Access-Control-Allow-Origin header — that's how the
  // CORS layer signals "not allowed" without erroring the request.
  const allowOrigin = r.headers()['access-control-allow-origin'];
  expect(allowOrigin).toBeFalsy();
});

// ────────────────────────────────────────────────────────────────────
// 6. Webhook paths bypass — Twilio / Mailgun / vendors don't set Origin
// ────────────────────────────────────────────────────────────────────
test('webhook paths bypass the Origin check', async ({ request }) => {
  // Marketplace lead webhook is one of the public paths in server.js's
  // openPaths list. Even with a forged-Origin from a non-allowed host,
  // the originCheck path-prefix bypass MUST allow it through (and then
  // the route's own validation will handle the missing/invalid payload).
  const r = await request.post(`${API}/marketplace-leads/webhook`, {
    data: { provider: 'test', payload: {} },
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://api.indiamart.com',  // not in allowlist
    },
    timeout: REQUEST_TIMEOUT,
  });
  // The route may 400 (bad payload), 401 (auth-shape mismatch), or 200/404
  // (route-specific) — but it must NOT be a 403 from originCheck. The key
  // assertion is "originCheck did not 403 with ORIGIN_NOT_ALLOWED".
  if (r.status() === 403) {
    const body = await r.json().catch(() => ({}));
    expect(body.code).not.toBe('ORIGIN_NOT_ALLOWED');
  }
});

// ────────────────────────────────────────────────────────────────────
// 7. /api/health unaffected (idempotent GET, but verify explicitly)
// ────────────────────────────────────────────────────────────────────
test('/api/health remains reachable regardless of Origin', async ({ request }) => {
  const r = await request.get(`${API}/health`, {
    headers: { 'Origin': 'https://evil.example.com' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.status()).toBe(200);
});

// ────────────────────────────────────────────────────────────────────
// 8. STRUCTURAL: zero `res.cookie(` calls outside the setSecureCookie helper
// ────────────────────────────────────────────────────────────────────
test('no raw res.cookie() calls exist in backend/routes or backend/middleware', async () => {
  // The setSecureCookie helper in middleware/originCheck.js DOES call
  // res.cookie() internally — that's expected. Every OTHER caller must
  // go through the helper so HttpOnly + Secure + SameSite are enforced
  // by default. This grep is the architectural enforcement: if a future
  // PR adds a raw res.cookie() in a route, this test goes red.
  //
  // Resolve repo root from this spec file's path so the test works
  // whether playwright is launched from /e2e or repo root.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(repoRoot, 'backend', 'routes'),
    path.join(repoRoot, 'backend', 'middleware'),
  ];

  const violations = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.js')) continue;
      const full = path.join(dir, entry);
      const content = fs.readFileSync(full, 'utf8');
      // Skip the helper file itself — it's the one legitimate caller.
      if (entry === 'originCheck.js') continue;
      // Look for `res.cookie(` — the raw Express cookie setter. Tolerate
      // matches inside comments (// or /* */) by stripping common comment
      // forms before matching.
      const stripped = content
        .replace(/\/\/[^\n]*/g, '')                  // line comments
        .replace(/\/\*[\s\S]*?\*\//g, '');           // block comments
      const matches = stripped.match(/\bres\.cookie\s*\(/g);
      if (matches && matches.length > 0) {
        violations.push(`${entry}: ${matches.length} call(s)`);
      }
    }
  }
  // If a real cookie-auth route lands, the offender must import + use
  // setSecureCookie from middleware/originCheck.js. The spec author
  // updating this test should also document the cookie's purpose in
  // the originCheck.js header.
  expect(violations).toEqual([]);
});
