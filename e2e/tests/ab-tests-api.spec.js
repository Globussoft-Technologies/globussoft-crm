// @ts-check
/**
 * AB Tests API — R-1 from the 2026-05-03 gap-discovery survey.
 *
 * Target: backend/routes/ab_tests.js (259 lines, previously zero gated API
 * coverage — only a smoke spec at e2e/tests/ab_tests.spec.js that hits
 * crm.globusdemos.com by default and is NOT in the deploy-gate list).
 * Drives marketing A/B campaign experiments. Has a sibling browser-style
 * smoke test, but nothing was guarding the route's contract on every push.
 *
 * Why this matters:
 *   - The route is the only writer to AbTest model rows that drive the
 *     /ab-tests UI + the marketing engine's variant rollouts.
 *   - tenantOf(req) defaults to `1` if `req.user.tenantId` is unset; the
 *     `findFirst({where: { id, tenantId } })` pattern is the data-isolation
 *     contract this spec asserts (cross-tenant detail / update / delete /
 *     start / track / declare-winner / stats all 404).
 *   - variantA / variantB are stored as JSON strings on disk and parsed
 *     back on the way out. The serialize() helper is the one branch in
 *     the route that has historically silently swallowed bad JSON.
 *
 * Endpoints covered (all under /api/ab-tests, all auth-gated by the
 * server.js global guard):
 *   GET    /                    — list, returns AbTest[] with computed stats
 *   POST   /                    — create, 400 missing name, 201 happy path
 *   GET    /:id                 — detail, 404 unknown id, 200 with stats
 *   PUT    /:id                 — update fields incl. status / winningVariant
 *   DELETE /:id                 — 404 unknown, 200 success:true
 *   POST   /:id/start           — flips status → RUNNING
 *   POST   /:id/track           — body { variant: A|B, action: sent|clicked }
 *                                 400 on either field invalid; increments
 *                                 the right counter
 *   POST   /:id/declare-winner  — body { winner: A|B }, 400 on bad winner;
 *                                 sets winningVariant + status=COMPLETED
 *   GET    /:id/stats           — returns { id, name, status, winningVariant,
 *                                 variantA{sent,clicked,ctr}, variantB{...},
 *                                 totalSent, significant, leader }
 *
 * Contract pitfalls / non-obvious bits:
 *   - The route has NO verifyRole gate — any authenticated user (USER /
 *     MANAGER / ADMIN) on the tenant can list+create+mutate. We assert
 *     this explicitly (USER can create) so an accidental future
 *     verifyRole(['ADMIN']) addition would surface here, not in
 *     production. If this is ever tightened to ADMIN, flip the
 *     "USER can create" test to a 403 expectation.
 *   - stripDangerous middleware (server.js:268) deletes
 *     id/createdAt/updatedAt/tenantId/userId from req.body, so we never
 *     send those.
 *   - The route accepts variantA/variantB as either a JSON string OR an
 *     object — both branches exercised here.
 *   - The leader field is only populated once at least one of the two
 *     variants has sent>0, otherwise it is `null`. computeStats() also
 *     returns ctr=0 (not NaN) for sent=0 — exercised by the
 *     just-created-test stats assertion.
 *
 * Tenant isolation: cross-tenant detail/update/delete/start/track/
 * declare-winner/stats every return 404 (handled via the
 * findFirst({where:{id, tenantId}}) check at the top of each handler).
 *
 * Test-data tag: E2E_FLOW_AB_<ts> (matches /^E2E_FLOW_/ in
 * test-data-patterns.js so global-teardown sweeps any residue if afterAll
 * fails). afterAll DELETEs every created abTest by id.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_AB_${Date.now()}`;

// ── Dual-tenant + dual-role auth ───────────────────────────────────
//   admin@globussoft.com  — generic ADMIN  (primary writer)
//   user@crm.com          — generic USER   (asserts no RBAC gate)
//   admin@wellness.demo   — wellness ADMIN (cross-tenant probes)

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
      await del(request, adminTok, `/api/ab-tests/${id}`).catch(() => {});
    }
  }
  const wellnessTok = await getWellnessAdmin(request);
  if (wellnessTok) {
    for (const id of createdWellnessIds) {
      await del(request, wellnessTok, `/api/ab-tests/${id}`).catch(() => {});
    }
  }
});

// Helper: create a fresh AB test and track it for cleanup
async function createTest(request, token, overrides = {}) {
  const tracker = overrides.__tracker || createdGenericIds;
  const body = {
    name: overrides.name || `${RUN_TAG} ${Math.random().toString(36).slice(2, 8)}`,
    variantA: overrides.variantA !== undefined ? overrides.variantA : { subject: 'A!', body: 'a' },
    variantB: overrides.variantB !== undefined ? overrides.variantB : { subject: 'B!', body: 'b' },
    campaignId: overrides.campaignId,
  };
  const res = await post(request, token, '/api/ab-tests', body);
  expect(res.status(), `create AB test: ${await res.text()}`).toBe(201);
  const json = await res.json();
  tracker.add(json.id);
  return json;
}

// ── GET / ──────────────────────────────────────────────────────────

test.describe('AB Tests API — GET /', () => {
  test('200 returns array with serialized variants + stats on every row', async ({ request }) => {
    const token = await getGenericAdmin(request);
    await createTest(request, token, { name: `${RUN_TAG} list-probe` });
    const res = await get(request, token, '/api/ab-tests');
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    const row = arr.find((r) => r.name === `${RUN_TAG} list-probe`);
    expect(row).toBeTruthy();
    // serialize() turns the JSON strings back into objects
    expect(typeof row.variantA).toBe('object');
    expect(typeof row.variantB).toBe('object');
    // computeStats() sticks a stats sub-object on every row
    expect(row.stats).toBeTruthy();
    expect(row.stats.variantA.ctr).toBe(0);
    expect(row.stats.totalSent).toBe(0);
    expect(row.stats.leader).toBeNull();
    expect(row.stats.significant).toBe(false);
  });
});

// ── POST / ─────────────────────────────────────────────────────────

test.describe('AB Tests API — POST /', () => {
  test('400 when name is missing', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests', {
      variantA: {},
      variantB: {},
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  test('201 happy path with object variants serializes through', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const test = await createTest(request, token, {
      name: `${RUN_TAG} obj-variants`,
      variantA: { subject: 'Hello A', sender: 'a@x.test' },
      variantB: { subject: 'Hello B', sender: 'b@x.test' },
    });
    expect(test.id).toBeTruthy();
    expect(test.status).toBe('DRAFT');
    expect(test.variantA.subject).toBe('Hello A');
    expect(test.variantB.subject).toBe('Hello B');
  });

  test('201 happy path with string variants survives the round trip', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const variantA = JSON.stringify({ subject: 'string A' });
    const variantB = JSON.stringify({ subject: 'string B' });
    const res = await post(request, token, '/api/ab-tests', {
      name: `${RUN_TAG} str-variants`,
      variantA, variantB,
    });
    expect(res.status()).toBe(201);
    const json = await res.json();
    createdGenericIds.add(json.id);
    expect(json.variantA.subject).toBe('string A');
    expect(json.variantB.subject).toBe('string B');
  });

  test('USER role can also create (route has no verifyRole gate)', async ({ request }) => {
    const token = await getGenericUser(request);
    if (!token) test.skip(true, 'no user@crm.com token');
    const res = await post(request, token, '/api/ab-tests', {
      name: `${RUN_TAG} user-create`,
      variantA: {}, variantB: {},
    });
    // Asserting permissive behavior — if a future PR locks this down to
    // ADMIN, flip this to expect 403 and update the JSDoc.
    expect(res.status()).toBe(201);
    createdGenericIds.add((await res.json()).id);
  });
});

// ── GET /:id ───────────────────────────────────────────────────────

test.describe('AB Tests API — GET /:id', () => {
  test('200 returns serialized row + stats', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} get-detail` });
    const res = await get(request, token, `/api/ab-tests/${created.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(`${RUN_TAG} get-detail`);
    expect(body.stats).toBeTruthy();
    expect(typeof body.variantA).toBe('object');
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await get(request, token, '/api/ab-tests/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── PUT /:id ───────────────────────────────────────────────────────

test.describe('AB Tests API — PUT /:id', () => {
  test('200 partial update: just the name', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} update-name-old` });
    const res = await put(request, token, `/api/ab-tests/${created.id}`, {
      name: `${RUN_TAG} update-name-new`,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toBe(`${RUN_TAG} update-name-new`);
  });

  test('200 update variantA (object) re-serializes correctly on the way out', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} update-variant` });
    const res = await put(request, token, `/api/ab-tests/${created.id}`, {
      variantA: { subject: 'rewritten' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).variantA.subject).toBe('rewritten');
  });

  test('200 update status + winningVariant', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} update-status` });
    const res = await put(request, token, `/api/ab-tests/${created.id}`, {
      status: 'PAUSED',
      winningVariant: 'A',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('PAUSED');
    expect(body.winningVariant).toBe('A');
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await put(request, token, '/api/ab-tests/99999999', { name: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/start ────────────────────────────────────────────────

test.describe('AB Tests API — POST /:id/start', () => {
  test('200 flips status to RUNNING', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} start` });
    const res = await post(request, token, `/api/ab-tests/${created.id}/start`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('RUNNING');
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests/99999999/start', {});
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/track ────────────────────────────────────────────────

test.describe('AB Tests API — POST /:id/track', () => {
  test('400 when variant is invalid', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} track-bad-variant` });
    const res = await post(request, token, `/api/ab-tests/${created.id}/track`, {
      variant: 'C',
      action: 'sent',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/variant/i);
  });

  test('400 when action is invalid', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} track-bad-action` });
    const res = await post(request, token, `/api/ab-tests/${created.id}/track`, {
      variant: 'A',
      action: 'opened',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/action/i);
  });

  test('200 increments counters across all four (variant, action) combos', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} track-increment` });

    for (const variant of ['A', 'B']) {
      for (const action of ['sent', 'clicked']) {
        const res = await post(request, token, `/api/ab-tests/${created.id}/track`, {
          variant,
          action,
        });
        expect(res.status(), `track ${variant}:${action}: ${await res.text()}`).toBe(200);
      }
    }

    // After 1 each, every counter is 1 → stats: ctr=100 for both,
    // |ctrA-ctrB|=0 → significant=false (also totalSent=4 < 100), leader=TIE
    const stats = await get(request, token, `/api/ab-tests/${created.id}/stats`);
    const body = await stats.json();
    expect(body.variantA.sent).toBe(1);
    expect(body.variantA.clicked).toBe(1);
    expect(body.variantB.sent).toBe(1);
    expect(body.variantB.clicked).toBe(1);
    expect(body.variantA.ctr).toBe(100);
    expect(body.variantB.ctr).toBe(100);
    expect(body.totalSent).toBe(2);
    expect(body.leader).toBe('TIE');
    expect(body.significant).toBe(false);
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests/99999999/track', {
      variant: 'A', action: 'sent',
    });
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/declare-winner ───────────────────────────────────────

test.describe('AB Tests API — POST /:id/declare-winner', () => {
  test('400 when winner is not A or B', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} declare-bad` });
    const res = await post(request, token, `/api/ab-tests/${created.id}/declare-winner`, {
      winner: 'TIE',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/winner/i);
  });

  test('200 sets winningVariant=B and status=COMPLETED', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} declare-ok` });
    const res = await post(request, token, `/api/ab-tests/${created.id}/declare-winner`, {
      winner: 'B',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.winningVariant).toBe('B');
    expect(body.status).toBe('COMPLETED');
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests/99999999/declare-winner', {
      winner: 'A',
    });
    expect(res.status()).toBe(404);
  });
});

// ── GET /:id/stats ─────────────────────────────────────────────────

test.describe('AB Tests API — GET /:id/stats', () => {
  test('200 returns the documented shape on a fresh test (zero counters)', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} stats-fresh` });
    const res = await get(request, token, `/api/ab-tests/${created.id}/stats`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(`${RUN_TAG} stats-fresh`);
    expect(body.status).toBe('DRAFT');
    expect(body.winningVariant).toBeNull();
    expect(body.variantA).toEqual({ sent: 0, clicked: 0, ctr: 0 });
    expect(body.variantB).toEqual({ sent: 0, clicked: 0, ctr: 0 });
    expect(body.totalSent).toBe(0);
    expect(body.significant).toBe(false);
    expect(body.leader).toBeNull();
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await get(request, token, '/api/ab-tests/99999999/stats');
    expect(res.status()).toBe(404);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('AB Tests API — DELETE /:id', () => {
  test('200 deletes own test, subsequent GET → 404', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} delete-target` });
    createdGenericIds.delete(created.id); // we'll assert deletion ourselves
    const del1 = await del(request, token, `/api/ab-tests/${created.id}`);
    expect(del1.status()).toBe(200);
    expect((await del1.json()).success).toBe(true);
    const after = await get(request, token, `/api/ab-tests/${created.id}`);
    expect(after.status()).toBe(404);
  });

  test('404 on unknown id', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await del(request, token, '/api/ab-tests/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────

test.describe('AB Tests API — tenant isolation', () => {
  test("wellness admin cannot read generic-tenant test (cross-tenant GET /:id → 404)", async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token available');

    const generic = await createTest(request, adminTok, { name: `${RUN_TAG} cross-read` });
    const res = await get(request, wellnessTok, `/api/ab-tests/${generic.id}`);
    expect(res.status()).toBe(404);
  });

  test("generic-tenant rows do not surface in wellness admin's list", async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token available');

    const generic = await createTest(request, adminTok, { name: `${RUN_TAG} cross-list` });
    const res = await get(request, wellnessTok, '/api/ab-tests');
    expect(res.status()).toBe(200);
    const arr = await res.json();
    expect(arr.find((r) => r.id === generic.id)).toBeUndefined();
  });

  test('wellness admin cannot update generic-tenant test (PUT /:id → 404)', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token available');

    const generic = await createTest(request, adminTok, { name: `${RUN_TAG} cross-update` });
    const res = await put(request, wellnessTok, `/api/ab-tests/${generic.id}`, {
      name: 'pwned-cross-tenant',
    });
    expect(res.status()).toBe(404);

    // Confirm name didn't actually mutate
    const after = await get(request, adminTok, `/api/ab-tests/${generic.id}`);
    expect((await after.json()).name).toBe(`${RUN_TAG} cross-update`);
  });

  test('wellness admin cannot delete generic-tenant test (DELETE → 404)', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token available');

    const generic = await createTest(request, adminTok, { name: `${RUN_TAG} cross-del` });
    const res = await del(request, wellnessTok, `/api/ab-tests/${generic.id}`);
    expect(res.status()).toBe(404);

    const after = await get(request, adminTok, `/api/ab-tests/${generic.id}`);
    expect(after.status()).toBe(200); // still exists
  });

  test('wellness admin cannot start/track/declare/stats on generic-tenant test', async ({ request }) => {
    const adminTok = await getGenericAdmin(request);
    const wellnessTok = await getWellnessAdmin(request);
    if (!wellnessTok) test.skip(true, 'no wellness admin token available');

    const generic = await createTest(request, adminTok, { name: `${RUN_TAG} cross-misc` });

    const start = await post(request, wellnessTok, `/api/ab-tests/${generic.id}/start`, {});
    expect(start.status()).toBe(404);

    const track = await post(request, wellnessTok, `/api/ab-tests/${generic.id}/track`, {
      variant: 'A', action: 'sent',
    });
    expect(track.status()).toBe(404);

    const declare = await post(request, wellnessTok, `/api/ab-tests/${generic.id}/declare-winner`, {
      winner: 'A',
    });
    expect(declare.status()).toBe(404);

    const stats = await get(request, wellnessTok, `/api/ab-tests/${generic.id}/stats`);
    expect(stats.status()).toBe(404);
  });
});

// ── v3.4.11 sanitization regression suite (#398/#447 class) ───────────
//
// Closes the v3.4.10 audit's ab_tests.js finding. Both the test name and
// variantA/B JSON are rendered in the AB-test detail page; variant
// content can also flow into email previews. HTML payloads in any of
// these fields would land as stored XSS the next time an admin opens
// the test or recipients receive a preview email. routes/ab_tests.js
// now runs sanitizeText on name + sanitizeJsonForStringColumn on
// variantA/B (both imported from backend/lib/sanitizeJson.js — the
// v3.4.11 097ef5a promotion of the helpers).

test.describe('AB Tests API — sanitization (#398/#447 class, v3.4.10 audit)', () => {
  test('POST strips HTML from test name', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests', {
      name: `${RUN_TAG} <img src=x onerror=alert(1)>safe-name`,
      variantA: { subject: 'A', body: 'a' },
      variantB: { subject: 'B', body: 'b' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGenericIds.add(body.id);
    expect(body.name).not.toMatch(/<img/i);
    expect(body.name).not.toMatch(/onerror/i);
    expect(body.name).toContain('safe-name');
  });

  test('POST sanitizes HTML inside variantA / variantB body fields', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests', {
      name: `${RUN_TAG} variant-xss`,
      variantA: { subject: 'A subject', body: '<script>alert(1)</script>Welcome to A!' },
      variantB: { subject: 'B', body: '<a href="javascript:alert(2)">click</a>' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGenericIds.add(body.id);
    // Serializer parses variantA/B back into objects on response.
    const aBody = JSON.stringify(body.variantA || {});
    const bBody = JSON.stringify(body.variantB || {});
    expect(aBody).not.toMatch(/<script/i);
    expect(aBody).toContain('Welcome to A!');
    expect(bBody).not.toMatch(/<a /i);
    expect(bBody).not.toMatch(/javascript:/i);
    expect(bBody).toContain('click');
  });

  test('PUT strips HTML from name + variant on partial update', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const created = await createTest(request, token, { name: `${RUN_TAG} put-target` });
    const res = await put(request, token, `/api/ab-tests/${created.id}`, {
      name: `<img onerror=alert(1)>Updated name`,
      variantA: { subject: '<style>x{}</style>Updated subject', body: 'plain' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).not.toMatch(/<img/i);
    expect(body.name).toContain('Updated name');
    const aBody = JSON.stringify(body.variantA || {});
    expect(aBody).not.toMatch(/<style/i);
    expect(aBody).toContain('Updated subject');
  });

  test('merge tags ({{firstName}}) survive sanitization in variant body', async ({ request }) => {
    const token = await getGenericAdmin(request);
    const res = await post(request, token, '/api/ab-tests', {
      name: `${RUN_TAG} merge-tag-variant`,
      variantA: { subject: 'Hi {{firstName}}', body: 'Welcome {{firstName}} from {{company}}' },
      variantB: { subject: 'Hello {{firstName}}', body: 'Plain B' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdGenericIds.add(body.id);
    const aStr = JSON.stringify(body.variantA);
    expect(aStr).toContain('{{firstName}}');
    expect(aStr).toContain('{{company}}');
    expect(JSON.stringify(body.variantB)).toContain('{{firstName}}');
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('AB Tests API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/ab-tests`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/ab-tests`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id with garbage token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/ab-tests/1`, {
      headers: { Authorization: 'Bearer garbage.garbage.garbage' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/ab-tests/1`, {
      data: { name: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/ab-tests/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/start without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/ab-tests/1/start`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/track without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/ab-tests/1/track`, {
      data: { variant: 'A', action: 'sent' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/declare-winner without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/ab-tests/1/declare-winner`, {
      data: { winner: 'A' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id/stats without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/ab-tests/1/stats`);
    expect([401, 403]).toContain(res.status());
  });
});
