// @ts-check
/**
 * Role.landingPath — round-trip API spec.
 *
 * Covers:
 *   POST   /api/roles                    — accepts landingPath on create
 *   POST   /api/roles                    — 400 on malformed landingPath
 *   PUT    /api/roles/:id                — updates landingPath on existing role
 *   POST   /api/auth/login               — response includes user.landingPath
 *                                          + user.primaryRole.landingPath
 *   GET    /api/auth/me                  — same
 *   GET    /api/auth/me/permissions      — same
 *
 * Pinning the per-role landingPath contract here lets cron-engine work,
 * frontend routing, and admin-UI work coalesce around one well-defined
 * server shape. New roles created without a landingPath default to null
 * (vertical fallback handles them on the frontend); roles with a path
 * set route logged-in users to that page on login.
 *
 * Run tag isolation: tests create roles tagged E2E_RLP_<ts>, clean up
 * via DELETE in afterAll. Single-worker serial because the same admin
 * token + tenant role table is shared across tests.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_RLP_${Date.now()}`;

/** @typedef {import('@playwright/test').APIRequestContext} Req */

/** @type {string | null} */
let adminToken = null;
/** @type {number | null} */
let adminUserId = null;

/**
 * @param {Req} request
 * @param {string} email
 * @param {string} password
 * @returns {Promise<any>}
 */
async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return await r.json();
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

/** @param {Req} request */
async function getAdmin(request) {
  if (!adminToken) {
    // admin@globussoft.com is the ADMIN on the NovaCrest (generic) tenant
    // seeded by prisma/seed.js. It has roles.manage and is the cleanest
    // token to drive Role CRUD against.
    const j = await loginAs(request, 'admin@globussoft.com', 'password123');
    if (j) {
      adminToken = j.token;
      adminUserId = j.user.id;
    }
  }
  return { token: adminToken, userId: adminUserId };
}

/** @param {string | null} token */
const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * @param {Req} request
 * @param {string | null} token
 * @param {string} path
 * @param {any} [body]
 */
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
/**
 * @param {Req} request
 * @param {string | null} token
 * @param {string} path
 * @param {any} [body]
 */
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
/**
 * @param {Req} request
 * @param {string | null} token
 * @param {string} path
 */
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}
/**
 * @param {Req} request
 * @param {string | null} token
 * @param {string} path
 */
async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}

const createdRoleIds = new Set();

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdRoleIds) {
    await del(request, token, `/api/roles/${id}`).catch(() => {});
  }
});

// ── POST /api/roles — create + landingPath ────────────────────────────

test.describe('POST /api/roles — landingPath on create', () => {
  test('201 saves a valid landingPath', async ({ request }) => {
    const { token } = await getAdmin(request);
    const key = `${RUN_TAG}_CREATE_OK`;
    const res = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} create-ok`,
      key,
      description: 'landingPath round-trip',
      userType: 'STAFF',
      landingPath: '/home',
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.key).toBe(key);
    expect(body.landingPath).toBe('/home');
    createdRoleIds.add(body.id);
  });

  test('201 accepts a nested path with query string', async ({ request }) => {
    const { token } = await getAdmin(request);
    const key = `${RUN_TAG}_CREATE_QS`;
    const res = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} create-qs`,
      key,
      userType: 'STAFF',
      landingPath: '/wellness/reports?tab=pnl',
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.landingPath).toBe('/wellness/reports?tab=pnl');
    createdRoleIds.add(body.id);
  });

  test('201 leaves landingPath null when omitted', async ({ request }) => {
    const { token } = await getAdmin(request);
    const key = `${RUN_TAG}_CREATE_NULL`;
    const res = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} create-null`,
      key,
      userType: 'STAFF',
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.landingPath).toBeNull();
    createdRoleIds.add(body.id);
  });

  test('400 rejects an absolute URL as landingPath (SSRF / redirect surface)', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} create-url`,
      key: `${RUN_TAG}_CREATE_URL`,
      userType: 'STAFF',
      landingPath: 'https://evil.com/dashboard',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/landingPath|relative SPA path/i);
  });

  test('400 rejects a protocol-relative landingPath', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} create-rel`,
      key: `${RUN_TAG}_CREATE_REL`,
      userType: 'STAFF',
      landingPath: '//evil.com/dashboard',
    });
    expect(res.status()).toBe(400);
  });

  test('400 rejects landingPath > 200 chars', async ({ request }) => {
    const { token } = await getAdmin(request);
    const tooLong = '/' + 'a'.repeat(201);
    const res = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} create-long`,
      key: `${RUN_TAG}_CREATE_LONG`,
      userType: 'STAFF',
      landingPath: tooLong,
    });
    expect(res.status()).toBe(400);
  });
});

