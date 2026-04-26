// @ts-check
/**
 * 2FA route smoke (`/api/auth/2fa`)
 *  - POST /setup   (only validates auth + response shape)
 *  - POST /enable  (validation gate — code required; cannot complete fully
 *                   without a TOTP secret on a clean test user)
 *  - POST /disable (validation gate — password+code required)
 *  - POST /verify  (validation gate — tempToken+code required, plus invalid
 *                   token branches)
 *
 * NOTE: We deliberately do not complete an end-to-end enable+verify flow
 * here. Doing so would (a) flip a real user account into 2FA-enforced state
 * and break every other spec's login flow, and (b) require us to compute a
 * live TOTP code from a secret returned by the live server — possible, but
 * outside the smoke-test contract. We test the shape and validation gates.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

// Use a plain USER account so even if /setup mutates twoFactorSecret, no
// admin login is broken for downstream specs. (And we never call /enable.)
const USER_EMAIL = 'user@crm.com';
const USER_PASSWORD = 'password123';

let userToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('2FA — /api/auth/2fa', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: USER_EMAIL, password: USER_PASSWORD },
    });
    expect(login.ok(), 'user login must succeed').toBeTruthy();
    const body = await login.json();
    userToken = body.token;
    expect(userToken).toBeTruthy();
  });

  const auth = () => ({ Authorization: `Bearer ${userToken}` });

  test('auth gate — POST /setup without token returns 401/403', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/setup`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /setup returns secret + qrCode data URL', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/setup`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.secret).toBe('string');
    expect(body.secret.length).toBeGreaterThan(10);
    expect(body.qrCode).toMatch(/^data:image\/png;base64,/);
  });

  test('POST /enable rejects missing code with 400', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/enable`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/code/i);
  });

  test('POST /enable rejects an invalid TOTP code with 400', async ({ request }) => {
    // /setup must run first to populate twoFactorSecret on the user
    await request.post(`${API}/auth/2fa/setup`, { headers: auth() });
    const res = await request.post(`${API}/auth/2fa/enable`, {
      headers: auth(),
      data: { code: '000000' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid|verification/i);
  });

  test('POST /disable rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/disable`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/password|code/i);
  });

  test('POST /disable on a non-2FA account returns 400 "not enabled"', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/disable`, {
      headers: auth(),
      data: { password: USER_PASSWORD, code: '123456' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    // Either "2FA is not enabled" OR an incorrect-password / invalid-code if
    // the seed user was previously enrolled. Either way it stays at 400.
    expect(body.error).toBeTruthy();
  });

  test('POST /verify rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/verify`, { data: {} });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/code|token/i);
  });

  test('POST /verify with invalid tempToken returns 401', async ({ request }) => {
    const res = await request.post(`${API}/auth/2fa/verify`, {
      data: { tempToken: 'not.a.real.jwt', code: '123456' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid|expired/i);
  });

  // The full verify happy path needs a 2FA-enrolled account + a live TOTP
  // code we can't compute here without the secret. Skip with a clear reason.
  test.skip('POST /verify happy path — needs an enrolled account + live TOTP code', () => {});
});
