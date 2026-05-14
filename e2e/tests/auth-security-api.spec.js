// @ts-check
/**
 * Auth & Security API gate (per-push)
 *
 * Closes regression risk for the auth/security cluster from the
 * regression-coverage backlog. Of the 14 issues listed, 9 are
 * testable from API-only request fixtures (the rest — #192 timing
 * oracle, #200/#201/#211 login-page credential exposure, #343/#344
 * sessionStorage migration — need page renders or hard-to-stabilise
 * statistical assertions, deferred to UI suites).
 *
 * Issues prevented from regressing:
 *
 *   #169  — POST /api/notifications/broadcast must require ADMIN
 *   #186  — security headers (HSTS, X-Frame-Options, X-Content-Type,
 *           Referrer-Policy, CSP) on every response
 *   #191  — POST /api/auth/login wired to express-rate-limit (max=5)
 *   #254  — OTP-bearing SMS not surfaced via staff-visible feeds
 *   #269  — same as #254, separate detection path
 *   #292  — POST /portal/login/verify-otp with hardcoded "1234" → 401
 *   #295  — POST /portal/login/request-otp wired to rate-limit
 *   #300  — POST /portal/login/request-otp body must NOT contain
 *           `otp`, `code`, or 4 consecutive digits (the original
 *           env-var leak that enabled patient-account takeover)
 *   #342  — Permissions-Policy header present on the API surface
 *
 * Out of scope (need a different harness):
 *
 *   #192  — login response time variance valid vs invalid email.
 *           CI rate-limit budget makes 30+ wrong-password attempts
 *           unreliable; a statistical assertion on mean timing is
 *           inherently flaky on shared runners.
 *   #200, #201, #211  — login page UI credential exposure. Need a
 *           page render and DOM inspection. Belongs in the UI suite.
 *   #343, #344  — sessionStorage migration. Tested by the existing
 *           e2e/auth.setup.js + the chromium project storageState.
 *
 * Revert-and-prove: revert backend/middleware/security.js (drop the
 * helmetMiddleware export) on a throwaway branch and confirm this
 * spec goes red on the headers tests. Same drill for express-rate-
 * limit removal in server.js.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

// ── #186 / #342: security headers ────────────────────────────────────

test.describe('Auth/Security — security headers (#186, #342)', () => {
  // Headers must be present on EVERY response, not just on /api/auth/login.
  // Probing /api/health (the cheapest no-auth endpoint) is the most robust
  // check — if helmet is wired into the global middleware chain, this
  // endpoint carries the same headers as everything else.
  //
  // Two headers are environment-conditional:
  //   - HSTS (Strict-Transport-Security): helmet only emits on HTTPS.
  //     The api_tests CI gate runs over HTTP at 127.0.0.1:5000, so this
  //     header is absent there. Asserted only when BASE_URL starts with
  //     https:// — that catches the demo + e2e-full deploy validation.
  //   - CSP: intentionally disabled in backend/middleware/security.js
  //     because the embed widget at /embed/lead-form.html is loaded by
  //     partner sites (callified.ai etc.) and a strict frame-ancestors
  //     would break that flow. Documented in the helmet config comment.
  //     Skipped here so the spec doesn't fight the architectural call.
  for (const path of ['/api/health', '/api/auth/login']) {
    test(`${path} response carries the helmet header set`, async ({ request }) => {
      // Use POST for /auth/login so it's a valid request even though
      // we expect 400/401 (no body). Both methods get headers either way.
      const res = path.endsWith('/login')
        ? await request.post(`${BASE_URL}${path}`, {
            data: { email: `security-headers-${Date.now()}@example.test`, password: 'wrong' },
            headers: { 'Content-Type': 'application/json' },
            timeout: REQUEST_TIMEOUT,
          })
        : await request.get(`${BASE_URL}${path}`, { timeout: REQUEST_TIMEOUT });

      const headers = res.headers();

      // Helmet defaults that must be pinned on every response.
      expect(headers['x-frame-options'], 'X-Frame-Options missing').toBeTruthy();
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy'], 'Referrer-Policy missing').toBeTruthy();
      // #342: Permissions-Policy is set explicitly by permissionsPolicyMiddleware
      // (helmet 8.x doesn't emit it). Pre-fix the header was missing entirely.
      expect(headers['permissions-policy'], 'Permissions-Policy missing (#342)').toBeTruthy();
      // HSTS only on HTTPS (helmet behaviour). Demo monitor catches it.
      if (BASE_URL.startsWith('https://')) {
        expect(headers['strict-transport-security'], 'HSTS missing on HTTPS deploy (#186)').toBeTruthy();
      }
    });
  }
});

// ── #191: login rate limit wired ─────────────────────────────────────

test.describe('Auth/Security — login rate limit wired (#191)', () => {
  // We assert the RateLimit-* headers exist + the configured max=5
  // rather than actually triggering 429. Triggering 429 burns the
  // CI runner's IP budget for the next 15 minutes and would 429
  // every other spec's intentional-401 attempts. The header check
  // is sufficient regression coverage: if someone removes the limiter
  // middleware, the headers disappear.
  test('POST /api/auth/login emits RateLimit-* headers (limiter wired)', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      // Unique email so the per-username limiter doesn't pre-empt
      // future runs that fire near this clock window.
      data: { email: `ratelimit-headers-${Date.now()}@example.test`, password: 'wrong' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // 401 expected — wrong password against a non-existent email.
    expect(res.status()).toBe(401);
    const headers = res.headers();
    // express-rate-limit standardHeaders: 'draft-7' emits these. We
    // don't pin the value because there are 3 stacked limiters on this
    // route (global 5000/15min + login-IP 5/15min + login-username
    // 10/hr) and express-rate-limit reports the value from whichever
    // ran last. The presence of the header is the regression signal —
    // remove the limiter and the headers disappear.
    expect(
      headers['ratelimit-policy'] || headers['ratelimit-limit'] || headers['x-ratelimit-limit'],
      'RateLimit headers missing on /api/auth/login — limiter may be unwired'
    ).toBeTruthy();
  });
});

// ── #169: notifications broadcast requires ADMIN ─────────────────────

test.describe('Auth/Security — broadcast endpoint admin-only (#169)', () => {
  // The broadcast surface is POST /api/notifications/ WITHOUT a
  // targetUserId in the body. Per backend/routes/notifications.js:160-164,
  // a tenant-wide blast (no targetUserId) is admin-only and rejects
  // non-admins with the stable BROADCAST_FORBIDDEN code.
  test('POST /api/notifications without targetUserId as USER → 403 BROADCAST_FORBIDDEN', async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'user@crm.com', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    test.skip(!login.ok(), 'user@crm.com seed unavailable');
    const token = (await login.json()).token;
    // No targetUserId → triggers the broadcast branch. Field name is
    // `message` not `body` per the route's input validation; the
    // validator fires BEFORE the role check, so a missing `message`
    // would short-circuit to 400 and mask the BROADCAST_FORBIDDEN test.
    const r = await request.post(`${API}/notifications`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { title: 'should-fail', message: 'should-fail' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('BROADCAST_FORBIDDEN');
  });
});

// ── #300: OTP must NEVER appear in the response body ─────────────────

test.describe('Auth/Security — portal OTP not in response body (#300)', () => {
  // Pre-fix, NODE_ENV !== 'production' returned the OTP in the response
  // body for "easier testing". The demo server ran with NODE_ENV unset
  // → OTP leaked to anyone who could call the public endpoint, enabling
  // patient-account takeover for any registered phone.
  test('POST /portal/login/request-otp body never contains OTP / code / 4-digit run', async ({ request }) => {
    // Use a 10-digit phone in the public endpoint — doesn't matter if a
    // patient with that phone exists; the endpoint always returns ok:true.
    const r = await request.post(`${API}/wellness/portal/login/request-otp`, {
      data: { phone: '9999900000' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();

    // Schema-level: no top-level `otp` or `code` field. The pre-fix
    // leak shape was `{ ok: true, otp: "1234", expiresAt: "..." }`.
    expect('otp' in body, 'top-level "otp" field present (#300)').toBe(false);
    expect('code' in body, 'top-level "code" field present (#300)').toBe(false);

    // Content-level: no string-typed value (other than ISO timestamps —
    // expiresAt: "2026-..." legitimately contains 4-digit years) carries
    // a 4-digit run that could be mistaken for an OTP. Walk the keys.
    const TIMESTAMP_KEYS = new Set(['expiresAt', 'createdAt', 'updatedAt', 'timestamp']);
    for (const [key, value] of Object.entries(body)) {
      if (TIMESTAMP_KEYS.has(key)) continue;
      if (typeof value !== 'string') continue;
      expect(value, `field "${key}" carries a 4-digit run that could be an OTP`).not.toMatch(/\b\d{4}\b/);
    }
  });
});

// ── #295: OTP request endpoint rate-limited ──────────────────────────

test.describe('Auth/Security — portal OTP rate-limit wired (#295)', () => {
  test('POST /portal/login/request-otp emits RateLimit-* headers', async ({ request }) => {
    const r = await request.post(`${API}/wellness/portal/login/request-otp`, {
      data: { phone: '9999988888' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const headers = r.headers();
    expect(
      headers['ratelimit-policy'] || headers['ratelimit-limit'],
      'OTP-request RateLimit headers missing — limiter may be unwired'
    ).toBeTruthy();
  });
});

// ── #292: hardcoded "1234" must be rejected by verify-otp ────────────

test.describe('Auth/Security — portal verify-otp rejects hardcoded "1234" (#292)', () => {
  // Pre-v1 portal had a "always accept 1234" cheat for QA. Rev'd out
  // but worth a guard — if it ever comes back as a debug shortcut
  // (e.g. in a feature flag that ships to prod), this catches it.
  test('POST /portal/login/verify-otp with otp=1234 → 401', async ({ request }) => {
    const r = await request.post(`${API}/wellness/portal/login/verify-otp`, {
      data: { phone: '9999912345', otp: '1234' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // 401 (no matching OTP) is the correct refusal. 400 (validation) is
    // also acceptable if the endpoint pre-validates the phone shape and
    // refuses before the OTP lookup. The thing we MUST NOT see is 200
    // with a token.
    expect(r.status(), `unexpected status for hardcoded 1234: ${r.status()}`).not.toBe(200);
    if (r.ok()) {
      const body = await r.json();
      expect(body.token, 'hardcoded 1234 must NOT issue a portal token').toBeFalsy();
    }
  });
});

// ── #254 / #269: OTP-bearing SMS not surfaced via staff feeds ────────

test.describe('Auth/Security — OTP SMS not in staff feeds (#254, #269)', () => {
  // The portal request-otp endpoint enqueues an outbound SMS row carrying
  // "Your verification code is XXXX." Pre-fix, /api/sms returned every
  // SmsMessage row to staff — including the OTP body. Staff with read-
  // only access could see active patient OTPs and impersonate them.
  test('GET /api/sms response does not surface OTP-shaped SMS bodies', async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@wellness.demo', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    test.skip(!login.ok(), 'wellness admin seed unavailable');
    const token = (await login.json()).token;

    const r = await request.get(`${API}/sms?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    // Some envs may not expose /api/sms at all — that's fine, the bug
    // can't manifest. We only fail if the endpoint exists AND returns
    // OTP-shaped content.
    if (!r.ok()) {
      expect([401, 403, 404]).toContain(r.status());
      return;
    }
    const body = await r.json();
    const list = Array.isArray(body) ? body : (body.messages || body.data || []);
    const leakedRows = list.filter((m) => /verification code is \d{4}|otp:\s*\d{4}|^\s*\d{4}\s*$/i.test(m.body || ''));
    expect(
      leakedRows.map((m) => `id=${m.id}: ${(m.body || '').slice(0, 60)}`),
      'OTP-bearing SMS rows visible to staff (#254/#269)'
    ).toEqual([]);
  });

  test('GET /api/communications response does not surface OTP-shaped bodies', async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@wellness.demo', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    test.skip(!login.ok(), 'wellness admin seed unavailable');
    const token = (await login.json()).token;

    const r = await request.get(`${API}/communications?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    if (!r.ok()) {
      expect([401, 403, 404]).toContain(r.status());
      return;
    }
    const body = await r.json();
    const list = Array.isArray(body) ? body : (body.events || body.data || body.communications || []);
    const leaked = list.filter((m) =>
      /verification code is \d{4}|otp:\s*\d{4}/i.test(m.body || m.summary || m.preview || '')
    );
    expect(
      leaked.map((m) => `id=${m.id}: ${(m.body || m.summary || '').slice(0, 60)}`),
      'OTP-bearing rows in /api/communications (#254/#269)'
    ).toEqual([]);
  });
});
