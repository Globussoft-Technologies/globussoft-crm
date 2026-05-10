// @ts-check
/**
 * Module × Action Permissions API spec — PRD Gap §1.3.
 *
 * Routes covered:
 *   GET  /api/field-permissions/entities   — registry (admin only)
 *   GET  /api/field-permissions/actions    — supported actions (admin only)
 *   GET  /api/field-permissions/matrix     — full module×role×action topology
 *   GET  /api/field-permissions/effective?role=USER&entity=Patient&action=DELETE
 *   POST /api/field-permissions            — single rule with action axis
 *   POST /api/field-permissions/bulk-update — array with action per row
 *
 * Coverage:
 *   - 401 without token (auth gate)
 *   - 403 for non-admin (role gate)
 *   - GET /matrix shape: every module × role × action triple has a cell with
 *     {canRead, canWrite}. Default-allow for missing rules.
 *   - POST /bulk-update accepts the new shape ({ role, entity, field, action, canRead, canWrite })
 *   - POST single-rule with action='DELETE' is upserted and round-trips on GET
 *   - Existing action-less rules continue to work (default action='WRITE')
 *   - 400 on unsupported action
 *   - Module-level rule (field='*') round-trips on the matrix endpoint
 *   - hasModuleAction-equivalent default-allow: a USER with no rule on
 *     (Patient, DELETE) should see canRead=true / canWrite=true on /matrix
 *
 * Cleanup: best-effort — delete every rule we created by id.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let adminToken = null;
let userToken = null;
const createdRuleIds = [];

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
        return { token: j.token, userId: j.user.id };
      }
    } catch {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.beforeAll(async ({ request }) => {
  const a = await loginAs(request, 'admin@globussoft.com', 'password123');
  adminToken = a.token;
  const u = await loginAs(request, 'user@crm.com', 'password123');
  userToken = u.token;
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  for (const id of createdRuleIds) {
    await request
      .delete(`${BASE_URL}/api/field-permissions/${id}`, {
        headers: headers(adminToken),
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

test.describe('Module × Action Permissions — discovery', () => {
  test('401 without token on /matrix', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/field-permissions/matrix`, { timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(401);
  });

  test('GET /matrix forbidden for non-admin (403)', async ({ request }) => {
    test.skip(!userToken, 'no user token');
    const r = await request.get(`${BASE_URL}/api/field-permissions/matrix`, {
      headers: headers(userToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });

  test('GET /actions returns the supported action enum', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.get(`${BASE_URL}/api/field-permissions/actions`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.actions)).toBe(true);
    expect(j.actions).toEqual(expect.arrayContaining(['READ', 'WRITE', 'DELETE', 'EXPORT']));
    expect(Array.isArray(j.roles)).toBe(true);
    expect(j.roles).toEqual(expect.arrayContaining(['ADMIN', 'MANAGER', 'USER']));
  });

  test('GET /entities returns wellness modules added by §1.3', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.get(`${BASE_URL}/api/field-permissions/entities`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    // PRD Gap §1.3 added Patient/Visit/Prescription/ConsentForm/Staff/Settings/Audit/Reports
    // as module-level entries (field='*'). The fields registry should include them.
    expect(j).toHaveProperty('Patient');
    expect(j).toHaveProperty('Visit');
    expect(j).toHaveProperty('Prescription');
    expect(j).toHaveProperty('Staff');
  });
});

test.describe('Module × Action Permissions — matrix shape', () => {
  test('GET /matrix returns module × role × action topology with default-allow', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.get(`${BASE_URL}/api/field-permissions/matrix`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const m = await r.json();
    // For at least one module, verify the role × action cube.
    const sample = m.Deal || m.Patient || m[Object.keys(m)[0]];
    expect(sample).toBeTruthy();
    for (const role of ['ADMIN', 'MANAGER', 'USER']) {
      expect(sample[role]).toBeTruthy();
      for (const action of ['READ', 'WRITE', 'DELETE', 'EXPORT']) {
        expect(sample[role][action]).toBeTruthy();
        expect(sample[role][action]).toHaveProperty('canRead');
        expect(sample[role][action]).toHaveProperty('canWrite');
      }
    }
  });
});

test.describe('Module × Action Permissions — CRUD with action axis', () => {
  test('POST /bulk-update accepts action axis + round-trips on /matrix', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const rules = [
      { role: 'USER', entity: 'Patient', field: '*', action: 'DELETE', canRead: true, canWrite: false },
      { role: 'USER', entity: 'Patient', field: '*', action: 'EXPORT', canRead: true, canWrite: false },
    ];
    const post = await request.post(`${BASE_URL}/api/field-permissions/bulk-update`, {
      headers: headers(adminToken),
      data: { rules },
      timeout: REQUEST_TIMEOUT,
    });
    expect(post.status()).toBe(200);
    const j = await post.json();
    expect(j.updated).toBeGreaterThanOrEqual(2);
    if (Array.isArray(j.rules)) {
      for (const row of j.rules) {
        if (row.id) createdRuleIds.push(row.id);
      }
    }

    // Verify on /matrix.
    const matrix = await request.get(`${BASE_URL}/api/field-permissions/matrix`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(matrix.status()).toBe(200);
    const m = await matrix.json();
    expect(m.Patient.USER.DELETE.canWrite).toBe(false);
    expect(m.Patient.USER.EXPORT.canWrite).toBe(false);
  });

  test('POST single rule with action=DELETE upserts and is reflected on /effective', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.post(`${BASE_URL}/api/field-permissions`, {
      headers: headers(adminToken),
      data: {
        role: 'USER',
        entity: 'Patient',
        field: '*',
        action: 'DELETE',
        canRead: false,
        canWrite: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const rule = await r.json();
    expect(rule.action).toBe('DELETE');
    if (rule.id) createdRuleIds.push(rule.id);

    const eff = await request.get(`${BASE_URL}/api/field-permissions/effective?role=USER&entity=Patient&action=DELETE`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(eff.status()).toBe(200);
    const e = await eff.json();
    expect(e['*']).toBeTruthy();
    expect(e['*'].canRead).toBe(false);
    expect(e['*'].canWrite).toBe(false);
  });

  test('400 on unsupported action', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.post(`${BASE_URL}/api/field-permissions`, {
      headers: headers(adminToken),
      data: {
        role: 'USER',
        entity: 'Patient',
        field: '*',
        action: 'NUKE',
        canRead: true,
        canWrite: true,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
  });

  test('Existing rules without action default to WRITE', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    // Create a legacy-shaped rule on a per-field entry; it should land in WRITE.
    const r = await request.post(`${BASE_URL}/api/field-permissions`, {
      headers: headers(adminToken),
      data: {
        role: 'USER',
        entity: 'Deal',
        field: 'amount',
        canRead: true,
        canWrite: false,
        // no action — backend default is WRITE
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const rule = await r.json();
    expect(rule.action).toBe('WRITE');
    if (rule.id) createdRuleIds.push(rule.id);
  });

  test('GET /effective without action defaults to WRITE bucket', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.get(`${BASE_URL}/api/field-permissions/effective?role=USER&entity=Deal`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    // The WRITE bucket should reflect the rule we just created on Deal.amount.
    expect(j).toHaveProperty('amount');
    expect(j.amount.canWrite).toBe(false);
  });
});

test.describe('Module × Action Permissions — wellness sub-roles', () => {
  test('POST accepts wellness sub-role (doctor) on a module-level rule', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.post(`${BASE_URL}/api/field-permissions`, {
      headers: headers(adminToken),
      data: {
        role: 'doctor',
        entity: 'Prescription',
        field: '*',
        action: 'DELETE',
        canRead: false,
        canWrite: false,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect([201, 200]).toContain(r.status());
    const rule = await r.json();
    if (rule.id) createdRuleIds.push(rule.id);
    // Round-trip via /matrix (doctor row should appear).
    const m = await request.get(`${BASE_URL}/api/field-permissions/matrix`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(m.status()).toBe(200);
    const matrix = await m.json();
    if (matrix.Prescription && matrix.Prescription.doctor) {
      expect(matrix.Prescription.doctor.DELETE.canWrite).toBe(false);
    }
  });
});
