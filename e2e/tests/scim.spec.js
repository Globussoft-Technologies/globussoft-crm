// @ts-check
/**
 * Smoke tests for backend/routes/scim.js — generic CRM tenant.
 * Mounted at /api/scim.
 *
 * Two auth modes:
 *   /tokens*       use standard JWT (admin)
 *   /v2/Users*     use SCIM Bearer token (pulled from ScimToken model)
 *
 * The /v2/Users tests would mutate live tenant users (create/patch/delete via
 * SCIM creates real User rows). We mint a SCIM token, exercise list-only,
 * then revoke. The destructive /v2/Users/:id DELETE and POST flows are
 * skipped because seed users have no opt-in for SCIM-driven mutation.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let jwtToken = '';
let scimPlaintext = '';
let scimTokenId = null;
let createdSettingTokens = [];

test.describe.configure({ mode: 'serial' });

test.describe('SCIM API — smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
    jwtToken = (await login.json()).token;
    expect(jwtToken).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdSettingTokens) {
      await request.delete(`${API}/scim/tokens/${id}`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
    }
    createdSettingTokens = [];
  });

  const jwtAuth = () => ({ Authorization: `Bearer ${jwtToken}` });
  const scimAuth = () => ({ Authorization: `Bearer ${scimPlaintext}` });

  // ── Token management (JWT auth) ────────────────────────────────────
  test('GET /api/scim/tokens returns array', async ({ request }) => {
    const res = await request.get(`${API}/scim/tokens`, { headers: jwtAuth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('POST /api/scim/tokens without name → 400', async ({ request }) => {
    const res = await request.post(`${API}/scim/tokens`, { headers: jwtAuth(), data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/scim/tokens creates token (plaintext returned ONCE)', async ({ request }) => {
    const tag = `E2E_AUDIT_${Date.now()}`;
    const res = await request.post(`${API}/scim/tokens`, {
      headers: jwtAuth(),
      data: { name: tag },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^scim_/);
    expect(body.id).toBeTruthy();
    scimPlaintext = body.token;
    scimTokenId = body.id;
    createdSettingTokens.push(body.id);
  });

  test('DELETE /api/scim/tokens/:id 404 for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/scim/tokens/99999999`, { headers: jwtAuth() });
    expect(res.status()).toBe(404);
  });

  // ── SCIM v2 endpoints (Bearer SCIM token) ──────────────────────────
  test('GET /api/scim/v2/Users without bearer → 401 with SCIM Error envelope', async ({ request }) => {
    const res = await request.get(`${API}/scim/v2/Users`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  test('GET /api/scim/v2/Users with junk bearer → 401', async ({ request }) => {
    const res = await request.get(`${API}/scim/v2/Users`, {
      headers: { Authorization: 'Bearer scim_clearly_not_real_token_12345' },
    });
    expect(res.status()).toBe(401);
  });

  test('GET /api/scim/v2/Users with real SCIM token returns ListResponse', async ({ request }) => {
    test.skip(!scimPlaintext, 'no SCIM token minted in this run');
    const res = await request.get(`${API}/scim/v2/Users`, { headers: scimAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
    expect(typeof body.totalResults).toBe('number');
    expect(Array.isArray(body.Resources)).toBe(true);
  });

  test('GET /api/scim/v2/Users/:id with unknown id returns SCIM 404', async ({ request }) => {
    test.skip(!scimPlaintext, 'no SCIM token minted in this run');
    const res = await request.get(`${API}/scim/v2/Users/99999999`, { headers: scimAuth() });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.status).toBe('404');
  });

  test('POST /api/scim/v2/Users without userName → 400', async ({ request }) => {
    test.skip(!scimPlaintext, 'no SCIM token minted in this run');
    const res = await request.post(`${API}/scim/v2/Users`, {
      headers: scimAuth(),
      data: { name: { givenName: 'Aarav', familyName: 'Mehta' } },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /api/scim/v2/Groups returns empty list', async ({ request }) => {
    test.skip(!scimPlaintext, 'no SCIM token minted in this run');
    const res = await request.get(`${API}/scim/v2/Groups`, { headers: scimAuth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(0);
    expect(body.Resources).toEqual([]);
  });

  // eslint-disable-next-line playwright/no-skipped-test
  test.skip('POST /api/scim/v2/Users — would create a real User row', async () => {
    // Skipped: SCIM POST creates a tenant User which is not auto-cleaned
    // by other suites and would pollute the seed list. Manual SCIM tests
    // belong in a dedicated provisioning environment.
  });

  // eslint-disable-next-line playwright/no-skipped-test
  test.skip('PATCH/DELETE /api/scim/v2/Users/:id — would mutate seed users', async () => {
    // Skipped: SCIM PATCH/DELETE rewrite or hard-delete tenant users by id.
    // We don't have a disposable user fixture, and deleting a real seed
    // user would break every other spec.
  });
});
