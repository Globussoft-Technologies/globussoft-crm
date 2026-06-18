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
    /** @type {{ catalog: Array<{ path: string, label: string, requiredPermissions: Array<{module: string, action: string}> }>, categories: string[], vertical: string | null }} */
    const body = await res.json();
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(body.catalog.length).toBeGreaterThan(10);
    const paths = body.catalog.map((p) => p.path);
    expect(paths).toContain('/home');
    // Vertical-aware (2026-06-15): /api/pages/catalog now returns only
    // the requesting tenant's vertical-relevant pages. admin@globussoft.com
    // is on the generic tenant, so wellness pages (`/wellness/*`) and
    // travel pages (`/travel/*`) are both hidden — pin cross-vertical
    // pages (/contacts, /tasks) which appear on every vertical instead.
    expect(paths).toContain('/contacts');
    expect(paths).toContain('/tasks');
    expect(paths).not.toContain('/wellness/patients');
    expect(paths).not.toContain('/travel/itineraries');
    // The vertical field is echoed for client-side observability.
    expect(body.vertical === null || typeof body.vertical === 'string').toBe(true);
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
    expect(initialPaths).not.toContain('/contacts');

    // 2. Trying to set landingPath to /contacts NOW should 400
    //    because the role doesn't have contacts.read.
    const tooEarly = await put(request, token, `/api/roles/${role.id}`, {
      landingPath: '/contacts',
    });
    expect(tooEarly.status(), await tooEarly.text()).toBe(400);
    const tooEarlyBody = await tooEarly.json();
    expect(tooEarlyBody.code).toBe('LANDING_PATH_NOT_ACCESSIBLE');

    // 3. Grant contacts.read + deals.read/write + tasks.read.
    //    These are COMMON modules, valid on the generic tenant that
    //    admin@globussoft.com belongs to. (Wellness-only modules would be
    //    rejected by the vertical-aware permission validator on a generic
    //    tenant, so this test intentionally uses cross-vertical common pages.)
    const grant = await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [
        { module: 'contacts', action: 'read' },
        { module: 'deals', action: 'read' },
        { module: 'deals', action: 'write' },
        { module: 'tasks', action: 'read' },
      ],
    });
    expect(grant.status()).toBe(200);

    // 4. accessible-pages now includes /contacts + /tasks.
    const after = await get(request, token, `/api/roles/${role.id}/accessible-pages`);
    /** @type {{ pages: Array<{ path: string }> }} */
    const afterBody = await after.json();
    const afterPaths = afterBody.pages.map((p) => p.path);
    expect(afterPaths).toContain('/contacts');
    expect(afterPaths).toContain('/tasks');

    // 5. Setting landingPath to /contacts should now succeed.
    const setOK = await put(request, token, `/api/roles/${role.id}`, {
      landingPath: '/contacts',
    });
    expect(setOK.status(), await setOK.text()).toBe(200);
    const setOKBody = await setOK.json();
    expect(setOKBody.landingPath).toBe('/contacts');

    // 6. THE AUTO-CLEAR: now revoke contacts.read by replacing perms
    //    with just deals.read. The role's landingPath should be
    //    cleared automatically because /contacts is no longer
    //    accessible. Without this the user would get redirected to a
    //    page they 403 on every login.
    const revoke = await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [{ module: 'deals', action: 'read' }],
    });
    expect(revoke.status()).toBe(200);
    const revokeBody = await revoke.json();
    expect(revokeBody.landingPathCleared).toBe(true);

    // 7. Reading the role back, landingPath should be null.
    const finalRead = await get(request, token, `/api/roles/${role.id}`);
    const finalBody = await finalRead.json();
    expect(finalBody.landingPath).toBeNull();

    // 8. Granting tasks.read back makes /tasks accessible again — pin it
    //    as the landingPath.
    await put(request, token, `/api/roles/${role.id}/permissions`, {
      permissions: [
        { module: 'deals', action: 'read' },
        { module: 'deals', action: 'write' },
        { module: 'tasks', action: 'read' },
      ],
    });
    const pinToTasks = await put(request, token, `/api/roles/${role.id}`, {
      landingPath: '/tasks',
    });
    expect(pinToTasks.status()).toBe(200);
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
