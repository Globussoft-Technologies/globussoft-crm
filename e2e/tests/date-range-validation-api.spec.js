// @ts-check
/**
 * #665 — cross-cutting inverted-date-range validation gate.
 *
 * Filed bug: multiple list/report routes accept ?from=&to= but historically did
 * NO validation when `to` was earlier than `from`. Pre-fix, every offending
 * endpoint silently returned an empty result set; operators (and tests) had
 * no signal that a typo had been swallowed.
 *
 * What this spec pins (one inverted-range probe per route family that lacked
 * validation before the wB1 sweep):
 *   ✅ GET /api/attribution/report                 — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/audit-viewer/                       — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/audit-viewer/export.csv             — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/wellness/inventory/receipts         — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/wellness/inventory/adjustments      — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/attendance/me                       — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/attendance/staff/:userId            — 400 INVERTED_DATE_RANGE
 *   ✅ GET /api/attendance/summary                  — 400 INVERTED_DATE_RANGE
 *   ✅ INVALID_DATE on unparseable input            — one route as a representative
 *   ✅ Happy path (to >= from) still 200            — pin the not-over-rejecting contract
 *
 * Two existing routes that already validated date ranges before this sweep
 * deliberately use different error codes and are left alone:
 *   - /api/reports/*  → INVERTED_RANGE          (pinned by reports-api.spec.js)
 *   - /api/wellness/reports/*  → INVERTED_DATE_RANGE (pinned by wellness-reports-api.spec.js)
 * Both are exercised by their own gate specs; this file only covers the routes
 * the bug report explicitly named (attribution + audit-log + inventory) plus
 * attendance which exhibited the same pattern.
 *
 * Pattern: thin dual-token (generic ADMIN + wellness ADMIN). The wellness
 * inventory + attendance staff/me routes are gated; the attribution +
 * audit-viewer + attendance summary routes accept generic ADMIN.
 *
 * Test data: this spec is read-only — it only sends GETs with bogus query
 * params. No fixtures created, no afterAll cleanup needed.
 *
 * Run locally:
 *   cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *     --project=chromium --no-deps tests/date-range-validation-api.spec.js
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

const FIXTURES = {
  admin:         { email: 'admin@globussoft.com', password: 'password123' },
  wellnessAdmin: { email: 'admin@wellness.demo',  password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const f = FIXTURES[who];
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: f,
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) throw new Error(`login as ${who} failed: ${r.status()}`);
  const j = await r.json();
  tokenCache[who] = j.token;
  userIdCache[who] = j.user.id;
  return { token: j.token, userId: j.user.id };
}

async function getInverted(request, token, path) {
  // 2026-05-01 .. 2026-04-01 — clearly inverted.
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}from=2026-05-01&to=2026-04-01`;
  return request.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

async function getInvalid(request, token, path) {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}from=notadate&to=2026-04-01`;
  return request.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

async function getValid(request, token, path) {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}from=2026-04-01&to=2026-04-30`;
  return request.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

async function assertInverted(res, label) {
  expect(res.status(), `${label}: status`).toBe(400);
  const body = await res.json();
  expect(body.code, `${label}: code`).toBe('INVERTED_DATE_RANGE');
}

test.describe('#665 inverted-date-range validation across modules', () => {
  test('attribution /report rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getInverted(request, token, '/api/attribution/report');
    await assertInverted(res, '/api/attribution/report');
  });

  test('audit-viewer / rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getInverted(request, token, '/api/audit-viewer/');
    await assertInverted(res, '/api/audit-viewer/');
  });

  test('audit-viewer /export.csv rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getInverted(request, token, '/api/audit-viewer/export.csv');
    await assertInverted(res, '/api/audit-viewer/export.csv');
  });

  test('wellness inventory receipts rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'wellnessAdmin');
    const res = await getInverted(request, token, '/api/wellness/inventory/receipts');
    await assertInverted(res, '/api/wellness/inventory/receipts');
  });

  test('wellness inventory adjustments rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'wellnessAdmin');
    const res = await getInverted(request, token, '/api/wellness/inventory/adjustments');
    await assertInverted(res, '/api/wellness/inventory/adjustments');
  });

  test('attendance /me rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getInverted(request, token, '/api/attendance/me');
    await assertInverted(res, '/api/attendance/me');
  });

  test('attendance /staff/:userId rejects inverted range', async ({ request }) => {
    const { token, userId } = await login(request, 'admin');
    const res = await getInverted(request, token, `/api/attendance/staff/${userId}`);
    await assertInverted(res, '/api/attendance/staff/:userId');
  });

  test('attendance /summary rejects inverted range', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getInverted(request, token, '/api/attendance/summary');
    await assertInverted(res, '/api/attendance/summary');
  });

  test('INVALID_DATE on unparseable input (attribution representative)', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getInvalid(request, token, '/api/attribution/report');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DATE');
  });

  test('happy-path: to >= from still returns 200 (audit-viewer)', async ({ request }) => {
    const { token } = await login(request, 'admin');
    const res = await getValid(request, token, '/api/audit-viewer/');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Pin the existing list envelope so the new validation doesn't accidentally
    // short-circuit when the range is fine.
    expect(body).toHaveProperty('logs');
    expect(Array.isArray(body.logs)).toBe(true);
  });
});
