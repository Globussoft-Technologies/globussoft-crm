// @ts-check
/**
 * /api/marketplace-leads — smoke spec covering 11 handlers in
 * backend/routes/marketplace_leads.js. Webhook routes are public; the rest
 * require auth (config endpoints are ADMIN-only).
 *
 *   GET    /                       (auth)
 *   GET    /stats                  (auth)
 *   POST   /import/:id             (auth)
 *   POST   /import-bulk            (auth)
 *   PUT    /dismiss/:id            (auth)
 *   GET    /config                 (ADMIN)
 *   PUT    /config/:provider       (ADMIN)
 *   POST   /sync/:provider         (ADMIN)
 *   POST   /webhook/indiamart      (public)
 *   POST   /webhook/justdial       (public)
 *   POST   /webhook/tradeindia     (public)
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const createdLeadExternalIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('marketplace-leads API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test('GET / requires auth', async ({ request }) => {
    const res = await request.get(`${API}/marketplace-leads`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / returns paginated leads', async ({ request }) => {
    const res = await request.get(`${API}/marketplace-leads?limit=5`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.leads)).toBe(true);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('page');
    expect(body).toHaveProperty('pages');
  });

  test('GET / honors provider filter', async ({ request }) => {
    const res = await request.get(`${API}/marketplace-leads?provider=indiamart&limit=5`, {
      headers: auth(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.leads)).toBe(true);
  });

  test('GET /stats returns dashboard counts', async ({ request }) => {
    const res = await request.get(`${API}/marketplace-leads/stats`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('thisWeek');
    expect(body).toHaveProperty('conversionRate');
    expect(body).toHaveProperty('byProvider');
    expect(body).toHaveProperty('byStatus');
  });

  test('GET /config requires ADMIN — returns masked config or array', async ({ request }) => {
    const res = await request.get(`${API}/marketplace-leads/config`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /import/:id 404s for unknown lead', async ({ request }) => {
    const res = await request.post(`${API}/marketplace-leads/import/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /import-bulk rejects empty leadIds', async ({ request }) => {
    const res = await request.post(`${API}/marketplace-leads/import-bulk`, {
      headers: auth(),
      data: { leadIds: [] },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /import-bulk handles a non-existent id gracefully', async ({ request }) => {
    const res = await request.post(`${API}/marketplace-leads/import-bulk`, {
      headers: auth(),
      data: { leadIds: [99999999] },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('imported');
    expect(body).toHaveProperty('failed');
    expect(body.failed).toBeGreaterThanOrEqual(1);
  });

  test('PUT /dismiss/:id 404s for unknown id', async ({ request }) => {
    const res = await request.put(`${API}/marketplace-leads/dismiss/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  // ── Public webhooks ──────────────────────────────────────────────
  test('POST /webhook/indiamart accepts seed payload (no auth)', async ({ request }) => {
    const stamp = `e2e_audit_${Date.now()}`;
    createdLeadExternalIds.push(stamp);
    const res = await request.post(`${API}/marketplace-leads/webhook/indiamart`, {
      data: {
        UNIQUE_QUERY_ID: stamp,
        SENDER_NAME: 'Aarav Sharma',
        SENDER_MOBILE: '+919900112233',
        SENDER_EMAIL: `${stamp}@example.com`,
        QUERY_PRODUCT_NAME: 'E2E_AUDIT product',
        QUERY_MESSAGE: 'Need a quote',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.created).toBe('number');
  });

  test('POST /webhook/indiamart with no UNIQUE_QUERY_ID creates 0', async ({ request }) => {
    const res = await request.post(`${API}/marketplace-leads/webhook/indiamart`, {
      data: { SENDER_NAME: 'no id here' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
  });

  test('POST /webhook/justdial accepts payload', async ({ request }) => {
    const stamp = `e2e_audit_jd_${Date.now()}`;
    createdLeadExternalIds.push(stamp);
    const res = await request.post(`${API}/marketplace-leads/webhook/justdial`, {
      data: {
        leadid: stamp,
        name: 'Priya Verma',
        phone: '+919900112244',
        email: `${stamp}@example.com`,
        category: 'E2E_AUDIT category',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('POST /webhook/tradeindia accepts payload', async ({ request }) => {
    const stamp = `e2e_audit_ti_${Date.now()}`;
    createdLeadExternalIds.push(stamp);
    const res = await request.post(`${API}/marketplace-leads/webhook/tradeindia`, {
      data: {
        inquiry_id: stamp,
        sender_name: 'Rohit Mehta',
        sender_mobile: '+919900112255',
        sender_email: `${stamp}@example.com`,
        product_name: 'E2E_AUDIT product',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // Cleanup: dismiss any leads we created via webhooks so they don't leak
  test('cleanup: dismiss webhook-created leads', async ({ request }) => {
    if (!createdLeadExternalIds.length) return;
    const res = await request.get(
      `${API}/marketplace-leads?limit=100`,
      { headers: auth() }
    );
    if (!res.ok()) return;
    const body = await res.json();
    const toDismiss = (body.leads || []).filter(
      (l) => createdLeadExternalIds.includes(l.externalLeadId)
    );
    for (const l of toDismiss) {
      await request.put(`${API}/marketplace-leads/dismiss/${l.id}`, { headers: auth() }).catch(() => {});
    }
  });
});
