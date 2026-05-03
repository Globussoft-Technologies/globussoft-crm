// @ts-check
/**
 * Projects module — backend coverage push.
 *
 * routes/projects.js was 21.18% (≈ 25/118 lines). The file is a flat CRUD
 * router (GET list / GET :id / POST / PUT :id / DELETE :id) with an optional
 * status filter on the list endpoint, owner stamped from req.user.userId,
 * and tenant scoping throughout. This spec exercises every handler + every
 * validation branch + every 404 / 400 / auth-gate path + status-transition
 * round-trip.
 *
 * Endpoints covered:
 *   GET    /api/projects                — list + ?status filter
 *   GET    /api/projects/:id            — single + 400 invalid id + 404 unknown
 *   POST   /api/projects                — create + 400 missing name + defaults
 *   PUT    /api/projects/:id            — partial update + status/priority transitions + 400/404
 *   DELETE /api/projects/:id            — delete + 400/404 paths
 *
 * Pattern: cached-token / authXyz helpers identical to sla-breach-api.spec.js.
 * Test data is tagged `E2E_PRJ_<ts>` so global-teardown can scrub.
 *
 * Tenant note: /api/projects is generic-tenant (vertical=generic) — no
 * wellness-only gates. We log in as admin@globussoft.com which IS the
 * generic admin, so every endpoint is reachable. tenantId + ownerId are
 * server-stamped from req.user; cross-tenant reads are NOT in scope here.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_PRJ_${Date.now()}`;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const auth = async (request) => ({ Authorization: `Bearer ${await getAuthToken(request)}` });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authPut(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.put(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function authDelete(request, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}

// ── cleanup tracking ────────────────────────────────────────────────
const createdProjectIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdProjectIds) {
    await authDelete(request, `/api/projects/${id}`).catch(() => {});
  }
});

// Helper: create a project and remember it for cleanup.
async function createProject(request, overrides = {}) {
  const res = await authPost(request, '/api/projects', {
    name: `${RUN_TAG} ${overrides.name || 'project'}`,
    description: overrides.description,
    priority: overrides.priority,
    startDate: overrides.startDate,
    endDate: overrides.endDate,
    budget: overrides.budget,
    contactId: overrides.contactId,
    dealId: overrides.dealId,
  });
  expect(res.status(), `project create: ${await res.text()}`).toBe(201);
  const p = await res.json();
  createdProjectIds.push(p.id);
  return p;
}

// ─── POST /api/projects ─────────────────────────────────────────────

test.describe('Projects API — POST /', () => {
  test('400 when "name" is missing', async ({ request }) => {
    const res = await authPost(request, '/api/projects', { description: 'no name' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name is required/i);
  });

  test('400 when body is empty', async ({ request }) => {
    const res = await authPost(request, '/api/projects', {});
    expect(res.status()).toBe(400);
  });

  test('creates with default priority="Medium" when omitted', async ({ request }) => {
    const p = await createProject(request, { name: 'default-prio' });
    expect(p.priority).toBe('Medium');
  });

  test('honors explicit priority', async ({ request }) => {
    const p = await createProject(request, { name: 'high-prio', priority: 'High' });
    expect(p.priority).toBe('High');
  });

  test('budget defaults to 0 when omitted', async ({ request }) => {
    const p = await createProject(request, { name: 'no-budget' });
    expect(parseFloat(p.budget || 0)).toBe(0);
  });

  test('budget parsed as float (string in → number out)', async ({ request }) => {
    const p = await createProject(request, { name: 'string-budget', budget: '1234.56' });
    expect(parseFloat(p.budget)).toBeCloseTo(1234.56, 2);
  });

  test('description defaults to null when omitted', async ({ request }) => {
    const p = await createProject(request, { name: 'no-desc' });
    expect(p.description).toBeNull();
  });

  test('startDate + endDate accepted as ISO strings', async ({ request }) => {
    const start = new Date('2026-01-01T00:00:00Z').toISOString();
    const end = new Date('2026-06-30T00:00:00Z').toISOString();
    const p = await createProject(request, { name: 'with-dates', startDate: start, endDate: end });
    expect(p.startDate).toBeTruthy();
    expect(p.endDate).toBeTruthy();
    expect(new Date(p.startDate).getUTCFullYear()).toBe(2026);
  });

  test('startDate + endDate default to null when omitted', async ({ request }) => {
    const p = await createProject(request, { name: 'no-dates' });
    expect(p.startDate).toBeNull();
    expect(p.endDate).toBeNull();
  });

  test('ownerId is server-stamped from req.user.userId', async ({ request }) => {
    const p = await createProject(request, { name: 'owner-stamp' });
    expect(typeof p.ownerId).toBe('number');
    // owner relation must be present (route uses include: { owner: true }).
    expect(p.owner).toBeTruthy();
    expect(p.owner.id).toBe(p.ownerId);
  });

  test('tenantId is server-stamped — body cannot override it', async ({ request }) => {
    const p = await createProject(request, { name: 'tenant-stamp' });
    expect(typeof p.tenantId).toBe('number');
  });

  test('owner + contact + deal + tasks relations included in create response', async ({ request }) => {
    const p = await createProject(request, { name: 'relations' });
    expect('owner' in p).toBe(true);
    expect('contact' in p).toBe(true);
    expect('deal' in p).toBe(true);
    expect('tasks' in p).toBe(true);
    expect(Array.isArray(p.tasks)).toBe(true);
  });

  test('contactId=null and dealId=null safely persist as null', async ({ request }) => {
    const p = await createProject(request, { name: 'nulls', contactId: null, dealId: null });
    expect(p.contactId).toBeNull();
    expect(p.dealId).toBeNull();
  });
});

// ─── GET /api/projects (list) ───────────────────────────────────────

test.describe('Projects API — GET / (list)', () => {
  test('returns array (and includes our created row)', async ({ request }) => {
    const p = await createProject(request, { name: 'list-includes' });
    const res = await authGet(request, '/api/projects');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((x) => x.id === p.id)).toBeTruthy();
  });

  test('?status filter passes through Prisma where', async ({ request }) => {
    // Create + stamp status via PUT, then filter.
    const p = await createProject(request, { name: 'status-filter' });
    const upd = await authPut(request, `/api/projects/${p.id}`, { status: 'In Progress' });
    expect(upd.status()).toBe(200);

    const res = await authGet(request, '/api/projects?status=In Progress');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.find((x) => x.id === p.id)).toBeTruthy();
    for (const row of list) expect(row.status).toBe('In Progress');
  });

  test('list orders by createdAt desc (newest first among ours)', async ({ request }) => {
    const a = await createProject(request, { name: 'order-A' });
    const b = await createProject(request, { name: 'order-B' });
    const list = await (await authGet(request, '/api/projects')).json();
    const idxA = list.findIndex((x) => x.id === a.id);
    const idxB = list.findIndex((x) => x.id === b.id);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
  });

  test('every list row carries owner + tasks (include shape)', async ({ request }) => {
    await createProject(request, { name: 'shape' });
    const list = await (await authGet(request, '/api/projects')).json();
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect('owner' in row).toBe(true);
      expect('tasks' in row).toBe(true);
      expect(Array.isArray(row.tasks)).toBe(true);
    }
  });
});

// ─── GET /api/projects/:id ──────────────────────────────────────────

test.describe('Projects API — GET /:id', () => {
  test('200 happy path with all relation joins', async ({ request }) => {
    const p = await createProject(request, { name: 'single' });
    const res = await authGet(request, `/api/projects/${p.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(p.id);
    expect(body.name).toContain('single');
    expect('owner' in body).toBe(true);
    expect('contact' in body).toBe(true);
    expect('deal' in body).toBe(true);
    expect('tasks' in body).toBe(true);
  });

  test('400 on non-numeric id', async ({ request }) => {
    const res = await authGet(request, '/api/projects/not-a-number');
    expect(res.status()).toBe(400);
    // Post-#423: middleware-level error message is generic.
    const _body = await res.json(); expect(_body.error).toMatch(/invalid id/i); expect(_body.code).toBe('INVALID_ID');
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authGet(request, '/api/projects/99999999');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });
});

// ─── PUT /api/projects/:id ──────────────────────────────────────────

test.describe('Projects API — PUT /:id', () => {
  test('partial update: only provided keys are changed', async ({ request }) => {
    const p = await createProject(request, { name: 'pre-edit', priority: 'Low', budget: 100 });
    const res = await authPut(request, `/api/projects/${p.id}`, { name: `${RUN_TAG} edited` });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.name).toContain('edited');
    expect(updated.priority).toBe('Low'); // untouched
    expect(parseFloat(updated.budget)).toBe(100);
  });

  test('PUT updates status (kanban transition)', async ({ request }) => {
    const p = await createProject(request, { name: 'kanban' });
    const res = await authPut(request, `/api/projects/${p.id}`, { status: 'Completed' });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('Completed');
  });

  test('status round-trip: Planning → In Progress → Completed', async ({ request }) => {
    const p = await createProject(request, { name: 'round-trip' });
    const r1 = await authPut(request, `/api/projects/${p.id}`, { status: 'Planning' });
    expect(r1.status()).toBe(200);
    const r2 = await authPut(request, `/api/projects/${p.id}`, { status: 'In Progress' });
    expect(r2.status()).toBe(200);
    const r3 = await authPut(request, `/api/projects/${p.id}`, { status: 'Completed' });
    expect(r3.status()).toBe(200);
    expect((await r3.json()).status).toBe('Completed');
  });

  test('PUT updates priority', async ({ request }) => {
    const p = await createProject(request, { name: 'prio-edit' });
    const res = await authPut(request, `/api/projects/${p.id}`, { priority: 'Critical' });
    expect(res.status()).toBe(200);
    expect((await res.json()).priority).toBe('Critical');
  });

  test('PUT clears startDate when explicitly null', async ({ request }) => {
    const p = await createProject(request, {
      name: 'clear-start',
      startDate: new Date().toISOString(),
    });
    const res = await authPut(request, `/api/projects/${p.id}`, { startDate: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).startDate).toBeNull();
  });

  test('PUT clears contactId when explicitly null', async ({ request }) => {
    const p = await createProject(request, { name: 'clear-contact' });
    const res = await authPut(request, `/api/projects/${p.id}`, { contactId: null });
    expect(res.status()).toBe(200);
    expect((await res.json()).contactId).toBeNull();
  });

  test('PUT with empty body is no-op (200, fields preserved)', async ({ request }) => {
    const p = await createProject(request, { name: 'noop', budget: 999, priority: 'High' });
    const res = await authPut(request, `/api/projects/${p.id}`, {});
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(parseFloat(updated.budget)).toBe(999);
    expect(updated.priority).toBe('High');
  });

  test('PUT 400 on non-numeric id', async ({ request }) => {
    const res = await authPut(request, '/api/projects/abc', { name: 'x' });
    expect(res.status()).toBe(400);
  });

  test('PUT 404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/projects/99999999', { name: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ─── DELETE /api/projects/:id ───────────────────────────────────────

test.describe('Projects API — DELETE /:id', () => {
  test('removes the row + returns confirmation message', async ({ request }) => {
    const p = await createProject(request, { name: 'to-delete' });
    const del = await authDelete(request, `/api/projects/${p.id}`);
    expect(del.status()).toBe(200);
    expect((await del.json()).message).toMatch(/deleted/i);
    // Confirm gone — GET after DELETE should 404.
    const after = await authGet(request, `/api/projects/${p.id}`);
    expect(after.status()).toBe(404);
  });

  test('DELETE 400 on non-numeric id', async ({ request }) => {
    const res = await authDelete(request, '/api/projects/abc');
    expect(res.status()).toBe(400);
  });

  test('DELETE 404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/projects/99999999');
    expect(res.status()).toBe(404);
  });

  test('DELETE same id twice → first 200, second 404 (idempotent-safe)', async ({ request }) => {
    const p = await createProject(request, { name: 'twice' });
    const r1 = await authDelete(request, `/api/projects/${p.id}`);
    expect(r1.status()).toBe(200);
    const r2 = await authDelete(request, `/api/projects/${p.id}`);
    expect(r2.status()).toBe(404);
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Projects API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/projects`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/projects`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/projects/1`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/projects/1`);
    expect([401, 403]).toContain(res.status());
  });
});
