// @ts-check
/**
 * Unit tests for backend/cron/forecastSnapshotEngine.js — runs Mon 01:00 to
 * snapshot weekly Forecast rows per (tenantId, userId, period).
 *
 * Why this file exists (regression class — gap card R-5 batch 2):
 *   - The engine has API-level coverage via e2e/tests/forecast-snapshot-api.spec.js
 *     (G-14, commit 2d4372d) but ZERO unit-level tests. Branches awkward to
 *     drive through the API spec:
 *       - Pipeline aggregation math (computeForecast):
 *           expectedRevenue = Σ amount*probability/100 for OPEN deals closing this Q
 *           committedRevenue = Σ amount where stage='won' OR probability>=90
 *           bestCaseRevenue  = Σ amount of ALL OPEN deals
 *           closedRevenue    = Σ amount where stage='won' AND closing this Q
 *         API specs verify the rollup row but can't easily isolate per-bucket math.
 *       - Per-tenant scope on every prisma.deal.findMany — pin where:{ tenantId }
 *         is mandatory (a regression here would leak deals across tenants).
 *       - Idempotency on (tenantId, userId, period, this-week) — second run
 *         in the same week-window UPDATEs not INSERTs.
 *       - Per-tenant try/catch — one bad tenant does not abort siblings.
 *       - Owner-grouping: deals with ownerId=null are excluded from per-user
 *         rows but DO contribute to the userId=null tenant rollup.
 *       - Empty-tenant graceful no-op (no crash, just rollup with zeroed metrics).
 *
 * Functions / branches covered:
 *   - currentQuarter()
 *       returns YYYY-Qn shape, n in 1..4 derived from current month.
 *   - quarterRange(period)
 *       Q1/Q2/Q3/Q4 → correct start month + month-end inclusive end-of-day.
 *   - runForecastSnapshot() (orchestrator)
 *       happy path → per-owner Forecast rows + tenant rollup row.
 *       per-tenant scope (where:{ tenantId } in deal.findMany).
 *       idempotency → existing row in same week-window triggers prisma.forecast.update,
 *                     not .create.
 *       per-tenant error containment → one failing tenant does not abort siblings.
 *       empty tenant (no deals) → no per-user rows, but rollup row still written.
 *       ownerId=null deals → rollup includes them, no per-user row created.
 *       computeForecast metric bucketing — through DB-write inspection.
 *       top-level error swallow → returns 0 rather than throwing.
 *
 * NOT covered (out of scope for unit tests):
 *   - initForecastSnapshotCron — schedules a real node-cron handler;
 *     invoking it in tests would register a long-lived timer + fight the
 *     test runner's lifecycle. Coverage of the cron-init shell is not the
 *     point of unit tests.
 *
 * Mocking strategy:
 *   Mirror backend/test/cron/wellnessOpsEngine.test.js + recurringInvoiceEngine.test.js:
 *   import the prisma singleton, monkey-patch model accessors. The cron
 *   module is inlined via vitest.config.js → server.deps.inline so its
 *   `require('../lib/prisma')` resolves to the same singleton under test.
 *
 *   Pattern reference: backend/test/cron/wellnessOpsEngine.test.js (commit 8303272).
 */
import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runForecastSnapshot,
  currentQuarter,
  quarterRange,
} from '../../cron/forecastSnapshotEngine.js';

