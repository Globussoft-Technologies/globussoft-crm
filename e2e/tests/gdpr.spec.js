// @ts-check
/**
 * /api/gdpr — smoke spec covering 7 handlers in backend/routes/gdpr.js.
 *
 *   POST   /export/contact/:id
 *   POST   /export/me
 *   DELETE /contact/:id            (destructive — only invoked on a
 *                                   throwaway contact created in this spec)
 *   GET    /consent/:contactId
 *   POST   /consent
 *   GET    /retention-policies
 *   PUT    /retention-policies
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

// Fresh-user fixture for the /export/me happy-path test. The seeded admin
// (admin@globussoft.com) accumulates demo data over time — 5,381 deals + 90+
// days of activity / audit rows on the demo box — so /export/me's response
// body is ~11 MB and the body transfer alone routinely brushes the 60s budget
// over Cloudflare. A throwaway tenant + user has zero owned rows, so
// /export/me returns a small envelope (sub-second). This keeps the spec's
// signal ("does the route work + return the documented shape?") meaningful
// even as the demo accumulates more seed data over the months.
let freshToken = '';
let freshEmail = '';
let freshPassword = 'Throwaway1234!';

let throwawayContactId = null;

test.describe.configure({ mode: 'serial' });

test.describe('gdpr API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;

    // Seed a throwaway contact we can destructively erase later.
    const stamp = Date.now();
    const create = await request.post(`${API}/contacts`, {
      headers: auth(),
      data: {
        name: `E2E_AUDIT Aarav Forgetme ${stamp}`,
        email: `e2e_audit_gdpr_${stamp}@delete.local`,
        phone: '+919900000099',
      },
    });
    if (create.ok()) {
      const c = await create.json();
      throwawayContactId = c.id || c.contact?.id;
    }

    // Mint a fresh tenant + user via /auth/register for the /export/me
    // happy-path test. See header comment on `freshToken` for rationale.
    // Best-effort — if register is throttled or otherwise 4xxs, the test
    // falls back to the seeded-admin token (which is still bounded by the
    // 60s timeout downstream).
    freshEmail = `e2e_audit_gdpr_export_${stamp}@delete.local`;
    try {
      const reg = await request.post(`${API}/auth/register`, {
        data: {
          email: freshEmail,
          password: freshPassword,
          name: 'E2E_AUDIT Throwaway Exporter',
          organizationName: `E2E_AUDIT GDPR Tenant ${stamp}`,
        },
      });
      if (reg.ok()) {
        const j = await reg.json();
        freshToken = j.token || '';
      }
    } catch (_e) { /* fall through to admin-token export */ }
  });

  test('GET /retention-policies requires auth', async ({ request }) => {
    const res = await request.get(`${API}/gdpr/retention-policies`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /retention-policies returns an array', async ({ request }) => {
    const res = await request.get(`${API}/gdpr/retention-policies`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('PUT /retention-policies rejects empty/non-array body', async ({ request }) => {
    const res = await request.put(`${API}/gdpr/retention-policies`, {
      headers: auth(),
      data: [],
    });
    expect(res.status()).toBe(400);
  });

  test('PUT /retention-policies upserts policies', async ({ request }) => {
    const res = await request.put(`${API}/gdpr/retention-policies`, {
      headers: auth(),
      data: [{ entity: 'AuditLog', retainDays: 365, isActive: true }],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('entity');
    expect(body[0]).toHaveProperty('retainDays');
  });

  test('POST /export/me returns user data export', async ({ request }) => {
    // Wave 4 Agent QQ (2026-05-09): use the fresh-tenant fixture token
    // when available so the export response is bounded (sub-second). Falls
    // back to the seeded-admin token only if /auth/register failed in
    // beforeAll; that path keeps the original 60s timeout for the ~11 MB
    // body transfer over Cloudflare. Admin token path is what `0ad13a8`
    // used pre-fixture; wave-4 prefers the bounded fixture path so the
    // spec's timing stays fast as the demo accumulates more seed data.
    const useFresh = !!freshToken;
    const requestToken = useFresh ? freshToken : token;
    const requestTimeout = useFresh ? 30000 : 60000;
    if (!useFresh) test.setTimeout(90_000);

    const res = await request.post(`${API}/gdpr/export/me`, {
      headers: { Authorization: `Bearer ${requestToken}` },
      timeout: requestTimeout,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('exportedAt');
    expect(body).toHaveProperty('user');
    expect(body).toHaveProperty('deals');
    expect(body).toHaveProperty('tasks');
    // Fresh-fixture tenant has zero owned rows — assert that explicitly so
    // a future regression where /export/me leaks cross-tenant data
    // (returning seed-admin's deals when called by the fresh user) reds.
    if (useFresh) {
      expect(Array.isArray(body.deals)).toBe(true);
      expect(body.deals.length).toBe(0);
      expect(body.tasks.length).toBe(0);
    }
  });

  test('POST /export/contact/:id 400s for invalid id', async ({ request }) => {
    const res = await request.post(`${API}/gdpr/export/contact/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('POST /export/contact/:id 404s for unknown contact', async ({ request }) => {
    const res = await request.post(`${API}/gdpr/export/contact/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /export/contact/:id returns full export for real contact', async ({ request }) => {
    test.skip(!throwawayContactId, 'no throwaway contact available — seed failed');
    const res = await request.post(`${API}/gdpr/export/contact/${throwawayContactId}`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('contact');
    expect(body.contact.id).toBe(throwawayContactId);
    expect(body).toHaveProperty('activities');
    expect(body).toHaveProperty('deals');
    expect(body).toHaveProperty('emails');
  });

  test('POST /consent rejects missing fields with 400', async ({ request }) => {
    const res = await request.post(`${API}/gdpr/consent`, {
      headers: auth(),
      data: { contactId: 1 },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /consent records a grant and GET /consent/:id surfaces it', async ({ request }) => {
    test.skip(!throwawayContactId, 'no throwaway contact available');
    const create = await request.post(`${API}/gdpr/consent`, {
      headers: auth(),
      data: {
        contactId: throwawayContactId,
        type: 'marketing-email',
        granted: true,
        source: 'e2e-test',
      },
    });
    expect(create.status()).toBe(201);
    const rec = await create.json();
    expect(rec.id).toBeTruthy();
    expect(rec.granted).toBe(true);

    const list = await request.get(`${API}/gdpr/consent/${throwawayContactId}`, { headers: auth() });
    expect(list.status()).toBe(200);
    const arr = await list.json();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.find((r) => r.id === rec.id)).toBeTruthy();
  });

  test('GET /consent/:contactId 400s for invalid id', async ({ request }) => {
    const res = await request.get(`${API}/gdpr/consent/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('DELETE /contact/:id anonymizes the throwaway contact', async ({ request }) => {
    test.skip(!throwawayContactId, 'no throwaway contact available');
    const res = await request.delete(`${API}/gdpr/contact/${throwawayContactId}`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.anonymized).toBe(true);
    throwawayContactId = null; // already anonymized — don't try to delete again
  });

  test('DELETE /contact/:id 400s for invalid id', async ({ request }) => {
    const res = await request.delete(`${API}/gdpr/contact/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });
});
