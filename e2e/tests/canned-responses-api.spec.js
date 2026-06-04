// @ts-check
/**
 * Canned Responses API — R-1 from the 2026-05-03 gap-discovery survey.
 *
 * Target: backend/routes/canned_responses.js (89 lines, previously zero
 * gated API coverage — only a smoke spec at e2e/tests/canned_responses.spec.js
 * that hits crm.globusdemos.com and is NOT in the deploy-gate list).
 * Reusable boilerplate replies for the inbox / shared-inbox UI:
 *   "Welcome", "Pricing", "Refund policy", etc., grouped by category.
 *
 * Why this matters:
 *   - Every CRM seat with shared-inbox access reads from this endpoint
 *     to populate the canned-response dropdown. A silent cross-tenant
 *     leak here would surface another tenant's reply boilerplate (and
 *     potentially their footer signature with their address) inside
 *     the wrong tenant's UI.
 *   - The route uses a tenant-default of `1` when req.user is somehow
 *     missing tenantId, but the global server.js auth guard blocks
 *     unauthenticated traffic upstream. The auth-gate tests assert
 *     that contract — a future change that drops /canned-responses
 *     into openPaths would surface here as the no-token tests
 *     unexpectedly returning 200.
 *   - All 5 endpoints share the `tenantId(req)` helper that pulls
 *     `req.user.tenantId`. The cross-tenant 404 assertions on
 *     PUT / DELETE catch a regression where someone trims the
 *     `findFirst({where: {id, tenantId} })` check down to a bare
 *     `findUnique({where: {id} })` — which has happened on similar
 *     small routes during refactors.
 *
 * Endpoints covered (all under /api/canned-responses, all auth-gated):
 *   GET    /                 — list, optional ?category=<str> filter,
 *                              orderBy [{ category: asc }, { name: asc }]
 *   POST   /                 — create, 400 missing name/content,
 *                              defaults category to 'General',
 *                              201 returns full row
 *   PUT    /:id              — partial update; 400 invalid id,
 *                              404 unknown id, 200 returns updated row
 *   DELETE /:id              — 400 invalid id, 404 unknown id,
 *                              200 returns { message: '... deleted' }
 *
 * Contract pitfalls / non-obvious bits:
 *   - The route has NO verifyRole gate — any authenticated user on the
 *     tenant can create/update/delete. We assert this so an accidental
 *     future verifyRole(['ADMIN']) addition surfaces here, not in
 *     production. If this is ever locked down to ADMIN, flip the "USER
 *     can create" test to a 403 expectation and update the JSDoc.
 *   - parseInt(req.params.id) returns NaN on a non-numeric id, which
 *     the route catches and 400s — exercised explicitly.
 *   - When category is omitted, the route inserts 'General'. We assert
 *     this default explicitly because the UI dropdown grouping depends
 *     on it.
 *   - stripDangerous middleware (server.js:268) deletes
 *     id/createdAt/updatedAt/tenantId/userId from req.body before this
 *     handler runs, so we never send those.
 *
 * Tenant isolation: cross-tenant PUT / DELETE both 404 (each handler
 * scopes via findFirst({where:{id, tenantId}})). Generic-tenant rows
 * never appear in wellness admin's GET / list. All asserted.
 *
 * Test-data tag: E2E_FLOW_CANNED_<ts>. afterAll DELETEs every created
 * canned-response row by id (tenant-aware via two cleanup sets).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_CANNED_${Date.now()}`;

// ── Dual-tenant + dual-role auth ───────────────────────────────────
//   admin@globussoft.com — generic ADMIN
//   user@crm.com         — generic USER  (asserts no RBAC gate)
//   admin@wellness.demo  — wellness ADMIN (cross-tenant probes)

let genericAdminToken = null;
let genericUserToken = null;
let wellnessAdminToken = null;

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
        return j.token || null;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return genericAdminToken;
}
async function getGenericUser(request) {
  if (!genericUserToken) {
    genericUserToken = await loginAs(request, 'user@crm.com', 'password123');
  }
  return genericUserToken;
}
async function getWellnessAdmin(request) {
  if (!wellnessAdminToken) {
    wellnessAdminToken = await loginAs(request, 'admin@wellness.demo', 'password123');
  }
  return wellnessAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
const createdGenericIds = new Set();
const createdWellnessIds = new Set();

test.afterAll(async ({ request }) => {
  const adminTok = await getGenericAdmin(request);
  if (adminTok) {
    for (const id of createdGenericIds) {
      await del(request, adminTok, `/api/canned-responses/${id}`).catch(() => {});
    }
  }
  const wellnessTok = await getWellnessAdmin(request);
  if (wellnessTok) {
    for (const id of createdWellnessIds) {
      await del(request, wellnessTok, `/api/canned-responses/${id}`).catch(() => {});
    }
  }
});

async function createOne(request, token, overrides = {}, tracker = createdGenericIds) {
  const body = {
    name: overrides.name || `${RUN_TAG} ${Math.random().toString(36).slice(2, 8)}`,
    content: overrides.content || 'Hello from the test suite.',
  };
  if (overrides.category !== undefined) body.category = overrides.category;
  const res = await post(request, token, '/api/canned-responses', body);
  expect(res.status(), `create canned-response: ${await res.text()}`).toBe(201);
  const json = await res.json();
  tracker.add(json.id);
  return json;
}

// ── GET / ──────────────────────────────────────────────────────────

test.describe('Canned Responses API — GET /', () => {
  test('200 returns array sorted by (category asc, name asc)', async ({ request }) => {
    const token = await getGenericAdmin(request);
    // Seed three rows across two categories so we can verify the order.
    await createOne(request, token, { name: `${RUN_TAG} ZZZ-bot`, category: 'Alpha' });
    await createOne(request, token, { name: `${RUN_TAG} AAA-bot`, category: 'Beta' });
    await createOne(request, token, { name: `${RUN_TAG} MMM-bot`, category: 'Alpha' });

    const res = await get(request, token, '/api/canned-responses');
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(Array.isArray(arr)).toBe(true);

    // Pull the rows we just created and verify their pairwise ordering.
    const ours = arr.filter((r) => typeof r.name === 'string' && r.name.startsWith(`${RUN_TAG} `));
    expect(ours.length).toBe(3);
    for (let i = 1; i < ours.length; i++) {
      const prev = ours[i - 1];
      const curr = ours[i];
      // category asc, then name asc
      if (prev.category === curr.category) {
        expect(curr.name.localeCompare(prev.name)).toBeGreaterThanOrEqual(0);
      } else {
        expect(curr.category.localeCompare(prev.category)).toBeGreaterThan(0);
      }
    }
  });

  test('?category=<x> filters to just that category', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const cat = `${RUN_TAG}-FILTER`;
    await createOne(request, token, { name: `${RUN_TAG} f1`, category: cat });
    await createOne(request, token, { name: `${RUN_TAG} f2`, category: cat });

    const res = await get(request, token, `/api/canned-responses?category=${encodeURIComponent(cat)}`);
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(arr.length).toBeGreaterThanOrEqual(2);
    expect(arr.every((r) => r.category === cat)).toBe(true);
  });

  test('?category=<missing> returns empty array', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await get(request, token, `/api/canned-responses?category=${RUN_TAG}-NOPE-${Date.now()}`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

// ── POST / ─────────────────────────────────────────────────────────

test.describe('Canned Responses API — POST /', () => {
  test('400 when name is missing', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/canned-responses', {
      content: 'orphan content',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name and content are required/i);
  });

  test('400 when content is missing', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/canned-responses', {
      name: `${RUN_TAG} no-content`,
    });
    expect(res.status()).toBe(400);
  });

  test('201 happy path with explicit category', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const json = await createOne(request, token, {
      name: `${RUN_TAG} happy-path`,
      content: 'Hi, thanks for reaching out.',
      category: 'Greetings',
    });
    expect(json.id).toBeTruthy();
    expect(json.name).toBe(`${RUN_TAG} happy-path`);
    expect(json.content).toBe('Hi, thanks for reaching out.');
    expect(json.category).toBe('Greetings');
    expect(json.tenantId).toBeTruthy();
  });

  test('201 defaults category to "General" when omitted', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const json = await createOne(request, token, {
      name: `${RUN_TAG} default-category`,
      content: 'No category specified.',
    });
    expect(json.category).toBe('General');
  });

  test('USER role is rejected with 403 (#527)', async ({ request }) => {
    const token = await getGenericUser(request);
    if (!token) test.skip(true, 'no user@crm.com token');
    const res = await post(request, token, '/api/canned-responses', {
      name: `${RUN_TAG} user-can-create`,
      content: 'Hello from a USER role.',
    });
    expect(res.status()).toBe(403);
  });
});

// ── PUT /:id ───────────────────────────────────────────────────────

test.describe('Canned Responses API — PUT /:id', () => {
  test('400 invalid id (non-numeric)', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await put(request, token, '/api/canned-responses/abc', {
      name: 'x',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid id/i);
  });

  test('404 unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await put(request, token, '/api/canned-responses/99999999', {
      name: `${RUN_TAG} ghost`,
    });
    expect(res.status()).toBe(404);
  });

  test('200 partial update: just the name', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createOne(request, token, {
      name: `${RUN_TAG} update-name-old`,
      content: 'ttt',
    });
    const res = await put(request, token, `/api/canned-responses/${created.id}`, {
      name: `${RUN_TAG} update-name-new`,
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe(`${RUN_TAG} update-name-new`);
    expect(updated.content).toBe('ttt'); // untouched
  });

  test('200 update content + category', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createOne(request, token, {
      name: `${RUN_TAG} update-content`,
      content: 'old content',
      category: 'OldCat',
    });
    const res = await put(request, token, `/api/canned-responses/${created.id}`, {
      content: 'new content',
      category: 'NewCat',
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.content).toBe('new content');
    expect(updated.category).toBe('NewCat');
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('Canned Responses API — DELETE /:id', () => {
  test('400 invalid id (non-numeric)', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await del(request, token, '/api/canned-responses/abc');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid id/i);
  });

  test('404 unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await del(request, token, '/api/canned-responses/99999999');
    expect(res.status()).toBe(404);
  });

  test('200 deletes own row, subsequent PUT → 404', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createOne(request, token, {
      name: `${RUN_TAG} delete-target`,
      content: 'will be deleted',
    });
    createdGenericIds.delete(created.id); // we'll delete it ourselves

    const res = await del(request, token, `/api/canned-responses/${created.id}`);
    expect(res.status()).toBe(204); // #550: DELETE → 204 No Content

    const after = await put(request, token, `/api/canned-responses/${created.id}`, {
      name: 'after',
    });
    expect(after.status()).toBe(404);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────

test.describe('Canned Responses API — tenant isolation', () => {
  test("wellness admin's list does not contain generic-tenant rows", async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token');

    const generic = await createOne(request, adminTok, {
      name: `${RUN_TAG} cross-list`,
      content: 'should not leak',
    });
    const res = await get(request, wellnessTok, '/api/canned-responses');
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(arr.find((r) => r.id === generic.id)).toBeUndefined();
  });

  test('wellness admin cannot update generic-tenant row (PUT /:id → 404)', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token');

    const generic = await createOne(request, adminTok, {
      name: `${RUN_TAG} cross-update`,
      content: 'original',
    });
    const res = await put(request, wellnessTok, `/api/canned-responses/${generic.id}`, {
      content: 'pwned-cross-tenant',
    });
    expect(res.status()).toBe(404);

    // Confirm content didn't actually mutate
    const after = await get(request, adminTok, '/api/canned-responses');
    const row = (await after.json()).find((r) => r.id === generic.id);
    expect(row.content).toBe('original');
  });

  test('wellness admin cannot delete generic-tenant row (DELETE → 404)', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token');

    const generic = await createOne(request, adminTok, {
      name: `${RUN_TAG} cross-delete`,
      content: 'survives the wellness DELETE attempt',
    });
    const res = await del(request, wellnessTok, `/api/canned-responses/${generic.id}`);
    expect(res.status()).toBe(404);

    // Row still exists for the rightful owner
    const after = await get(request, adminTok, '/api/canned-responses');
    expect((await after.json()).find((r) => r.id === generic.id)).toBeTruthy();
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Canned Responses API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/canned-responses`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/canned-responses`, {
      data: { name: 'x', content: 'y' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/canned-responses/1`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/canned-responses/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET / with garbage token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/canned-responses`, {
      headers: { Authorization: 'Bearer garbage.garbage.garbage' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