beforeAll(() => {
  prisma.tenant = { findMany: vi.fn() };
  prisma.deal = { findMany: vi.fn() };
  prisma.forecast = {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.tenant.findMany.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.forecast.findFirst.mockReset();
  prisma.forecast.create.mockReset();
  prisma.forecast.update.mockReset();

  // Sensible defaults — every test overrides what it cares about.
  prisma.tenant.findMany.mockResolvedValue([]);
  prisma.deal.findMany.mockResolvedValue([]);
  prisma.forecast.findFirst.mockResolvedValue(null);
  prisma.forecast.create.mockResolvedValue({ id: 1 });
  prisma.forecast.update.mockResolvedValue({ id: 1 });
});

// Suppress engine console.error/log noise in test output.
let errSpy;
let logSpy;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe('cron/forecastSnapshotEngine — currentQuarter()', () => {
  test('returns YYYY-Qn matching today', () => {
    const period = currentQuarter();
    expect(period).toMatch(/^\d{4}-Q[1-4]$/);

    const now = new Date();
    const expectedQ = Math.floor(now.getMonth() / 3) + 1;
    expect(period).toBe(`${now.getFullYear()}-Q${expectedQ}`);
  });
});

describe('cron/forecastSnapshotEngine — quarterRange()', () => {
  test('Q1 spans Jan 1 → Mar 31 inclusive end-of-day', () => {
    const { start, end } = quarterRange('2026-Q1');
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0); // Jan
    expect(start.getDate()).toBe(1);

    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(2); // Mar
    expect(end.getDate()).toBe(31);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
  });

  test('Q2 spans Apr 1 → Jun 30', () => {
    const { start, end } = quarterRange('2026-Q2');
    expect(start.getMonth()).toBe(3); // Apr
    expect(end.getMonth()).toBe(5); // Jun
    expect(end.getDate()).toBe(30);
  });

  test('Q3 spans Jul 1 → Sep 30', () => {
    const { start, end } = quarterRange('2026-Q3');
    expect(start.getMonth()).toBe(6); // Jul
    expect(end.getMonth()).toBe(8); // Sep
    expect(end.getDate()).toBe(30);
  });

  test('Q4 spans Oct 1 → Dec 31', () => {
    const { start, end } = quarterRange('2026-Q4');
    expect(start.getMonth()).toBe(9); // Oct
    expect(end.getMonth()).toBe(11); // Dec
    expect(end.getDate()).toBe(31);
  });
});

// ─── Tenant query shape ────────────────────────────────────────────────────

describe('cron/forecastSnapshotEngine — tenant fan-out', () => {
  test('queries only active tenants', async () => {
    await runForecastSnapshot();

    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isActive: true });
    expect(arg.select).toEqual({ id: true, name: true });
  });

  test('zero active tenants → returns 0, no deal queries', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);
    const saved = await runForecastSnapshot();
    expect(saved).toBe(0);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });
});

// ─── Per-tenant scope (CRITICAL: never leak deals across tenants) ──────────

describe('cron/forecastSnapshotEngine — per-tenant scope (mandatory)', () => {
  test('deal.findMany filters where:{ tenantId } for each tenant', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 1, name: 'Generic' },
      { id: 2, name: 'Wellness' },
    ]);
    prisma.deal.findMany.mockResolvedValue([]);

    await runForecastSnapshot();

    expect(prisma.deal.findMany).toHaveBeenCalledTimes(2);
    const t1Arg = prisma.deal.findMany.mock.calls[0][0];
    const t2Arg = prisma.deal.findMany.mock.calls[1][0];
    expect(t1Arg.where).toEqual({ tenantId: 1 });
    expect(t2Arg.where).toEqual({ tenantId: 2 });
  });

  test('select projection limits returned columns to forecast-relevant fields', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    await runForecastSnapshot();

    const arg = prisma.deal.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      amount: true,
      probability: true,
      stage: true,
      expectedClose: true,
      ownerId: true,
    });
  });

  test('forecast.findFirst dedup probe carries tenantId for every write', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 42, name: 'Acme' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 9 },
    ]);

    await runForecastSnapshot();

    // Every dedup probe must scope to tenantId=42 — never leak across tenants.
    const probeCalls = prisma.forecast.findFirst.mock.calls;
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const [arg] of probeCalls) {
      expect(arg.where.tenantId).toBe(42);
    }
  });
});

// ─── Happy path — per-owner + tenant rollup ────────────────────────────────

