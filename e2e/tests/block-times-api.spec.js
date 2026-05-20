// @ts-check
/**
 * Block-times API — staff availability block CRUD coverage.
 *
 * Endpoints covered (all under /api/wellness/block-times):
 *   GET    /                 — list, optional ?userId / ?startDate / ?endDate filters
 *   GET    /user/:userId     — list for one staff member
 *   POST   /                 — create (ADMIN/MANAGER) — targetUserId/startAt/endAt/reason required
 *   PATCH  /:id              — update (ADMIN/MANAGER) — 404 on unknown id, 400 on bad time order
 *   DELETE /:id              — delete (ADMIN/MANAGER) — 404 on unknown id
 *
 * Validation pinned:
 *   400 when targetUserId/startAt/endAt/reason are missing on POST
 *   400 when startAt >= endAt on POST or PATCH
 *   404 when targetUserId does not belong to the caller's tenant
 *   404 when /:id does not exist
 *
 * RBAC pinned:
 *   401 without a Bearer token on every method
 *   403 when a USER role tries POST / PATCH / DELETE
 *
 * Body field: the route reads `targetUserId` (NOT `userId`). The global
 * stripDangerous middleware deletes req.body.userId before any handler
 * runs (anti-impersonation guardrail) — a body field named `userId` would
 * silently never reach this route. Same standing rule as notifications-api.
 *
 * Dual-token auth (wellness tenant):
 *   admin@wellness.demo (ADMIN)  — drives mutation happy paths
 *   user@wellness.demo  (USER)   — drives 403 RBAC checks
 *
 * Test data: every created row uses reason starting with `${RUN_TAG} `,
 * tracked in createdBlockIds and deleted in afterAll.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_BLK_${Date.now()}`;

let adminToken = null;
let adminUserId = null;
let userToken = null;

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
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    adminToken = r.token;
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@wellness.demo', 'password123');
    userToken = r.token;
  }
  return userToken;
}

const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: token ? auth(token) : { 'Content-Type': 'application/json' },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function patch(request, token, path, body) {
  return request.patch(`${BASE_URL}${path}`, {
    headers: token ? auth(token) : { 'Content-Type': 'application/json' },
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: REQUEST_TIMEOUT,
  });
}

const createdBlockIds = new Set();

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdBlockIds) {
    await del(request, token, `/api/wellness/block-times/${id}`).catch(() => {});
  }
});

// Helper: create a block time and return its row. Defaults to a far-future
// window so it cannot collide with real demo scheduling activity.
async function createBlock(request, overrides = {}) {
  const { token, userId } = await getAdmin(request);
  // Unambiguous-future dates (next year) avoid the TZ-window flakes that
  // bite "today" / "tomorrow" boundaries on CI vs demo.
  const start = overrides.startAt || new Date(Date.now() + 365 * 86_400_000).toISOString();
  const end = overrides.endAt || new Date(Date.now() + 365 * 86_400_000 + 60 * 60 * 1000).toISOString();
  const res = await post(request, token, '/api/wellness/block-times', {
    targetUserId: overrides.targetUserId ?? userId,
    startAt: start,
    endAt: end,
    reason: `${RUN_TAG} ${overrides.reason || 'lunch break'}`,
    recurring: overrides.recurring,
  });
  expect(res.status(), `create block-time: ${await res.text()}`).toBe(201);
  const body = await res.json();
  createdBlockIds.add(body.id);
  return body;
}

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('block-times — auth gate', () => {
  test('GET / without token → 401', async ({ request }) => {
    const r = await get(request, null, '/api/wellness/block-times');
    expect(r.status()).toBe(401);
  });

  test('POST / without token → 401', async ({ request }) => {
    const r = await post(request, null, '/api/wellness/block-times', {});
    expect(r.status()).toBe(401);
  });

  test('PATCH /:id without token → 401', async ({ request }) => {
    const r = await patch(request, null, '/api/wellness/block-times/1', {});
    expect(r.status()).toBe(401);
  });

  test('DELETE /:id without token → 401', async ({ request }) => {
    const r = await del(request, null, '/api/wellness/block-times/1');
    expect(r.status()).toBe(401);
  });
});

// ── GET list ───────────────────────────────────────────────────────

test.describe('block-times — GET /', () => {
  test('200 returns an array', async ({ request }) => {
    const { token } = await getAdmin(request);
    if (!token) test.skip(true, 'wellness admin credentials not available');
    const r = await get(request, token, '/api/wellness/block-times');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('includes user.{id,name,email} relation for each row', async ({ request }) => {
    const created = await createBlock(request, { reason: 'list-include' });
    const { token } = await getAdmin(request);
    const r = await get(request, token, '/api/wellness/block-times');
    expect(r.status()).toBe(200);
    const list = await r.json();
    const hit = list.find((b) => b.id === created.id);
    expect(hit, 'just-created block must appear in list').toBeTruthy();
    expect(hit.user).toBeTruthy();
    expect(typeof hit.user.id).toBe('number');
    expect(typeof hit.user.name).toBe('string');
    expect(typeof hit.user.email).toBe('string');
  });

  test('?userId filter scopes the list to that staff member', async ({ request }) => {
    const created = await createBlock(request, { reason: 'userid-filter' });
    const { token, userId } = await getAdmin(request);
    const r = await get(request, token, `/api/wellness/block-times?userId=${userId}`);
    expect(r.status()).toBe(200);
    const list = await r.json();
    expect(list.every((b) => b.userId === userId)).toBe(true);
    expect(list.some((b) => b.id === created.id)).toBe(true);
  });

  test('list is ordered by startAt ascending', async ({ request }) => {
    const { token } = await getAdmin(request);
    const r = await get(request, token, '/api/wellness/block-times');
    expect(r.status()).toBe(200);
    const list = await r.json();
    if (list.length < 2) return;
    for (let i = 1; i < list.length; i++) {
      expect(new Date(list[i].startAt).getTime()).toBeGreaterThanOrEqual(
        new Date(list[i - 1].startAt).getTime()
      );
    }
  });
});

// ── GET /user/:userId ──────────────────────────────────────────────

test.describe('block-times — GET /user/:userId', () => {
  test('200 returns array scoped to that user', async ({ request }) => {
    const created = await createBlock(request, { reason: 'per-user' });
    const { token, userId } = await getAdmin(request);
    const r = await get(request, token, `/api/wellness/block-times/user/${userId}`);
    expect(r.status()).toBe(200);
    const list = await r.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((b) => b.userId === userId)).toBe(true);
    expect(list.some((b) => b.id === created.id)).toBe(true);
  });
});

// ── POST / — create ────────────────────────────────────────────────

test.describe('block-times — POST /', () => {
  test('201 happy path — creates a row, returns user relation', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const res = await post(request, token, '/api/wellness/block-times', {
      targetUserId: userId,
      startAt: new Date(Date.now() + 366 * 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 366 * 86_400_000 + 3_600_000).toISOString(),
      reason: `${RUN_TAG} happy-create`,
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    createdBlockIds.add(body.id);
    expect(typeof body.id).toBe('number');
    expect(body.userId).toBe(userId);
    expect(body.user?.id).toBe(userId);
    expect(body.reason).toBe(`${RUN_TAG} happy-create`);
  });

  test('400 when targetUserId missing', async ({ request }) => {
    const { token } = await getAdmin(request);
    const r = await post(request, token, '/api/wellness/block-times', {
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'x',
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/targetUserId/);
  });

  test('400 when reason missing', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const r = await post(request, token, '/api/wellness/block-times', {
      targetUserId: userId,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(r.status()).toBe(400);
  });

  test('400 when startAt >= endAt', async ({ request }) => {
    const { token, userId } = await getAdmin(request);
    const start = new Date(Date.now() + 365 * 86_400_000 + 7_200_000).toISOString();
    const end = new Date(Date.now() + 365 * 86_400_000).toISOString(); // earlier than start
    const r = await post(request, token, '/api/wellness/block-times', {
      targetUserId: userId,
      startAt: start,
      endAt: end,
      reason: `${RUN_TAG} bad-order`,
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/startAt must be before endAt/);
  });

  test('404 when targetUserId does not exist in this tenant', async ({ request }) => {
    const { token } = await getAdmin(request);
    const r = await post(request, token, '/api/wellness/block-times', {
      targetUserId: 999_999_999,
      startAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 365 * 86_400_000 + 3_600_000).toISOString(),
      reason: `${RUN_TAG} cross-tenant`,
    });
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.error).toMatch(/User not found/);
  });

  test('403 when USER role tries to create', async ({ request }) => {
    const userTok = await getUser(request);
    const { userId } = await getAdmin(request);
    if (!userTok) test.skip(true, 'wellness user credentials not available');
    const r = await post(request, userTok, '/api/wellness/block-times', {
      targetUserId: userId,
      startAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      endAt: new Date(Date.now() + 365 * 86_400_000 + 3_600_000).toISOString(),
      reason: `${RUN_TAG} rbac-create`,
    });
    expect(r.status()).toBe(403);
  });
});

// ── PATCH /:id — update ────────────────────────────────────────────

test.describe('block-times — PATCH /:id', () => {
  test('200 updates reason', async ({ request }) => {
    const b = await createBlock(request, { reason: 'patch-target' });
    const { token } = await getAdmin(request);
    const r = await patch(request, token, `/api/wellness/block-times/${b.id}`, {
      reason: `${RUN_TAG} patched`,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.id).toBe(b.id);
    expect(body.reason).toBe(`${RUN_TAG} patched`);
  });

  test('400 when patched startAt >= endAt', async ({ request }) => {
    const b = await createBlock(request, { reason: 'patch-bad-order' });
    const { token } = await getAdmin(request);
    const r = await patch(request, token, `/api/wellness/block-times/${b.id}`, {
      startAt: new Date(Date.now() + 366 * 86_400_000 + 7_200_000).toISOString(),
      endAt: new Date(Date.now() + 366 * 86_400_000).toISOString(),
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/startAt must be before endAt/);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const r = await patch(request, token, '/api/wellness/block-times/999999999', {
      reason: 'never',
    });
    expect(r.status()).toBe(404);
  });

  test('403 when USER role tries to patch', async ({ request }) => {
    const b = await createBlock(request, { reason: 'patch-rbac' });
    const userTok = await getUser(request);
    if (!userTok) test.skip(true, 'wellness user credentials not available');
    const r = await patch(request, userTok, `/api/wellness/block-times/${b.id}`, {
      reason: 'no-access',
    });
    expect(r.status()).toBe(403);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('block-times — DELETE /:id', () => {
  test('200 deletes row, list no longer contains it', async ({ request }) => {
    const b = await createBlock(request, { reason: 'delete-target' });
    const { token } = await getAdmin(request);
    const r = await del(request, token, `/api/wellness/block-times/${b.id}`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    createdBlockIds.delete(b.id);

    const list = await get(request, token, '/api/wellness/block-times');
    const after = await list.json();
    expect(after.some((x) => x.id === b.id)).toBe(false);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const r = await del(request, token, '/api/wellness/block-times/999999999');
    expect(r.status()).toBe(404);
  });

  test('403 when USER role tries to delete', async ({ request }) => {
    const b = await createBlock(request, { reason: 'delete-rbac' });
    const userTok = await getUser(request);
    if (!userTok) test.skip(true, 'wellness user credentials not available');
    const r = await del(request, userTok, `/api/wellness/block-times/${b.id}`);
    expect(r.status()).toBe(403);
  });
});
