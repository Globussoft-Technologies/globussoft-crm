// Unit tests for backend/services/haramainRailClient.js
//
// What this module does:
//   Stub-mode Haramain High-Speed Rail (HHR) pricing API client. Saudi
//   Arabia's HHR connects Makkah ↔ Madinah (~450km in 2.5h), common
//   alternative to road transfer for RFU Umrah cohorts. Quote alongside
//   hotel + flight on the unified Umrah itinerary search surface.
//
//   Seventh consumer of the cross-cutting per-tenant budget-cap pattern
//   (after llmRouter / adsGptClient / ratehawkClient / callifiedClient
//   / bookingExpediaClient / bookingCom).
//
//   Wrinkles on top of the shared cap pattern:
//     - tenantSettings.KEYS does NOT yet include 'haramain_rail' —
//       client reads cap via inline getSetting() with explicit fallback
//       rather than getBudgetCap(). See client header NOTE for
//       rationale. Same workaround as bookingCom.js.
//     - bookRoute deliberately throws 503 HARAMAIN_RAIL_NOT_YET_ENABLED
//       (writes blocked in stub mode; only reads return placeholder
//       data).
//     - searchRoutes returns 2-3 deterministic placeholder routes with
//       stable trainIds; price scales by passengerCount so multi-pax
//       queries return larger totals deterministically.
//
//   Exports:
//     - INTEGRATION                       — short token 'haramain_rail'
//     - BUDGET_CAP_KEY                    — TenantSetting key for the cap row
//     - DEFAULT_CAP_CENTS                 — 50000 (= $500/mo)
//     - isEnabledForTenant(tenantId)      — defaults to true; honours .disabled flag
//     - checkBudgetCap(t, cost?)          — pre-call cap check; throws HARAMAIN_RAIL_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t)       — stub returns 0
//     - searchRoutes({...})               — 2-3 deterministic routes, currency 'SAR'
//     - getRouteDetails({...})            — detail object with availability + cancellation policy
//     - bookRoute({...})                  — throws HARAMAIN_RAIL_NOT_YET_ENABLED 503
//
// Surface area covered (12 tests):
//   1. Module shape — exports + constants
//   2. isEnabledForTenant — default true
//   3. isEnabledForTenant — honours `haramain_rail.disabled='true'` flag
//   4. checkBudgetCap — under 80% returns withinCap:true, alertThreshold:false
//   5. checkBudgetCap — between 80-100% warns via console.warn spy
//   6. checkBudgetCap — ≥100% throws with code HARAMAIN_RAIL_BUDGET_EXCEEDED
//   7. computeMonthlySpendCents — stub returns 0
//   8. searchRoutes — returns array, length 2-3, currency 'SAR'
//   9. searchRoutes — deterministic for same inputs
//  10. searchRoutes — scales price by passengerCount
//  11. getRouteDetails — returns expected shape (availability + cancellation policy)
//  12. bookRoute — throws HARAMAIN_RAIL_NOT_YET_ENABLED 503
//  13. CJS self-mocking seam — vi.spyOn(client, 'computeMonthlySpendCents') intercepts
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (RFU unified-search, Umrah itinerary
// builder, future HHR PNR integration) depend on the returned envelope
// shape.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Installed into Node's Module._cache the same way as the
// ratehawkClient / callifiedClient / bookingExpediaClient / bookingCom
// tests (vitest's ESM-level vi.mock can't intercept CJS require()).
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
  // are pristine. Same pattern as bookingCom.test.js /
  // ratehawkClient.test.js / callifiedClient.test.js /
  // bookingExpediaClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/haramainRailClient.js')];
  // Also reload tenantSettings so its imported prisma binding
  // re-resolves to the mocked module in Module._cache.
  delete requireCjs.cache[requireCjs.resolve('../../lib/tenantSettings.js')];
  return requireCjs('../../services/haramainRailClient.js');
}

describe('haramainRailClient — module shape', () => {
  test('exports the contract surface + constants', () => {
    const c = loadClient();
    expect(typeof c.isEnabledForTenant).toBe('function');
    expect(typeof c.searchRoutes).toBe('function');
    expect(typeof c.getRouteDetails).toBe('function');
    expect(typeof c.bookRoute).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(c.INTEGRATION).toBe('haramain_rail');
    expect(c.BUDGET_CAP_KEY).toBe('budgetCap_haramain_rail_monthly_usd_cents');
    expect(c.DEFAULT_CAP_CENTS).toBe(50000);
  });
});

