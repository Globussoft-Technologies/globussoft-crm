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
    const res = await request.post(`${API}/gdpr/export/me`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('exportedAt');
    expect(body).toHaveProperty('user');
    expect(body).toHaveProperty('deals');
    expect(body).toHaveProperty('tasks');
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
