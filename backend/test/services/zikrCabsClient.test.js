// Unit tests for backend/services/zikrCabsClient.js
//
// What this module does:
//   Stub-mode Zikr Cabs Saudi ground-transfer API client. Saudi-side
//   ground transfers for RFU Umrah pilgrim groups: Jeddah airport ↔
//   Makkah (~80km), Madinah ↔ Jeddah airport (~440km), Makkah ↔
//   Madinah (~450km). Typical vehicle classes: sedan (1-3 pax), van
//   (4-8 pax — RFU's default small-cohort van), minibus (9-15 pax),
//   bus (16-30 pax). Quote alongside hotel + flight + HHR on the
//   unified Umrah itinerary search surface.
//
//   Eighth consumer of the cross-cutting per-tenant budget-cap pattern
//   (after llmRouter / adsGptClient / ratehawkClient / callifiedClient
//   / bookingExpediaClient / bookingCom / haramainRailClient).
//
//   Wrinkles on top of the shared cap pattern:
//     - tenantSettings.KEYS does NOT yet include 'zikr_cabs' — client
//       reads cap via inline getSetting() with explicit fallback rather
//       than getBudgetCap(). Same workaround as haramainRailClient.js +
//       bookingCom.js. See client header NOTE for rationale.
//     - bookTransfer deliberately throws 503 ZIKR_CABS_NOT_YET_ENABLED
//       (writes blocked in stub mode; only reads return placeholder
//       data).
//     - searchTransfers returns 3-4 deterministic placeholder transfers
//       with stable transferIds; per-route price-jitter is seeded by
//       hashOfArgs({fromCity,toCity,pickupDate}) so the same query is
//       byte-stable across calls.
//     - getTransferDetails applies perPaxSupplement when
//       passengerCount > baseCapacity (e.g. 5-pax in a sedan-3 triggers
//       2 extra-pax rows).
//
//   Exports:
//     - INTEGRATION                       — short token 'zikr_cabs'
//     - BUDGET_CAP_KEY                    — TenantSetting key for the cap row
//     - DEFAULT_CAP_CENTS                 — 30000 (= $300/mo)
//     - isEnabledForTenant(tenantId)      — defaults to true; honours .disabled flag
//     - checkBudgetCap(t, cost?)          — pre-call cap check; throws ZIKR_CABS_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t)       — stub returns 0
//     - searchTransfers({...})            — 3-4 deterministic transfers, currency 'SAR'
//     - getTransferDetails({...})         — detail object with driver + cancellation + total price
//     - bookTransfer({...})               — throws ZIKR_CABS_NOT_YET_ENABLED 503
//
// Surface area covered (13 tests):
//   1.  Module shape — exports + constants
//   2.  isEnabledForTenant — default true
//   3.  isEnabledForTenant — honours `zikr_cabs.disabled='true'` flag
//   4.  checkBudgetCap — under 80% returns withinCap:true, alertThreshold:false
//   5.  checkBudgetCap — between 80-100% warns via console.warn spy
//   6.  checkBudgetCap — ≥100% throws with code ZIKR_CABS_BUDGET_EXCEEDED
//   7.  computeMonthlySpendCents — stub returns 0
//   8.  searchTransfers — returns array length 3-4 with currency 'SAR' + vehicle classes
//   9.  searchTransfers — deterministic for same inputs
//  10.  searchTransfers — different (fromCity,toCity,pickupDate) seeds diverge in price
//  11.  getTransferDetails — applies per-pax supplement when passengerCount > baseCapacity
//  12.  getTransferDetails — NO supplement when passengerCount ≤ baseCapacity
//  13.  bookTransfer — throws ZIKR_CABS_NOT_YET_ENABLED 503
//  14.  CJS self-mocking seam — vi.spyOn(client, 'computeMonthlySpendCents') intercepts
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (RFU unified-search, Umrah itinerary
// builder, future Zikr Cabs PNR integration) depend on the returned
// envelope shape.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Installed into Node's Module._cache the same way as the
// ratehawkClient / callifiedClient / bookingExpediaClient / bookingCom
// / haramainRailClient tests (vitest's ESM-level vi.mock can't
// intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → fallback (DEFAULT_CAP_CENTS)
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue(null),
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
  prismaMock.tenant.findUnique.mockReset();
  prismaMock.tenant.findUnique.mockResolvedValue(null);
});

function loadClient() {
  // Reload fresh between tests so the spend-stub mock + module state
  // are pristine. Same pattern as haramainRailClient.test.js /
  // bookingCom.test.js / ratehawkClient.test.js / callifiedClient.test.js /
  // bookingExpediaClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/zikrCabsClient.js')];
  // Also reload tenantSettings so its imported prisma binding
  // re-resolves to the mocked module in Module._cache.
  delete requireCjs.cache[requireCjs.resolve('../../lib/tenantSettings.js')];
  return requireCjs('../../services/zikrCabsClient.js');
}

