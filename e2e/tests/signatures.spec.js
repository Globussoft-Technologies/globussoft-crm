// @ts-check
/**
 * Smoke tests for backend/routes/signatures.js — generic CRM tenant.
 * Mounted at /api/signatures.
 *
 * Public (whitelisted in server.js openPaths):
 *   GET  /sign/:token
 *   POST /sign/:token
 *   POST /decline/:token
 *
 * Authenticated (tenant-scoped):
 *   GET  /
 *   POST /                   create + email
 *   GET  /:id
 *   DELETE /:id
 *   POST /:id/resend
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Signatures API — smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    token = (await login.json()).token;
    expect(token).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request.delete(`${API}/signatures/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  // ── Public endpoints ────────────────────────────────────────────────
  test('GET /api/signatures/sign/:token with bogus token → 404', async ({ request }) => {
    const res = await request.get(`${API}/signatures/sign/clearly-not-real-token-${Date.now()}`);
    expect(res.status()).toBe(404);
  });

  test('POST /api/signatures/sign/:token without signature data URL → 400', async ({ request }) => {
    const res = await request.post(`${API}/signatures/sign/anytoken`, {
      data: { signature: 'not-a-data-url' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/signatures/sign/:token with no body → 400', async ({ request }) => {
    const res = await request.post(`${API}/signatures/sign/anytoken`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/signatures/decline/:token with bogus token → 404', async ({ request }) => {
    const res = await request.post(`${API}/signatures/decline/clearly-not-real-${Date.now()}`, {
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  // ── Authenticated endpoints ─────────────────────────────────────────
  test('GET /api/signatures returns array', async ({ request }) => {
    const res = await request.get(`${API}/signatures`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/signatures without auth → 401', async ({ request }) => {
    const res = await request.get(`${API}/signatures`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/signatures without required fields → 400', async ({ request }) => {
    const res = await request.post(`${API}/signatures`, {
      headers: auth(),
      data: { documentType: 'Contract' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/signatures with bad documentType → 400', async ({ request }) => {
    const res = await request.post(`${API}/signatures`, {
      headers: auth(),
      data: {
        documentType: 'WeirdThing',
        documentId: 1,
        signerName: 'Aanya Saxena',
        signerEmail: 'aanya.saxena@example.com',
      },
    });
    expect(res.status()).toBe(400);
  });

  test('POST + GET /:id + DELETE happy path', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const create = await request.post(`${API}/signatures`, {
      headers: auth(),
      data: {
        documentType: 'Custom',
        documentId: 999999, // arbitrary — no FK enforced for Custom
        signerName: `${tag} Devansh Bhatia`,
        signerEmail: `e2e+${Date.now()}@example.com`,
        expiresInDays: 1,
      },
    });
    expect(create.status()).toBe(201);
    const sig = await create.json();
    expect(sig.id).toBeTruthy();
    expect(sig.status).toBe('PENDING');
    expect(sig.signToken).toBeTruthy();
    createdIds.push(sig.id);

    // GET /:id
    const get1 = await request.get(`${API}/signatures/${sig.id}`, { headers: auth() });
    expect(get1.status()).toBe(200);
    expect((await get1.json()).id).toBe(sig.id);

    // Public GET of the sign URL works (whitelisted)
    const pub = await request.get(`${API}/signatures/sign/${sig.signToken}`);
    expect(pub.status()).toBe(200);
    const pubBody = await pub.json();
    expect(pubBody.status).toBe('PENDING');
    expect(pubBody.signerName).toContain('Devansh Bhatia');
  });

  test('GET /api/signatures/:id with non-numeric id → 400', async ({ request }) => {
    const res = await request.get(`${API}/signatures/not-a-number`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/signatures/:id with unknown id → 404', async ({ request }) => {
    const res = await request.get(`${API}/signatures/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/signatures/:id/resend with unknown id → 404', async ({ request }) => {
    const res = await request.post(`${API}/signatures/99999999/resend`, { headers: auth() });
    expect(res.status()).toBe(404);
  });
});
