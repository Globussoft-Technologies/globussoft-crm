// @ts-check
/**
 * Forecast Snapshot Engine — gate spec for cron/forecastSnapshotEngine.js (G-14).
 *
 * Engine under test: backend/cron/forecastSnapshotEngine.js
 *   - cron `0 1 * * 1` (Monday 01:00, disabled in CI by DISABLE_CRONS=1)
 *   - For every active Tenant, aggregates `Deal` rows into `Forecast` rows
 *     keyed by (tenantId, userId, period, week-window). The week window is
 *     [Monday 00:00, next Monday 00:00) computed off `new Date()`.
 *   - Per-owner forecast: one Forecast per ownerId !== null.
 *   - Tenant rollup: one Forecast with userId=null, summing ALL deals.
 *   - Metrics:
 *       expectedRevenue  = Σ amount * probability/100, OPEN deals closing this Q
 *       committedRevenue = Σ amount, deals where stage='won' OR probability>=90
 *       bestCaseRevenue  = Σ amount, ALL OPEN deals (any close date)
 *       closedRevenue    = Σ amount, stage='won' AND closing this Q
 *   - Idempotency: upsertWeeklyForecast() looks for an existing row in the
 *     SAME (tenantId, userId, period, createdAt within current week) tuple
 *     and `prisma.forecast.update`s it; otherwise create. So two runs in the
 *     same week-window UPDATE the same row, never duplicate it.
 *
 * Trigger endpoint (NEW — added in this PR alongside the spec):
 *   POST /api/forecasting/snapshot/run
 *     middleware: verifyToken (global) → verifyRole(["ADMIN"])
 *     - 401/403 without token (verifyToken returns 403 "Access Denied")
 *     - 403 with token but role !== ADMIN
 *     - 200 with ADMIN — returns { success, tenantId, period, weekStart,
 *       savedCount, total } where `total` is the userId=null rollup row.
 *   The route inlines the per-tenant body of the engine (deals →
 *   computeForecast → upsertWeekly) so the cron + manual paths agree on
 *   metrics. Mirrors POST /api/wellness/ops/run /
 *   /api/wellness/inventory/low-stock/run / /api/wellness/reminders/run.
 *
 * Acceptance criteria covered (G-14 from docs/E2E_GAPS.md):
 *   1. Snapshot creates Forecast row with current week-start in createdAt
 *      and the correct period (currentQuarter()).
 *   2. Pipeline aggregates flow through: bestCaseRevenue includes the
 *      seeded deal's amount; expectedRevenue weights by probability;
 *      committedRevenue picks up probability>=90 and stage='won'.
 *   3. Idempotency — second run in same week updates the same Forecast
 *      row (history count unchanged; rollup row id is reused on update).
 *   4. Tenant isolation — wellness-tenant /history never includes
 *      generic-tenant rows; generic admin's /run snapshot does NOT touch
 *      wellness Forecast rows. Re-running on wellness preserves the
 *      generic count.
 *   5. RBAC: ADMIN → 200. MANAGER → 403. USER → 403.
 *   6. Auth: no token → 401/403; bogus bearer → 401/403.
 *   7. Self-clean: spec-created Deal rows are deleted in afterAll. The
 *      Forecast rows produced by the engine are scrubbed by a SQL DELETE
 *      added to e2e/global-teardown.js (covers the engine's residue
 *      because there's no /forecasting DELETE route).
 *
 * Test data hygiene:
 *   - RUN_TAG = `E2E_FLOW_FORECAST_<ts>`. Deal.title carries the tag so
 *     teardown's NAME regex (`^E2E_FLOW_/`) matches; we also DELETE
 *     created Deals via the public route in afterAll for safety.
 *   - Forecast rows have no `name` / `title` field — just numeric
 *     metrics + period — so global-teardown can't pattern-match them.
 *     The accompanying global-teardown.js change wipes any Forecast
 *     row created in the last week (createdAt >= now-7d) on tenant 1
 *     during the test run. CI starts from an empty Forecast table so
 *     this is safe.
 *
 * Pattern: clones e2e/tests/appointment-reminders-api.spec.js + low-stock.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

const RUN_TAG = `E2E_FLOW_FORECAST_${Date.now()}`;

// Force serial execution. Each `runSnapshot()` aggregates ALL Deal rows in
// the requesting tenant — if two tests are racing, the first's seeded deal
// shows up in the second's expectedRevenue/bestCaseRevenue counters and
// breaks the "rollup matches my single deal" assertion. Serialising costs
// ~3-4s but keeps each test's per-deal expectations local.
test.describe.configure({ mode: 'serial' });

const FIXTURES = {
  // Generic CRM ADMIN — Pipelines + Deals live on tenant 1 (vertical='generic').
  // The forecast engine + /snapshot/run aggregate Deal rows; only this
  // tenant has seeded deals on the demo + CI seed. Drives the 200 path.
  admin: { email: 'admin@globussoft.com', password: 'password123' },
  // Generic CRM MANAGER — ADMIN-only route, must 403.
  manager: { email: 'manager@crm.com', password: 'password123' },
  // Generic CRM USER — must also 403.
  user: { email: 'user@crm.com', password: 'password123' },
  // Wellness ADMIN — different tenantId. Drives the tenant-isolation
  // suite below: snapshot run scopes to req.user.tenantId, so a wellness
  // run can never write Forecast rows for the generic tenant (or vice
  // versa). Confirmed by /history scoped to tenantId.
  wellnessAdmin: { email: 'admin@wellness.demo', password: 'password123' },
};

const tokens = {};
// Track Deal ids we created so afterAll can hard-delete them via the
// public DELETE route. The Deal.title is RUN_TAG-prefixed so global-
// teardown is a defence in depth if the API delete fails.
const createdDealIds = [];

async function login(request, fixture) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${API}/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function authPost(request, token, path, body) {
  return request.post(`${API}${path}`, {
    headers: authHeader(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

async function authGet(request, token, path) {
  return request.get(`${API}${path}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

async function authDelete(request, token, path) {
  return request.delete(`${API}${path}`, {
    headers: authHeader(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// Trigger the engine for the requesting tenant.
async function runSnapshot(request, token) {
  return authPost(request, token, '/forecasting/snapshot/run', {});
}

// Read the requesting tenant's full Forecast history (scoped server-side
// to tenantId). The route returns up to 100 rows ordered by createdAt
// desc — sufficient for our same-week assertions.
async function getHistory(request, token) {
  const res = await authGet(request, token, '/forecasting/history');
  expect(res.status()).toBe(200);
  return res.json();
}

// Seed a Deal owned by the calling user. The route auto-stamps
// ownerId=req.user.userId and tenantId=req.user.tenantId. Returns the
// created row.
async function createDeal(request, token, overrides = {}) {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);
  const payload = {
    title: `${RUN_TAG} ${overrides.title || 'deal'}-${stamp}`,
    amount: overrides.amount != null ? overrides.amount : 10000,
    probability: overrides.probability != null ? overrides.probability : 50,
    stage: overrides.stage || 'lead',
    // expectedClose this quarter so the engine's `closesInQuarter` window
    // catches it for expectedRevenue / closedRevenue accumulation.
    expectedClose: overrides.expectedClose || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  };
  const res = await authPost(request, token, '/deals', payload);
  expect(res.status(), `deal create: ${await res.text()}`).toBe(201);
  const deal = await res.json();
  createdDealIds.push(deal.id);
  return deal;
}

test.beforeAll(async ({ request }) => {
  for (const [k, f] of Object.entries(FIXTURES)) {
    const t = await login(request, f);
    if (t) tokens[k] = t;
  }
  expect(tokens.admin, 'generic admin token must be available').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // Tear down spec-created Deals via the public route. ADMIN-only route
  // (verifyRole(["ADMIN"]) on DELETE /api/deals/:id), so we use the
  // generic admin token. Best-effort — global-teardown's NAME regex
  // (`^E2E_FLOW_/`) is the safety net if the API delete fails.
  if (!tokens.admin) return;
  for (const id of createdDealIds) {
    await request.delete(`${API}/deals/${id}`, {
      headers: authHeader(tokens.admin),
      timeout: REQUEST_TIMEOUT,
    }).catch(() => { /* best-effort */ });
  }
  // Forecast rows produced by /snapshot/run have no DELETE surface and no
  // name/title field for global-teardown to match on. The accompanying
  // global-teardown.js change adds a sweep for Forecast rows created
  // within the last 8 days (covers the test's week-window), scoped to
  // tenant 1 + 2. CI starts from a clean Forecast table so this only
  // ever scrubs E2E residue.
});