// ── PUT /api/roles/:id — update landingPath ───────────────────────────

test.describe('PUT /api/roles/:id — landingPath update', () => {
  test('200 updates landingPath on an existing role (after granting required perm)', async ({ request }) => {
    const { token } = await getAdmin(request);
    // Create with /home (permission-free), then PUT to change it.
    const key = `${RUN_TAG}_PUT_OK`;
    const create = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} put-ok`,
      key,
      userType: 'STAFF',
      landingPath: '/home',
    });
    expect(create.status()).toBe(201);
    const created = await create.json();
    createdRoleIds.add(created.id);

    // Grant appointments.read + appointments.write so /wellness/calendar
    // becomes accessible. The landingPath-validate-against-perms
    // contract (introduced after the page-catalog work) now rejects
    // setting a landingPath the role can't actually access. Calendar is
    // gated on appointments.write specifically (practitioner-only) so a
    // Nurse-shape permission set (read + update, no write) wouldn't pass.
    const grant = await put(request, token, `/api/roles/${created.id}/permissions`, {
      permissions: [
        { module: 'appointments', action: 'read' },
        { module: 'appointments', action: 'write' },
      ],
    });
    expect(grant.status()).toBe(200);

    const update = await put(request, token, `/api/roles/${created.id}`, {
      name: created.name,
      landingPath: '/wellness/calendar',
    });
    expect(update.status(), await update.text()).toBe(200);
    const updated = await update.json();
    expect(updated.landingPath).toBe('/wellness/calendar');
  });

  test('200 clears landingPath when passed an empty string', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);
    const key = `${RUN_TAG}_PUT_CLEAR`;
    const create = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} put-clear`,
      key,
      userType: 'STAFF',
      landingPath: '/home',
    });
    const created = await create.json();
    createdRoleIds.add(created.id);

    const update = await put(request, token, `/api/roles/${created.id}`, {
      landingPath: '',
    });
    expect(update.status()).toBe(200);
    const updated = await update.json();
    expect(updated.landingPath).toBeNull();
  });

  test('400 rejects malformed landingPath on update', async ({ request }) => {
    const { token } = await getAdmin(request);
    const key = `${RUN_TAG}_PUT_BAD`;
    const create = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} put-bad`,
      key,
      userType: 'STAFF',
    });
    const created = await create.json();
    createdRoleIds.add(created.id);

    const update = await put(request, token, `/api/roles/${created.id}`, {
      landingPath: 'http://evil.com',
    });
    expect(update.status()).toBe(400);
  });
});

// ── /api/auth/login — surface landingPath on login response ─────────

test.describe('Auth responses — primaryRole + landingPath', () => {
  test('POST /api/auth/login returns user.landingPath + primaryRole shape', async ({
    request,
  }) => {
    const j = await loginAs(request, 'admin@globussoft.com', 'password123');
    expect(j, 'login should succeed').not.toBeNull();
    expect(j.user).toBeTruthy();
    // landingPath may be null (admin tenant hasn't been touched by the new
    // backfill on the demo yet) OR /dashboard (after backfill). Both are
    // valid; assert the field EXISTS on the response.
    expect('landingPath' in j.user).toBe(true);
    expect('primaryRole' in j.user).toBe(true);
    if (j.user.primaryRole) {
      expect(typeof j.user.primaryRole.key).toBe('string');
      expect('landingPath' in j.user.primaryRole).toBe(true);
    }
  });

  test('GET /api/auth/me returns primaryRole + landingPath', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/auth/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect('landingPath' in body).toBe(true);
    expect('primaryRole' in body).toBe(true);
  });

  test('GET /api/auth/me/permissions returns primaryRole + landingPath', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/auth/me/permissions');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect('landingPath' in body).toBe(true);
    expect('primaryRole' in body).toBe(true);
    expect(Array.isArray(body.permissions)).toBe(true);
  });
});

// ── Single-role-per-user enforcement on assign endpoint ──────────────
//
// Pin the contract change in routes/roles.js: assigning a user to a role
// when they already have a different role REPLACES the old assignment
// (delete-then-create in a single transaction) rather than appending a
// second row. Without this, a user accumulates many UserRole rows over
// time and the /home + landingPath routing can't pick a deterministic
// "primary" role.

test.describe('POST /api/roles/:id/assign/:userId — single-role replacement', () => {
  test('reassigning a user to a different role removes the prior role', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);

    // Target: user@crm.com (USER in the generic tenant seed). We'll move
    // them between two throwaway roles and back to USER so other specs
    // that depend on this user keep working.
    const userLogin = await loginAs(request, 'user@crm.com', 'password123');
    expect(userLogin, 'user@crm.com login should succeed').not.toBeNull();
    const targetUserId = userLogin.user.id;
    const originalRoleKey = userLogin.user.primaryRole?.key || 'USER';

    // Look up the original role id so we can restore the user at the end.
    const rolesList = await get(request, token, '/api/roles');
    /** @type {{ roles: Array<{ id: number, key: string }> }} */
    const rolesBody = await rolesList.json();
    const originalRole = /** @type {{ id: number, key: string }} */ (
      rolesBody.roles.find(
        (/** @type {{ key: string }} */ r) => r.key === originalRoleKey,
      )
    );
    expect(originalRole, `original role ${originalRoleKey} found`).toBeTruthy();

    // Create two throwaway roles for the swap.
    const roleAKey = `${RUN_TAG}_SR_A`;
    const roleBKey = `${RUN_TAG}_SR_B`;
    const roleARes = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} role A`,
      key: roleAKey,
      userType: 'STAFF',
    });
    expect(roleARes.status(), await roleARes.text()).toBe(201);
    const roleA = await roleARes.json();
    createdRoleIds.add(roleA.id);

    const roleBRes = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} role B`,
      key: roleBKey,
      userType: 'STAFF',
    });
    expect(roleBRes.status()).toBe(201);
    const roleB = await roleBRes.json();
    createdRoleIds.add(roleB.id);

    try {
      // Step 1: move user → roleA. Their original USER row should be replaced.
      const r1 = await post(
        request,
        token,
        `/api/roles/${roleA.id}/assign/${targetUserId}`,
      );
      expect(r1.status(), await r1.text()).toBe(201);

      // Helper: pull user ids out of a /api/roles/:id/users response.
      /** @param {{ users: Array<{ id: number }> }} body */
      const ids = (body) => body.users.map((u) => u.id);

      // Original USER role should no longer have this user.
      const origUsers1 = await get(
        request,
        token,
        `/api/roles/${originalRole.id}/users`,
      );
      expect(ids(await origUsers1.json())).not.toContain(targetUserId);

      // RoleA should have them.
      const aUsers = await get(
        request,
        token,
        `/api/roles/${roleA.id}/users`,
      );
      expect(ids(await aUsers.json())).toContain(targetUserId);

      // Step 2: move user → roleB. RoleA row should be replaced.
      const r2 = await post(
        request,
        token,
        `/api/roles/${roleB.id}/assign/${targetUserId}`,
      );
      expect(r2.status(), await r2.text()).toBe(201);

      const aUsers2 = await get(
        request,
        token,
        `/api/roles/${roleA.id}/users`,
      );
      expect(ids(await aUsers2.json())).not.toContain(targetUserId);

      const bUsers = await get(
        request,
        token,
        `/api/roles/${roleB.id}/users`,
      );
      expect(ids(await bUsers.json())).toContain(targetUserId);

      // Step 3: re-assign to same role → 409 (no-op).
      const r3 = await post(
        request,
        token,
        `/api/roles/${roleB.id}/assign/${targetUserId}`,
      );
      expect(r3.status()).toBe(409);
    } finally {
      // Always restore the user to their original role so this spec is
      // safe to re-run + doesn't leak state into other specs that depend
      // on user@crm.com being a USER.
      await post(
        request,
        token,
        `/api/roles/${originalRole.id}/assign/${targetUserId}`,
      ).catch(() => {});
    }
  });
});

// ── POST /api/staff — rbacRoleId at user creation ───────────────────
//
// The Add Staff workflow has to be one-step: admin picks a role, the
// new user lands on that role's landingPath with that role's widget
// layout. Without rbacRoleId support on POST /api/staff, admin had to
// (1) create the user, then (2) open Roles & Permissions, then (3)
// assign them — a 3-step process where step 2+3 was easy to forget.
//
// Tests below pin the one-step contract: send rbacRoleId at create
// time, get back primaryRole on the response, verify the UserRole
// junction row exists.

const createdStaffIds = new Set();

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdStaffIds) {
    // Soft-delete via deactivate; hard delete needs special permission
    // and might 403 on later runs of the same suite.
    await request
      .patch(`${BASE_URL}/api/staff/${id}`, {
        headers: headers(token),
        data: { active: false },
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

test.describe('POST /api/staff — rbacRoleId at creation', () => {
  test('201 creates a user + UserRole junction in one atomic call', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);

    // Create a throwaway role first so the test doesn't depend on
    // tenant-specific seeded roles existing.
    const roleKey = `${RUN_TAG}_STAFF_ROLE_A`;
    const roleRes = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} staff role A`,
      key: roleKey,
      userType: 'STAFF',
      landingPath: '/home',
    });
    expect(roleRes.status()).toBe(201);
    const newRole = await roleRes.json();
    createdRoleIds.add(newRole.id);

    // Create the staff with rbacRoleId.
    const email = `${RUN_TAG}_a@e2e.local`.toLowerCase();
    const create = await post(request, token, '/api/staff', {
      name: `${RUN_TAG} A`,
      email,
      password: 'password123',
      role: 'USER',
      rbacRoleId: newRole.id,
    });
    expect(create.status(), await create.text()).toBe(201);
    const staff = await create.json();
    createdStaffIds.add(staff.id);

    // Response echoes the primary role.
    expect(staff.primaryRole).toBeTruthy();
    expect(staff.primaryRole.id).toBe(newRole.id);
    expect(staff.primaryRole.key).toBe(roleKey);
    expect(staff.primaryRole.landingPath).toBe('/home');

    // Junction row is visible from the role's users endpoint.
    const usersInRole = await get(
      request,
      token,
      `/api/roles/${newRole.id}/users`,
    );
    const body = await usersInRole.json();
    expect(body.users.map((/** @type {{ id: number }} */ u) => u.id)).toContain(
      staff.id,
    );
  });

  test('400 rejects an unknown rbacRoleId (no half-created user)', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);
    const email = `${RUN_TAG}_b@e2e.local`.toLowerCase();
    const create = await post(request, token, '/api/staff', {
      name: `${RUN_TAG} B`,
      email,
      password: 'password123',
      role: 'USER',
      rbacRoleId: 999999999,
    });
    // 404 (role not found) vs 400 (invalid shape) — both acceptable.
    expect([400, 404]).toContain(create.status());

    // Critical: no user was created (transaction rolled back).
    // Look for the email in the staff list — should NOT be there.
    const list = await get(request, token, '/api/staff');
    /** @type {Array<{ email: string, id: number }>} */
    const all = await list.json();
    expect(all.find((u) => u.email === email)).toBeUndefined();
  });

  test('GET /api/staff includes primaryRole on each row', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/staff');
    /** @type {Array<{ id: number, primaryRole: object | null }>} */
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    // The contract is "every row has the primaryRole field (possibly null)".
    for (const u of list.slice(0, 5)) {
      expect('primaryRole' in u).toBe(true);
    }
  });

  test('PUT /api/staff/:id with rbacRoleId swaps the assignment (single-role replacement)', async ({
    request,
  }) => {
    const { token } = await getAdmin(request);

    // Create two throwaway roles + a throwaway user assigned to role A.
    const keyA = `${RUN_TAG}_PUT_A`;
    const keyB = `${RUN_TAG}_PUT_B`;
    const rA = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} put A`,
      key: keyA,
      userType: 'STAFF',
    });
    expect(rA.status()).toBe(201);
    const roleA = await rA.json();
    createdRoleIds.add(roleA.id);

    const rB = await post(request, token, '/api/roles', {
      name: `${RUN_TAG} put B`,
      key: keyB,
      userType: 'STAFF',
    });
    expect(rB.status()).toBe(201);
    const roleB = await rB.json();
    createdRoleIds.add(roleB.id);

    const email = `${RUN_TAG}_put@e2e.local`.toLowerCase();
    const create = await post(request, token, '/api/staff', {
      name: `${RUN_TAG} PUT-target`,
      email,
      password: 'password123',
      role: 'USER',
      rbacRoleId: roleA.id,
    });
    expect(create.status()).toBe(201);
    const staff = await create.json();
    createdStaffIds.add(staff.id);
    expect(staff.primaryRole.id).toBe(roleA.id);

    // Swap them to role B via PUT.
    const update = await put(request, token, `/api/staff/${staff.id}`, {
      rbacRoleId: roleB.id,
    });
    expect(update.status(), await update.text()).toBe(200);
    const updated = await update.json();
    expect(updated.primaryRole).toBeTruthy();
    expect(updated.primaryRole.id).toBe(roleB.id);

    // Role A's users list no longer contains them.
    const aUsers = await get(request, token, `/api/roles/${roleA.id}/users`);
    const aBody = await aUsers.json();
    expect(aBody.users.map((/** @type {{ id: number }} */ u) => u.id)).not.toContain(
      staff.id,
    );
    // Role B's users list does.
    const bUsers = await get(request, token, `/api/roles/${roleB.id}/users`);
    const bBody = await bUsers.json();
    expect(bBody.users.map((/** @type {{ id: number }} */ u) => u.id)).toContain(
      staff.id,
    );
  });
});
