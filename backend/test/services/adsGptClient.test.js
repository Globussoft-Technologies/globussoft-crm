// Unit tests for backend/services/adsGptClient.js
//
// What this module does:
//   Stub-mode wrapper for AdsGPT marketing-reports integration. Real API
//   call lands when Q1 creds (handover from Yasin) drop. Exports:
//     - INTEGRATION                  — short token ('adsgpt') for the cap helper
//     - checkBudgetCap(tenantId)     — pre-call cap check; throws ADSGPT_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t)  — stub returns 0 (real sums LlmCallLog)
//     - fetchAdReport({...})         — stub canned shape per PRD §3.4
//
// Surface area covered (3+ cases):
//   1. fetchAdReport happy path returns stub shape with note + budget-check passes
//   2. fetchAdReport throws ADSGPT_BUDGET_EXCEEDED when stubbed spend exceeds cap
//   3. checkBudgetCap returns alertThreshold:true when stubbed spend ≥80% of cap
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (marketing-reports page, dashboard
// widgets, scheduled email reports) depend on the returned envelope.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// PRD_ADSGPT_MARKETING_REPORTS DC-2: $50/mo cap = 5000 cents (the env-var
// default from backend/lib/tenantSettings.js DEFAULTS map). Tests below
// override per case via mock of tenantSetting.findUnique.

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Installed into Node's Module._cache the same way as the llmRouter
// test (vitest's ESM-level vi.mock can't intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → DEFAULTS fallback
    },
  };
  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const prismaLibPath = requireFromCwd.resolve('./lib/prisma');
  Module._cache[prismaLibPath] = {
    id: prismaLibPath,
    filename: prismaLibPath,
    loaded: true,
    exports: mock,
    children: [],
    paths: [],
  };
  return mock;
});

afterEach(() => {
  vi.restoreAllMocks();
  prismaMock.tenantSetting.findUnique.mockReset();
  prismaMock.tenantSetting.findUnique.mockResolvedValue(null);
});

function loadClient() {
  // Reload fresh between tests so the spend-stub mock + module state are
  // pristine. Same pattern as llmRouter.test.js / digilockerClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/adsGptClient.js')];
  return requireCjs('../../services/adsGptClient.js');
}

describe('adsGptClient — module shape', () => {
  test('exports the contract surface', () => {
    const c = loadClient();
    expect(typeof c.fetchAdReport).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(c.INTEGRATION).toBe('adsgpt');
  });
});