describe('isEnabledForTenant', () => {
  test('defaults to true when no setting row exists', async () => {
    const c = loadClient();
    const enabled = await c.isEnabledForTenant(42);
    expect(enabled).toBe(true);
  });

  test("honours haramain_rail.disabled='true' flag", async () => {
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'haramain_rail.disabled'
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
    // Cap row: 50000 cents ($500, DEFAULT_CAP_CENTS — explicit for clarity).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'budgetCap_haramain_rail_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '50000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 1000 / 50000 = 2% → withinCap, no alert.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(1000);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation).toMatchObject({
      spentCents: 1000,
      capCents: 50000,
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
        where.tenantId_key.key === 'budgetCap_haramain_rail_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '50000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 42500 / 50000 = 85% → alertThreshold true, withinCap still true.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(42500);

    const evaluation = await c.checkBudgetCap(7);
    expect(evaluation).toMatchObject({
      withinCap: true,
      alertThreshold: true,
    });
    expect(evaluation.percent).toBeCloseTo(0.85, 5);

    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).toMatch(/tenant 7/);
    expect(warnMsgs).toMatch(/85%/);
    expect(warnMsgs).toMatch(/Haramain Rail/);

    spendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('≥100%: throws with code HARAMAIN_RAIL_BUDGET_EXCEEDED', async () => {
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'budgetCap_haramain_rail_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '50000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 50001 cents > 50000 cap → withinCap false → throw.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(50001);

    let caught;
    try {
      await c.checkBudgetCap(7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('HARAMAIN_RAIL_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Haramain High-Speed Rail cap reached/);
    expect(caught.spentCents).toBe(50001);
    expect(caught.capCents).toBe(50000);

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

describe('searchRoutes', () => {
  test('happy path: returns array length 2-3 with currency SAR + vendor tag', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchRoutes({
      tenantId: 42,
      fromStation: 'Makkah',
      toStation: 'Madinah',
      travelDate: '2026-08-01',
      passengerCount: 1,
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
    });
    expect(Array.isArray(out.routes)).toBe(true);
    expect(out.routes.length).toBeGreaterThanOrEqual(2);
    expect(out.routes.length).toBeLessThanOrEqual(3);

    for (const r of out.routes) {
      expect(r).toMatchObject({
        trainId: expect.any(String),
        departure: expect.any(String),
        arrival: expect.any(String),
        durationMin: expect.any(Number),
        classType: expect.any(String),
        basePriceCents: expect.any(Number),
        currency: 'SAR',
        vendor: 'haramain.rail',
      });
    }

    expect(out.query).toMatchObject({
      fromStation: 'Makkah',
      toStation: 'Madinah',
      travelDate: '2026-08-01',
      passengerCount: 1,
    });
    // Note must mention #928 + HHR framing.
    expect(out.note).toMatch(/#928/);
    expect(out.note).toMatch(/Haramain/);

    logSpy.mockRestore();
  });

  test('deterministic: same inputs return identical output across two calls', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const inputs = {
      tenantId: 42,
      fromStation: 'Makkah',
      toStation: 'Madinah',
      travelDate: '2026-08-01',
      passengerCount: 2,
    };
    const out1 = await c.searchRoutes(inputs);
    const out2 = await c.searchRoutes(inputs);

    // Strip the stub envelope, compare core route arrays byte-equal.
    expect(out1.routes).toEqual(out2.routes);

    logSpy.mockRestore();
  });

  test('scales basePriceCents by passengerCount', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out1 = await c.searchRoutes({
      tenantId: 42,
      fromStation: 'Makkah',
      toStation: 'Madinah',
      travelDate: '2026-08-01',
      passengerCount: 1,
    });
    const out4 = await c.searchRoutes({
      tenantId: 42,
      fromStation: 'Makkah',
      toStation: 'Madinah',
      travelDate: '2026-08-01',
      passengerCount: 4,
    });

    // Compare matching trainIds: passengerCount=4 should be 4× the
    // basePriceCents of passengerCount=1 row with the same trainId.
    for (const r1 of out1.routes) {
      const r4 = out4.routes.find((r) => r.trainId === r1.trainId);
      expect(r4).toBeDefined();
      expect(r4.basePriceCents).toBe(r1.basePriceCents * 4);
    }

    logSpy.mockRestore();
  });
});

describe('getRouteDetails', () => {
  test('returns deterministic detail object with availability + cancellation policy', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.getRouteDetails({
      trainId: 'hhr-stub-train-001',
      classType: 'economy',
      passengerCount: 2,
    });

    expect(out).toMatchObject({ stub: true });
    expect(out.route).toMatchObject({
      trainId: 'hhr-stub-train-001',
      classType: 'economy',
      currency: 'SAR',
      vendor: 'haramain.rail',
    });
    expect(out.route.availability).toMatchObject({
      economy: expect.objectContaining({
        seatsRemaining: expect.any(Number),
        totalSeats: expect.any(Number),
      }),
      business: expect.objectContaining({
        seatsRemaining: expect.any(Number),
        totalSeats: expect.any(Number),
      }),
    });
    expect(out.route.cancellationPolicy).toMatch(/refund/i);
    expect(out.note).toMatch(/#928/);

    logSpy.mockRestore();
  });
});

describe('bookRoute', () => {
  test('throws HARAMAIN_RAIL_NOT_YET_ENABLED (live writes disabled in stub mode)', async () => {
    const c = loadClient();
    let caught;
    try {
      await c.bookRoute({
        tenantId: 42,
        trainId: 'hhr-stub-train-001',
        classType: 'economy',
        passengerCount: 2,
        passengerNames: ['Khan, Imran', 'Khan, Fatima'],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('HARAMAIN_RAIL_NOT_YET_ENABLED');
    expect(caught.statusCode).toBe(503);
    expect(caught.message).toMatch(/Phase 1/);
    expect(caught.message).toMatch(/#928/);
  });
});

describe('CJS self-mocking seam', () => {
  test("vi.spyOn(client, 'computeMonthlySpendCents') intercepts checkBudgetCap's inter-function call", async () => {
    // This test pins the CJS self-mocking seam pattern. checkBudgetCap
    // calls computeMonthlySpendCents internally via
    // `module.exports.fn()` rather than the local closure binding —
    // so the spy below must fire. Per CLAUDE.md 2026-05-24 cron-
    // learning: seventh instance of this pattern (after safeEmitEvent,
    // adsGptClient, ratehawkClient, callifiedClient,
    // bookingExpediaClient, bookingCom).
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
    expect(caught.code).toBe('HARAMAIN_RAIL_BUDGET_EXCEEDED');
    expect(caught.spentCents).toBe(999_999_999);

    spendSpy.mockRestore();
  });
});