describe('zikrCabsClient — module shape', () => {
  test('exports the contract surface + constants', () => {
    const c = loadClient();
    expect(typeof c.isEnabledForTenant).toBe('function');
    expect(typeof c.searchTransfers).toBe('function');
    expect(typeof c.getTransferDetails).toBe('function');
    expect(typeof c.bookTransfer).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(c.INTEGRATION).toBe('zikr_cabs');
    expect(c.BUDGET_CAP_KEY).toBe('zikr_cabs.monthly_cap_cents');
    expect(c.DEFAULT_CAP_CENTS).toBe(30000);
  });
});

describe('isEnabledForTenant', () => {
  test('defaults to true when no setting row exists', async () => {
    const c = loadClient();
    const enabled = await c.isEnabledForTenant(42);
    expect(enabled).toBe(true);
  });

  test("honours zikr_cabs.disabled='true' flag", async () => {
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'zikr_cabs.disabled'
      ) {
        return Promise.resolve({ value: 'true' });
      }
      return Promise.resolve(null);
    });
    const c = loadClient();
    const enabled = await c.isEnabledForTenant(42);
    expect(enabled).toBe(false);
  });
});

describe('checkBudgetCap', () => {
  test('under 80%: returns withinCap:true, alertThreshold:false', async () => {
    // Cap row: 30000 cents ($300, DEFAULT_CAP_CENTS — explicit for clarity).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'zikr_cabs.monthly_cap_cents'
      ) {
        return Promise.resolve({ value: '30000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 1000 / 30000 ≈ 3% → withinCap, no alert.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(1000);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation).toMatchObject({
      spentCents: 1000,
      capCents: 30000,
      withinCap: true,
      alertThreshold: false,
    });

    spendSpy.mockRestore();
  });

  test('between 80-100%: warns via console.warn spy', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'zikr_cabs.monthly_cap_cents'
      ) {
        return Promise.resolve({ value: '30000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 25500 / 30000 = 85% → alertThreshold true, withinCap still true.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(25500);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation).toMatchObject({
      withinCap: true,
      alertThreshold: true,
    });
    expect(evaluation.percent).toBeCloseTo(0.85, 5);

    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/tenant 7/);
    expect(warnMsgs).toMatch(/85%/);
    expect(warnMsgs).toMatch(/Zikr Cabs/);

    spendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('≥100%: throws with code ZIKR_CABS_BUDGET_EXCEEDED', async () => {
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'zikr_cabs.monthly_cap_cents'
      ) {
        return Promise.resolve({ value: '30000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 30001 cents > 30000 cap → withinCap false → throw.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(30001);

    let caught;
    try {
      await c.checkBudgetCap(7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ZIKR_CABS_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Zikr Cabs ground-transfer cap reached/);
    expect(caught.spentCents).toBe(30001);
    expect(caught.capCents).toBe(30000);

    spendSpy.mockRestore();
  });
});

describe('computeMonthlySpendCents', () => {
  test('stub returns 0', async () => {
    const c = loadClient();
    const cents = await c.computeMonthlySpendCents(42);
    expect(cents).toBe(0);
  });
});

describe('searchTransfers', () => {
  test('happy path: returns array length 3-4 with currency SAR + vehicle classes match spec + vendor tag', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchTransfers({
      tenantId: 42,
      fromCity: 'Madinah',
      toCity: 'Jeddah',
      pickupDate: '2026-08-01',
      passengerCount: 1,
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
    });
    expect(Array.isArray(out.transfers)).toBe(true);
    expect(out.transfers.length).toBeGreaterThanOrEqual(3);
    expect(out.transfers.length).toBeLessThanOrEqual(4);

    const allowedClasses = new Set(['sedan', 'van', 'minibus', 'bus']);
    for (const t of out.transfers) {
      expect(t).toMatchObject({
        transferId: expect.any(String),
        vehicleClass: expect.any(String),
        capacity: expect.any(Number),
        durationMin: expect.any(Number),
        basePriceCents: expect.any(Number),
        currency: 'SAR',
        vendor: 'zikr.cabs',
      });
      expect(allowedClasses.has(t.vehicleClass)).toBe(true);
    }

    expect(out.query).toMatchObject({
      fromCity: 'Madinah',
      toCity: 'Jeddah',
      pickupDate: '2026-08-01',
      passengerCount: 1,
    });
    // Note must mention #926 + Zikr Cabs framing.
    expect(out.note).toMatch(/#926/);
    expect(out.note).toMatch(/Zikr Cabs/);

    logSpy.mockRestore();
  });

  test('deterministic: same inputs return identical output across two calls', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const inputs = {
      tenantId: 42,
      fromCity: 'Madinah',
      toCity: 'Jeddah',
      pickupDate: '2026-08-01',
      passengerCount: 2,
    };
    const out1 = await c.searchTransfers(inputs);
    const out2 = await c.searchTransfers(inputs);

    // Strip the stub envelope, compare core transfer arrays byte-equal.
    expect(out1.transfers).toEqual(out2.transfers);

    logSpy.mockRestore();
  });

  test('different (fromCity,toCity,pickupDate) seed produces divergent pricing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    // Two distinct routes. The price-jitter seed is hashOfArgs({fromCity,
    // toCity, pickupDate}) — if seeds produce the same jitter percent
    // by sheer coincidence the test is brittle; pick inputs that
    // produce visibly different jitter. Compare ANY matching transferId.
    const outRoute1 = await c.searchTransfers({
      tenantId: 42,
      fromCity: 'Madinah',
      toCity: 'Jeddah',
      pickupDate: '2026-08-01',
      passengerCount: 1,
    });
    const outRoute2 = await c.searchTransfers({
      tenantId: 42,
      fromCity: 'Makkah',
      toCity: 'Madinah',
      pickupDate: '2026-09-15',
      passengerCount: 1,
    });

    // At least one matching transferId should show a different price
    // (the seeds shouldn't collide).
    let foundDivergence = false;
    for (const t1 of outRoute1.transfers) {
      const t2 = outRoute2.transfers.find((x) => x.transferId === t1.transferId);
      if (t2 && t2.basePriceCents !== t1.basePriceCents) {
        foundDivergence = true;
        break;
      }
    }
    expect(foundDivergence).toBe(true);

    logSpy.mockRestore();
  });
});

describe('getTransferDetails', () => {
  test('applies per-pax supplement when passengerCount > baseCapacity (5 pax in sedan-3 → 2× supplement)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.getTransferDetails({
      transferId: 'zikr-stub-sedan-001', // capacity=3, baseCapacity=3, perPaxSupplementCents=5000
      passengerCount: 5,
    });

    expect(out).toMatchObject({ stub: true });
    expect(out.transfer).toMatchObject({
      transferId: 'zikr-stub-sedan-001',
      vehicleClass: 'sedan',
      baseCapacity: 3,
      currency: 'SAR',
      vendor: 'zikr.cabs',
    });
    // 2 extra pax × 5000 cents = 10000 supplement.
    expect(out.transfer.supplementCents).toBe(10000);
    // base 35000 + supplement 10000 = 45000 total.
    expect(out.transfer.totalPriceCents).toBe(
      out.transfer.basePriceCents + out.transfer.supplementCents,
    );
    expect(out.transfer.totalPriceCents).toBe(45000);
    // Driver + cancellation policy placeholders present.
    expect(out.transfer.driver).toMatchObject({
      name: expect.any(String),
      phoneMasked: expect.any(String),
      languages: expect.arrayContaining(['en', 'ar']),
    });
    expect(out.transfer.cancellationPolicy).toMatch(/refund/i);
    expect(out.note).toMatch(/#926/);

    logSpy.mockRestore();
  });

  test('NO supplement when passengerCount ≤ baseCapacity (3 pax in sedan-3 → supplement=0, total=base)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.getTransferDetails({
      transferId: 'zikr-stub-sedan-001', // baseCapacity=3
      passengerCount: 3,
    });

    expect(out.transfer.supplementCents).toBe(0);
    expect(out.transfer.totalPriceCents).toBe(out.transfer.basePriceCents);

    logSpy.mockRestore();
  });
});