describe('fetchAdReport', () => {
  test('happy path: returns stub shape with note + budget-check passes (zero spend)', async () => {
    // No cap row → falls back to DEFAULTS ($50 = 5000 cents); stub spend = 0
    // → withinCap = true, alertThreshold = false. Should not throw or warn.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.fetchAdReport({
      tenantId: 42,
      subBrand: 'tmc',
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
      platform: 'google_ads',
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
      subBrand: 'tmc',
      platform: 'google_ads',
      window: { fromDate: '2026-05-01', toDate: '2026-05-31' },
      metrics: {
        spendUsdCents: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        cpaCents: 0,
        roas: 0,
      },
      rows: [],
    });
    // Note must mention Q1 creds + Yasin so downstream UI can show
    // "integration pending" messaging deterministically.
    expect(out.note).toMatch(/Q1 creds/);
    expect(out.note).toMatch(/Yasin/);

    // Cap query was performed against the right (tenantId, key) tuple.
    expect(prismaMock.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 42, key: 'budgetCap_adsgpt_monthly_usd_cents' } },
      select: { value: true },
    });
    // Zero spend → no alert warning.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).not.toMatch(/AdsGPT/);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('throws ADSGPT_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Cap row: 5000 cents ($50, the DC-2 default — explicit here for clarity).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '5000' });

    const c = loadClient();
    // Override computeMonthlySpendCents to return cap + 1 = 5001 cents
    // (over cap → evaluateCap.withinCap = false → throw).
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(5001);

    let caught;
    try {
      await c.fetchAdReport({
        tenantId: 99,
        subBrand: 'rfu',
        fromDate: '2026-05-01',
        toDate: '2026-05-31',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ADSGPT_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly AdsGPT spend cap reached/);
    expect(caught.spentCents).toBe(5001);
    expect(caught.capCents).toBe(5000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('checkBudgetCap', () => {
  test('returns alertThreshold:true when stubbed spend is ≥80% of cap (10000c cap, 8500c spend)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Cap row: 10000 cents ($100 — explicit per-tenant override above the DC-2 default).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });

    const c = loadClient();
    // 8500 / 10000 = 85% → alertThreshold true, withinCap still true.
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(8500);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation).toMatchObject({
      spentCents: 8500,
      capCents: 10000,
      withinCap: true,
      alertThreshold: true,
    });
    expect(evaluation.percent).toBeCloseTo(0.85, 5);

    // 80%-threshold warning was emitted with tenant + amounts visible.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/tenant 7/);
    expect(warnMsgs).toMatch(/85%/);
    expect(warnMsgs).toMatch(/AdsGPT/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('under cap (<80%): no warning emitted, withinCap true, alertThreshold false', async () => {
    // Below the 80% warning threshold — quiet success path. Pins that the
    // warn line is gated on alertThreshold; flipping the check would noise
    // up every healthy tenant's logs.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '10000' });

    const c = loadClient();
    // 5000 / 10000 = 50% → both withinCap true AND alertThreshold false.
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(5000);

    const evaluation = await c.checkBudgetCap(11);
    expect(evaluation).toMatchObject({
      spentCents: 5000,
      capCents: 10000,
      withinCap: true,
      alertThreshold: false,
    });
    expect(evaluation.percent).toBeCloseTo(0.5, 5);

    // Critical: zero warn calls referencing AdsGPT — silent below 80%.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).not.toMatch(/AdsGPT/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('exactly at cap (spend === cap): withinCap false → throws ADSGPT_BUDGET_EXCEEDED', async () => {
    // evaluateCap uses strict `<` for withinCap, so spend === cap is OVER.
    // This pins the boundary semantics — a tenant that has spent exactly
    // $50.00 against a $50.00 cap cannot make one more call.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '5000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(5000);

    let caught;
    try {
      await c.checkBudgetCap(13);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ADSGPT_BUDGET_EXCEEDED');
    expect(caught.spentCents).toBe(5000);
    expect(caught.capCents).toBe(5000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('CJS self-mocking seam: checkBudgetCap calls computeMonthlySpendCents via module.exports indirection (regression-pin)', async () => {
    // Per the 2026-05-24 cron-learning + the inline comment in adsGptClient.js:36-41:
    // `checkBudgetCap` MUST call `module.exports.computeMonthlySpendCents(...)`
    // not the local closure binding. If a future refactor switches back to
    // a direct local-name call, this test reds — protecting downstream tests
    // that depend on `vi.spyOn(client, 'computeMonthlySpendCents')` to control
    // the budget-eval path.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '5000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(123);

    await c.checkBudgetCap(17);

    // The spy MUST have been hit — proves the seam is wired correctly.
    expect(spendSpy).toHaveBeenCalledTimes(1);
    expect(spendSpy).toHaveBeenCalledWith(17);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('falls back to DC-2 default ($50 = 5000c) when no TenantSetting row exists', async () => {
    // No cap row in the DB → getBudgetCap reads DEFAULTS[KEYS.ADSGPT...] which
    // is 5000c (= $50/mo) per the 2026-05-24 product-call resolution.
    // Pins that downstream tenants without explicit cap rows still get the
    // documented floor; flipping DEFAULTS without updating the PRD would red.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce(null);

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(100);

    const evaluation = await c.checkBudgetCap(23);
    expect(evaluation.capCents).toBe(5000);
    expect(evaluation.spentCents).toBe(100);
    expect(evaluation.withinCap).toBe(true);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('computeMonthlySpendCents (stub)', () => {
  test('returns 0 for any tenantId in stub mode (no LlmCallLog summing yet)', async () => {
    // Pins the documented STUB contract: until Q1 creds land + the real
    // SUM query is wired (against LlmCallLog filtered by provider=adsgpt),
    // computeMonthlySpendCents returns 0 for every tenant. The shape of
    // the swap-in must keep this signature: `(tenantId) => Promise<number>`.
    const c = loadClient();
    expect(await c.computeMonthlySpendCents(1)).toBe(0);
    expect(await c.computeMonthlySpendCents(999)).toBe(0);
    expect(await c.computeMonthlySpendCents(undefined)).toBe(0);
  });
});

describe('fetchAdReport — additional shape / arg pinning', () => {
  test('throws when tenantId is missing (before budget check fires)', async () => {
    // Argument validation runs BEFORE budget check — important because
    // a missing tenantId would otherwise null-coalesce into a tenant-0 cap
    // lookup (wrong tenant) and produce a confusing downstream error.
    const c = loadClient();
    // Spy on checkBudgetCap to assert it was NOT called.
    const capSpy = vi.spyOn(c, 'checkBudgetCap');

    await expect(c.fetchAdReport({ fromDate: '2026-05-01', toDate: '2026-05-31' }))
      .rejects.toThrow(/tenantId required/);

    expect(capSpy).not.toHaveBeenCalled();
    capSpy.mockRestore();
  });

  test('defaults platform to "all" when omitted from args', async () => {
    // The handler signature destructures `platform = 'all'`. The stub
    // returns the resolved value verbatim — if a future refactor moves
    // platform resolution server-side, downstream consumers reading
    // out.platform === 'all' on no-arg fetches must keep working.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.fetchAdReport({
      tenantId: 31,
      subBrand: 'visa',
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
      // platform deliberately omitted
    });

    expect(out.platform).toBe('all');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('coerces missing subBrand to null in the response envelope', async () => {
    // `subBrand || null` — when caller passes undefined, the stub envelope
    // surfaces explicit `null` so downstream UIs can distinguish "asked for
    // all sub-brands" from "asked for a specific one." Critical for the
    // marketing-reports page when the user lands without picking a brand.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.fetchAdReport({
      tenantId: 41,
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
      platform: 'meta',
      // subBrand deliberately omitted
    });

    expect(out.subBrand).toBeNull();

    // Empty-string variant exercises the same `||` short-circuit branch.
    const out2 = await c.fetchAdReport({
      tenantId: 41,
      subBrand: '',
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
    });
    expect(out2.subBrand).toBeNull();

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('emits STUB log line with the key request params (observability pin)', async () => {
    // The stub's console.log is the only observability signal in stub mode
    // (no LlmCallLog rows yet). Operator support reads this log to see what
    // tenant/sub-brand/platform combos are being asked for. If the log format
    // changes, downstream grep playbooks break — pin verbatim params.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const c = loadClient();
    await c.fetchAdReport({
      tenantId: 53,
      subBrand: 'travel-stall',
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
      platform: 'tiktok',
    });

    const logMsgs = logSpy.mock.calls.flat().map(String).join(' ');
    expect(logMsgs).toMatch(/adsGptClient STUB/);
    expect(logMsgs).toMatch(/tenantId=53/);
    expect(logMsgs).toMatch(/subBrand=travel-stall/);
    expect(logMsgs).toMatch(/platform=tiktok/);
    expect(logMsgs).toMatch(/2026-05-01\.\.2026-05-31/);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
