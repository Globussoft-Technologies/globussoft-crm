// @ts-check
/**
 * Page catalog + permission-driven landing-page endpoints.
 *
 * Covers:
 *   GET  /api/pages/catalog                       — full catalog metadata
 *   GET  /api/pages/me                            — accessible to signed-in user
 *   GET  /api/roles/:id/accessible-pages          — accessible to a specific role
 *   PUT  /api/roles/:id (landingPath)             — rejected when role lacks perms
 *   PUT  /api/roles/:id/permissions               — auto-clears landingPath when
 *                                                   the previously-set page is no
 *                                                   longer accessible
 *
 * Pins the contract: a Role.landingPath can only point at a page the
 * role has permission to access. Revoking the permission auto-clears
 * the landingPath so users don't get redirected to a 403 on next login.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_PAGES_${Date.now()}`;

/** @typedef {import('@playwright/test').APIRequestContext} Req */

/** @type {string | null} */
let adminToken = null;

/** @param {Req} request */
async function loginAdmin(request) {
  if (adminToken) return adminToken;
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  const j = await r.json();
  adminToken = j.token;
  return adminToken;
}

/** @param {string | null} token */
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/** @param {Req} request @param {string | null} token @param {string} path */
const get = (request, token, path) =>
  request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
/** @param {Req} request @param {string | null} token @param {string} path @param {any} body */
const post = (request, token, path, body) =>
  request.post(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
/** @param {Req} request @param {string | null} token @param {string} path @param {any} body */
const put = (request, token, path, body) =>
  request.put(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
/** @param {Req} request @param {string | null} token @param {string} path */
const del = (request, token, path) =>
  request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

const createdRoleIds = new Set();

test.afterAll(async ({ request }) => {
  const token = await loginAdmin(request);
  if (!token) return;
  for (const id of createdRoleIds) {
    await del(request, token, `/api/roles/${id}`).catch(() => {});
  }
});

// ── GET /api/pages/catalog ──────────────────────────────────────────

test.describe('GET /api/pages/catalog', () => {
  test('200 returns the static page catalog with categories', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await get(request, token, '/api/pages/catalog');
    expect(res.status(), await res.text()).toBe(200);
    /** @type {{ catalog: Array<{ path: string, label: string, requiredPermissions: Array<{module: string, action: string}> }>, categories: string[] }} */
    const body = await res.json();
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(body.catalog.length).toBeGreaterThan(10);
    const paths = body.catalog.map((p) => p.path);
    expect(paths).toContain('/home');
    expect(paths).toContain('/wellness/patients');
  });

  test('401 without a token', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/pages/catalog`);
    expect(r.status()).toBe(401);
  });
});

// ── GET /api/pages/me ───────────────────────────────────────────────

test.describe('GET /api/pages/me', () => {
  test('200 returns admin-accessible pages (admin has all perms → big list)', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const res = await get(request, token, '/api/pages/me');
    expect(res.status()).toBe(200);
    /** @type {{ pages: Array<{ path: string }> }} */
    const body = await res.json();
    expect(Array.isArray(body.pages)).toBe(true);
    // /home is permission-free so every authenticated user sees it.
    expect(body.pages.map((p) => p.path)).toContain('/home');
  });
});

// ── Per-role accessible-pages + landingPath auto-clear contract ────

test.describe('Per-role accessible pages + landingPath lifecycle', () => {
  test('end-to-end: grant perm → page becomes accessible → set as landingPath → revoke perm → landingPath auto-cleared', async ({
    request,
  }) => {
    const token = await loginAdmin(request);

    // Create a brand-new role with no permissions.
    const create = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} life`,
      key: `${RUN_TAG}_LIFE`,
      userType: 'STAFF',
    });
    expect(create.status(), await create.text()).toBe(201);
    const role = await create.json();
    createdRoleIds.add(role.id);

    // 1. accessible-pages should only include /home (no perms granted yet).
    const initial = await get(request, token, `/api/roles/${role.id}/accessible-pages`);
    expect(initial.status()).toBe(200);
    /** @type {{ pages: Array<{ path: string }> }} */
    const initialBody = await initial.json();
    const initialPaths = initialBody.pages.map((p) => p.path);
    expect(initialPaths).toContain('/home');
    expect(initialPaths).not.toContain('/wellness/patients');

    // 2. Trying to set landingPath to /wellness/patients NOW should 400
    //    because the role doesn't have patients.read.
    const tooEarly = await put(request, token, `/api/roles/${role.id}`, {
      landingPath: '/wellness/patients',
    });
    expect(tooEarly.status(), await tooEarly.text()).toBe(400);
    const tooEarlyBody = await tooEarly.json();
    expect(tooEarlyBody.code).toBe('LANDING_PATH_NOT_ACCESSIBLE');

    // 3. Grant patients.read + appointments.read/write + calendar.read.
    //    Calendar (/wellness/calendar) is gated on a DEDICATED `calendar`
    //    module (pageCatalog.js) — deliberately separated from appointments
    //    so admins can grant view-only Calendar access without exposing the
    //    Appointments list. So calendar.read is required for /wellness/calendar
    //    to appear in accessible-pages below.
    const grant = await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [
        { module: 'patients', action: 'read' },
        { module: 'appointments', action: 'read' },
        { module: 'appointments', action: 'write' },
        { module: 'calendar', action: 'read' },
      ],
    });
    expect(grant.status()).toBe(200);

    // 4. accessible-pages now includes /wellness/patients + /wellness/calendar.
    const after = await get(request, token, `/api/roles/${role.id}/accessible-pages`);
    /** @type {{ pages: Array<{ path: string }> }} */
    const afterBody = await after.json();
    const afterPaths = afterBody.pages.map((p) => p.path);
    expect(afterPaths).toContain('/wellness/patients');
    expect(afterPaths).toContain('/wellness/calendar');

    // 5. Setting landingPath to /wellness/patients should now succeed.
    const setOK = await put(request, token, `/api/roles/${role.id}`, {
      landingPath: '/wellness/patients',
    });
    expect(setOK.status(), await setOK.text()).toBe(200);
    const setOKBody = await setOK.json();
    expect(setOKBody.landingPath).toBe('/wellness/patients');

    // 6. THE AUTO-CLEAR: now revoke patients.read by replacing perms
    //    with just appointments.read. The role's landingPath should be
    //    cleared automatically because /wellness/patients is no longer
    //    accessible. Without this the user would get redirected to a
    //    page they 403 on every login.
    const revoke = await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [{ module: 'appointments', action: 'read' }],
    });
    expect(revoke.status()).toBe(200);
    const revokeBody = await revoke.json();
    expect(revokeBody.landingPathCleared).toBe(true);

    // 7. Reading the role back, landingPath should be null.
    const finalRead = await get(request, token, `/api/roles/${role.id}`);
    const finalBody = await finalRead.json();
    expect(finalBody.landingPath).toBeNull();

    // 8. Granting calendar.read back makes /wellness/calendar accessible
    //    again — pin it as the landingPath. (/wellness/calendar is gated on
    //    the dedicated `calendar` module, separated from appointments.)
    await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [
        { module: 'appointments', action: 'read' },
        { module: 'appointments', action: 'write' },
        { module: 'calendar', action: 'read' },
      ],
    });
    const pinToCalendar = await put(request, token, `/api/roles/${role.id}`, {
      landingPath: '/wellness/calendar',
    });
    expect(pinToCalendar.status()).toBe(200);
    // Now revoke ALL perms — landingPath should clear again.
    const revokeAll = await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [],
    });
    expect(revokeAll.status()).toBe(200);
    const revokeAllBody = await revokeAll.json();
    expect(revokeAllBody.landingPathCleared).toBe(true);
  });

  test('/home survives a permission revocation (permission-free fallback)', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const create = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} home`,
      key: `${RUN_TAG}_HOME`,
      userType: 'STAFF',
      landingPath: '/home',
    });
    expect(create.status()).toBe(201);
    const role = await create.json();
    createdRoleIds.add(role.id);
    expect(role.landingPath).toBe('/home');

    // Revoking all perms should NOT clear /home (it's permission-free).
    const revoke = await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [],
    });
    expect(revoke.status()).toBe(200);
    const revokeBody = await revoke.json();
    expect(revokeBody.landingPathCleared).toBe(false);

    const readBack = await get(request, token, `/api/roles/${role.id}`);
    const readBackBody = await readBack.json();
    expect(readBackBody.landingPath).toBe('/home');
  });
});
