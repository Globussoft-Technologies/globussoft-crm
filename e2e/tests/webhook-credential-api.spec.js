// @ts-check
/**
 * Webhook Signing Credential — API coverage.
 *
 * routes/settings.js — the per-tenant HMAC signing credential that replaces
 * the single global WEBHOOK_HMAC_SECRET. Surfaced in the Settings page. Covers:
 *   GET    /api/settings/webhook-credential          — ADMIN, status + entitlement, NEVER leaks secret
 *   POST   /api/settings/webhook-credential          — ADMIN, entitlement-gated, show-once raw secret, 409 if active
 *   POST   /api/settings/webhook-credential/rotate   — ADMIN, show-once new secret, differs from first
 *   DELETE /api/settings/webhook-credential          — ADMIN, revoke (status REVOKED)
 *
 * Auth: admin@globussoft.com (generic tenant, seeded TRIAL with a 15-day
 * trial → entitled, so generation/rotation return 201/200 deterministically).
 * Role gate uses manager@crm.com (MANAGER → 403).
 *
 * Show-once contract pinned here: POST/rotate responses INCLUDE `secret`
 * (the raw value); GET responses NEVER do. There is no reveal endpoint.
 *
 * State note: tenantId is @unique so there is ONE credential row per tenant,
 * shared across these tests — hence `mode: 'serial'` for the lifecycle block.
 * Re-runs are safe: generate reactivates a previously-REVOKED row (no 409),
 * and afterAll revokes so the tenant is left in a known state.
 *
 * The 402-not-entitled gate is covered at the unit layer
 * (backend/test/lib/webhookEntitlement.test.js) — every seeded tenant here is
 * trial-entitled, so it can't be exercised deterministically from e2e.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let managerToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getAdmin(request) {
  if (!adminToken) adminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  return adminToken;
}
async function getManager(request) {
  if (!managerToken) managerToken = await loginAs(request, 'manager@crm.com', 'password123');
  return managerToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const get = (request, token) => request.get(`${BASE_URL}/api/settings/webhook-credential`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
const gen = (request, token) => request.post(`${BASE_URL}/api/settings/webhook-credential`, { headers: headers(token), data: {}, timeout: REQUEST_TIMEOUT });
const rotate = (request, token) => request.post(`${BASE_URL}/api/settings/webhook-credential/rotate`, { headers: headers(token), data: {}, timeout: REQUEST_TIMEOUT });
const revoke = (request, token) => request.delete(`${BASE_URL}/api/settings/webhook-credential`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

test.afterAll(async ({ request }) => {
  const token = await getAdmin(request);
  if (token) await revoke(request, token).catch(() => {});
});

// ── Auth + role gates ───────────────────────────────────────────────

test.describe('Webhook Credential API — auth + role gates', () => {
  test('GET without token → 401', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/settings/webhook-credential`, { timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(401);
  });

  test('POST without token → 401', async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/settings/webhook-credential`, { data: {}, headers: { 'Content-Type': 'application/json' }, timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(401);
  });

  test('GET as MANAGER (non-admin) → 403', async ({ request }) => {
    const token = await getManager(request);
    test.skip(!token, 'manager login unavailable');
    const r = await get(request, token);
    expect(r.status()).toBe(403);
  });

  test('POST as MANAGER (non-admin) → 403', async ({ request }) => {
    const token = await getManager(request);
    test.skip(!token, 'manager login unavailable');
    const r = await gen(request, token);
    expect(r.status()).toBe(403);
  });
});

// ── Lifecycle (serial — shares the single per-tenant credential row) ──

test.describe('Webhook Credential API — lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  let firstSecret = null;

  test('GET returns entitlement + signing block, never a raw secret', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await get(request, token);
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('exists');
    expect(body).toHaveProperty('entitled');
    expect(body.entitled).toBe(true); // seeded admin is trial-entitled
    expect(body).not.toHaveProperty('secret'); // never leaks the raw secret
    expect(body.signing).toMatchObject({
      header: 'X-Globussoft-Signature',
      algorithm: 'HMAC-SHA256',
    });
  });

  test('POST generates a credential and returns the raw secret ONCE', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    // Clean slate: if an ACTIVE credential lingers from a prior run, revoke so
    // generate doesn't 409. (A revoked row is reactivated by generate.)
    const pre = await get(request, token);
    if ((await pre.json()).status === 'ACTIVE') await revoke(request, token);

    const r = await gen(request, token);
    expect(r.status(), await r.text()).toBe(201);
    const body = await r.json();
    expect(body.exists).toBe(true);
    expect(body.status).toBe('ACTIVE');
    expect(typeof body.secret).toBe('string');
    expect(body.secret).toMatch(/^[a-f0-9]{64}$/); // 32-byte hex
    expect(body.signingId).toMatch(/^whid_[a-f0-9]+$/);
    firstSecret = body.secret;
  });

  test('GET after generate exposes status/metadata but NOT the secret', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await get(request, token);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.exists).toBe(true);
    expect(body.status).toBe('ACTIVE');
    expect(body.signingId).toMatch(/^whid_[a-f0-9]+$/);
    expect(body).not.toHaveProperty('secret'); // show-once: not retrievable
    expect(body.secretMasked).not.toContain(firstSecret); // hint isn't the secret
  });

  test('POST again while ACTIVE → 409 (must rotate)', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await gen(request, token);
    expect(r.status(), await r.text()).toBe(409);
    expect((await r.json()).code).toBe('CREDENTIAL_EXISTS');
  });

  test('rotate returns a NEW raw secret different from the first', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await rotate(request, token);
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    expect(typeof body.secret).toBe('string');
    expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.secret).not.toBe(firstSecret); // rotation actually changed it
    expect(body.lastRotatedAt).toBeTruthy();
  });

  test('revoke sets status REVOKED', async ({ request }) => {
    const token = await getAdmin(request);
    test.skip(!token, 'admin login unavailable');
    const r = await revoke(request, token);
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('REVOKED');

    const after = await get(request, token);
    expect((await after.json()).status).toBe('REVOKED');
  });
});
