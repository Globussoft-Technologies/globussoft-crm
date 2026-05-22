// @ts-check
/**
 * Admin LLM spend gate — PRD §9.1 + R7 cost observability.
 *
 * Route pinned: GET /api/admin/llm-spend?days=N
 * Backed by LlmCallLog rows that backend/lib/llmRouter.js writes fire-and-
 * forget per call. Cron consumer at routes/travel_diagnostics.js
 * /talking-points/regen exercises the persist path in stub-mode CI.
 *
 * Contract pinned:
 *   - 401/403 without auth
 *   - 403 RBAC_DENIED for USER + MANAGER (admin-only)
 *   - 200 happy path for ADMIN with documented envelope shape
 *   - ?days defaults to 7; >90 → 400 INVALID_RANGE; non-numeric falls back
 *     to the default (forgiving for hand-typed curls)
 *   - byTask + byModel sorted descending by costEstimate then by calls
 *   - Tenant isolation: rows written under tenant A do NOT leak into
 *     tenant B's response (yasin@travelstall vs admin@globussoft)
 *
 * Run: cd e2e && BASE_URL=http://127.0.0.1:5000 \
 *      npx playwright test --project=chromium tests/admin-llm-spend-api.spec.js
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let userToken = null;
let managerToken = null;
let travelAdminToken = null;

async function login(request, email, password = 'password123') {
  const r = await request.post(`${API}/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

async function authGet(request, t, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${t}` },
    timeout: REQUEST_TIMEOUT,
  });
}

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin@globussoft.com');
  userToken = await login(request, 'user@crm.com');
  managerToken = await login(request, 'manager@crm.com');
  travelAdminToken = await login(request, 'yasin@travelstall.in');
});

test.describe('Admin LLM spend — auth + RBAC gates', () => {
  test('no token → 401/403', async ({ request }) => {
    const r = await request.get(`${API}/admin/llm-spend`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(r.status());
  });

  test('USER role → 403', async ({ request }) => {
    test.skip(!userToken, 'user@crm.com not seeded');
    const r = await authGet(request, userToken, '/api/admin/llm-spend');
    expect(r.status()).toBe(403);
  });

  test('MANAGER role → 403 (admin-only endpoint)', async ({ request }) => {
    test.skip(!managerToken, 'manager@crm.com not seeded');
    const r = await authGet(request, managerToken, '/api/admin/llm-spend');
    expect(r.status()).toBe(403);
  });
});

test.describe('Admin LLM spend — envelope + filters', () => {
  test('ADMIN happy path returns the documented envelope', async ({ request }) => {
    test.skip(!adminToken, 'admin@globussoft.com not seeded');
    const r = await authGet(request, adminToken, '/api/admin/llm-spend');
    expect(r.status(), `body: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body.days).toBe(7);
    expect(typeof body.from).toBe('string');
    expect(typeof body.to).toBe('string');
    expect(body.totals).toMatchObject({
      calls: expect.any(Number),
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      totalTokens: expect.any(Number),
      stubCalls: expect.any(Number),
      realCalls: expect.any(Number),
    });
    expect(typeof body.totals.costEstimate).toBe('number');
    expect(Array.isArray(body.byDay)).toBe(true);
    expect(Array.isArray(body.byTask)).toBe(true);
    expect(Array.isArray(body.byModel)).toBe(true);
  });

  test('?days=30 widens the window', async ({ request }) => {
    test.skip(!adminToken, 'admin not seeded');
    const r = await authGet(request, adminToken, '/api/admin/llm-spend?days=30');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.days).toBe(30);
  });

  test('?days=100 → 400 INVALID_RANGE', async ({ request }) => {
    test.skip(!adminToken, 'admin not seeded');
    const r = await authGet(request, adminToken, '/api/admin/llm-spend?days=100');
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_RANGE');
  });

  test('?days=abc falls back to the default (7) silently', async ({ request }) => {
    test.skip(!adminToken, 'admin not seeded');
    const r = await authGet(request, adminToken, '/api/admin/llm-spend?days=abc');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.days).toBe(7);
  });

  test('byTask + byModel sorted descending by costEstimate then calls', async ({ request }) => {
    test.skip(!adminToken, 'admin not seeded');
    const r = await authGet(request, adminToken, '/api/admin/llm-spend?days=30');
    expect(r.status()).toBe(200);
    const body = await r.json();
    const isSorted = (arr) => {
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1];
        const cur = arr[i];
        if (prev.costEstimate < cur.costEstimate) return false;
        if (prev.costEstimate === cur.costEstimate && prev.calls < cur.calls) return false;
      }
      return true;
    };
    expect(isSorted(body.byTask)).toBe(true);
    expect(isSorted(body.byModel)).toBe(true);
  });
});

test.describe('Admin LLM spend — tenant isolation', () => {
  test('rows from one tenant do not leak into another tenant response', async ({ request }) => {
    test.skip(!adminToken || !travelAdminToken, 'cross-tenant tokens missing');
    // Travel-tenant talking-points regen writes an LlmCallLog row under
    // the travel tenant — yasin's POST against an existing diagnostic
    // generates a row. Then verify that admin@globussoft.com (generic
    // tenant) does NOT see the increase.

    // Baseline: generic tenant's call count over the last day.
    const baselineRes = await authGet(request, adminToken, '/api/admin/llm-spend?days=1');
    if (baselineRes.status() !== 200) test.skip(true, 'baseline fetch failed');
    const baseline = await baselineRes.json();
    const baselineCalls = baseline.totals.calls;

    // Travel-tenant trigger: find a diagnostic + POST talking-points/regen
    const diagListRes = await authGet(request, travelAdminToken, '/api/travel/diagnostics?limit=1');
    if (diagListRes.status() !== 200) test.skip(true, 'travel diagnostic fetch failed');
    const diagBody = await diagListRes.json();
    const diagId = (diagBody.diagnostics || [])[0]?.id;
    if (!diagId) test.skip(true, 'no seeded diagnostic to regen against');

    const regenRes = await request.post(
      `${API}/travel/diagnostics/${diagId}/talking-points/regen`,
      { headers: { Authorization: `Bearer ${travelAdminToken}`, 'Content-Type': 'application/json' }, timeout: REQUEST_TIMEOUT },
    );
    if (![200, 201].includes(regenRes.status())) {
      test.skip(true, `regen returned ${regenRes.status()} — skipping isolation check`);
    }

    // Give the fire-and-forget persist a beat to land in the LlmCallLog.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Re-fetch generic-tenant summary — count should be UNCHANGED.
    const afterRes = await authGet(request, adminToken, '/api/admin/llm-spend?days=1');
    expect(afterRes.status()).toBe(200);
    const after = await afterRes.json();
    expect(after.totals.calls).toBe(baselineCalls);
  });
});
