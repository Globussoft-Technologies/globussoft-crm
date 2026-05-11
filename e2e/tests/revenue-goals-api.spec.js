// @ts-check
/**
 * Staff Revenue Goals API spec — PRD Gap §1.6.
 *
 * Routes covered:
 *   GET    /api/staff/revenue-goals          — list (admin sees all, USER sees own)
 *   POST   /api/staff/revenue-goals          — create (admin only)
 *   PUT    /api/staff/revenue-goals/:id      — update (admin only)
 *   DELETE /api/staff/revenue-goals/:id      — delete (admin only)
 *
 * Coverage:
 *   - 401 without token (auth gate)
 *   - 403 for non-admin POST/PUT/DELETE (role gate)
 *   - 200 GET as USER returns ONLY rows where userId === self
 *   - 400 on missing required fields, invalid period/scope, periodStart >= periodEnd
 *   - 201 happy-path create + response shape (period / target / scope / achievedAmount)
 *   - 200 update of targetAmount + scope
 *   - achievedAmount is computed from Sale.total SUM (we don't seed sales here;
 *     a fresh goal MUST report achievedAmount = 0 — that's the assertion)
 *   - 204 delete
 *   - tenant isolation: spawning a generic-tenant goal cannot be read by the
 *     wellness-tenant admin via the same endpoint
 *
 * Cleanup: tagged via the notes field; afterAll deletes every created goal.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `_teardown_RG_${Date.now()}`;

let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;
let wellnessAdminToken = null;
const createdGoalIds = [];

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
    } catch {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.beforeAll(async ({ request }) => {
  const a = await loginAs(request, 'admin@globussoft.com', 'password123');
  adminToken = a.token;
  adminUserId = a.userId;
  const u = await loginAs(request, 'user@crm.com', 'password123');
  userToken = u.token;
  userUserId = u.userId;
  // Cross-tenant probe: wellness admin should not see generic tenant goals.
  const w = await loginAs(request, 'admin@wellness.demo', 'password123');
  wellnessAdminToken = w.token;

  // v3.7.4 spec hygiene — clean up orphan rows from PRIOR runs that
  // crashed before their afterAll could fire. Without this, a flaky run
  // (e.g. demo-overload timeout) leaks a row at the hardcoded
  // periodStart, and the next run's POST hits the
  // @@unique([tenantId, userId, period, periodStart]) constraint
  // → 409 → "real failure" alarm on a spec-pollution artifact.
  // Filter on the notes prefix RUN_TAG uses (`_teardown_RG_`) so we
  // never touch real goals.
  if (adminToken) {
    try {
      const listRes = await request.get(`${BASE_URL}/api/staff/revenue-goals`, {
        headers: headers(adminToken),
        timeout: REQUEST_TIMEOUT,
      });
      if (listRes.ok()) {
        const body = await listRes.json();
        const items = Array.isArray(body) ? body : (body.goals || body.rows || []);
        const orphans = items.filter(
          (g) => g && typeof g.notes === 'string' && g.notes.startsWith('_teardown_RG_'),
        );
        for (const g of orphans) {
          await request
            .delete(`${BASE_URL}/api/staff/revenue-goals/${g.id}`, {
              headers: headers(adminToken),
              timeout: REQUEST_TIMEOUT,
            })
            .catch(() => {});
        }
      }
    } catch (_e) {
      /* fail-soft — the spec still has the unique-periodStart fallback below */
    }
  }
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  for (const id of createdGoalIds) {
    await request
      .delete(`${BASE_URL}/api/staff/revenue-goals/${id}`, {
        headers: headers(adminToken),
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

// Future-window goal (so we don't accidentally pick up real demo sales).
//
// v3.7.4 — periodStart is now unique-per-run instead of hardcoded
// 2099-01-01. The @@unique([tenantId, userId, period, periodStart])
// constraint on StaffRevenueGoal means any two runs that hit the
// same admin + same period + same hardcoded start collide on P2002.
// `Date.now() / 1000 % 365` spreads picks across all days of 2099,
// effectively eliminating collisions across the ~few-runs-per-day
// e2e-full cadence. The 30-day period stays inside 2099.
function farFutureWindow() {
  const dayOffset = Math.floor(Date.now() / 1000) % 365; // 0-364
  const start = new Date(Date.UTC(2099, 0, 1 + dayOffset));
  const end = new Date(start.getTime() + 30 * 86_400_000);
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

test.describe('Revenue Goals — auth gates', () => {
  test('401 without token', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/api/staff/revenue-goals`, { timeout: REQUEST_TIMEOUT });
    expect(r.status()).toBe(401);
  });

  test('POST forbidden for USER (403)', async ({ request }) => {
    test.skip(!userToken, 'no user token');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(userToken),
      data: {
        targetUserId: userUserId,
        period: 'MONTHLY',
        targetAmount: 50000,
        ...win,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });
});

test.describe('Revenue Goals — validation', () => {
  test('400 on missing userId', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { period: 'MONTHLY', targetAmount: 100, ...win, notes: RUN_TAG },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
  });

  test('400 on invalid period', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { targetUserId: adminUserId, period: 'BIWEEKLY', targetAmount: 100, ...win, notes: RUN_TAG },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
  });

  test('400 on invalid scope', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { targetUserId: adminUserId, period: 'MONTHLY', targetAmount: 100, scope: 'BOGUS', ...win, notes: RUN_TAG },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
  });

  test('400 on negative targetAmount', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { targetUserId: adminUserId, period: 'MONTHLY', targetAmount: -100, ...win, notes: RUN_TAG },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
  });

  test('400 when periodStart >= periodEnd', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: {
        targetUserId: adminUserId,
        period: 'MONTHLY',
        targetAmount: 100,
        periodStart: new Date(Date.UTC(2099, 1, 1)).toISOString(),
        periodEnd: new Date(Date.UTC(2099, 0, 1)).toISOString(),
        notes: RUN_TAG,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(400);
  });

  test('404 when target user not in tenant', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { targetUserId: 999_999_999, period: 'MONTHLY', targetAmount: 100, ...win, notes: RUN_TAG },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
  });
});

test.describe('Revenue Goals — happy path', () => {
  let createdId = null;

  test('POST creates a goal (201) with correct shape', async ({ request }) => {
    test.skip(!adminToken || !adminUserId, 'no admin');
    const win = farFutureWindow();
    const r = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: {
        targetUserId: adminUserId,
        period: 'MONTHLY',
        targetAmount: 50000,
        scope: 'ALL',
        notes: RUN_TAG,
        ...win,
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(j).toHaveProperty('id');
    expect(j.userId).toBe(adminUserId);
    expect(j.period).toBe('MONTHLY');
    expect(Number(j.targetAmount)).toBe(50000);
    expect(j.scope).toBe('ALL');
    createdId = j.id;
    createdGoalIds.push(createdId);
  });

  test('GET as admin returns the created goal with achievedAmount=0 (no sales in window)', async ({ request }) => {
    test.skip(!adminToken || !createdId, 'no admin/goal');
    const r = await request.get(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const rows = await r.json();
    const found = rows.find((g) => g.id === createdId);
    expect(found).toBeTruthy();
    // No COMPLETED sales for this user in 2099 — achieved must be 0.
    expect(Number(found.achievedAmount)).toBe(0);
    // user object embedded for the dashboard widget.
    expect(found.user).toBeTruthy();
    expect(found.user.id).toBe(adminUserId);
  });

  test('PUT updates targetAmount + scope', async ({ request }) => {
    test.skip(!adminToken || !createdId, 'no admin/goal');
    const r = await request.put(`${BASE_URL}/api/staff/revenue-goals/${createdId}`, {
      headers: headers(adminToken),
      data: { targetAmount: 75000, scope: 'SERVICE', scopeFilter: 'Aesthetics' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Number(j.targetAmount)).toBe(75000);
    expect(j.scope).toBe('SERVICE');
    expect(j.scopeFilter).toBe('Aesthetics');
  });
});

test.describe('Revenue Goals — RBAC scoping on GET', () => {
  let adminGoalId = null;
  let userGoalId = null;

  test('admin creates goals for both admin and USER', async ({ request }) => {
    test.skip(!adminToken || !adminUserId || !userUserId, 'no admin/user');
    const win = farFutureWindow();
    // v3.7.4 — win2 needs a DIFFERENT periodStart from `win` (we're
    // creating two goals for the same admin user in this test, and the
    // @@unique([tenantId, userId, period, periodStart]) constraint would
    // bite if both used farFutureWindow()'s clock-derived day). Offset
    // win2 by 100 days from win's start so the two are always distinct.
    const winStart = new Date(win.periodStart);
    const win2Start = new Date(winStart.getTime() + 100 * 86_400_000);
    const win2 = {
      periodStart: win2Start.toISOString(),
      periodEnd: new Date(win2Start.getTime() + 30 * 86_400_000).toISOString(),
    };
    const r1 = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { targetUserId: adminUserId, period: 'MONTHLY', targetAmount: 1000, scope: 'ALL', notes: RUN_TAG, ...win2 },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r1.status()).toBe(201);
    adminGoalId = (await r1.json()).id;
    createdGoalIds.push(adminGoalId);

    const r2 = await request.post(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(adminToken),
      data: { targetUserId: userUserId, period: 'MONTHLY', targetAmount: 2000, scope: 'ALL', notes: RUN_TAG, ...win },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r2.status()).toBe(201);
    userGoalId = (await r2.json()).id;
    createdGoalIds.push(userGoalId);
  });

  test('USER sees ONLY their own goal on GET', async ({ request }) => {
    test.skip(!userToken || !userGoalId, 'no user/userGoal');
    const r = await request.get(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(userToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const rows = await r.json();
    expect(Array.isArray(rows)).toBe(true);
    // USER must see their own goal but NOT the admin's goal.
    const ownIds = rows.map((g) => g.id);
    expect(ownIds).toContain(userGoalId);
    expect(ownIds).not.toContain(adminGoalId);
    // All returned rows are scoped to the calling user.
    for (const g of rows) {
      expect(g.userId).toBe(userUserId);
    }
  });

  test('USER cannot filter by another userId (403)', async ({ request }) => {
    test.skip(!userToken || !adminUserId, 'no user');
    const r = await request.get(`${BASE_URL}/api/staff/revenue-goals?userId=${adminUserId}`, {
      headers: headers(userToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(403);
  });
});

test.describe('Revenue Goals — tenant isolation', () => {
  test('wellness-tenant admin does NOT see generic-tenant goals', async ({ request }) => {
    test.skip(!wellnessAdminToken, 'no wellness admin token');
    const r = await request.get(`${BASE_URL}/api/staff/revenue-goals`, {
      headers: headers(wellnessAdminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const rows = await r.json();
    // None of the generic tenant's goal ids should leak through.
    for (const id of createdGoalIds) {
      expect(rows.find((g) => g.id === id)).toBeFalsy();
    }
  });
});

test.describe('Revenue Goals — delete', () => {
  test('DELETE returns 204', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    // Pick the first goal to delete.
    const id = createdGoalIds[0];
    if (!id) test.skip();
    const r = await request.delete(`${BASE_URL}/api/staff/revenue-goals/${id}`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect([204, 200]).toContain(r.status());
    const idx = createdGoalIds.indexOf(id);
    if (idx >= 0) createdGoalIds.splice(idx, 1);
  });

  test('DELETE on unknown id returns 404', async ({ request }) => {
    test.skip(!adminToken, 'no admin');
    const r = await request.delete(`${BASE_URL}/api/staff/revenue-goals/999999999`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(404);
  });
});
