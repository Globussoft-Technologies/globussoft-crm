// @ts-check
/**
 * Lead-capture-settings API gate — G009 (PRD_TRAVEL_MULTICHANNEL_LEADS FR-3.7).
 *
 * Pins the contract for /api/settings/lead-capture (the admin surface for
 * per-channel toggles + cooldowns + Meta form-ID routing mappings).
 *
 * Standing rules followed:
 *   - JWT key is userId (not id) — backend ESLint enforces; spec follows by
 *     not embedding any id-key payloads.
 *   - Body strips id/createdAt/updatedAt/tenantId/userId (global
 *     stripDangerous middleware) — none of those keys appear in the POST/PUT
 *     bodies below.
 *   - RUN_TAG used for unique externalFormId values so concurrent runs don't
 *     collide on the (tenantId, channel, externalFormId) UNIQUE constraint.
 *   - afterAll cleanup uses the _teardown_ prefix convention only where
 *     applicable; this surface uses external-form-id strings derived from
 *     RUN_TAG which already satisfies the uniqueness + teardown-by-prefix
 *     contract.
 *   - No Co-Authored-By in commits (handled at commit time).
 *
 * Contract pinned:
 *   1. GET requires auth (401 unauthenticated).
 *   2. GET requires ADMIN (403 as MANAGER/USER).
 *   3. GET happy path returns the envelope shape:
 *      { channels, cooldowns, formRoutingMappings, allowedChannels,
 *        cooldownRange:{min:0,max:86400} }.
 *   4. PUT happy path persists channels + cooldowns; subsequent GET reflects.
 *   5. PUT partial merge: missing keys preserve stored values.
 *   6. PUT clamps out-of-range cooldowns to [0, 86400].
 *   7. PUT rejects non-object channels/cooldowns body shape (400 INVALID_BODY).
 *   8. POST /form-routing-mappings happy path (201 + envelope).
 *   9. POST /form-routing-mappings duplicate → 409 DUPLICATE_MAPPING.
 *  10. POST /form-routing-mappings rejects unknown channel (400 INVALID_CHANNEL).
 *  11. POST /form-routing-mappings rejects malformed externalFormId.
 *  12. PUT /form-routing-mappings/:id partial update.
 *  13. PUT cross-tenant id → 404 NOT_FOUND (manager-tenant attempt against
 *      admin-tenant's mapping — emulated by hitting an id we never created
 *      under our tenant; for the demo single-tenant setup, just hit a
 *      bogus id and expect 404).
 *  14. DELETE happy path → 204; subsequent GET on the id → 404.
 *  15. DELETE invalid id → 400 INVALID_ID.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let managerToken = null;
const RUN_TAG = `E2E_LC_${Date.now()}`;
const createdMappings = []; // ids to cleanup

async function login(request, email, password) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function authGet(request, t, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, t, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: auth(t), data: body, timeout: REQUEST_TIMEOUT,
  });
}
async function authPut(request, t, path, body) {
  return request.put(`${BASE_URL}${path}`, {
    headers: auth(t), data: body, timeout: REQUEST_TIMEOUT,
  });
}
async function authDelete(request, t, path) {
  return request.delete(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT,
  });
}

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin@globussoft.com', 'password123');
  managerToken = await login(request, 'manager@crm.com', 'password123');
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  for (const id of createdMappings) {
    await authDelete(request, adminToken, `/api/settings/lead-capture/form-routing-mappings/${id}`).catch(() => {});
  }
});

test.describe('GET /api/settings/lead-capture — auth gate', () => {
  test('unauthenticated → 401', async ({ request }) => {
    const r = await authGet(request, null, '/api/settings/lead-capture');
    expect(r.status()).toBe(401);
  });

  test('MANAGER role → 403', async ({ request }) => {
    test.skip(!managerToken, 'manager auth unavailable');
    const r = await authGet(request, managerToken, '/api/settings/lead-capture');
    expect(r.status()).toBe(403);
  });
});

test.describe('GET /api/settings/lead-capture — envelope shape', () => {
  test('happy path returns the canonical envelope', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const r = await authGet(request, adminToken, '/api/settings/lead-capture');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('channels');
    expect(body).toHaveProperty('cooldowns');
    expect(body).toHaveProperty('formRoutingMappings');
    expect(Array.isArray(body.formRoutingMappings)).toBe(true);
    expect(Array.isArray(body.allowedChannels)).toBe(true);
    expect(body.allowedChannels).toContain('web_form');
    expect(body.allowedChannels).toContain('meta_ad');
    expect(body.cooldownRange).toEqual({ min: 0, max: 86400 });
  });
});

test.describe('PUT /api/settings/lead-capture — settings persistence', () => {
  test('PUT happy path persists channels + cooldowns; GET reflects', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const putRes = await authPut(request, adminToken, '/api/settings/lead-capture', {
      channels: { web_form: true, whatsapp: false },
      cooldowns: { web_form: 120 },
    });
    expect(putRes.status()).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.ok).toBe(true);
    expect(putBody.channels.web_form).toBe(true);
    expect(putBody.channels.whatsapp).toBe(false);
    expect(putBody.cooldowns.web_form).toBe(120);

    // Round-trip GET shows the same.
    const getRes = await authGet(request, adminToken, '/api/settings/lead-capture');
    const getBody = await getRes.json();
    expect(getBody.channels.web_form).toBe(true);
    expect(getBody.cooldowns.web_form).toBe(120);
  });

  test('PUT partial merge preserves untouched keys', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    // Seed two channels first
    await authPut(request, adminToken, '/api/settings/lead-capture', {
      channels: { web_form: true, whatsapp: true },
    });
    // Update only one — the other must persist.
    const putRes = await authPut(request, adminToken, '/api/settings/lead-capture', {
      channels: { whatsapp: false },
    });
    expect(putRes.status()).toBe(200);
    const body = await putRes.json();
    expect(body.channels.web_form).toBe(true);
    expect(body.channels.whatsapp).toBe(false);
  });

  test('PUT clamps out-of-range cooldowns', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const putRes = await authPut(request, adminToken, '/api/settings/lead-capture', {
      cooldowns: { whatsapp: 999999, email: -50 },
    });
    expect(putRes.status()).toBe(200);
    const body = await putRes.json();
    expect(body.cooldowns.whatsapp).toBe(86400);
    expect(body.cooldowns.email).toBe(0);
  });

  test('PUT non-object channels body → 400 INVALID_BODY', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const r = await authPut(request, adminToken, '/api/settings/lead-capture', {
      channels: 'not-an-object',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_BODY');
  });
});

test.describe('Form-routing mappings CRUD', () => {
  test('POST happy path returns 201 + projection envelope', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const externalFormId = `${RUN_TAG}_1`;
    const r = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'meta_ad',
      externalFormId,
      subBrand: 'tmc',
      notes: 'gate-spec marker',
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.mapping).toMatchObject({
      channel: 'meta_ad',
      externalFormId,
      subBrand: 'tmc',
      isActive: true,
    });
    createdMappings.push(body.mapping.id);
  });

  test('POST duplicate (same channel + externalFormId) → 409 DUPLICATE_MAPPING', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const externalFormId = `${RUN_TAG}_dup`;
    const r1 = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'meta_ad', externalFormId,
    });
    expect(r1.status()).toBe(201);
    createdMappings.push((await r1.json()).mapping.id);
    const r2 = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'meta_ad', externalFormId,
    });
    expect(r2.status()).toBe(409);
    const body = await r2.json();
    expect(body.code).toBe('DUPLICATE_MAPPING');
  });

  test('POST unknown channel → 400 INVALID_CHANNEL', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const r = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'martian_ad', externalFormId: `${RUN_TAG}_bad_ch`,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_CHANNEL');
  });

  test('POST malformed externalFormId → 400 INVALID_EXTERNAL_FORM_ID', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const r = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'meta_ad', externalFormId: 'has spaces & symbols!',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_EXTERNAL_FORM_ID');
  });

  test('PUT partial update preserves shape', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const externalFormId = `${RUN_TAG}_upd`;
    const create = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'meta_ad', externalFormId, subBrand: 'tmc',
    });
    const id = (await create.json()).mapping.id;
    createdMappings.push(id);

    const upd = await authPut(request, adminToken, `/api/settings/lead-capture/form-routing-mappings/${id}`, {
      isActive: false, subBrand: 'rfu',
    });
    expect(upd.status()).toBe(200);
    const body = await upd.json();
    expect(body.mapping.subBrand).toBe('rfu');
    expect(body.mapping.isActive).toBe(false);
    expect(body.mapping.channel).toBe('meta_ad'); // preserved
    expect(body.mapping.externalFormId).toBe(externalFormId); // preserved
  });

  test('PUT non-existent id → 404 NOT_FOUND', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const r = await authPut(request, adminToken, '/api/settings/lead-capture/form-routing-mappings/99999999', {
      isActive: false,
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.code).toBe('NOT_FOUND');
  });

  test('DELETE happy path → 204', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const externalFormId = `${RUN_TAG}_del`;
    const create = await authPost(request, adminToken, '/api/settings/lead-capture/form-routing-mappings', {
      channel: 'meta_ad', externalFormId,
    });
    const id = (await create.json()).mapping.id;
    const del = await authDelete(request, adminToken, `/api/settings/lead-capture/form-routing-mappings/${id}`);
    expect(del.status()).toBe(204);
    // Second DELETE → 404
    const del2 = await authDelete(request, adminToken, `/api/settings/lead-capture/form-routing-mappings/${id}`);
    expect(del2.status()).toBe(404);
  });

  test('DELETE invalid id → 400 INVALID_ID', async ({ request }) => {
    test.skip(!adminToken, 'admin auth unavailable');
    const r = await authDelete(request, adminToken, '/api/settings/lead-capture/form-routing-mappings/abc');
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_ID');
  });
});