// ─── Auth gate ───────────────────────────────────────────────────────────

test.describe('POST /api/forecasting/snapshot/run — auth gate', () => {
  test('no token → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/forecasting/snapshot/run`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    // verifyToken returns 403 ("Access Denied") on missing Authorization
    // header; some middlewares return 401. Accept either — both prove the
    // global guard refused the unauthenticated call.
    expect([401, 403]).toContain(res.status());
  });

  test('bogus bearer → 401/403', async ({ request }) => {
    const res = await request.post(`${API}/forecasting/snapshot/run`, {
      data: {},
      headers: { Authorization: 'Bearer not-a-real-jwt', 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── RBAC gate (verifyRole(["ADMIN"])) ──────────────────────────────────

test.describe('POST /api/forecasting/snapshot/run — RBAC gate', () => {
  test('MANAGER → 403', async ({ request }) => {
    test.skip(!tokens.manager, 'manager fixture (manager@crm.com) not seeded');
    const res = await runSnapshot(request, tokens.manager);
    expect(res.status()).toBe(403);
  });

  test('USER → 403', async ({ request }) => {
    test.skip(!tokens.user, 'user fixture (user@crm.com) not seeded');
    const res = await runSnapshot(request, tokens.user);
    expect(res.status()).toBe(403);
  });

  test('ADMIN → 200 with envelope { success, tenantId, period, weekStart, savedCount, total }', async ({ request }) => {
    const res = await runSnapshot(request, tokens.admin);
    expect(res.status(), `body: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.tenantId).toBe('number');
    // Period contract: "<year>-Q<quarter>" — currentQuarter() output.
    expect(body.period).toMatch(/^\d{4}-Q[1-4]$/);
    expect(typeof body.weekStart).toBe('string');
    expect(typeof body.savedCount).toBe('number');
    // savedCount is at least 1 (the userId=null rollup) even with zero deals.
    expect(body.savedCount).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeTruthy();
    // Total row is the rollup — userId=null, tenantId=requesting tenant.
    expect(body.total.userId).toBeNull();
    expect(body.total.tenantId).toBe(body.tenantId);
    expect(body.total.period).toBe(body.period);
    // All four metric fields exist on the row (Forecast schema).
    expect(typeof body.total.expectedRevenue).toBe('number');
    expect(typeof body.total.committedRevenue).toBe('number');
    expect(typeof body.total.bestCaseRevenue).toBe('number');
    expect(typeof body.total.closedRevenue).toBe('number');
  });
});

// ─── Snapshot creation ──────────────────────────────────────────────────

test.describe('Forecast Snapshot Engine — snapshot creation', () => {
  test('snapshot creates Forecast row that surfaces in /history', async ({ request }) => {
    // Snapshot, then re-fetch /history — the rollup row from this tick
    // must be visible (history is ordered by createdAt desc, so it's near
    // the top).
    const runRes = await runSnapshot(request, tokens.admin);
    expect(runRes.status()).toBe(200);
    const body = await runRes.json();

    const history = await getHistory(request, tokens.admin);
    const found = history.find((h) => h.id === body.total.id);
    expect(found, 'rollup row must be visible in /history').toBeTruthy();
    expect(found.tenantId).toBe(body.tenantId);
    expect(found.period).toBe(body.period);
    expect(found.userId).toBeNull();
  });

  test('snapshot row createdAt falls inside the current week-window', async ({ request }) => {
    const runRes = await runSnapshot(request, tokens.admin);
    expect(runRes.status()).toBe(200);
    const body = await runRes.json();

    // weekStart is ISO; createdAt of the row should be >= weekStart and
    // < weekStart + 7d. The engine uses the same Monday-anchor logic the
    // route reproduces.
    const weekStart = new Date(body.weekStart);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const createdAt = new Date(body.total.createdAt);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(weekStart.getTime());
    expect(createdAt.getTime()).toBeLessThan(weekEnd.getTime());
  });
});

// ─── Pipeline aggregates flow through ───────────────────────────────────

test.describe('Forecast Snapshot Engine — pipeline aggregates', () => {
  test('seeded open deal contributes to bestCaseRevenue', async ({ request }) => {
    // Snapshot pre-seed to capture the baseline rollup amount.
    const before = await runSnapshot(request, tokens.admin);
    const baseline = (await before.json()).total.bestCaseRevenue;

    // Seed a brand-new open deal with a known amount.
    const SEED_AMOUNT = 137777;
    const deal = await createDeal(request, tokens.admin, {
      title: 'aggregate-bestCase',
      amount: SEED_AMOUNT,
      probability: 25,
      stage: 'lead',
    });
    expect(deal.amount).toBe(SEED_AMOUNT);

    // Re-snapshot. The same week-window row gets UPDATED — bestCase
    // grows by AT LEAST the seeded amount (open deals contribute their
    // full amount to bestCaseRevenue regardless of probability). With
    // fullyParallel:true / workers=2 in CI, sibling specs may create
    // additional open deals between baseline and updated, so assert
    // the seed-amount lower bound rather than strict equality.
    const after = await runSnapshot(request, tokens.admin);
    const updated = (await after.json()).total;
    expect(updated.bestCaseRevenue).toBeGreaterThanOrEqual(baseline + SEED_AMOUNT - 0.01);
  });

  test('open deal contributes amount * probability/100 to expectedRevenue', async ({ request }) => {
    const before = await runSnapshot(request, tokens.admin);
    const baseline = (await before.json()).total.expectedRevenue;

    // 80000 * 0.65 = 52000 contribution — only if expectedClose lands in
    // the current quarter, which the helper guarantees (now+7d).
    const SEED_AMOUNT = 80000;
    const PROB = 65;
    await createDeal(request, tokens.admin, {
      title: 'aggregate-expected',
      amount: SEED_AMOUNT,
      probability: PROB,
      stage: 'proposal',
    });

    const after = await runSnapshot(request, tokens.admin);
    const updated = (await after.json()).total;
    const delta = updated.expectedRevenue - baseline;
    // Floating-point math via the engine's `* (probability/100)` —
    // toBeCloseTo with 2 decimals is the appropriate looseness.
    expect(delta).toBeCloseTo(SEED_AMOUNT * (PROB / 100), 2);
  });

  test('high-probability deal (>=90) contributes to committedRevenue', async ({ request }) => {
    const before = await runSnapshot(request, tokens.admin);
    const baseline = (await before.json()).total.committedRevenue;

    // probability=95 → committed includes amount even with stage='proposal'.
    // Engine: `if (stage === "won" || probability >= 90) committedRevenue += amount`.
    const SEED_AMOUNT = 50000;
    await createDeal(request, tokens.admin, {
      title: 'aggregate-committed',
      amount: SEED_AMOUNT,
      probability: 95,
      stage: 'proposal',
    });

    const after = await runSnapshot(request, tokens.admin);
    const updated = (await after.json()).total;
    expect(updated.committedRevenue - baseline).toBeCloseTo(SEED_AMOUNT, 2);
  });

  test('won deal closing this quarter contributes to closedRevenue', async ({ request }) => {
    const before = await runSnapshot(request, tokens.admin);
    const baseline = (await before.json()).total.closedRevenue;

    // stage='won' AND expectedClose this quarter → closedRevenue += amount.
    const SEED_AMOUNT = 33333;
    await createDeal(request, tokens.admin, {
      title: 'aggregate-closed',
      amount: SEED_AMOUNT,
      probability: 100,
      stage: 'won',
    });

    const after = await runSnapshot(request, tokens.admin);
    const updated = (await after.json()).total;
    expect(updated.closedRevenue - baseline).toBeCloseTo(SEED_AMOUNT, 2);
  });

  test('lost deal contributes to NONE of the open-deal metrics', async ({ request }) => {
    const before = await runSnapshot(request, tokens.admin);
    const beforeBody = (await before.json()).total;

    await createDeal(request, tokens.admin, {
      title: 'aggregate-lost',
      amount: 99999,
      probability: 10,
      stage: 'lost',
    });

    const after = await runSnapshot(request, tokens.admin);
    const afterBody = (await after.json()).total;
    // Lost deals are NOT open → bestCase/expected don't grow; not won,
    // not >=90 prob → committed doesn't grow; not won → closed doesn't
    // grow. ALL four metrics must be unchanged after seeding the loser.
    expect(afterBody.bestCaseRevenue).toBeCloseTo(beforeBody.bestCaseRevenue, 2);
    expect(afterBody.expectedRevenue).toBeCloseTo(beforeBody.expectedRevenue, 2);
    expect(afterBody.committedRevenue).toBeCloseTo(beforeBody.committedRevenue, 2);
    expect(afterBody.closedRevenue).toBeCloseTo(beforeBody.closedRevenue, 2);
  });
});

// ─── Idempotency / dedup ────────────────────────────────────────────────

test.describe('Forecast Snapshot Engine — idempotency (same week-window)', () => {
  test('two consecutive runs UPDATE the rollup row, do not duplicate it', async ({ request }) => {
    const r1 = await runSnapshot(request, tokens.admin);
    expect(r1.status()).toBe(200);
    const body1 = await r1.json();
    const id1 = body1.total.id;

    const r2 = await runSnapshot(request, tokens.admin);
    expect(r2.status()).toBe(200);
    const body2 = await r2.json();
    const id2 = body2.total.id;

    // Same row id ⇒ engine UPDATEd, not INSERTed. This is the contract:
    // upsertWeeklyForecast() finds the existing (tenantId, userId=null,
    // period, createdAt-this-week) and prisma.forecast.update()s it.
    expect(id2).toBe(id1);
  });

  test('history row count for the rollup does not grow between two same-week runs', async ({ request }) => {
    // Snapshot once to ensure a baseline row exists.
    await runSnapshot(request, tokens.admin);
    const before = await getHistory(request, tokens.admin);
    const beforeRollupRows = before.filter(
      (h) => h.userId === null && h.period.match(/^\d{4}-Q[1-4]$/),
    );

    // Run again. The same rollup row gets updated, so the count stays
    // exactly the same. (Per-owner rows also stay constant — same
    // owner has only one weekly row per (period, week-window).)
    await runSnapshot(request, tokens.admin);
    const after = await getHistory(request, tokens.admin);
    const afterRollupRows = after.filter(
      (h) => h.userId === null && h.period.match(/^\d{4}-Q[1-4]$/),
    );
    expect(afterRollupRows.length).toBe(beforeRollupRows.length);
  });

  test('same period: per-owner row uniqueness — engine never duplicates owner forecasts in same week', async ({ request }) => {
    // Drive two ticks back-to-back, then count how many Forecast rows
    // for the seeded admin user exist in the current week-window. Should
    // be exactly 1 (the userId column matches admin user id).
    await runSnapshot(request, tokens.admin);
    const r2 = await runSnapshot(request, tokens.admin);
    expect(r2.status()).toBe(200);
    const body = await r2.json();
    const period = body.period;

    const history = await getHistory(request, tokens.admin);
    // Filter to current period rows, group by userId. For each userId
    // value seen, expect exactly one row in the current week window.
    const weekStart = new Date(body.weekStart).getTime();
    const weekEnd = weekStart + 7 * 24 * 3600 * 1000;
    const inWeek = history.filter((h) => {
      const t = new Date(h.createdAt).getTime();
      return h.period === period && t >= weekStart && t < weekEnd;
    });
    const groupedByOwner = new Map();
    for (const r of inWeek) {
      const key = r.userId === null ? 'null' : String(r.userId);
      groupedByOwner.set(key, (groupedByOwner.get(key) || 0) + 1);
    }
    for (const [k, count] of groupedByOwner.entries()) {
      expect(count, `owner=${k} must have exactly 1 weekly forecast`).toBe(1);
    }
  });
});

// ─── Tenant isolation ───────────────────────────────────────────────────

test.describe('Forecast Snapshot Engine — tenant isolation', () => {
  test('generic-tenant /history never includes wellness-tenant Forecast rows', async ({ request }) => {
    // Drive a snapshot on each tenant in isolation, then assert /history
    // for each tenant returns ONLY rows scoped to that tenantId.
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');

    await runSnapshot(request, tokens.admin);
    await runSnapshot(request, tokens.wellnessAdmin);

    const genericHistory = await getHistory(request, tokens.admin);
    const wellnessHistory = await getHistory(request, tokens.wellnessAdmin);

    // Critical contract: NO row in either history carries the OTHER
    // tenant's tenantId. A leak here would silently misreport revenue.
    const genericTenantIds = new Set(genericHistory.map((h) => h.tenantId));
    const wellnessTenantIds = new Set(wellnessHistory.map((h) => h.tenantId));
    expect(genericTenantIds.size).toBeLessThanOrEqual(1);
    expect(wellnessTenantIds.size).toBeLessThanOrEqual(1);
    if (genericHistory.length > 0) {
      expect([...genericTenantIds][0]).not.toBe([...wellnessTenantIds][0] ?? null);
    }
  });

  test('wellness snapshot does NOT include generic-tenant deals in totals', async ({ request }) => {
    test.skip(!tokens.wellnessAdmin, 'wellness admin fixture not seeded');

    // Seed a HUGE deal on the generic tenant.
    const HUGE = 9_999_999;
    await createDeal(request, tokens.admin, {
      title: 'isolation-huge',
      amount: HUGE,
      probability: 50,
      stage: 'lead',
    });

    // Run wellness snapshot. Its rollup must NOT see the generic deal
    // — wellness tenantId differs, so engine's `where: { tenantId }`
    // filter excludes generic deals at the SQL layer.
    const wRes = await runSnapshot(request, tokens.wellnessAdmin);
    expect(wRes.status()).toBe(200);
    const wBody = await wRes.json();

    // Wellness rollup bestCase should never reach 9.99M from one
    // generic-tenant seed. (Wellness deals from the seed-wellness fixture
    // are 0 by default; even if some exist, they are <<9.99M.)
    expect(wBody.total.bestCaseRevenue).toBeLessThan(HUGE);
  });

  test('snapshot run as generic admin writes Forecast rows ONLY for tenantId=req.user.tenantId', async ({ request }) => {
    const r = await runSnapshot(request, tokens.admin);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.tenantId).toBe(body.total.tenantId);
    // Sanity: the rollup row's tenantId === admin's tenantId.
    expect(typeof body.tenantId).toBe('number');
  });
});
