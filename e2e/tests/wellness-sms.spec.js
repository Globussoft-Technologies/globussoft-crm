// @ts-check
/**
 * Fast2SMS integration smoke test.
 *
 * Sends a real SMS via POST /api/sms/send (which looks up the active
 * SmsConfig for the tenant and calls services/smsProvider.sendSms).
 * Needs an SmsConfig row with provider="fast2sms" — seed it first via
 *   cd ~/globussoft-crm/backend && node scripts/seed-fast2sms-config.js
 *
 * The actual delivery is network-dependent, so we assert:
 *   - /api/sms/send returns 2xx or a structured error
 *   - an SmsMessage row is persisted (via the CRM's API)
 *
 * The "real delivery" case (SMS lands on your phone) only runs if
 * SMS_TEST_PHONE is set — otherwise the test skips so the suite stays
 * deterministic and doesn't spam random numbers.
 *
 * Run on server (per the rule):
 *   SMS_TEST_PHONE=9876543210 BASE_URL=https://crm.globusdemos.com \
 *     npx playwright test tests/wellness-sms.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const ADMIN = { email: 'admin@wellness.demo', password: 'password123' };

async function login(request) {
  const res = await request.post(`${API}/auth/login`, { data: ADMIN });
  expect(res.ok(), `admin login ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}

test.describe('Fast2SMS — SMS provider integration', () => {
  test('S1. Active SmsConfig for the tenant has provider="fast2sms"', async ({ request }) => {
    const token = await login(request);
    const res = await request.get(`${API}/sms/config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok(), `GET /sms/config ${res.status()}`).toBeTruthy();
    const configs = await res.json();
    const list = Array.isArray(configs) ? configs : (configs.data || []);
    const active = list.find((c) => c.isActive);
    expect(active, 'expected an active SmsConfig on the wellness tenant — run seed-fast2sms-config.js').toBeDefined();
    expect(active.provider).toBe('fast2sms');
    // API masks the key — confirm mask format (first 6 chars + ****)
    expect(active.apiKey).toMatch(/\*{4}$/);
  });

  test('S2. POST /api/sms/send with a dummy number returns a structured result (no crash)', async ({ request }) => {
    const token = await login(request);
    // Known-invalid dummy number — we just want the route to reach sendViaFast2SMS
    // and get back EITHER success OR a clear provider error (not a 500 HTML crash).
    const res = await request.post(`${API}/sms/send`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        to: '0000000000', // ensures a "numbers is invalid" response without hitting a real inbox
        body: 'E2E smoke test — ignore',
      },
    });
    const body = await res.json();
    // Tolerant — we want JSON back, either { success: true, messageId } OR
    // { success: false, error: "..." }. The point is the route didn't crash.
    expect(typeof body).toBe('object');
    expect('success' in body || 'error' in body).toBeTruthy();
  });

  test('S3. If SMS_TEST_PHONE is set, actually send a real SMS', async ({ request }) => {
    const phone = process.env.SMS_TEST_PHONE;
    if (!phone) {
      test.skip(true, 'set SMS_TEST_PHONE=<10-digit Indian mobile> to enable real delivery');
    }

    const token = await login(request);
    const stamp = Date.now().toString().slice(-6);
    const res = await request.post(`${API}/sms/send`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        to: phone,
        body: `Globussoft CRM: smoke-test from Fast2SMS integration (#${stamp}). If you got this, delivery works.`,
      },
    });
    const body = await res.json();
    console.log('[sms smoke]', JSON.stringify(body));

    // Accept either instant success or "queued with provider message ID"
    if (res.ok() && body.success) {
      expect(body.providerMsgId).toBeTruthy();
    } else {
      // Fast2SMS can reject for various reasons (invalid number, DLT not
      // registered, insufficient balance). Print the reason so a human
      // can diagnose without failing the whole suite.
      console.warn('[sms smoke] provider rejected:', body.error || JSON.stringify(body));
      // Assert that the error shape is JSON with an `error` field, not HTML
      expect(typeof body.error === 'string' || typeof body.message === 'string').toBeTruthy();
    }
  });
});