describe('bookTransfer', () => {
  test('throws ZIKR_CABS_NOT_YET_ENABLED (live writes disabled in stub mode)', async () => {
    const c = loadClient();
    let caught;
    try {
      await c.bookTransfer({
        tenantId: 42,
        transferId: 'zikr-stub-van-001',
        passengerCount: 6,
        passengerNames: ['Khan, Imran', 'Khan, Fatima'],
        pickupAddress: 'Hilton Madinah',
        dropoffAddress: 'Jeddah King Abdulaziz Airport (JED) — T1',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ZIKR_CABS_NOT_YET_ENABLED');
    expect(caught.statusCode).toBe(503);
    expect(caught.message).toMatch(/Phase 1/);
    expect(caught.message).toMatch(/#926/);
  });
});

describe('CJS self-mocking seam', () => {
  test("vi.spyOn(client, 'computeMonthlySpendCents') intercepts checkBudgetCap's inter-function call", async () => {
    // This test pins the CJS self-mocking seam pattern. checkBudgetCap
    // calls computeMonthlySpendCents internally via
    // `module.exports.fn()` rather than the local closure binding —
    // so the spy below must fire. Per CLAUDE.md 2026-05-24 cron-
    // learning: EIGHTH instance of this pattern (after safeEmitEvent,
    // adsGptClient, ratehawkClient, callifiedClient,
    // bookingExpediaClient, bookingCom, haramainRailClient).
    //
    // Stub spend = 999_999_999 cents (well above any cap). With a tiny
    // attemptedCost, checkBudgetCap should still throw because spend
    // already exceeds the (default) cap. This proves the
    // module.exports indirection works — without the seam the spy
    // would not fire and the throw would not happen.
    const c = loadClient();
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(999_999_999);

    let caught;
    try {
      await c.checkBudgetCap(7, 100);
    } catch (e) {
      caught = e;
    }
    expect(spendSpy).toHaveBeenCalledWith(7);
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ZIKR_CABS_BUDGET_EXCEEDED');
    expect(caught.spentCents).toBe(999_999_999);

    spendSpy.mockRestore();
  });
});