describe('cron/forecastSnapshotEngine — happy path writes', () => {
  test('single-owner tenant → 1 per-user row + 1 rollup row', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'Generic' }]);
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 100,
        amount: 1000,
        probability: 50,
        stage: 'open',
        expectedClose: null,
        ownerId: 7,
      },
    ]);

    const saved = await runForecastSnapshot();

    // 1 per-user (ownerId=7) + 1 rollup (userId=null) = 2.
    expect(saved).toBe(2);
    expect(prisma.forecast.create).toHaveBeenCalledTimes(2);

    // First call is the per-user row.
    const userCall = prisma.forecast.create.mock.calls[0][0].data;
    expect(userCall.tenantId).toBe(1);
    expect(userCall.userId).toBe(7);

    // Second call is the tenant rollup with userId=null.
    const rollupCall = prisma.forecast.create.mock.calls[1][0].data;
    expect(rollupCall.tenantId).toBe(1);
    expect(rollupCall.userId).toBeNull();
  });

  test('multiple owners → one Forecast row per owner + one rollup', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'Generic' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
      { id: 2, amount: 200, probability: 70, stage: 'open', expectedClose: null, ownerId: 8 },
      { id: 3, amount: 300, probability: 90, stage: 'open', expectedClose: null, ownerId: 9 },
    ]);

    const saved = await runForecastSnapshot();

    // 3 owners + 1 rollup = 4.
    expect(saved).toBe(4);
    expect(prisma.forecast.create).toHaveBeenCalledTimes(4);

    const ownerIds = prisma.forecast.create.mock.calls
      .map((c) => c[0].data.userId)
      .filter((id) => id !== null);
    expect(ownerIds).toEqual(expect.arrayContaining([7, 8, 9]));
  });

  test('record carries period (YYYY-Qn) + the four metric fields', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.period).toMatch(/^\d{4}-Q[1-4]$/);
    expect(data).toHaveProperty('expectedRevenue');
    expect(data).toHaveProperty('committedRevenue');
    expect(data).toHaveProperty('bestCaseRevenue');
    expect(data).toHaveProperty('closedRevenue');
  });
});

// ─── computeForecast() metric bucketing — exercised via DB-write shape ─────

describe('cron/forecastSnapshotEngine — computeForecast metric bucketing', () => {
  test('bestCaseRevenue counts ALL open deals (any close date)', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      // Open, no close date → counts toward bestCase, NOT expected.
      { id: 1, amount: 1000, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
      // Open, future close (next year, definitely outside any single quarter)
      // → counts toward bestCase, NOT expected.
      {
        id: 2,
        amount: 500,
        probability: 60,
        stage: 'qualified',
        expectedClose: new Date(Date.now() + 366 * 86400000),
        ownerId: 7,
      },
      // Lost deal → does NOT count toward bestCase.
      { id: 3, amount: 9999, probability: 0, stage: 'lost', expectedClose: null, ownerId: 7 },
      // Won deal → does NOT count toward bestCase (closed, not open).
      { id: 4, amount: 9999, probability: 100, stage: 'won', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    // First call = per-user; second = rollup. Both should reflect the same
    // bestCase since there's only one owner.
    const userData = prisma.forecast.create.mock.calls[0][0].data;
    expect(userData.bestCaseRevenue).toBe(1500);
  });

  test('expectedRevenue weights by probability AND requires closing this Q', async () => {
    // Use Q-relative dates so the test is calendar-agnostic.
    const period = currentQuarter();
    const { start, end } = quarterRange(period);
    const insideQ = new Date((start.getTime() + end.getTime()) / 2);
    const outsideQ = new Date(end.getTime() + 30 * 86400000); // 30d past quarter end

    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      // Open, closes inside Q → weighted: 1000 * 50/100 = 500.
      { id: 1, amount: 1000, probability: 50, stage: 'open', expectedClose: insideQ, ownerId: 7 },
      // Open, closes outside Q → does NOT contribute to expectedRevenue.
      { id: 2, amount: 9999, probability: 80, stage: 'open', expectedClose: outsideQ, ownerId: 7 },
      // Won, closes inside Q → does NOT contribute to expectedRevenue (not open).
      { id: 3, amount: 9999, probability: 100, stage: 'won', expectedClose: insideQ, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.expectedRevenue).toBe(500);
  });

  test('committedRevenue includes stage=won OR probability>=90', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      // Won → counts.
      { id: 1, amount: 100, probability: 100, stage: 'won', expectedClose: null, ownerId: 7 },
      // Open with probability>=90 → counts.
      { id: 2, amount: 200, probability: 95, stage: 'open', expectedClose: null, ownerId: 7 },
      // Open with probability<90 → does NOT count.
      { id: 3, amount: 9999, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
      // Lost → does NOT count.
      { id: 4, amount: 9999, probability: 0, stage: 'lost', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.committedRevenue).toBe(300); // 100 + 200
  });

  test('closedRevenue requires stage=won AND closing this Q', async () => {
    const period = currentQuarter();
    const { start, end } = quarterRange(period);
    const insideQ = new Date((start.getTime() + end.getTime()) / 2);
    const outsideQ = new Date(end.getTime() + 30 * 86400000);

    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      // Won + inside Q → counts.
      { id: 1, amount: 100, probability: 100, stage: 'won', expectedClose: insideQ, ownerId: 7 },
      // Won + outside Q → does NOT count toward closedRevenue.
      { id: 2, amount: 9999, probability: 100, stage: 'won', expectedClose: outsideQ, ownerId: 7 },
      // Open + inside Q → does NOT count (must be won).
      { id: 3, amount: 9999, probability: 50, stage: 'open', expectedClose: insideQ, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.closedRevenue).toBe(100);
  });

  test('case-insensitive stage matching (Won / WON / won all behave the same)', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 100, stage: 'WON', expectedClose: null, ownerId: 7 },
      { id: 2, amount: 200, probability: 100, stage: 'Won', expectedClose: null, ownerId: 7 },
      { id: 3, amount: 300, probability: 100, stage: 'won', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    // All three should be excluded from bestCase (closed) and all three should
    // contribute to committedRevenue (probability=100 catches them anyway, but
    // the casing test pins the stage check).
    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.bestCaseRevenue).toBe(0); // none open
    expect(data.committedRevenue).toBe(600);
  });

  test('null/undefined amount and probability default to 0', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      // Both fields absent → contributes 0 to bestCase (open with amount=0).
      { id: 1, amount: null, probability: null, stage: 'open', expectedClose: null, ownerId: 7 },
      { id: 2, amount: undefined, probability: undefined, stage: 'open', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.bestCaseRevenue).toBe(0);
    expect(data.expectedRevenue).toBe(0);
    expect(data.committedRevenue).toBe(0);
    expect(data.closedRevenue).toBe(0);
  });
});

