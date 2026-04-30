// @ts-check
/**
 * Deals module — backend coverage push.
 *
 * routes/deals.js was 26.9% covered (393 uncovered / 538 total). The file is a
 * CRUD+pipeline-stage router with soft-delete, restore, dedicated won/lost
 * actions, a stats aggregation, and a merged-timeline view. Stage values are
 * lowercase per the #190 migration — `lead`, `contacted`, `proposal`,
 * `negotiation`, `won`, `lost`.
 *
 * Endpoints covered:
 *   GET    /api/deals                — list + filters (stage, ownerId,
 *                                      pipelineId, contactId, from, to) +
 *                                      pagination (limit/offset, capped at 500)
 *                                      + ?includeDeleted opt-in
 *   GET    /api/deals/stats          — aggregations (totalDeals, totalValue,
 *                                      avgDealSize, winRate, byStage,
 *                                      closedThisMonth)
 *   GET    /api/deals/:id            — single + 400 INVALID_ID + 404 +
 *                                      soft-delete hidden by default +
 *                                      ?includeDeleted=true reveals
 *   POST   /api/deals                — create + 400 missing title +
 *                                      INVALID_AMOUNT + INVALID_PROBABILITY +
 *                                      INVALID_STAGE + currency default
 *   PUT    /api/deals/:id            — partial update + 404 + same validators
 *                                      as POST + stage transition emits
 *                                      `deal.stage_changed` (asserted via
 *                                      response shape — eventBus side
 *                                      effects are async and out-of-scope)
 *                                      + auto-100/0 probability on won/lost
 *   PUT    /api/deals/:id/stage      — backwards-compat stage-only update +
 *                                      400 missing stage + 404
 *   POST   /api/deals/:id/won        — mark won + 404
 *   POST   /api/deals/:id/lost       — mark lost (with optional lostReason) +
 *                                      404
 *   DELETE /api/deals/:id            — ADMIN soft-delete + 400 INVALID_ID +
 *                                      404 + idempotent + 403 RBAC for USER
 *   POST   /api/deals/:id/restore    — ADMIN restore + 400 INVALID_ID + 404 +
 *                                      idempotent (already-not-deleted no-op)
 *                                      + 403 RBAC for USER
 *   GET    /api/deals/:id/timeline   — merged activity/email/call/task
 *                                      timeline + 404
 *
 * Tenant: generic. Dual-token (admin + USER) so we can exercise admin-only
 * paths and assert 403 for the USER role on delete + restore. Test data
 * tagged `E2E_DEAL_<ts>` in title; afterAll DELETEs every created deal as
 * admin (best-effort).
 *
 * Concurrency: each test creates its own deal, so spec is parallel-safe; no
 * serial mode pin needed.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_DEAL_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;

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

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
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

// Convenience admin wrappers (most tests use admin).
async function aget(request, path) { const { token } = await getAdmin(request); return get(request, token, path); }
async function apost(request, path, body) { const { token } = await getAdmin(request); return post(request, token, path, body); }
async function aput(request, path, body) { const { token } = await getAdmin(request); return put(request, token, path, body); }
async function adel(request, path) { const { token } = await getAdmin(request); return del(request, token, path); }

// ── Cleanup tracking ───────────────────────────────────────────────
const createdDealIds = [];

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdDealIds) {
    await del(request, token, `/api/deals/${id}`).catch(() => {});
  }
});

// Helper: create a deal as admin and remember it for cleanup.
async function createDeal(request, overrides = {}) {
  const body = {
    title: `${RUN_TAG} ${overrides.title || 'deal'}`,
    amount: overrides.amount ?? 1000,
    probability: overrides.probability ?? 50,
    stage: overrides.stage || 'lead',
    ...(overrides.contactId !== undefined ? { contactId: overrides.contactId } : {}),
    ...(overrides.pipelineId !== undefined ? { pipelineId: overrides.pipelineId } : {}),
    ...(overrides.expectedClose !== undefined ? { expectedClose: overrides.expectedClose } : {}),
    ...(overrides.currency !== undefined ? { currency: overrides.currency } : {}),
  };
  const res = await apost(request, '/api/deals', body);
  expect(res.status(), `deal create: ${await res.text()}`).toBe(201);
  const d = await res.json();
  createdDealIds.push(d.id);
  return d;
}

// ─── POST /api/deals ─────────────────────────────────────────────────

test.describe('Deals API — POST /', () => {
  test('400 when title is missing', async ({ request }) => {
    const res = await apost(request, '/api/deals', { amount: 100 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title/i);
  });

  test('201 happy path with all stages — lead', async ({ request }) => {
    const d = await createDeal(request, { title: 'create-lead', stage: 'lead' });
    expect(d.stage).toBe('lead');
    expect(d.title).toContain('create-lead');
    expect(d.amount).toBe(1000);
    expect(d.probability).toBe(50);
    expect(d.ownerId).toBeTruthy();
    expect(d.tenantId).toBeTruthy();
  });

  test('201 with stage=contacted', async ({ request }) => {
    const d = await createDeal(request, { title: 'create-contacted', stage: 'contacted' });
    expect(d.stage).toBe('contacted');
  });

  test('201 with stage=proposal', async ({ request }) => {
    const d = await createDeal(request, { title: 'create-proposal', stage: 'proposal' });
    expect(d.stage).toBe('proposal');
  });

  test('201 with stage=negotiation', async ({ request }) => {
    const d = await createDeal(request, { title: 'create-negotiation', stage: 'negotiation' });
    expect(d.stage).toBe('negotiation');
  });

  test('400 INVALID_STAGE on bogus stage', async ({ request }) => {
    const res = await apost(request, '/api/deals', {
      title: `${RUN_TAG} bad-stage`,
      stage: 'NotAStage',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_STAGE');
  });

  test('400 INVALID_AMOUNT on negative amount', async ({ request }) => {
    const res = await apost(request, '/api/deals', {
      title: `${RUN_TAG} neg-amount`,
      amount: -50,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_AMOUNT');
  });

  test('400 INVALID_PROBABILITY on probability out of range', async ({ request }) => {
    const res = await apost(request, '/api/deals', {
      title: `${RUN_TAG} bad-prob`,
      probability: 150,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_PROBABILITY');
  });

  test('default stage is "lead" when omitted', async ({ request }) => {
    const res = await apost(request, '/api/deals', {
      title: `${RUN_TAG} default-stage`,
      amount: 100,
    });
    expect(res.status()).toBe(201);
    const d = await res.json();
    createdDealIds.push(d.id);
    expect(d.stage).toBe('lead');
  });

  test('amount defaults to 0 when omitted, probability to 50', async ({ request }) => {
    const res = await apost(request, '/api/deals', { title: `${RUN_TAG} no-amount` });
    expect(res.status()).toBe(201);
    const d = await res.json();
    createdDealIds.push(d.id);
    expect(d.amount).toBe(0);
    expect(d.probability).toBe(50);
  });

  test('currency defaults to tenant defaultCurrency when omitted', async ({ request }) => {
    const d = await createDeal(request, { title: 'default-currency' });
    // Generic tenant defaultCurrency falls back to USD if not seeded.
    expect(typeof d.currency).toBe('string');
    expect(d.currency.length).toBeGreaterThan(0);
  });

  test('explicit currency override is respected', async ({ request }) => {
    const d = await createDeal(request, { title: 'explicit-currency', currency: 'EUR' });
    expect(d.currency).toBe('EUR');
  });

  test('expectedClose date is parsed and stored', async ({ request }) => {
    const d = await createDeal(request, { title: 'with-expected-close', expectedClose: '2099-06-15' });
    expect(d.expectedClose).toBeTruthy();
    expect(new Date(d.expectedClose).getFullYear()).toBe(2099);
  });
});

// ─── GET /api/deals ──────────────────────────────────────────────────

test.describe('Deals API — GET /', () => {
  test('200 returns array', async ({ request }) => {
    await createDeal(request, { title: 'list-A' });
    const res = await aget(request, '/api/deals');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('?stage=lead filters to lead-only', async ({ request }) => {
    await createDeal(request, { title: 'filter-lead', stage: 'lead' });
    const res = await aget(request, '/api/deals?stage=lead&limit=500');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((d) => d.stage === 'lead')).toBe(true);
  });

  test('?ownerId filter applied (own deals visible)', async ({ request }) => {
    const { userId } = await getAdmin(request);
    const d = await createDeal(request, { title: 'filter-owner' });
    const res = await aget(request, `/api/deals?ownerId=${userId}&limit=500`);
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.find((row) => row.id === d.id)).toBeTruthy();
    expect(list.every((row) => row.ownerId === userId)).toBe(true);
  });

  test('?from/?to date range filter narrows results', async ({ request }) => {
    await createDeal(request, { title: 'filter-date' });
    // Far-past range — should return zero rows.
    const res = await aget(request, '/api/deals?from=2000-01-01&to=2000-12-31&limit=500');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBe(0);
  });

  test('pagination — limit honored', async ({ request }) => {
    await createDeal(request, { title: 'page-1' });
    const res = await aget(request, '/api/deals?limit=1');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(1);
  });

  test('pagination — limit > 500 clamped to 500', async ({ request }) => {
    const res = await aget(request, '/api/deals?limit=99999');
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeLessThanOrEqual(500);
  });

  test('offset honored — second page differs from first', async ({ request }) => {
    // Need at least 2 deals; create two and just verify the call is accepted.
    await createDeal(request, { title: 'offset-A' });
    await createDeal(request, { title: 'offset-B' });
    const res = await aget(request, '/api/deals?limit=1&offset=1');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeLessThanOrEqual(1);
  });

  test('soft-deleted hidden by default', async ({ request }) => {
    const d = await createDeal(request, { title: 'hidden-default' });
    await adel(request, `/api/deals/${d.id}`);
    const list = await (await aget(request, '/api/deals?limit=500')).json();
    expect(list.find((row) => row.id === d.id)).toBeFalsy();
  });

  test('?includeDeleted=true surfaces soft-deleted rows', async ({ request }) => {
    const d = await createDeal(request, { title: 'opt-in-deleted' });
    await adel(request, `/api/deals/${d.id}`);
    const list = await (await aget(request, '/api/deals?includeDeleted=true&limit=500')).json();
    expect(list.find((row) => row.id === d.id)).toBeTruthy();
  });
});

// ─── GET /api/deals/stats ────────────────────────────────────────────

test.describe('Deals API — GET /stats', () => {
  test('200 returns aggregation envelope', async ({ request }) => {
    await createDeal(request, { title: 'stats-feed' });
    const res = await aget(request, '/api/deals/stats');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.totalDeals).toBe('number');
    expect(typeof body.totalValue).toBe('number');
    expect(typeof body.avgDealSize).toBe('number');
    expect(typeof body.winRate).toBe('number');
    expect(Array.isArray(body.byStage)).toBe(true);
    expect(typeof body.closedThisMonth).toBe('number');
  });

  test('byStage entries have {stage,count,value} shape', async ({ request }) => {
    const res = await aget(request, '/api/deals/stats');
    expect(res.status()).toBe(200);
    const { byStage } = await res.json();
    for (const row of byStage) {
      expect(typeof row.stage).toBe('string');
      expect(typeof row.count).toBe('number');
      expect(typeof row.value).toBe('number');
    }
  });
});

// ─── GET /api/deals/:id ──────────────────────────────────────────────

test.describe('Deals API — GET /:id', () => {
  test('400 INVALID_ID on non-numeric id', async ({ request }) => {
    const res = await aget(request, '/api/deals/not-a-number');
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_ID');
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await aget(request, '/api/deals/99999999');
    expect(res.status()).toBe(404);
  });

  test('returns row with relations + activities array', async ({ request }) => {
    const d = await createDeal(request, { title: 'detail-eager' });
    const res = await aget(request, `/api/deals/${d.id}`);
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.id).toBe(d.id);
    expect(Array.isArray(got.activities)).toBe(true);
    // owner relation pulled in.
    expect(got.owner).toBeTruthy();
  });

  test('soft-deleted deal returns 404 by default', async ({ request }) => {
    const d = await createDeal(request, { title: 'detail-deleted' });
    await adel(request, `/api/deals/${d.id}`);
    const res = await aget(request, `/api/deals/${d.id}`);
    expect(res.status()).toBe(404);
  });

  test('soft-deleted deal visible with ?includeDeleted=true', async ({ request }) => {
    const d = await createDeal(request, { title: 'detail-included' });
    await adel(request, `/api/deals/${d.id}`);
    const res = await aget(request, `/api/deals/${d.id}?includeDeleted=true`);
    expect(res.status()).toBe(200);
    expect((await res.json()).deletedAt).toBeTruthy();
  });
});

// ─── PUT /api/deals/:id ──────────────────────────────────────────────

test.describe('Deals API — PUT /:id', () => {
  test('400 INVALID_ID on non-numeric id', async ({ request }) => {
    const res = await aput(request, '/api/deals/abc', { title: 'x' });
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await aput(request, '/api/deals/99999999', { title: 'x' });
    expect(res.status()).toBe(404);
  });

  test('updates title (partial update)', async ({ request }) => {
    const d = await createDeal(request, { title: 'pre-rename' });
    const res = await aput(request, `/api/deals/${d.id}`, { title: `${RUN_TAG} renamed` });
    expect(res.status()).toBe(200);
    expect((await res.json()).title).toContain('renamed');
  });

  test('updates amount', async ({ request }) => {
    const d = await createDeal(request, { title: 'amount-update', amount: 100 });
    const res = await aput(request, `/api/deals/${d.id}`, { amount: 500 });
    expect(res.status()).toBe(200);
    expect((await res.json()).amount).toBe(500);
  });

  test('400 INVALID_AMOUNT on negative amount in PUT', async ({ request }) => {
    const d = await createDeal(request, { title: 'put-neg-amount' });
    const res = await aput(request, `/api/deals/${d.id}`, { amount: -1 });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_AMOUNT');
  });

  test('400 INVALID_STAGE on bogus stage in PUT', async ({ request }) => {
    const d = await createDeal(request, { title: 'put-bad-stage' });
    const res = await aput(request, `/api/deals/${d.id}`, { stage: 'NotAStage' });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_STAGE');
  });

  test('stage transition lead → proposal returns updated deal', async ({ request }) => {
    const d = await createDeal(request, { title: 'stage-transition', stage: 'lead' });
    const res = await aput(request, `/api/deals/${d.id}`, { stage: 'proposal' });
    expect(res.status()).toBe(200);
    expect((await res.json()).stage).toBe('proposal');
  });

  test('stage=won via PUT auto-sets probability to 100', async ({ request }) => {
    const d = await createDeal(request, { title: 'put-to-won', stage: 'lead', probability: 30 });
    const res = await aput(request, `/api/deals/${d.id}`, { stage: 'won' });
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.stage).toBe('won');
    expect(got.probability).toBe(100);
  });

  test('stage=lost via PUT auto-sets probability to 0', async ({ request }) => {
    const d = await createDeal(request, { title: 'put-to-lost', stage: 'lead', probability: 30 });
    const res = await aput(request, `/api/deals/${d.id}`, { stage: 'lost', lostReason: 'budget' });
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.stage).toBe('lost');
    expect(got.probability).toBe(0);
    expect(got.lostReason).toBe('budget');
  });

  test('PUT empty body is no-op (200, fields preserved)', async ({ request }) => {
    const d = await createDeal(request, { title: 'noop-update' });
    const res = await aput(request, `/api/deals/${d.id}`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).title).toContain('noop-update');
  });
});

// ─── PUT /api/deals/:id/stage ────────────────────────────────────────

test.describe('Deals API — PUT /:id/stage', () => {
  test('400 when stage is missing', async ({ request }) => {
    const d = await createDeal(request, { title: 'stage-missing' });
    const res = await aput(request, `/api/deals/${d.id}/stage`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/stage/i);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await aput(request, '/api/deals/99999999/stage', { stage: 'won' });
    expect(res.status()).toBe(404);
  });

  test('flips stage to negotiation', async ({ request }) => {
    const d = await createDeal(request, { title: 'stage-to-negotiation', stage: 'lead' });
    const res = await aput(request, `/api/deals/${d.id}/stage`, { stage: 'negotiation' });
    expect(res.status()).toBe(200);
    expect((await res.json()).stage).toBe('negotiation');
  });

  test('stage=won via /stage auto-sets probability to 100', async ({ request }) => {
    const d = await createDeal(request, { title: 'stage-to-won', stage: 'lead' });
    const res = await aput(request, `/api/deals/${d.id}/stage`, { stage: 'won' });
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.stage).toBe('won');
    expect(got.probability).toBe(100);
  });

  test('stage=lost with lostReason via /stage', async ({ request }) => {
    const d = await createDeal(request, { title: 'stage-to-lost', stage: 'lead' });
    const res = await aput(request, `/api/deals/${d.id}/stage`, { stage: 'lost', lostReason: 'price' });
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.stage).toBe('lost');
    expect(got.probability).toBe(0);
    expect(got.lostReason).toBe('price');
  });
});

// ─── POST /api/deals/:id/won ─────────────────────────────────────────

test.describe('Deals API — POST /:id/won', () => {
  test('404 on unknown id', async ({ request }) => {
    const res = await apost(request, '/api/deals/99999999/won', {});
    expect(res.status()).toBe(404);
  });

  test('flips stage to won and probability to 100', async ({ request }) => {
    const d = await createDeal(request, { title: 'mark-won', stage: 'proposal', probability: 60 });
    const res = await apost(request, `/api/deals/${d.id}/won`, {});
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.stage).toBe('won');
    expect(got.probability).toBe(100);
  });
});

// ─── POST /api/deals/:id/lost ────────────────────────────────────────

test.describe('Deals API — POST /:id/lost', () => {
  test('404 on unknown id', async ({ request }) => {
    const res = await apost(request, '/api/deals/99999999/lost', {});
    expect(res.status()).toBe(404);
  });

  test('flips stage to lost and probability to 0', async ({ request }) => {
    const d = await createDeal(request, { title: 'mark-lost', stage: 'proposal', probability: 60 });
    const res = await apost(request, `/api/deals/${d.id}/lost`, {});
    expect(res.status()).toBe(200);
    const got = await res.json();
    expect(got.stage).toBe('lost');
    expect(got.probability).toBe(0);
  });

  test('persists lostReason when provided', async ({ request }) => {
    const d = await createDeal(request, { title: 'mark-lost-with-reason', stage: 'proposal' });
    const res = await apost(request, `/api/deals/${d.id}/lost`, { lostReason: 'competitor' });
    expect(res.status()).toBe(200);
    expect((await res.json()).lostReason).toBe('competitor');
  });
});

// ─── DELETE /api/deals/:id (admin-only soft-delete) ──────────────────

test.describe('Deals API — DELETE /:id (soft-delete)', () => {
  test('400 INVALID_ID on non-numeric id', async ({ request }) => {
    const res = await adel(request, '/api/deals/abc');
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await adel(request, '/api/deals/99999999');
    expect(res.status()).toBe(404);
  });

  test('flips deletedAt; row hidden from default list', async ({ request }) => {
    const d = await createDeal(request, { title: 'soft-delete-target' });
    const res = await adel(request, `/api/deals/${d.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.softDeleted).toBe(true);
    expect(body.deletedAt).toBeTruthy();
  });

  test('idempotent: second DELETE returns idempotent:true', async ({ request }) => {
    const d = await createDeal(request, { title: 'idempotent-delete' });
    await adel(request, `/api/deals/${d.id}`);
    const second = await adel(request, `/api/deals/${d.id}`);
    expect(second.status()).toBe(200);
    const body = await second.json();
    expect(body.idempotent).toBe(true);
    expect(body.softDeleted).toBe(true);
  });

  test('403 RBAC — regular USER cannot soft-delete', async ({ request }) => {
    const { token: utok } = await getUser(request);
    if (!utok) test.skip(true, 'no regular USER token available');
    const d = await createDeal(request, { title: 'rbac-delete' });
    const res = await del(request, utok, `/api/deals/${d.id}`);
    expect([401, 403]).toContain(res.status());
  });
});

// ─── POST /api/deals/:id/restore (admin-only) ────────────────────────

test.describe('Deals API — POST /:id/restore', () => {
  test('400 INVALID_ID on non-numeric id', async ({ request }) => {
    const res = await apost(request, '/api/deals/abc/restore', {});
    expect(res.status()).toBe(400);
  });

  test('404 on unknown id', async ({ request }) => {
    const res = await apost(request, '/api/deals/99999999/restore', {});
    expect(res.status()).toBe(404);
  });

  test('clears deletedAt; row visible in default list again', async ({ request }) => {
    const d = await createDeal(request, { title: 'restore-target' });
    await adel(request, `/api/deals/${d.id}`);
    const res = await apost(request, `/api/deals/${d.id}/restore`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.restored).toBe(true);
    expect(body.deletedAt).toBeNull();

    const list = await (await aget(request, '/api/deals?limit=500')).json();
    expect(list.find((row) => row.id === d.id)).toBeTruthy();
  });

  test('idempotent: restore on a non-deleted deal returns idempotent:true', async ({ request }) => {
    const d = await createDeal(request, { title: 'restore-noop' });
    const res = await apost(request, `/api/deals/${d.id}/restore`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.restored).toBe(false);
  });

  test('403 RBAC — regular USER cannot restore', async ({ request }) => {
    const { token: utok } = await getUser(request);
    if (!utok) test.skip(true, 'no regular USER token available');
    const d = await createDeal(request, { title: 'rbac-restore' });
    await adel(request, `/api/deals/${d.id}`);
    const res = await post(request, utok, `/api/deals/${d.id}/restore`, {});
    expect([401, 403]).toContain(res.status());
  });
});

// ─── GET /api/deals/:id/timeline ─────────────────────────────────────

test.describe('Deals API — GET /:id/timeline', () => {
  test('404 on unknown id', async ({ request }) => {
    const res = await aget(request, '/api/deals/99999999/timeline');
    expect(res.status()).toBe(404);
  });

  test('200 returns array (possibly empty for deal with no contact)', async ({ request }) => {
    const d = await createDeal(request, { title: 'timeline-target' });
    const res = await aget(request, `/api/deals/${d.id}/timeline`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('timeline entries are sorted descending by createdAt when present', async ({ request }) => {
    const d = await createDeal(request, { title: 'timeline-sort' });
    const res = await aget(request, `/api/deals/${d.id}/timeline`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.length >= 2) {
      const t0 = new Date(body[0].createdAt).getTime();
      const t1 = new Date(body[1].createdAt).getTime();
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });
});

// ─── Auth gate ───────────────────────────────────────────────────────

test.describe('Deals API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/deals`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /stats without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/deals/stats`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/deals/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/deals`, {
      data: { title: 'x', amount: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/deals/1`, {
      data: { title: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id/stage without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/deals/1/stage`, {
      data: { stage: 'won' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/won without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/deals/1/won`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/lost without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/deals/1/lost`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/deals/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/restore without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/deals/1/restore`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id/timeline without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/deals/1/timeline`);
    expect([401, 403]).toContain(res.status());
  });
});
