// @ts-check
/**
 * Wellness patient-portal notification inbox — Option A REST endpoints.
 *
 * routes/wellness.js (behind verifyPatientToken, scoped to req.patient.id):
 *   GET  /api/wellness/portal/me/notifications            → { notifications[], unreadCount, count }
 *   PUT  /api/wellness/portal/me/notifications/:id/read    → updated row (isRead:true)
 *   POST /api/wellness/portal/me/notifications/mark-all-read → { success, marked }
 *
 * These serve the patient Android app / web portal inbox. They are SEPARATE
 * from the staff /api/notifications bell (which rejects portal tokens by
 * design) — backed by the additive PatientNotification table, patient-scoped.
 *
 * Auth model pinned:
 *   - no token            → 401
 *   - staff JWT (no patientId / no linked Patient) → rejected (401/403), never 200
 *   - valid portal token  → 200, sees ONLY this patient's rows
 *
 * Token mint: demo-OTP bypass (#238/#292) for the seeded "Demo Portal Patient"
 * at +919876500001 — request-otp + verify-otp with WELLNESS_DEMO_OTP (1234).
 * seed-wellness.js seeds 3 notifications for this patient (2 unread, 1 read).
 *
 * Re-run safe: the only mutation is marking rows read; after mark-all-read the
 * unread invariant (=0) holds regardless of prior runs. The 3 seeded rows are
 * never deleted/duplicated (seed is count-guarded). Acceptable demo pollution:
 * after this spec the demo patient's notifications are all read.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const DEMO_PORTAL_PHONE = '+919876500001';
const DEMO_OTP = process.env.WELLNESS_DEMO_OTP || '1234';
const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };

let portalToken = '';
let staffToken = '';
const portalAuth = () => ({ Authorization: `Bearer ${portalToken}` });
async function safeJson(res) { try { return await res.json(); } catch (_e) { return null; } }

test.beforeAll(async ({ request }) => {
  // Mint a portal token via demo-OTP bypass.
  await request.post(`${API}/wellness/portal/login/request-otp`, { data: { phone: DEMO_PORTAL_PHONE }, timeout: REQUEST_TIMEOUT });
  const verify = await request.post(`${API}/wellness/portal/login/verify-otp`, {
    data: { phone: DEMO_PORTAL_PHONE, otp: DEMO_OTP }, timeout: REQUEST_TIMEOUT,
  });
  if (verify.ok()) portalToken = (await verify.json()).token || '';

  const login = await request.post(`${API}/auth/login`, { data: RISHU, timeout: REQUEST_TIMEOUT });
  if (login.ok()) staffToken = (await login.json()).token || '';
});

// ── Auth gates ──────────────────────────────────────────────────────

test('GET notifications without token → 401', async ({ request }) => {
  const r = await request.get(`${API}/wellness/portal/me/notifications`, { timeout: REQUEST_TIMEOUT });
  expect(r.status()).toBe(401);
});

test('GET notifications with a STAFF token → rejected (never 200, no leak)', async ({ request }) => {
  test.skip(!staffToken, 'staff login unavailable');
  const r = await request.get(`${API}/wellness/portal/me/notifications`, {
    headers: { Authorization: `Bearer ${staffToken}` }, timeout: REQUEST_TIMEOUT,
  });
  // Staff JWT carries userId (no patientId) + has no linked Patient → 401/403.
  expect([401, 403]).toContain(r.status());
  expect(r.status()).not.toBe(200);
});

// ── Inbox lifecycle (serial — shares the demo patient's rows) ────────

test('GET returns the patient inbox shape (notifications[] + unreadCount + count)', async ({ request }) => {
  test.skip(!portalToken, 'portal token unavailable (WELLNESS_DEMO_OTP not set?)');
  const r = await request.get(`${API}/wellness/portal/me/notifications`, { headers: portalAuth(), timeout: REQUEST_TIMEOUT });
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(Array.isArray(body.notifications)).toBe(true);
  expect(typeof body.unreadCount).toBe('number');
  expect(typeof body.count).toBe('number');
  expect(body.notifications.length).toBeGreaterThanOrEqual(1); // 3 seeded
  // Public shape: rows must NOT leak tenantId.
  for (const n of body.notifications) {
    expect(n).not.toHaveProperty('tenantId');
    expect(n).toHaveProperty('id');
    expect(n).toHaveProperty('title');
    expect(n).toHaveProperty('isRead');
  }
});

test('PUT :id/read marks a single notification read', async ({ request }) => {
  test.skip(!portalToken, 'portal token unavailable');
  const list = await (await request.get(`${API}/wellness/portal/me/notifications`, { headers: portalAuth(), timeout: REQUEST_TIMEOUT })).json();
  const target = list.notifications[0];
  const r = await request.put(`${API}/wellness/portal/me/notifications/${target.id}/read`, { headers: portalAuth(), timeout: REQUEST_TIMEOUT });
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(body.id).toBe(target.id);
  expect(body.isRead).toBe(true);
  expect(body).not.toHaveProperty('tenantId');
});

test('PUT :id/read on a non-existent id → 404', async ({ request }) => {
  test.skip(!portalToken, 'portal token unavailable');
  const r = await request.put(`${API}/wellness/portal/me/notifications/99999999/read`, { headers: portalAuth(), timeout: REQUEST_TIMEOUT });
  expect(r.status()).toBe(404);
  expect((await safeJson(r))?.code).toBe('NOTIFICATION_NOT_FOUND');
});

test('POST mark-all-read clears unread; subsequent GET has unreadCount 0', async ({ request }) => {
  test.skip(!portalToken, 'portal token unavailable');
  const r = await request.post(`${API}/wellness/portal/me/notifications/mark-all-read`, { headers: portalAuth(), data: {}, timeout: REQUEST_TIMEOUT });
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(body.success).toBe(true);
  expect(typeof body.marked).toBe('number');

  const after = await (await request.get(`${API}/wellness/portal/me/notifications`, { headers: portalAuth(), timeout: REQUEST_TIMEOUT })).json();
  expect(after.unreadCount).toBe(0);
  expect(after.notifications.every((n) => n.isRead === true)).toBe(true);
});

test('?unreadOnly=true returns only unread (empty after mark-all-read)', async ({ request }) => {
  test.skip(!portalToken, 'portal token unavailable');
  const r = await request.get(`${API}/wellness/portal/me/notifications?unreadOnly=true`, { headers: portalAuth(), timeout: REQUEST_TIMEOUT });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.notifications.every((n) => n.isRead === false)).toBe(true);
});