// ─── Owner grouping — null owners excluded from per-user but counted in rollup ─

describe('cron/forecastSnapshotEngine — owner grouping', () => {
  test('ownerId=null deals → no per-user row, but DO appear in tenant rollup', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      // Owned by user 7.
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
      // Unowned.
      { id: 2, amount: 999, probability: 50, stage: 'open', expectedClose: null, ownerId: null },
    ]);

    const saved = await runForecastSnapshot();

    // 1 per-user + 1 rollup = 2 (no row for unowned).
    expect(saved).toBe(2);
    expect(prisma.forecast.create).toHaveBeenCalledTimes(2);

    const userData = prisma.forecast.create.mock.calls[0][0].data;
    expect(userData.userId).toBe(7);
    expect(userData.bestCaseRevenue).toBe(100);

    // The rollup MUST include the unowned deal — bestCase = 100 + 999 = 1099.
    const rollupData = prisma.forecast.create.mock.calls[1][0].data;
    expect(rollupData.userId).toBeNull();
    expect(rollupData.bestCaseRevenue).toBe(1099);
  });

  test('all-unowned tenant → only the rollup row, no per-user rows', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: null },
    ]);

    const saved = await runForecastSnapshot();
    expect(saved).toBe(1);
    expect(prisma.forecast.create).toHaveBeenCalledTimes(1);
    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.userId).toBeNull();
  });
});

// ─── Empty tenant — no crash, rollup row still written ─────────────────────

describe('cron/forecastSnapshotEngine — empty tenant graceful', () => {
  test('tenant with zero deals → no per-user rows, rollup row with 0 metrics', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 5, name: 'EmptyTenant' }]);
    prisma.deal.findMany.mockResolvedValue([]);

    const saved = await runForecastSnapshot();

    // Empty tenant still emits a rollup row (consistency for the dashboard
    // that joins on Forecast).
    expect(saved).toBe(1);
    expect(prisma.forecast.create).toHaveBeenCalledTimes(1);

    const data = prisma.forecast.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(5);
    expect(data.userId).toBeNull();
    expect(data.expectedRevenue).toBe(0);
    expect(data.committedRevenue).toBe(0);
    expect(data.bestCaseRevenue).toBe(0);
    expect(data.closedRevenue).toBe(0);
  });
});

// ─── Idempotency: second run in same week-window UPDATEs not INSERTs ───────

