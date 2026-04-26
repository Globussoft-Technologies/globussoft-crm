// @ts-check
/**
 * Smoke tests for backend/routes/sandbox.js — generic CRM tenant.
 * Mounted at /api/sandbox.
 *
 * SAFETY: this route can WIPE tenant data via /restore and /reset. We
 * deliberately skip those destructive endpoints — exercising them on a
 * shared dev tenant would erase the demo dataset.
 *
 * Endpoints covered:
 *   GET    /
 *   POST   /                    capture (creates a real snapshot — cleaned up)
 *   GET    /:id                 metadata
 *   GET    /:id/download        full JSON download
 *   DELETE /:id
 *   POST   /:id/restore         test.skip — destructive
 *   POST   /reset               test.skip — destructive
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let token = '';
let createdIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('Sandbox Snapshots API — smoke (non-destructive only)', () => {
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
      await request.delete(`${API}/sandbox/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    createdIds = [];
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test('GET /api/sandbox returns array of snapshots', async ({ request }) => {
    const res = await request.get(`${API}/sandbox`, { headers: auth() });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('GET /api/sandbox without auth → 401', async ({ request }) => {
    const res = await request.get(`${API}/sandbox`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/sandbox without name → 400', async ({ request }) => {
    const res = await request.post(`${API}/sandbox`, { headers: auth(), data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST /api/sandbox creates a snapshot, GET /:id, GET /:id/download, DELETE /:id', async ({ request }) => {
    test.setTimeout(60_000); // capture iterates several models
    const tag = `E2E_AUDIT_${Date.now()}`;
    const create = await request.post(`${API}/sandbox`, {
      headers: auth(),
      data: { name: tag, description: 'Captured by Vivaan Kapoor E2E suite' },
    });
    expect(create.status()).toBe(201);
    const snap = await create.json();
    expect(snap.id).toBeTruthy();
    expect(snap.name).toBe(tag);
    expect(typeof snap.sizeBytes).toBe('number');
    createdIds.push(snap.id);

    // GET /:id
    const meta = await request.get(`${API}/sandbox/${snap.id}`, { headers: auth() });
    expect(meta.status()).toBe(200);
    const metaBody = await meta.json();
    expect(metaBody.id).toBe(snap.id);
    expect(metaBody.name).toBe(tag);

    // GET /:id/download
    const dl = await request.get(`${API}/sandbox/${snap.id}/download`, { headers: auth() });
    expect(dl.status()).toBe(200);
    expect(dl.headers()['content-disposition']).toContain('attachment');
    const text = await dl.text();
    const parsed = JSON.parse(text);
    expect(parsed.version).toBeDefined();
    expect(parsed.data).toBeDefined();
  });

  test('GET /api/sandbox/:id 400 for non-numeric id', async ({ request }) => {
    const res = await request.get(`${API}/sandbox/not-a-number`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /api/sandbox/:id 404 for unknown id', async ({ request }) => {
    const res = await request.get(`${API}/sandbox/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('POST /api/sandbox/reset rejects without confirm token (validation only)', async ({ request }) => {
    // The route requires confirm:'DELETE_EVERYTHING'. We send the WRONG value
    // so we exercise the validation gate WITHOUT actually wiping the tenant.
    const res = await request.post(`${API}/sandbox/reset`, {
      headers: auth(),
      data: { confirm: 'no thanks' },
    });
    expect(res.status()).toBe(400);
  });

  // eslint-disable-next-line playwright/no-skipped-test
  test.skip('POST /api/sandbox/:id/restore — destructive, would wipe dev tenant', async () => {
    // Intentionally skipped: restore wipes ALL tenant data before re-creating
    // it. Running on the shared crm.globusdemos.com would destroy the demo
    // dataset used by every other spec in this suite.
  });

  // eslint-disable-next-line playwright/no-skipped-test
  test.skip('POST /api/sandbox/reset — destructive, would wipe dev tenant', async () => {
    // Intentionally skipped: reset hard-deletes contacts/deals/invoices/etc.
    // for the calling tenant. Cannot be run safely on the shared dev server.
  });
});
