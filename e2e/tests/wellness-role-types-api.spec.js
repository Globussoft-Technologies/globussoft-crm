// @ts-check
/**
 * Wellness role catalog — per-push gate spec.
 *
 * Pins the contract for the per-tenant WellnessRoleType catalog (Option B —
 * replaces the hard-coded VALID_WELLNESS_ROLES whitelist in routes/staff.js
 * with admin-maintained rows). Admins add custom roles like "nurse" from
 * Settings → Wellness Role Types; the Calendar grid + Staff edit form
 * read from this catalog so a new role surfaces without a code change.
 *
 * Endpoints covered:
 *   GET    /api/wellness/role-types           — list, ?activeOnly=1 filter
 *   POST   /api/wellness/role-types           — admin/manager create, validation
 *   PUT    /api/wellness/role-types/:id       — toggle isActive, canTakeVisits, rename
 *   DELETE /api/wellness/role-types/:id       — refuses when staff use the role
 *
 * Status-code + error-key contracts pinned here:
 *   POST
 *     201 + row                          — admin / manager with valid input
 *     400 {code: ROLE_KEY_REQUIRED}      — empty key
 *     400 {code: INVALID_ROLE_KEY}       — uppercase / spaces / special chars
 *     400 {code: ROLE_LABEL_REQUIRED}    — empty label
 *     409 {code: ROLE_KEY_DUPLICATE}     — key already in tenant catalog
 *     403 {code: WELLNESS_ROLE_FORBIDDEN} — caller is doctor / professional / telecaller / helper
 *     403 {code: WELLNESS_TENANT_REQUIRED} — caller is on a generic tenant
 *   PUT
 *     200 + row                          — toggle isActive / canTakeVisits
 *     404                                — unknown id
 *     409 {code: ROLE_KEY_IN_USE}        — rename blocked by assigned staff
 *   DELETE
 *     200 {ok: true}                     — unused role
 *     409 {code: ROLE_IN_USE}            — role currently assigned to staff
 *     404                                — unknown id
 *
 * Staff endpoint integration (proves the staff.js whitelist was replaced):
 *   POST /api/staff body wellnessRole="nurse" → 201 only when "nurse" exists
 *     in the catalog; otherwise 400 {code: ROLE_NOT_IN_CATALOG}.
 *
 * Persona table (seeded by prisma/seed-wellness.js):
 *   admin@wellness.demo            — RBAC ADMIN (passes admin gate)
 *   manager@enhancedwellness.in    — RBAC MANAGER (passes manager gate)
 *   drharsh@enhancedwellness.in    — wellnessRole=doctor (denied)
 *   stylist1@enhancedwellness.in   — wellnessRole=professional (denied)
 *   telecaller@enhancedwellness.in — wellnessRole=telecaller (denied)
 *   helper1@enhancedwellness.in    — wellnessRole=helper (denied)
 *   admin@globussoft.com           — generic-tenant ADMIN (wrong vertical)
 *
 * RUN_TAG: `E2E_ROLE_<ts>` — afterAll cleans up every created row by id.
 *
 * stripDangerous reminder: the global middleware deletes
 * `id, createdAt, updatedAt, tenantId, userId, isAdmin, passwordHash,
 * portalPasswordHash` from every request body. None of those are referenced
 * here — role-type POSTs are key/label/canTakeVisits/icon/color-shaped only.
 */
const { test, expect } = require('@playwright/test');

// Tests in this file create + read back + mutate catalog rows under the
// same tenant. With fullyParallel:true + 2 workers, parallel shuffle
// scrambles ordering and races on the create-then-delete tests. Pin to
// serial.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `e2erole${Date.now()}`; // lowercase + digits only — fits ROLE_KEY_RE

// ── Fixtures ───────────────────────────────────────────────────────
const FIXTURES = {
  admin:      { email: 'admin@wellness.demo',            password: 'password123' },
  manager:    { email: 'manager@enhancedwellness.in',    password: 'password123' },
  drharsh:    { email: 'drharsh@enhancedwellness.in',    password: 'password123' },
  stylist:    { email: 'stylist1@enhancedwellness.in',   password: 'password123' },
  telecaller: { email: 'telecaller@enhancedwellness.in', password: 'password123' },
  helper:     { email: 'helper1@enhancedwellness.in',    password: 'password123' },
  generic:    { email: 'admin@globussoft.com',           password: 'password123' },
};

