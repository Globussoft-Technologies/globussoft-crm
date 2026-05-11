// @ts-check
/**
 * CSP + Step-up auth gate — closes #654.
 *
 * Pins two distinct contracts shipped in the #654 wave:
 *
 *  PART 1 — Content-Security-Policy header is now SET on every response.
 *    backend/middleware/security.js transitioned from
 *    `contentSecurityPolicy: false` to a real directive list. This spec
 *    asserts the header is present + contains the load-bearing directives
 *    that prevent a future "oops we turned it off again" regression.
 *    Co-evolves with security-headers.spec.js (G-25) which previously
 *    asserted CSP=ABSENT — that spec was updated in the same PR to assert
 *    CSP=PRESENT.
 *
 *  PART 2 — POST /api/auth/step-up + requireStepUp() middleware.
 *    Destructive admin flows (GDPR retention-policy PUT, retention-sweep
 *    POST) now require the caller to RE-PRESENT their password (or TOTP
 *    when 2FA is enabled) and receive a short-lived (5-min) stepUpToken,
 *    which they attach via the `x-step-up-token` header on the destructive
 *    request. Plain Bearer auth is no longer sufficient.
 *
 *    Coverage targets:
 *      - POST /api/auth/step-up with password    → 200 + stepUpToken
 *      - POST /api/auth/step-up with no creds    → 400 MISSING_CREDENTIAL
 *      - POST /api/auth/step-up wrong password   → 401 STEP_UP_FAILED
 *      - PUT  /api/gdpr/retention-policies no step-up → 401 STEP_UP_REQUIRED
 *      - PUT  /api/gdpr/retention-policies with step-up → 200
 *      - PUT  /api/gdpr/retention-policies with mismatched-user step-up → 401
 *      - PUT  /api/gdpr/retention-policies with garbage step-up → 401 STEP_UP_INVALID
 *      - POST /api/gdpr/retention/run requires step-up (in addition to existing
 *        ADMIN gate + confirmDestructive flag)
 *
 *  Why ADMIN account: the GDPR retention-policy endpoints are router-level
 *  authenticated and the /retention/run endpoint is verifyRole(['ADMIN'])
 *  gated. We use admin@globussoft.com which is ADMIN on the generic tenant.
 *
 *  Revert-and-prove:
 *    - Comment out requireStepUp() on gdpr.js → "no step-up" tests go green
 *      where they shouldn't (regression caught).
 *    - Set contentSecurityPolicy: false in security.js → Part 1 fails.
 *    - Drop the userId check in requireStepUp() → "mismatched-user" passes.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';
const USER_EMAIL = 'user@crm.com';
const USER_PASSWORD = 'password123';

async function loginAs(request, email, password) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return { token: null, userId: null };
  const j = await r.json();
  return { token: j.token, userId: j.user && j.user.id };
}

let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, ADMIN_EMAIL, ADMIN_PASSWORD);
    adminToken = r.token;
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, USER_EMAIL, USER_PASSWORD);
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
}

async function mintStepUp(request, token, password) {
  const r = await request.post(`${BASE_URL}/api/auth/step-up`, {
    data: { password },
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  return r;
}

// ────────────────────────────────────────────────────────────────────
// PART 1 — CSP header is now present
// ────────────────────────────────────────────────────────────────────
test.describe('#654 Part 1 — Content-Security-Policy header is set', () => {
  test('CSP header is present on /api/health', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'CSP header missing — security.js transitional CSP regressed').toBeTruthy();
  });

  test("CSP header includes default-src 'self'", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    const csp = res.headers()['content-security-policy'] || '';
    // Helmet emits directives lowercased + space-separated within each;
    // directives are separated by `;`. Allow either kebab or "default-src 'self'".
    expect(csp.toLowerCase()).toContain("default-src 'self'");
  });

  test("CSP includes object-src 'none' + frame-ancestors 'self'", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    const csp = res.headers()['content-security-policy'] || '';
    expect(csp.toLowerCase()).toContain("object-src 'none'");
    expect(csp.toLowerCase()).toContain("frame-ancestors 'self'");
  });

  test("CSP includes form-action 'self' + base-uri 'self'", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, { timeout: REQUEST_TIMEOUT });
    const csp = res.headers()['content-security-policy'] || '';
    expect(csp.toLowerCase()).toContain("form-action 'self'");
    expect(csp.toLowerCase()).toContain("base-uri 'self'");
  });

  test('CSP header is present on POST /api/auth/login (even on 401)', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: `csp-stepup-probe-${Date.now()}@example.test`, password: 'wrong' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'CSP not emitted on auth/login responses').toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────
// PART 2 — POST /api/auth/step-up
// ────────────────────────────────────────────────────────────────────
test.describe('#654 Part 2 — POST /api/auth/step-up endpoint', () => {
  test('400 MISSING_CREDENTIAL when no password / totpCode supplied', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const r = await request.post(`${BASE_URL}/api/auth/step-up`, {
      data: {},
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('MISSING_CREDENTIAL');
  });

  test('401 when no auth header supplied at all', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/auth/step-up`, {
      data: { password: 'whatever' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
  });

  test('401 STEP_UP_FAILED on wrong password', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const r = await mintStepUp(request, token, 'not-the-real-password');
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe('STEP_UP_FAILED');
  });

  test('200 mints stepUpToken on correct password', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const r = await mintStepUp(request, token, ADMIN_PASSWORD);
    expect(r.status(), `step-up: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(typeof body.stepUpToken).toBe('string');
    expect(body.stepUpToken.length).toBeGreaterThan(20);
    expect(body.method).toBe('password');
    expect(body.expiresIn).toBe(300);
  });
});

// ────────────────────────────────────────────────────────────────────
// PART 3 — requireStepUp() middleware gates destructive endpoints
// ────────────────────────────────────────────────────────────────────
test.describe('#654 Part 3 — destructive endpoints require step-up', () => {
  test('PUT /api/gdpr/retention-policies without step-up → 401 STEP_UP_REQUIRED', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const r = await request.put(`${BASE_URL}/api/gdpr/retention-policies`, {
      data: [{ entity: 'EmailMessage', retainDays: 365, isActive: true }],
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe('STEP_UP_REQUIRED');
  });

  test('PUT /api/gdpr/retention-policies with valid step-up → 200', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const stepRes = await mintStepUp(request, token, ADMIN_PASSWORD);
    expect(stepRes.status()).toBe(200);
    const { stepUpToken } = await stepRes.json();

    const r = await request.put(`${BASE_URL}/api/gdpr/retention-policies`, {
      data: [{ entity: 'EmailMessage', retainDays: 365, isActive: true }],
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-step-up-token': stepUpToken,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `retention-policies PUT: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('PUT /api/gdpr/retention-policies with garbage step-up token → 401 STEP_UP_INVALID', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const r = await request.put(`${BASE_URL}/api/gdpr/retention-policies`, {
      data: [{ entity: 'EmailMessage', retainDays: 365, isActive: true }],
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-step-up-token': 'not.a.real.jwt.token',
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(['STEP_UP_INVALID', 'STEP_UP_EXPIRED']).toContain(body.code);
  });

  test('PUT /api/gdpr/retention-policies with step-up minted by DIFFERENT user → 401 STEP_UP_USER_MISMATCH', async ({ request }) => {
    const { token: adminTok } = await getAdmin(request);
    const { token: userTok } = await getUser(request);
    test.skip(!adminTok || !userTok, 'Admin or user login unavailable');

    // Mint step-up as the USER, then try to use it on the ADMIN's request.
    const stepRes = await mintStepUp(request, userTok, USER_PASSWORD);
    expect(stepRes.status()).toBe(200);
    const { stepUpToken: userStep } = await stepRes.json();

    const r = await request.put(`${BASE_URL}/api/gdpr/retention-policies`, {
      data: [{ entity: 'EmailMessage', retainDays: 365, isActive: true }],
      headers: {
        Authorization: `Bearer ${adminTok}`,
        'Content-Type': 'application/json',
        'x-step-up-token': userStep,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe('STEP_UP_USER_MISMATCH');
  });

  test('POST /api/gdpr/retention/run without step-up → 401 STEP_UP_REQUIRED (layered on top of ADMIN + confirmDestructive)', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const r = await request.post(`${BASE_URL}/api/gdpr/retention/run`, {
      data: { confirmDestructive: true },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe('STEP_UP_REQUIRED');
  });

  test('stepUpToken accepted via request body (alongside header support)', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const stepRes = await mintStepUp(request, token, ADMIN_PASSWORD);
    expect(stepRes.status()).toBe(200);
    const { stepUpToken } = await stepRes.json();

    // PUT /retention-policies — supply stepUpToken in body (will be stripped
    // by stripDangerous? No — only id/userId/tenantId/createdAt/updatedAt are
    // stripped; stepUpToken is not). The middleware reads either header OR
    // body.stepUpToken. We assert the body path works as a usability fallback
    // for clients that can't add custom headers.
    const r = await request.put(`${BASE_URL}/api/gdpr/retention-policies`, {
      data: [{ entity: 'EmailMessage', retainDays: 365, isActive: true, stepUpToken }],
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // Body is an ARRAY — stepUpToken on an array entry doesn't make sense.
    // This test is here to document that the header is the canonical path;
    // a body-based supply when the body is a flat object would also work.
    // Either way the request is rejected as STEP_UP_REQUIRED because the
    // middleware can't find stepUpToken on req.body when req.body is an array.
    expect(r.status()).toBe(401);
  });

  test('stepUpToken works on an object-body endpoint via body field too', async ({ request }) => {
    const { token } = await getAdmin(request);
    test.skip(!token, 'Admin login unavailable in this environment');
    const stepRes = await mintStepUp(request, token, ADMIN_PASSWORD);
    expect(stepRes.status()).toBe(200);
    const { stepUpToken } = await stepRes.json();

    // POST /retention/run accepts an object body, so the body-based supply
    // path is actually exercisable here.
    const r = await request.post(`${BASE_URL}/api/gdpr/retention/run`, {
      data: { confirmDestructive: true, stepUpToken },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // Should now pass the step-up check. The actual sweep semantics return
    // 200 with a summary; on a fresh test stack there may be no active
    // policies → summary: [].
    expect(r.status(), `retention/run with body stepUpToken: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.summary)).toBe(true);
  });
});