describe('cron/forecastSnapshotEngine — idempotency (closes G-14 acceptance #3)', () => {
  test('existing row in this week → update, not duplicate create', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
    ]);
    // Both the per-user probe AND the rollup probe find existing rows.
    prisma.forecast.findFirst
      .mockResolvedValueOnce({ id: 'existing-user' })
      .mockResolvedValueOnce({ id: 'existing-rollup' });

    await runForecastSnapshot();

    // Two updates, zero creates.
    expect(prisma.forecast.update).toHaveBeenCalledTimes(2);
    expect(prisma.forecast.create).not.toHaveBeenCalled();

    const userUpdate = prisma.forecast.update.mock.calls[0][0];
    expect(userUpdate.where).toEqual({ id: 'existing-user' });
    expect(userUpdate.data).toHaveProperty('expectedRevenue');
    expect(userUpdate.data).toHaveProperty('bestCaseRevenue');

    const rollupUpdate = prisma.forecast.update.mock.calls[1][0];
    expect(rollupUpdate.where).toEqual({ id: 'existing-rollup' });
  });

  test('dedup probe filters by tenantId + userId + period + this-week createdAt', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const userProbe = prisma.forecast.findFirst.mock.calls[0][0];
    expect(userProbe.where.tenantId).toBe(1);
    expect(userProbe.where.userId).toBe(7);
    expect(userProbe.where.period).toMatch(/^\d{4}-Q[1-4]$/);
    expect(userProbe.where.createdAt).toHaveProperty('gte');
    expect(userProbe.where.createdAt).toHaveProperty('lt');
    expect(userProbe.where.createdAt.gte).toBeInstanceOf(Date);
    expect(userProbe.where.createdAt.lt).toBeInstanceOf(Date);
    // gte (week start) is BEFORE lt (week end).
    expect(userProbe.where.createdAt.gte.getTime()).toBeLessThan(
      userProbe.where.createdAt.lt.getTime(),
    );

    // Rollup probe uses userId:null.
    const rollupProbe = prisma.forecast.findFirst.mock.calls[1][0];
    expect(rollupProbe.where.userId).toBeNull();
  });

  test('week window spans exactly 7 days (Monday → next Monday)', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 1, name: 'T' }]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
    ]);

    await runForecastSnapshot();

    const probe = prisma.forecast.findFirst.mock.calls[0][0];
    const span = probe.where.createdAt.lt.getTime() - probe.where.createdAt.gte.getTime();
    expect(span).toBe(7 * 86400000);
  });
});

// ─── Per-tenant error containment ──────────────────────────────────────────

describe('cron/forecastSnapshotEngine — per-tenant error containment', () => {
  test('one failing tenant does NOT abort sibling tenants', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 1, name: 'Bad' },
      { id: 2, name: 'Good' },
    ]);
    // Tenant 1: deal.findMany throws.
    // Tenant 2: deal.findMany returns one deal.
    prisma.deal.findMany
      .mockRejectedValueOnce(new Error('DB connection lost mid-tenant'))
      .mockResolvedValueOnce([
        { id: 99, amount: 500, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
      ]);

    const saved = await runForecastSnapshot();

    // Tenant 1 contributed 0; tenant 2 contributed 2 (per-user + rollup).
    expect(saved).toBe(2);
    expect(prisma.forecast.create).toHaveBeenCalledTimes(2);

    // The successful writes are for tenant 2.
    const writes = prisma.forecast.create.mock.calls.map((c) => c[0].data.tenantId);
    expect(writes.every((tid) => tid === 2)).toBe(true);
  });

  test('one failing forecast write within a tenant → tenant logs and continues to next tenant', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 1, name: 'WriteFail' },
      { id: 2, name: 'OK' },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, amount: 100, probability: 50, stage: 'open', expectedClose: null, ownerId: 7 },
    ]);
    // Per-user write fails for tenant 1, but tenant 2 must still run.
    prisma.forecast.create
      .mockRejectedValueOnce(new Error('write failure'))
      // Tenant 2 per-user + rollup.
      .mockResolvedValueOnce({ id: 'ok-user' })
      .mockResolvedValueOnce({ id: 'ok-rollup' });

    await expect(runForecastSnapshot()).resolves.not.toThrow();
    // Tenant 1's per-user create attempted (failed), then loop bailed for that
    // tenant; tenant 2 ran cleanly. Total successful writes = 2.
    const tenant2Writes = prisma.forecast.create.mock.calls.filter(
      (c) => c[0].data.tenantId === 2,
    );
    expect(tenant2Writes).toHaveLength(2);
  });

  test('top-level prisma.tenant.findMany failure → engine returns 0, no throw', async () => {
    prisma.tenant.findMany.mockRejectedValue(new Error('top-level boom'));

    await expect(runForecastSnapshot()).resolves.toBe(0);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
    expect(prisma.forecast.create).not.toHaveBeenCalled();
  });
});
