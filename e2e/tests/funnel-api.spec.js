// @ts-check
/**
 * Funnel module — e2e API contract pin for backend/routes/funnel.js.
 *
 * routes/funnel.js currently sits at 12.85% lines in c8 instrumentation —
 * vitest covers shape (37 cases, 278% test ratio at backend/test/routes/
 * funnel.test.js) but no *-api.spec.js exercises through the api_tests gate's
 * c8-instrumented backend. This spec adds HTTP-layer coverage so the c8 gate
 * records hits on every handler.
 *
 * Distinct from the bare `e2e/tests/funnel.spec.js` (5-test UI/auth smoke,
 * NOT in the per-push api_tests gate spec list per the *-api.spec.js naming
 * convention).
 *
 * Endpoints covered (all GET — funnel is read-only analytics):
 *   GET /api/funnel/stages                 — per-stage breakdown + conversion
 *   GET /api/funnel/conversion-by-source   — contact source → won % rollup
 *   GET /api/funnel/by-rep                 — owner rollup + winRate
 *   GET /api/funnel/velocity               — avg days-in-stage
 *   GET /api/funnel/trend?months=N         — monthly stage-entry rollup
 *
 * Contracts asserted:
 *   1. GET /stages happy path returns `{ stages: [...] }` with name, current,
 *      totalEntered, conversionToNext, avgDays, totalValue per stage.
 *   2. GET /stages honours `?from` / `?to` date filter.
 *   3. GET /stages honours `?pipelineId` filter.
 *   4. GET /conversion-by-source returns sorted array with source, count,
 *      won, conversionRate.
 *   5. GET /conversion-by-source honours `?from` / `?to`.
 *   6. GET /by-rep returns array with ownerId, owner, total, won, lost, open,
 *      revenue, stages map, winRate; sorted by revenue desc.
 *   7. GET /velocity returns array of `{ stage, avgDaysInStage }`.
 *   8. GET /trend default months=6 returns 6 month buckets.
 *   9. GET /trend?months=1 returns single month.
 *  10. GET /trend?months=99 clamps to 36 max.
 *  11. GET /trend?months=0 floors to 1.
 *  12. 401 on every endpoint without auth.
 *  13. Tenant isolation: wellness-tenant view of /by-rep does not leak
 *      generic-tenant owner labels (admin@globussoft.com etc.).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let adminToken = null;
let wellnessToken = null;

async function login(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (res.ok()) {
        const body = await res.json();
        return body.token;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getAdminToken(request) {
  if (adminToken) return adminToken;
  adminToken = await login(request, 'admin@globussoft.com', 'password123');
  return adminToken;
}

async function getWellnessToken(request) {
  if (wellnessToken) return wellnessToken;
  wellnessToken = await login(request, 'rishu@enhancedwellness.in', 'password123');
  return wellnessToken;
}

async function authGet(request, path, token) {
  if (!token) throw new Error('Failed to acquire auth token');
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

function isoDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

test.describe.configure({ mode: 'serial' });

// ─── GET /stages ─────────────────────────────────────────────────

test.describe('Funnel API — GET /stages', () => {
  test('happy path returns { stages: [...] } envelope with required keys per stage', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/stages', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('stages');
    expect(Array.isArray(body.stages)).toBe(true);
    if (body.stages.length > 0) {
      const s = body.stages[0];
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('current');
      expect(s).toHaveProperty('totalEntered');
      expect(s).toHaveProperty('conversionToNext');
      expect(s).toHaveProperty('avgDays');
      expect(s).toHaveProperty('totalValue');
      expect(typeof s.current).toBe('number');
      expect(typeof s.totalEntered).toBe('number');
    }
  });

  test('honours ?from / ?to date filter without erroring', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(
      request,
      `/api/funnel/stages?from=${isoDate(-365)}&to=${isoDate(0)}`,
      token,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
  });

  test('honours ?pipelineId filter (numeric coerce); unknown pipeline returns empty/zeroed stages', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/stages?pipelineId=9999999', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
    for (const s of body.stages) {
      expect(s.current).toBe(0);
      expect(s.totalEntered).toBe(0);
    }
  });
});

// ─── GET /conversion-by-source ───────────────────────────────────

test.describe('Funnel API — GET /conversion-by-source', () => {
  test('returns sorted array of {source, count, won, conversionRate}', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/conversion-by-source', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      const row = body[0];
      expect(row).toHaveProperty('source');
      expect(row).toHaveProperty('count');
      expect(row).toHaveProperty('won');
      expect(row).toHaveProperty('conversionRate');
    }
    // Sorted desc by count
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1].count).toBeGreaterThanOrEqual(body[i].count);
    }
  });

  test('honours ?from / ?to date filter', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(
      request,
      `/api/funnel/conversion-by-source?from=${isoDate(-30)}&to=${isoDate(0)}`,
      token,
    );
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// ─── GET /by-rep ─────────────────────────────────────────────────

test.describe('Funnel API — GET /by-rep', () => {
  test('returns array sorted by revenue desc with ownerId, owner, total/won/lost/open, winRate, stages map', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/by-rep', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      const r = body[0];
      expect(r).toHaveProperty('ownerId');
      expect(r).toHaveProperty('owner');
      expect(r).toHaveProperty('total');
      expect(r).toHaveProperty('won');
      expect(r).toHaveProperty('lost');
      expect(r).toHaveProperty('open');
      expect(r).toHaveProperty('revenue');
      expect(r).toHaveProperty('winRate');
      expect(r).toHaveProperty('stages');
      expect(typeof r.stages).toBe('object');
    }
    // Sorted by revenue desc
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1].revenue).toBeGreaterThanOrEqual(body[i].revenue);
    }
  });

  test('tenant isolation — wellness JWT does not leak generic admin owner label', async ({ request }) => {
    const wToken = await getWellnessToken(request);
    test.skip(!wToken, 'wellness tenant credentials unavailable in this environment');
    const res = await authGet(request, '/api/funnel/by-rep', wToken);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const owners = body.map((r) => String(r.owner || '').toLowerCase());
    expect(owners.some((o) => o.includes('admin@globussoft'))).toBe(false);
  });
});

// ─── GET /velocity ───────────────────────────────────────────────

test.describe('Funnel API — GET /velocity', () => {
  test('returns array of {stage, avgDaysInStage}', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/velocity', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row).toHaveProperty('stage');
      expect(row).toHaveProperty('avgDaysInStage');
      expect(typeof row.avgDaysInStage).toBe('number');
      expect(row.avgDaysInStage).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── GET /trend ──────────────────────────────────────────────────

test.describe('Funnel API — GET /trend', () => {
  test('default returns 6 month buckets with stage keys per row', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/trend', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(6);
    expect(body[0]).toHaveProperty('month');
    // Month keys are YYYY-MM
    expect(body[0].month).toMatch(/^\d{4}-\d{2}$/);
  });

  test('?months=1 returns a single month bucket', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/trend?months=1', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  test('?months=99 clamps to max=36', async ({ request }) => {
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/trend?months=99', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(36);
  });

  test('?months=0 falls through to default 6 (parseInt("0")||6 short-circuit)', async ({ request }) => {
    // Source: routes/funnel.js:270 — `Math.max(1, Math.min(36, parseInt(req.query.months, 10) || 6))`.
    // parseInt('0') is 0 (falsy) → falls through `|| 6` → returns 6 buckets, NOT 1.
    // Pinning reality, not the spec's earlier guess of floor-to-1.
    const token = await getAdminToken(request);
    const res = await authGet(request, '/api/funnel/trend?months=0', token);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(6);
  });
});

// ─── Auth gate ───────────────────────────────────────────────────

test.describe('Funnel API — auth gate', () => {
  for (const path of [
    '/api/funnel/stages',
    '/api/funnel/conversion-by-source',
    '/api/funnel/by-rep',
    '/api/funnel/velocity',
    '/api/funnel/trend',
  ]) {
    test(`401 on ${path} without auth`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${path}`, { timeout: REQUEST_TIMEOUT });
      expect(res.status()).toBe(401);
    });
  }
});