const tokenCache = {};

async function login(request, who) {
  if (tokenCache[who]) return tokenCache[who];
  const fixture = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const data = await r.json();
        tokenCache[who] = data.token;
        return data.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${await login(request, who)}`,
  'Content-Type': 'application/json',
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${API}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'admin') {
  return request.post(`${API}${path}`, {
    headers: await authHdr(request, who),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPut(request, path, body, who = 'admin') {
  return request.put(`${API}${path}`, {
    headers: await authHdr(request, who),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function authDelete(request, path, who = 'admin') {
  return request.delete(`${API}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}

// Track every catalog row + staff member we create so afterAll can clean up.
const createdRoleIds = [];
const createdUserEmails = [];

test.afterAll(async ({ request }) => {
  if (!tokenCache.admin) return;
  // Delete staff first — DELETE on role 409s while staff is assigned.
  for (const email of createdUserEmails) {
    try {
      const list = await authGet(request, '/staff');
      if (list.ok()) {
        const users = await list.json();
        const found = users.find((u) => u.email === email);
        if (found) {
          await authDelete(request, `/staff/${found.id}`).catch(() => {});
        }
      }
    } catch (_e) { /* swallow */ }
  }
  for (const id of createdRoleIds) {
    await authDelete(request, `/wellness/role-types/${id}`).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────────────────
// Auth + tenant-vertical gates
// ──────────────────────────────────────────────────────────────────────

test.describe('auth + tenant gates', () => {
  test('GET without token → 401', async ({ request }) => {
    const r = await request.get(`${API}/wellness/role-types`, { timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(401);
  });

  test('POST as generic-tenant admin → 403 WELLNESS_TENANT_REQUIRED', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', {
      key: `${RUN_TAG}1`, label: 'Test',
    }, 'generic');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });

  test('POST as doctor → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', {
      key: `${RUN_TAG}1`, label: 'Test',
    }, 'drharsh');
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(Array.isArray(body.allowed)).toBe(true);
  });

  test('POST as telecaller → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', {
      key: `${RUN_TAG}1`, label: 'Test',
    }, 'telecaller');
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('POST as helper → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', {
      key: `${RUN_TAG}1`, label: 'Test',
    }, 'helper');
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});

// ──────────────────────────────────────────────────────────────────────
// GET — list + ?activeOnly filter
// ──────────────────────────────────────────────────────────────────────

test.describe('GET /wellness/role-types', () => {
  test('returns the seeded default catalog including "nurse"', async ({ request }) => {
    const r = await authGet(request, '/wellness/role-types');
    expect(r.ok()).toBe(true);
    const rows = await r.json();
    expect(Array.isArray(rows)).toBe(true);
    const keys = rows.map((r) => r.key);
    // Every legacy whitelist entry should be in the seeded catalog.
    for (const k of ['doctor', 'professional', 'telecaller', 'helper', 'stylist']) {
      expect(keys).toContain(k);
    }
    // "nurse" is the new addition motivating Option B.
    expect(keys).toContain('nurse');
  });

  test('canTakeVisits is a boolean on every row', async ({ request }) => {
    const r = await authGet(request, '/wellness/role-types');
    const rows = await r.json();
    for (const row of rows) {
      expect(typeof row.canTakeVisits).toBe('boolean');
    }
  });

  test('telecaller + helper are operational (canTakeVisits=false)', async ({ request }) => {
    const r = await authGet(request, '/wellness/role-types');
    const rows = await r.json();
    const t = rows.find((x) => x.key === 'telecaller');
    const h = rows.find((x) => x.key === 'helper');
    expect(t?.canTakeVisits).toBe(false);
    expect(h?.canTakeVisits).toBe(false);
  });

  test('doctor + nurse are practitioners (canTakeVisits=true)', async ({ request }) => {
    const r = await authGet(request, '/wellness/role-types');
    const rows = await r.json();
    const d = rows.find((x) => x.key === 'doctor');
    const n = rows.find((x) => x.key === 'nurse');
    expect(d?.canTakeVisits).toBe(true);
    expect(n?.canTakeVisits).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST — validation + happy path
// ──────────────────────────────────────────────────────────────────────

test.describe('POST /wellness/role-types — validation', () => {
  test('empty key → 400 ROLE_KEY_REQUIRED', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', { key: '', label: 'X' });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('ROLE_KEY_REQUIRED');
  });

  test('uppercase in key → 400 INVALID_ROLE_KEY', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', { key: 'Nurse', label: 'Nurse' });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ROLE_KEY');
  });

  test('space in key → 400 INVALID_ROLE_KEY', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', { key: 'senior nurse', label: 'X' });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ROLE_KEY');
  });

  test('underscore in key → 400 INVALID_ROLE_KEY', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', { key: 'senior_nurse', label: 'X' });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_ROLE_KEY');
  });

  test('empty label → 400 ROLE_LABEL_REQUIRED', async ({ request }) => {
    const r = await authPost(request, '/wellness/role-types', { key: `${RUN_TAG}empty`, label: '' });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('ROLE_LABEL_REQUIRED');
  });

  test('duplicate key → 409 ROLE_KEY_DUPLICATE', async ({ request }) => {
    // "doctor" is in the seeded catalog already.
    const r = await authPost(request, '/wellness/role-types', { key: 'doctor', label: 'Another Doctor' });
    expect(r.status()).toBe(409);
    expect((await r.json()).code).toBe('ROLE_KEY_DUPLICATE');
  });
});

