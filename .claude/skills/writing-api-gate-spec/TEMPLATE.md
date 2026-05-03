# API gate spec — template

Copy into `e2e/tests/<area>-api.spec.js`. Replace `<AREA>` / `<area>` / `<route-path>` / endpoint-specific bits.

```js
// @ts-check
/**
 * <Area> API — <gap-id> from docs/E2E_GAPS.md.
 *
 * Target: routes/<area>.js (<line-count> lines, [zero / smoke-only] coverage).
 * Endpoints:
 *   GET  /api/<route-path>            — list
 *   POST /api/<route-path>            — create
 *   PUT  /api/<route-path>/:id        — update
 *   DELETE /api/<route-path>/:id      — delete
 *   [+ any state-machine endpoints]
 *
 * Why this exists: <regression class this catches — e.g. "tenant scoping
 * on the list endpoint silently leaked rows pre-#XXX" or "the route had
 * no automated coverage; QA caught a 500 on missing-field POST in #YYY">.
 *
 * Acceptance per endpoint:
 *   ✅ Happy path: minimum-valid payload returns expected status + shape
 *   ✅ 400 INVALID_<FIELD> on validator branches
 *   ✅ 404 on unknown id (id-bearing endpoints)
 *   ✅ Auth gate: no token → 401/403
 *   ✅ Tenant isolation: row created in tenant A invisible to tenant B
 *   ✅ RBAC where applicable (ADMIN-only / wellness-role-gated)
 *
 * Non-obvious setup: <e.g. "needs a seeded Patient before POST /visits
 * can succeed" — list anything a future reader can't infer from the code>.
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com (matches other gate specs)
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/<area>-api.spec.js
 *   - Login: admin@globussoft.com / password123 (generic admin)
 *            admin@wellness.demo / password123 (wellness admin)
 *
 * Pattern: cloned from e2e/tests/<reference-spec>.spec.js.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;
const RUN_TAG = `E2E_FLOW_<AREA>_${Date.now()}`;

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
  return request.get(`${BASE_URL}${path}`, {
    headers: await auth(request),
    timeout: REQUEST_TIMEOUT,
  });
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

// ── cleanup tracking ──────────────────────────────────────────────────
const createdIds = [];

test.afterAll(async ({ request }) => {
  for (const id of createdIds) {
    await authDelete(request, `/api/<route-path>/${id}`).catch(() => {});
  }
  // For routes WITHOUT a DELETE endpoint, replace the loop above with a
  // PUT-rename to "_teardown_<area>_<id>" so the residue regex misses,
  // mirroring e2e/tests/appointment-reminders-api.spec.js:194.
});

// Helper: create a fixture and remember it for cleanup.
async function createFixture(request, overrides = {}) {
  const res = await authPost(request, '/api/<route-path>', {
    name: `${RUN_TAG} ${overrides.name || 'fixture'}`,
    // ... other required fields per the route's validator
    ...overrides,
  });
  expect(res.status(), `create: ${await res.text()}`).toBe(201);
  const row = await res.json();
  createdIds.push(row.id);
  return row;
}

// ── POST /api/<route-path> ─────────────────────────────────────────────

test.describe('<Area> API — POST /', () => {
  test('400 when required field is missing', async ({ request }) => {
    const res = await authPost(request, '/api/<route-path>', {});
    expect(res.status()).toBe(400);
  });

  test('201 happy path with minimum-valid payload', async ({ request }) => {
    const row = await createFixture(request);
    expect(typeof row.id).toBe('number');
  });

  // ... add validation tests for each validator branch
});

// ── GET /api/<route-path> ──────────────────────────────────────────────

test.describe('<Area> API — GET /', () => {
  test('returns array', async ({ request }) => {
    await createFixture(request);
    const res = await authGet(request, '/api/<route-path>');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
  });
});

// ── PUT /api/<route-path>/:id ──────────────────────────────────────────

test.describe('<Area> API — PUT /:id', () => {
  test('400 on non-numeric id', async ({ request }) => {
    const res = await authPut(request, '/api/<route-path>/not-a-number', {});
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await authPut(request, '/api/<route-path>/99999999', {});
    expect(res.status()).toBe(404);
  });
});

// ── DELETE /api/<route-path>/:id ───────────────────────────────────────

test.describe('<Area> API — DELETE /:id', () => {
  test('404 on unknown id', async ({ request }) => {
    const res = await authDelete(request, '/api/<route-path>/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── Auth gate ──────────────────────────────────────────────────────────

test.describe('<Area> API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/<route-path>`);
    expect([401, 403]).toContain(res.status());
  });
});

// ── Tenant isolation ──────────────────────────────────────────────────

test.describe('<Area> API — tenant isolation', () => {
  test('Tenant B does not see Tenant A row', async ({ request }) => {
    // 1. Create as generic admin
    const row = await createFixture(request, { name: `${RUN_TAG} cross-tenant` });

    // 2. Log in as wellness admin (different tenant)
    const wellnessLogin = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: 'admin@wellness.demo', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(wellnessLogin.status()).toBe(200);
    const wellnessToken = (await wellnessLogin.json()).token;

    // 3. Fetch as wellness — should NOT see the generic-tenant row
    const res = await request.get(`${BASE_URL}/api/<route-path>?limit=500`, {
      headers: { Authorization: `Bearer ${wellnessToken}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.data || []);
    const leaked = list.filter((r) => r.id === row.id);
    expect(leaked, `cross-tenant leak detected on /api/<route-path>`).toHaveLength(0);
  });
});
```

After this is green, run:
```
node .claude/skills/wiring-spec-into-gate/wire-in.sh tests/<area>-api.spec.js
```
to add it to the deploy.yml + coverage.yml gate-spec lists.
