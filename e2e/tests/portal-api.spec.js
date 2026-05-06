// @ts-check
/**
 * Smoke tests for backend/routes/portal.js — generic client portal API.
 * Mounted at /api/portal. Authenticated via a separate PORTAL JWT (not the
 * admin JWT). The seed does NOT plant a portal password for any contact, so
 * we verify all the public/unauthenticated paths and validation gates only.
 *
 * Endpoints covered:
 *   POST /login           public
 *   POST /set-password    public (sort of)
 *   POST /forgot          public (always 200 to prevent enumeration)
 *   POST /reset           public (token-based)
 *   GET  /me              portal-token gated
 *   GET  /tickets         portal-token gated
 *   POST /tickets         portal-token gated
 *   GET  /invoices        portal-token gated
 *   GET  /contracts       portal-token gated
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

test.describe('Portal API — public + auth gates', () => {
  test('POST /api/portal/login without body returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/login`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/portal/login with unknown email returns 401', async ({ request }) => {
    const res = await request.post(`${API}/portal/login`, {
      data: { email: 'rohan.unknown@example.com', password: 'whatever' },
    });
    expect(res.status()).toBe(401);
  });

  // /portal/set-password is NOT in server.js openPaths — it requires staff
  // auth (admin/manager promotes a contact to a portal user). Without a token
  // the global auth guard returns 401 (#537 RFC 7235 — was 403 pre-fix; 403
  // is reserved for "authenticated but not allowed").
  test('POST /api/portal/set-password without staff token returns 401', async ({ request }) => {
    const res = await request.post(`${API}/portal/set-password`, {
      data: { email: 'someone@example.com', newPassword: 'newpass123' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/portal/forgot without email returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/forgot`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/portal/forgot with unknown email still returns 200 (no enumeration)', async ({ request }) => {
    const res = await request.post(`${API}/portal/forgot`, {
      data: { email: 'enum.probe.' + Date.now() + '@example.com' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code || body.message).toBeTruthy(); // #550
  });

  test('POST /api/portal/reset without fields returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/reset`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/portal/reset with bogus token returns 400', async ({ request }) => {
    const res = await request.post(`${API}/portal/reset`, {
      data: { token: 'not-a-real-token', newPassword: 'newpass123' },
    });
    expect(res.status()).toBe(400);
  });

  // The portal-token-protected endpoints are NOT in server.js openPaths, so
  // the global staff auth guard runs first and returns 401 (#537 RFC 7235)
  // for missing token. The portal-token middleware (also returning 401) only
  // runs for staff-authed requests with the wrong token type — see next test.
  test('GET /api/portal/me without any token returns 401', async ({ request }) => {
    const res = await request.get(`${API}/portal/me`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/portal/me with admin JWT (wrong type) returns 401 from portal middleware', async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
    });
    const adminToken = (await login.json()).token;
    const res = await request.get(`${API}/portal/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    // Staff token passes the global guard; portal middleware then rejects
    // because decoded.type !== "PORTAL".
    expect(res.status()).toBe(401);
  });

  // #537 RFC 7235: missing-auth → 401, not 403, on the global staff guard.
  test('GET /api/portal/tickets without token returns 401', async ({ request }) => {
    const res = await request.get(`${API}/portal/tickets`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/portal/tickets without token returns 401', async ({ request }) => {
    const res = await request.post(`${API}/portal/tickets`, {
      data: { subject: 'help' },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/portal/invoices without token returns 401', async ({ request }) => {
    const res = await request.get(`${API}/portal/invoices`);
    expect(res.status()).toBe(401);
  });

  test('GET /api/portal/contracts without token returns 401', async ({ request }) => {
    const res = await request.get(`${API}/portal/contracts`);
    expect(res.status()).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────────
// #238 — wellness portal verify-otp must reject wrong codes
// ──────────────────────────────────────────────────────────────────────
//
// Distinct from / broader than Agent G's #292 pin in
// auth-security-regression-api.spec.js:508-535 (commit db543af). That spec
// pins the hardcoded-1234 bypass against a non-whitelisted phone — i.e.
// "even with WELLNESS_DEMO_OTP=1234 set, otp=1234 against 9999999999 must
// return 401, not mint a portal token". The bypass-tightening hardening.
//
// THIS spec covers the v1 footgun before the bypass was introduced at all:
// pre-#238 the verify-otp handler accepted ANY 4-digit code matching
// /^\d{4}$/. The fix requires a real PatientOtp row with otp matching the
// posted value. So the broader invariant: a freshly-issued OTP, then
// verify with the WRONG 4-digit code, must return 401 (not 200).
//
// Two-layer defence: Agent G pins "the demo-bypass value 1234 doesn't
// work outside the whitelist"; we pin "ANY non-issued 4-digit code
// returns 401, regardless of bypass". A regression that re-introduced the
// "any 4 digits accepts" bug would defeat the bypass-whitelist hardening
// trivially — they're complementary.
//
// CI env-block parity: WELLNESS_DEMO_OTP=1234 is set in deploy.yml:147
// (api_tests env block). Locally + CI: 1234 against the seeded
// "+919876500001" demo phone WILL succeed (200 + token). Other 4-digit
// codes against that same phone MUST fail (401). That's the contract.

test.describe('#238 — wellness portal verify-otp rejects wrong codes', () => {
  // Use a phone that is NOT the demo-bypass whitelist phone so the
  // bypass branch can never accept '1234'. The wellness seed plants
  // patients at "9811891334" (Kavita Reddy) and others — pick one
  // that's outside WELLNESS_DEMO_OTP_PHONES (default "9876500001").
  // We use a random suffix on a known-unseeded prefix so we don't
  // depend on a specific seed phone (and any leaked OTP can't matter
  // — there's no Patient row anyway, so 401 either way).
  const NON_WHITELIST_PHONE = '9811891334'; // Kavita Reddy — seeded, NOT whitelisted

  test('POST /portal/login/verify-otp with random wrong code → 401, no token', async ({ request }) => {
    // Step 1: request an OTP for a real seeded patient. The handler
    // creates a PatientOtp row with a random 4-digit code AND queues
    // an SMS. We don't read the issued OTP (the #300 fix removed it
    // from the response body, and reading from PatientOtp would
    // require DB access we don't have at the spec layer).
    const reqRes = await request.post(`${API}/wellness/portal/login/request-otp`, {
      data: { phone: NON_WHITELIST_PHONE },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(reqRes.status()).toBe(200);

    // Step 2: try to verify with a random WRONG 4-digit code. The
    // handler MUST consult the PatientOtp table — pre-#238 it just
    // matched the regex shape and minted a token. Pick a code that
    // is statistically unlikely to collide with the issued one
    // (1/9000 chance per try; using two distinct attempts below).
    const wrongCodes = ['0000', '7777'];
    for (const wrong of wrongCodes) {
      const verifyRes = await request.post(`${API}/wellness/portal/login/verify-otp`, {
        data: { phone: NON_WHITELIST_PHONE, otp: wrong },
        headers: { 'Content-Type': 'application/json' },
      });
      // Should be 401 unless we got astronomically unlucky AND hit
      // the actual issued code. Even then a token would be a wrong
      // outcome only because the test got lucky — we still consider
      // 200 a failure here for non-whitelist phones because the
      // PROBABILITY is so low this almost certainly indicates the
      // "any 4 digits" footgun returning. Two attempts cuts the
      // false-positive odds to ~1/40M.
      expect(verifyRes.status(), `wrong code ${wrong} for ${NON_WHITELIST_PHONE} should 401`).toBe(401);
      const body = await verifyRes.json().catch(() => ({}));
      expect(body.token, '#238 regressed: verify-otp minted a token for a wrong code').toBeFalsy();
      expect(body.error, 'verify-otp should return a structured error message').toBeTruthy();
    }
  });

  test('POST /portal/login/verify-otp with otp=1234 + non-whitelisted phone → 401 (defence-in-depth vs Agent G #292)', async ({ request }) => {
    // Mirror of auth-security-regression-api.spec.js:508 (Agent G's
    // #292 pin) but at the portal-api.spec.js surface — defence in
    // depth per the cross-cutting standing rule. Even with
    // WELLNESS_DEMO_OTP=1234 set in CI, otp=1234 against a phone NOT
    // in WELLNESS_DEMO_OTP_PHONES MUST NOT return a portal token.
    const r = await request.post(`${API}/wellness/portal/login/verify-otp`, {
      data: { phone: NON_WHITELIST_PHONE, otp: '1234' },
      headers: { 'Content-Type': 'application/json' },
    });
    // 401 is the normal outcome (no PatientOtp row matches '1234'
    // unless we get astronomically unlucky on the random issued OTP
    // from a sibling test — but the bypass branch is gated on the
    // whitelist regardless). 200 is the regression we're pinning
    // against — the original #238 takeover.
    expect(r.status(), 'otp=1234 against non-whitelisted phone should not 200').not.toBe(200);
    if (r.ok()) {
      const body = await r.json().catch(() => ({}));
      expect(body.token, '#238/#292 regressed: 1234 minted a portal token for non-whitelist phone').toBeFalsy();
    }
  });

  test('POST /portal/login/verify-otp with malformed code → 400 (validation, not 401)', async ({ request }) => {
    // Belt-and-braces: a regression that loosens /^\d{4}$/ to /^\d+$/
    // (or drops the regex) would let 5+digit / non-digit OTPs through.
    // The handler should 400 on shape failure, not 401 (so a client
    // sees a clear "fix your input" vs "auth failed").
    const malformed = ['123', '12345', 'abcd', '12 4', ''];
    for (const bad of malformed) {
      const r = await request.post(`${API}/wellness/portal/login/verify-otp`, {
        data: { phone: NON_WHITELIST_PHONE, otp: bad },
        headers: { 'Content-Type': 'application/json' },
      });
      // 400 (validation) is the canonical outcome for malformed shape.
      // Empty string takes the "phone and otp are required" branch
      // which also 400s. Either way, NOT 200 + token.
      expect(r.status(), `malformed otp "${bad}" should 400, got ${r.status()}`).toBe(400);
    }
  });
});