test.describe('POST /wellness/role-types — happy path', () => {
  test('admin creates a new role with defaults', async ({ request }) => {
    const key = `${RUN_TAG}admin`;
    const r = await authPost(request, '/wellness/role-types', { key, label: 'E2E Admin Role' });
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdRoleIds.push(body.id);
    expect(body.key).toBe(key);
    expect(body.label).toBe('E2E Admin Role');
    expect(body.canTakeVisits).toBe(true); // default
    expect(body.isActive).toBe(true); // default
  });

  test('manager can create a role too', async ({ request }) => {
    const key = `${RUN_TAG}mgr`;
    const r = await authPost(request, '/wellness/role-types', {
      key, label: 'E2E Manager Role', canTakeVisits: false,
    }, 'manager');
    expect(r.status()).toBe(201);
    const body = await r.json();
    createdRoleIds.push(body.id);
    expect(body.canTakeVisits).toBe(false);
  });

  test('newly-created role appears in GET list', async ({ request }) => {
    const key = `${RUN_TAG}list`;
    const created = await authPost(request, '/wellness/role-types', { key, label: 'E2E List Role' });
    expect(created.status()).toBe(201);
    createdRoleIds.push((await created.json()).id);

    const list = await authGet(request, '/wellness/role-types');
    const rows = await list.json();
    expect(rows.map((r) => r.key)).toContain(key);
  });
});

// ──────────────────────────────────────────────────────────────────────
// PUT — toggles + rename guard
// ──────────────────────────────────────────────────────────────────────

