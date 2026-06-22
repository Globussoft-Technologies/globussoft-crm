// @ts-check
/**
 * Patient soft-delete + restore API coverage (#628).
 *
 * Pre-fix DELETE /api/wellness/patients/:id was a hard-delete that hit
 * Prisma's Restrict policy on the FK chain (visits/Rx/consents/treatment
 * plans / loyalty / referrals) → 409 PATIENT_HAS_CHILDREN whenever the
 * patient had ANY clinical activity. Compliance gap: clinics must keep
 * records for 5+ years, but the only "delete" flow either destroyed
 * everything OR refused to act.
 *
 * Fix (commit Wave-9 closer):
 *   - Patient.deletedAt: DateTime? added to the schema
 *   - DELETE /api/wellness/patients/:id sets deletedAt instead of removing
 *   - POST /api/wellness/patients/:id/restore (admin-only) clears deletedAt
 *   - GET list defaults to where: deletedAt:null; admin/manager can pass
 *     ?includeDeleted=1 to view archived patients
 *   - GET detail returns 404 for soft-deleted rows unless admin+includeDeleted
 *   - Audit-log SOFT_DELETE + RESTORE events on AuditLog
 *
 * Endpoints covered:
 *   DELETE  /api/wellness/patients/:id            — soft-delete (sets deletedAt)
 *   GET     /api/wellness/patients                — soft-deleted hidden by default
 *   GET     /api/wellness/patients?includeDeleted=1 — admin can see archived
 *   GET     /api/wellness/patients/:id            — 404 on soft-deleted
 *   GET     /api/wellness/patients/:id?includeDeleted=1 — admin can read archived
 *   POST    /api/wellness/patients/:id/restore    — clears deletedAt (admin-only)
 *
 * Test data tagged `E2E_PSD_<ts>` so global-teardown picks it up.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_PSD_${Date.now()}`;

let adminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return j.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getAdminToken(request) {
  if (!adminToken) adminToken = await loginAs(request, 'admin@wellness.demo', 'password123');
  return adminToken;
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function adminPost(request, path, body) {
  const t = await getAdminToken(request);
  return request.post(`${BASE_URL}${path}`, { headers: auth(t), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function adminGet(request, path) {
  const t = await getAdminToken(request);
  return request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT });
}
async function adminDelete(request, path) {
  const t = await getAdminToken(request);
  return request.delete(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${t}` }, timeout: REQUEST_TIMEOUT });
}

async function createPatient(request, suffix) {
  // Names use the E2E_PSD_ prefix so demo-monitor scrub picks them up,
  // and a phone with a per-test suffix (last-digit collision avoidance —
  // the (tenantId, normalizedPhone) unique constraint from #401 makes
  // every test need its own number). Retry a few times on duplicate-phone
  // collisions with stale demo data or parallel workers.
  for (let attempt = 0; attempt < 5; attempt++) {
    const phone = `+919${String(Date.now()).slice(-5)}${String(Math.random()).slice(2, 6)}${suffix}`.slice(0, 14);
    const r = await adminPost(request, '/api/wellness/patients', {
      name: `${RUN_TAG} ${suffix}`,
      phone,
      gender: 'M',
    });
    if (r.status() === 201) {
      return await r.json();
    }
    const text = await r.text();
    if (attempt === 4 || !/phone already exists/i.test(text)) {
      throw new Error(`create patient: ${text}`);
    }
  }
  throw new Error('create patient failed after retries');
}

test.describe('Wellness — Patient soft-delete + restore (#628)', () => {
  test('DELETE soft-deletes (sets deletedAt) and removes patient from default list', async ({ request }) => {
    const p = await createPatient(request, '01');
    try {
      const del = await adminDelete(request, `/api/wellness/patients/${p.id}`);
      expect(del.status()).toBe(200);
      const delBody = await del.json();
      expect(delBody.success).toBe(true);
      expect(delBody.id).toBe(p.id);
      // The handler returns the deletedAt timestamp.
      expect(delBody.deletedAt).toBeTruthy();

      // Default list MUST hide the soft-deleted patient.
      const list = await adminGet(request, `/api/wellness/patients?q=${RUN_TAG}+01&limit=50`);
      expect(list.status()).toBe(200);
      const lb = await list.json();
      const hit = (lb.patients || []).find((x) => x.id === p.id);
      expect(hit, 'soft-deleted patient must NOT appear in default list').toBeFalsy();
    } finally {
      // best-effort cleanup — test asserts soft-delete already.
    }
  });

  test('GET /:id on a soft-deleted patient returns 404 by default', async ({ request }) => {
    const p = await createPatient(request, '02');
    await adminDelete(request, `/api/wellness/patients/${p.id}`);
    const r = await adminGet(request, `/api/wellness/patients/${p.id}`);
    expect(r.status()).toBe(404);
  });

  test('Admin can view soft-deleted patient via ?includeDeleted=1', async ({ request }) => {
    const p = await createPatient(request, '03');
    await adminDelete(request, `/api/wellness/patients/${p.id}`);
    const r = await adminGet(request, `/api/wellness/patients/${p.id}?includeDeleted=1`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.id).toBe(p.id);
    expect(body.deletedAt).toBeTruthy();
  });

  test('Admin list with ?includeDeleted=1 includes soft-deleted rows', async ({ request }) => {
    const p = await createPatient(request, '04');
    await adminDelete(request, `/api/wellness/patients/${p.id}`);
    const r = await adminGet(request, `/api/wellness/patients?q=${RUN_TAG}+04&includeDeleted=1&limit=50`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    const hit = (body.patients || []).find((x) => x.id === p.id);
    expect(hit, 'archived patient must appear when includeDeleted=1').toBeTruthy();
    expect(hit.deletedAt).toBeTruthy();
  });

  test('POST /restore clears deletedAt and patient reappears in default list', async ({ request }) => {
    const p = await createPatient(request, '05');
    await adminDelete(request, `/api/wellness/patients/${p.id}`);
    const r = await adminPost(request, `/api/wellness/patients/${p.id}/restore`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.patient.deletedAt).toBeNull();

    // Default list now shows it again.
    const list = await adminGet(request, `/api/wellness/patients?q=${RUN_TAG}+05&limit=50`);
    expect(list.status()).toBe(200);
    const lb = await list.json();
    const hit = (lb.patients || []).find((x) => x.id === p.id);
    expect(hit, 'restored patient must reappear in default list').toBeTruthy();
  });

  test('Restoring a not-deleted patient is idempotent (200 + idempotent flag)', async ({ request }) => {
    const p = await createPatient(request, '06');
    const r = await adminPost(request, `/api/wellness/patients/${p.id}/restore`, {});
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.idempotent).toBe(true);
  });

  test('Soft-deleting an already-soft-deleted patient returns 409', async ({ request }) => {
    const p = await createPatient(request, '07');
    const first = await adminDelete(request, `/api/wellness/patients/${p.id}`);
    expect(first.status()).toBe(200);
    const second = await adminDelete(request, `/api/wellness/patients/${p.id}`);
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.code).toBe('PATIENT_ALREADY_DELETED');
  });
});

test.afterAll(async ({ request }) => {
  void request;
});
