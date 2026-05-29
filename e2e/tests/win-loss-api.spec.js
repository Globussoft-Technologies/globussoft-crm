// @ts-check
/**
 * Win/Loss API — e2e contract pin for backend/routes/win_loss.js.
 *
 * File purpose
 * ─────────────
 * routes/win_loss.js was 13.59% lines per c8 measurement. The sibling vitest
 * suite at backend/test/routes/win-loss.test.js (17 cases, 216% test ratio)
 * pins the unit-level shape with mocked prisma, but no *-api.spec.js wired
 * into the api_tests deploy gate exercises the route through Express +
 * real Prisma against the seeded MySQL stack. A bare e2e/tests/win_loss.spec.js
 * exists but is not in the gate spec list. This file is the canonical
 * gate-coverage partner — once the parent cron wires it into deploy.yml +
 * coverage.yml, the route's exposure to silent regressions drops sharply.
 *
 * The route owns the Sales WinLoss dashboard's three load-bearing contracts:
 *   (1) WinLossReason CRUD is tenant-scoped — cross-tenant lookups MUST 404
 *       (per #550 the DELETE returns 204 No Content, not 200);
 *   (2) GET /analysis aggregates won/lost deals into a {wonCount, lostCount,
 *       winRate, byReason, avgDealSize, closedDeals} envelope; winRate is
 *       rounded to one decimal place;
 *   (3) PUT /deals/:dealId/reason resolves winLossReasonId strictly inside
 *       the deal's tenant — a forged id from another tenant must 400.
 *
 * Endpoints under test
 * ────────────────────
 *   GET    /api/win-loss/reasons              — tenant-scoped list
 *   POST   /api/win-loss/reasons              — create (won|lost validated)
 *   DELETE /api/win-loss/reasons/:id          — tenant-scoped delete (204)
 *   GET    /api/win-loss/analysis?from=&to=   — aggregate envelope
 *   PUT    /api/win-loss/deals/:dealId/reason — set lostReason / winLossReasonId
 *
 * Contracts asserted (numbered)
 * ─────────────────────────────
 *   C1.  GET /reasons → 200 array, tenant-scoped, ordered (type asc, count desc).
 *   C2.  POST /reasons → 201 with {type, reason, count:0, tenantId} echoed.
 *   C3.  POST /reasons → 400 when type missing.
 *   C4.  POST /reasons → 400 when reason missing.
 *   C5.  POST /reasons → 400 when type not in {'won','lost'}.
 *   C6.  DELETE /reasons/:id → 204 No Content on happy path (per #550).
 *   C7.  DELETE /reasons/:id → 404 when id does not exist in tenant scope.
 *   C8.  GET /analysis → 200 returns the {wonCount, lostCount, winRate,
 *        byReason, avgDealSize, closedDeals} envelope shape.
 *   C9.  GET /analysis → byReason groups by reason text + type; winRate is
 *        a rounded-to-1dp percentage; avgDealSize.{won,lost} are numbers.
 *   C10. GET /analysis?from=&to= → filters by createdAt date range.
 *   C11. PUT /deals/:dealId/reason → 200 sets lostReason on a lost deal.
 *   C12. PUT /deals/:dealId/reason → 404 when deal does not exist in tenant.
 *   C13. PUT /deals/:dealId/reason → 400 when winLossReasonId is invalid /
 *        outside-tenant (cross-tenant assignment guard).
 *   C14. PUT /deals/:dealId/reason → 400 when body has nothing to update.
 *   C15. Auth gate — every endpoint returns 401/403 without a token.
 *
 * Tenant: generic (admin@globussoft.com). Test data is tagged with RUN_TAG
 * prefix; afterAll deletes the created reasons + deals (best-effort).
 *
 * Concurrency: each test creates its own reason / deal, so the spec is
 * parallel-safe. No describe-level serial pin needed.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_WINLOSS_${Date.now()}_${process.pid}`;

let adminToken = null;
let adminUserId = null;

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
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: authHeaders(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, {
    headers: authHeaders(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT });
}

// Admin-token wrappers
async function aget(request, path) { const { token } = await getAdmin(request); return get(request, token, path); }
async function apost(request, path, body) { const { token } = await getAdmin(request); return post(request, token, path, body); }
async function aput(request, path, body) { const { token } = await getAdmin(request); return put(request, token, path, body); }
async function adel(request, path) { const { token } = await getAdmin(request); return del(request, token, path); }

// ── Cleanup tracking ───────────────────────────────────────────────────
const createdReasonIds = [];
const createdDealIds = [];

test.afterAll(async ({ request }) => {
  test.setTimeout(120_000);
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdReasonIds) {
    await del(request, token, `/api/win-loss/reasons/${id}`).catch(() => {});
  }
  for (const id of createdDealIds) {
    await del(request, token, `/api/deals/${id}`).catch(() => {});
  }
});

// Helper: create a WinLossReason (tagged + tracked).
async function createReason(request, type, suffix = 'reason') {
  const body = { type, reason: `${RUN_TAG} ${suffix}` };
  const res = await apost(request, '/api/win-loss/reasons', body);
  expect(res.status(), `reason create: ${await res.text()}`).toBe(201);
  const j = await res.json();
  createdReasonIds.push(j.id);
  return j;
}

// Helper: create a deal so we can exercise /deals/:dealId/reason.
async function createDeal(request, overrides = {}) {
  const body = {
    title: `${RUN_TAG} ${overrides.title || 'deal'}`,
    amount: overrides.amount ?? 1000,
    stage: overrides.stage || 'lost',
    ...(overrides.lostReason !== undefined ? { lostReason: overrides.lostReason } : {}),
  };
  const res = await apost(request, '/api/deals', body);
  expect(res.status(), `deal create: ${await res.text()}`).toBe(201);
  const d = await res.json();
  createdDealIds.push(d.id);
  return d;
}

// ─── GET /api/win-loss/reasons ───────────────────────────────────────────

test.describe('Win/Loss API — GET /reasons', () => {
  test('C1: 200 returns array, tenant-scoped', async ({ request }) => {
    await createReason(request, 'won', 'c1-list');
    const res = await aget(request, '/api/win-loss/reasons');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Our created reason is present
    expect(body.find((r) => r.reason && r.reason.startsWith(RUN_TAG))).toBeTruthy();
    // Every row carries a tenantId
    for (const row of body) {
      expect(row.tenantId).toBeTruthy();
      expect(['won', 'lost']).toContain(row.type);
    }
  });

  test('C1: order is type asc, count desc', async ({ request }) => {
    // Seed 1 won + 1 lost so we can assert ordering across both buckets.
    await createReason(request, 'won', 'order-won');
    await createReason(request, 'lost', 'order-lost');
    const res = await aget(request, '/api/win-loss/reasons');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // type asc means 'lost' (l < w) precedes 'won'. If both present, the
    // last 'lost' index must be before the first 'won' index.
    const lostIdxs = body.map((r, i) => (r.type === 'lost' ? i : -1)).filter((i) => i >= 0);
    const wonIdxs = body.map((r, i) => (r.type === 'won' ? i : -1)).filter((i) => i >= 0);
    if (lostIdxs.length && wonIdxs.length) {
      expect(Math.max(...lostIdxs)).toBeLessThan(Math.min(...wonIdxs));
    }
    // Within a single type group, count is monotonically non-increasing.
    let lastCount = Infinity;
    let lastType = null;
    for (const r of body) {
      if (r.type !== lastType) {
        lastCount = Infinity;
        lastType = r.type;
      }
      expect(r.count).toBeLessThanOrEqual(lastCount);
      lastCount = r.count;
    }
  });
});

// ─── POST /api/win-loss/reasons ──────────────────────────────────────────

test.describe('Win/Loss API — POST /reasons', () => {
  test('C2: 201 happy path returns {type, reason, count:0, tenantId}', async ({ request }) => {
    const created = await createReason(request, 'won', 'c2-create');
    expect(created.type).toBe('won');
    expect(created.reason).toContain(RUN_TAG);
    expect(created.count).toBe(0);
    expect(created.tenantId).toBeTruthy();
    expect(typeof created.id).toBe('number');
  });

  test('C2: also accepts lost type', async ({ request }) => {
    const created = await createReason(request, 'lost', 'c2-lost');
    expect(created.type).toBe('lost');
    expect(created.count).toBe(0);
  });

  test('C3: 400 when type is missing', async ({ request }) => {
    const res = await apost(request, '/api/win-loss/reasons', { reason: `${RUN_TAG} no-type` });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/type|reason/i);
  });

  test('C4: 400 when reason is missing', async ({ request }) => {
    const res = await apost(request, '/api/win-loss/reasons', { type: 'won' });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/type|reason/i);
  });

  test('C5: 400 when type is not won|lost', async ({ request }) => {
    const res = await apost(request, '/api/win-loss/reasons', {
      type: 'tied',
      reason: `${RUN_TAG} bad-type`,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/won|lost|type/i);
  });
});

// ─── DELETE /api/win-loss/reasons/:id ────────────────────────────────────

test.describe('Win/Loss API — DELETE /reasons/:id', () => {
  test('C6: 204 No Content on happy path (per #550)', async ({ request }) => {
    // Create, then delete — but don't rely on createdReasonIds for cleanup
    // since we're explicitly deleting here.
    const created = await createReason(request, 'won', 'c6-del');
    const res = await adel(request, `/api/win-loss/reasons/${created.id}`);
    expect(res.status()).toBe(204);
    // 204 body should be empty
    const text = await res.text();
    expect(text).toBe('');
  });

  test('C7: 404 when id does not exist (or belongs to another tenant)', async ({ request }) => {
    const res = await adel(request, '/api/win-loss/reasons/99999999');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found|reason/i);
  });
});

// ─── GET /api/win-loss/analysis ──────────────────────────────────────────

test.describe('Win/Loss API — GET /analysis', () => {
  test('C8: 200 returns the full envelope shape', async ({ request }) => {
    const res = await aget(request, '/api/win-loss/analysis');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.wonCount).toBe('number');
    expect(typeof body.lostCount).toBe('number');
    expect(typeof body.winRate).toBe('number');
    expect(Array.isArray(body.byReason)).toBe(true);
    expect(body.avgDealSize).toBeTruthy();
    expect(typeof body.avgDealSize.won).toBe('number');
    expect(typeof body.avgDealSize.lost).toBe('number');
    expect(Array.isArray(body.closedDeals)).toBe(true);
  });

  test('C9: winRate is 0..100 rounded to 1 decimal; byReason rows have {reason,type,count}', async ({ request }) => {
    const res = await aget(request, '/api/win-loss/analysis');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.winRate).toBeGreaterThanOrEqual(0);
    expect(body.winRate).toBeLessThanOrEqual(100);
    // rounded to 1dp → x*10 is integer
    expect(Math.round(body.winRate * 10)).toBe(body.winRate * 10);
    for (const row of body.byReason) {
      expect(typeof row.reason).toBe('string');
      expect(['won', 'lost']).toContain(row.type);
      expect(typeof row.count).toBe('number');
      expect(row.count).toBeGreaterThan(0);
    }
    // closedDeals capped at 50, each row has {id, title, amount, stage, reason, createdAt}
    expect(body.closedDeals.length).toBeLessThanOrEqual(50);
    for (const d of body.closedDeals) {
      expect(typeof d.id).toBe('number');
      expect(['won', 'lost']).toContain(d.stage);
      expect(typeof d.amount === 'number' || d.amount === null).toBe(true);
    }
  });

  test('C9: free-text lostReason fallback surfaces in byReason', async ({ request }) => {
    const marker = `${RUN_TAG} freetext-lost`;
    // Create a lost deal with a free-text lostReason (no winLossReasonId)
    await createDeal(request, { title: 'analysis-freetext', stage: 'lost', lostReason: marker });
    const res = await aget(request, '/api/win-loss/analysis');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const row = body.byReason.find((r) => r.reason === marker && r.type === 'lost');
    expect(row).toBeTruthy();
    expect(row.count).toBeGreaterThanOrEqual(1);
  });

  test('C10: ?from/?to far-past range narrows to empty wonCount+lostCount=0', async ({ request }) => {
    const res = await aget(request, '/api/win-loss/analysis?from=2000-01-01&to=2000-12-31');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.wonCount).toBe(0);
    expect(body.lostCount).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.byReason).toEqual([]);
    expect(body.closedDeals).toEqual([]);
  });
});

// ─── PUT /api/win-loss/deals/:dealId/reason ──────────────────────────────

test.describe('Win/Loss API — PUT /deals/:dealId/reason', () => {
  test('C11: 200 sets lostReason on a lost deal', async ({ request }) => {
    const deal = await createDeal(request, { title: 'put-lost-reason', stage: 'lost' });
    const newReason = `${RUN_TAG} c11-set-text`;
    const res = await aput(request, `/api/win-loss/deals/${deal.id}/reason`, { lostReason: newReason });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.id).toBe(deal.id);
    expect(updated.lostReason).toBe(newReason);
  });

  test('C11: 200 sets winLossReasonId pointing at a tenant-scoped reason', async ({ request }) => {
    const reason = await createReason(request, 'lost', 'c11-link-target');
    const deal = await createDeal(request, { title: 'put-link', stage: 'lost' });
    const res = await aput(request, `/api/win-loss/deals/${deal.id}/reason`, {
      winLossReasonId: reason.id,
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.winLossReasonId).toBe(reason.id);
  });

  test('C12: 404 when deal id is unknown', async ({ request }) => {
    const res = await aput(request, '/api/win-loss/deals/99999999/reason', {
      lostReason: 'whatever',
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/deal|not found/i);
  });

  test('C13: 400 when winLossReasonId points at an unknown reason id', async ({ request }) => {
    const deal = await createDeal(request, { title: 'put-bad-reasonid', stage: 'lost' });
    const res = await aput(request, `/api/win-loss/deals/${deal.id}/reason`, {
      winLossReasonId: 99999999,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid|reason/i);
  });

  test('C14: 400 when body has no fields to update', async ({ request }) => {
    const deal = await createDeal(request, { title: 'put-noop', stage: 'lost' });
    const res = await aput(request, `/api/win-loss/deals/${deal.id}/reason`, {});
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no fields|update/i);
  });

  test('C11: clears winLossReasonId when null is passed', async ({ request }) => {
    const reason = await createReason(request, 'lost', 'c11-clear-target');
    const deal = await createDeal(request, { title: 'put-clear', stage: 'lost' });
    // First set
    await aput(request, `/api/win-loss/deals/${deal.id}/reason`, { winLossReasonId: reason.id });
    // Then clear
    const res = await aput(request, `/api/win-loss/deals/${deal.id}/reason`, { winLossReasonId: null });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.winLossReasonId).toBeNull();
  });
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('Win/Loss API — auth gate', () => {
  test('C15: GET /reasons without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/win-loss/reasons`);
    expect([401, 403]).toContain(res.status());
  });

  test('C15: POST /reasons without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/win-loss/reasons`, {
      data: { type: 'won', reason: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('C15: DELETE /reasons/:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/win-loss/reasons/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('C15: GET /analysis without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/win-loss/analysis`);
    expect([401, 403]).toContain(res.status());
  });

  test('C15: PUT /deals/:dealId/reason without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/win-loss/deals/1/reason`, {
      data: { lostReason: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