test.describe('PUT /wellness/role-types/:id', () => {
  test('404 on unknown id', async ({ request }) => {
    const r = await authPut(request, '/wellness/role-types/9999999', { label: 'nope' });
    expect(r.status()).toBe(404);
  });

  test('toggles isActive', async ({ request }) => {
    const key = `${RUN_TAG}toggle`;
    const created = await authPost(request, '/wellness/role-types', { key, label: 'E2E Toggle Role' });
    const id = (await created.json()).id;
    createdRoleIds.push(id);

    const off = await authPut(request, `/wellness/role-types/${id}`, { isActive: false });
    expect(off.ok()).toBe(true);
    expect((await off.json()).isActive).toBe(false);

    const on = await authPut(request, `/wellness/role-types/${id}`, { isActive: true });
    expect((await on.json()).isActive).toBe(true);
  });

  test('toggles canTakeVisits', async ({ request }) => {
    const key = `${RUN_TAG}ctv`;
    const created = await authPost(request, '/wellness/role-types', {
      key, label: 'E2E CTV Role', canTakeVisits: true,
    });
    const id = (await created.json()).id;
    createdRoleIds.push(id);

    const off = await authPut(request, `/wellness/role-types/${id}`, { canTakeVisits: false });
    expect((await off.json()).canTakeVisits).toBe(false);
  });

  test('?activeOnly=1 excludes deactivated rows', async ({ request }) => {
    const key = `${RUN_TAG}hidden`;
    const created = await authPost(request, '/wellness/role-types', { key, label: 'E2E Hidden Role' });
    const id = (await created.json()).id;
    createdRoleIds.push(id);

    await authPut(request, `/wellness/role-types/${id}`, { isActive: false });

    const all = await authGet(request, '/wellness/role-types');
    const allKeys = (await all.json()).map((r) => r.key);
    expect(allKeys).toContain(key);

    const active = await authGet(request, '/wellness/role-types?activeOnly=1');
    const activeKeys = (await active.json()).map((r) => r.key);
    expect(activeKeys).not.toContain(key);
  });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE — refuses when in use
// ──────────────────────────────────────────────────────────────────────

test.describe('DELETE /wellness/role-types/:id', () => {
  test('404 on unknown id', async ({ request }) => {
    const r = await authDelete(request, '/wellness/role-types/9999999');
    expect(r.status()).toBe(404);
  });

  test('unused role can be deleted', async ({ request }) => {
    const key = `${RUN_TAG}delok`;
    const created = await authPost(request, '/wellness/role-types', { key, label: 'E2E Delete Me' });
    const id = (await created.json()).id;

    const del = await authDelete(request, `/wellness/role-types/${id}`);
    expect(del.ok()).toBe(true);
    expect((await del.json()).ok).toBe(true);

    // Verify gone.
    const list = await authGet(request, '/wellness/role-types');
    const keys = (await list.json()).map((r) => r.key);
    expect(keys).not.toContain(key);
  });

  test('role in use by a staff member → 409 ROLE_IN_USE', async ({ request }) => {
    const key = `${RUN_TAG}inuse`;
    const created = await authPost(request, '/wellness/role-types', { key, label: 'E2E InUse Role' });
    const roleId = (await created.json()).id;
    createdRoleIds.push(roleId);

    // Create a staff member with this wellnessRole.
    const email = `${RUN_TAG}-inuse@e2e.test`;
    const staff = await authPost(request, '/staff', {
      name: 'InUse Staff', email, password: 'password123',
      role: 'USER', wellnessRole: key,
    });
    expect(staff.status()).toBe(201);
    createdUserEmails.push(email);

    const del = await authDelete(request, `/wellness/role-types/${roleId}`);
    expect(del.status()).toBe(409);
    const body = await del.json();
    expect(body.code).toBe('ROLE_IN_USE');
    expect(typeof body.inUseCount).toBe('number');
    expect(body.inUseCount).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Staff.js integration — catalog drives wellnessRole validation
// ──────────────────────────────────────────────────────────────────────

test.describe('staff.js wellnessRole catalog integration', () => {
  test('POST /staff with cataloged key → 201', async ({ request }) => {
    const key = `${RUN_TAG}cat`;
    const created = await authPost(request, '/wellness/role-types', { key, label: 'E2E Catalog Role' });
    expect(created.status()).toBe(201);
    createdRoleIds.push((await created.json()).id);

    const email = `${RUN_TAG}-cat@e2e.test`;
    const staff = await authPost(request, '/staff', {
      name: 'Cataloged Staff', email, password: 'password123',
      role: 'USER', wellnessRole: key,
    });
    expect(staff.status()).toBe(201);
    createdUserEmails.push(email);
    const body = await staff.json();
    expect(body.wellnessRole).toBe(key);
  });

  test('POST /staff with non-cataloged key → 400 ROLE_NOT_IN_CATALOG', async ({ request }) => {
    const email = `${RUN_TAG}-bad@e2e.test`;
    const staff = await authPost(request, '/staff', {
      name: 'Bad Role Staff', email, password: 'password123',
      role: 'USER', wellnessRole: `${RUN_TAG}does-not-exist`,
    });
    expect(staff.status()).toBe(400);
    expect((await staff.json()).code).toBe('ROLE_NOT_IN_CATALOG');
  });

  test('POST /staff with built-in "nurse" key → 201 (proves seed defaults work)', async ({ request }) => {
    const email = `${RUN_TAG}-nurse@e2e.test`;
    const staff = await authPost(request, '/staff', {
      name: 'E2E Nurse', email, password: 'password123',
      role: 'USER', wellnessRole: 'nurse',
    });
    expect(staff.status()).toBe(201);
    createdUserEmails.push(email);
    const body = await staff.json();
    expect(body.wellnessRole).toBe('nurse');
  });
});
