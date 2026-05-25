// Unit tests for backend/services/bookingCom.js
//
// What this module does:
//   Stub-mode Booking.com Affiliate Partner API client. Per DC-1 RESOLVED
//   2026-05-24, Booking.com is priority over Expedia (India inventory
//   density + simpler OAuth2). Lower-level provider client; coexists with
//   the unified bookingExpediaClient.js wrapper (which routes per provider
//   and shares a separate cap key 'booking_expedia').
//
//   Sixth consumer of the cross-cutting per-tenant budget-cap pattern
//   (after llmRouter / adsGptClient / ratehawkClient / callifiedClient /
//   bookingExpediaClient).
//
//   Wrinkles on top of the shared cap pattern:
//     - tenantSettings.KEYS does NOT yet include 'booking_com' — client
//       reads cap via inline getSetting() with explicit fallback rather
//       than getBudgetCap(). See client header NOTE for rationale.
//     - bookHotel deliberately throws 503 BOOKING_COM_NOT_YET_ENABLED
//       (writes blocked in stub mode; only reads return placeholder data).
//     - searchHotels returns 3-4 deterministic placeholder hotels with
//       stable IDs (downstream UI / spec snapshots reproducible).
//
//   Exports:
//     - INTEGRATION                  — short token 'booking_com'
//     - BUDGET_CAP_KEY               — TenantSetting key for the cap row
//     - DEFAULT_CAP_CENTS            — 10000 (= $100/mo)
//     - checkBudgetCap(t)            — pre-call cap check; throws BOOKING_COM_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t)  — stub returns 0
//     - searchHotels({...})          — stub canned shape, 3-4 deterministic hotels
//     - getHotelDetails(id, t)       — stub detail object with rooms[]
//     - bookHotel({...})             — throws BOOKING_COM_NOT_YET_ENABLED 503
//
// Surface area covered:
//   1. Module shape — exports + constants
//   2. searchHotels happy path returns array of 3-4 hotels with expected fields
//   3. searchHotels passes subBrand through in returned data
//   4. searchHotels throws BOOKING_COM_BUDGET_EXCEEDED when spend exceeds cap
//   5. searchHotels throws when tenantId missing
//   6. getHotelDetails returns deterministic object with rooms array
//   7. getHotelDetails throws when hotelId missing
//   8. bookHotel throws BOOKING_COM_NOT_YET_ENABLED
//   9. checkBudgetCap returns alertThreshold:true at ≥80% spend
//  10. CJS self-mocking seam: vi.spyOn(module.exports, 'computeMonthlySpendCents') intercepts
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (RFU unified-search, Travel Stall hotel
// booking flow, future Booking.com PNR integration) depend on the
// returned envelope shape.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Installed into Node's Module._cache the same way as the
// ratehawkClient / callifiedClient / bookingExpediaClient tests
// (vitest's ESM-level vi.mock can't intercept CJS require()).
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
  // Reload fresh between tests so the spend-stub mock + module state are
  // pristine. Same pattern as ratehawkClient.test.js / callifiedClient.test.js
  // / bookingExpediaClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/bookingCom.js')];
  // Also reload tenantSettings so its imported prisma binding re-resolves
  // to the mocked module in Module._cache.
  delete requireCjs.cache[requireCjs.resolve('../../lib/tenantSettings.js')];
  return requireCjs('../../services/bookingCom.js');
}

describe('bookingCom — module shape', () => {
  test('exports the contract surface + constants', () => {
    const c = loadClient();
    expect(typeof c.searchHotels).toBe('function');
    expect(typeof c.getHotelDetails).toBe('function');
    expect(typeof c.bookHotel).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(c.INTEGRATION).toBe('booking_com');
    expect(c.BUDGET_CAP_KEY).toBe('budgetCap_booking_com_monthly_usd_cents');
    expect(c.DEFAULT_CAP_CENTS).toBe(10000);
  });
});

describe('searchHotels', () => {
  test('happy path: returns array of 3-4 hotels with expected fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchHotels({
      tenantId: 42,
      destination: 'Mecca',
      checkIn: '2026-08-01',
      checkOut: '2026-08-07',
      guests: 2,
      rooms: 1,
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
    });
    expect(Array.isArray(out.hotels)).toBe(true);
    expect(out.hotels.length).toBeGreaterThanOrEqual(3);
    expect(out.hotels.length).toBeLessThanOrEqual(4);

    // Each hotel has the contract shape.
    for (const h of out.hotels) {
      expect(h).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        address: expect.any(String),
        priceFromCents: expect.any(Number),
        currency: expect.any(String),
        cancellationPolicy: expect.any(String),
        vendor: 'booking.com',
      });
    }

    expect(out.query).toMatchObject({
      destination: 'Mecca',
      checkIn: '2026-08-01',
      checkOut: '2026-08-07',
      guests: 2,
      rooms: 1,
    });
    // Note must mention Q11 + Booking.com framing.
    expect(out.note).toMatch(/Q11/);
    expect(out.note).toMatch(/Booking\.com/);

    logSpy.mockRestore();
  });

  test('respects subBrand param: passes through in returned data', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchHotels({
      tenantId: 42,
      destination: 'Mecca',
      checkIn: '2026-08-01',
      checkOut: '2026-08-07',
      subBrand: 'rfu',
    });

    expect(out.subBrand).toBe('rfu');

    logSpy.mockRestore();
  });

  test('throws BOOKING_COM_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Cap row: 5000 cents ($50, override below DEFAULT_CAP_CENTS).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'budgetCap_booking_com_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '5000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // Override computeMonthlySpendCents to return cap + 1 = 5001 cents
    // (over cap → evaluateCap.withinCap = false → throw). Spy works because
    // the SUT resolves the call via module.exports (CJS self-mocking seam).
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(5001);

    let caught;
    try {
      await c.searchHotels({
        tenantId: 7,
        destination: 'Mecca',
        checkIn: '2026-08-01',
        checkOut: '2026-08-05',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('BOOKING_COM_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly Booking\.com hotel-inventory cap reached/);
    expect(caught.spentCents).toBe(5001);
    expect(caught.capCents).toBe(5000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('throws when tenantId missing', async () => {
    const c = loadClient();
    await expect(
      c.searchHotels({
        destination: 'Mecca',
        checkIn: '2026-08-01',
        checkOut: '2026-08-05',
      }),
    ).rejects.toThrow(/tenantId required/);
  });
});

describe('getHotelDetails', () => {
  test('happy path: returns deterministic detail object with rooms array', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.getHotelDetails('bcom-stub-hotel-001', 42);

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
    });
    expect(out.hotel).toMatchObject({
      id: 'bcom-stub-hotel-001',
      vendor: 'booking.com',
    });
    expect(Array.isArray(out.hotel.rooms)).toBe(true);
    expect(out.hotel.rooms.length).toBeGreaterThanOrEqual(1);

    for (const r of out.hotel.rooms) {
      expect(r).toMatchObject({
        id: expect.any(String),
        type: expect.any(String),
        priceFromCents: expect.any(Number),
        currency: expect.any(String),
        maxOccupancy: expect.any(Number),
        cancellationPolicy: expect.any(String),
      });
    }

    expect(out.note).toMatch(/Q11/);

    logSpy.mockRestore();
  });

  test('throws when hotelId missing', async () => {
    const c = loadClient();
    await expect(c.getHotelDetails(null, 42)).rejects.toThrow(/hotelId required/);
  });

  test('throws when tenantId missing', async () => {
    const c = loadClient();
    await expect(c.getHotelDetails('bcom-stub-hotel-001', null)).rejects.toThrow(
      /tenantId required/,
    );
  });
});

describe('bookHotel', () => {
  test('throws BOOKING_COM_NOT_YET_ENABLED (live writes disabled in stub mode)', async () => {
    const c = loadClient();
    let caught;
    try {
      await c.bookHotel({
        tenantId: 42,
        hotelId: 'bcom-stub-hotel-001',
        roomType: 'standard',
        checkIn: '2026-08-01',
        checkOut: '2026-08-05',
        guestNames: ['Khan, Imran'],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('BOOKING_COM_NOT_YET_ENABLED');
    expect(caught.statusCode).toBe(503);
    expect(caught.message).toMatch(/Phase 1/);
    expect(caught.message).toMatch(/Q11/);
  });
});

describe('checkBudgetCap', () => {
  test('returns alertThreshold:true when stubbed spend is ≥80% of cap (10000c cap, 8500c spend)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Cap row: 10000 cents ($100, DEFAULT_CAP_CENTS — explicit for clarity).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'budgetCap_booking_com_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '10000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // 8500 / 10000 = 85% → alertThreshold true, withinCap still true.
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(8500);

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
    expect(warnMsgs).toMatch(/Booking\.com/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('falls back to DEFAULT_CAP_CENTS when no TenantSetting row exists', async () => {
    // No tenantSetting rows → cap falls back to DEFAULT_CAP_CENTS (10000);
    // stub spend = 0 → withinCap = true, percent = 0.
    const c = loadClient();
    const evaluation = await c.checkBudgetCap(99);
    expect(evaluation).toMatchObject({
      spentCents: 0,
      capCents: 10000,
      withinCap: true,
      alertThreshold: false,
    });
    expect(evaluation.percent).toBe(0);
  });
});

describe('CJS self-mocking seam', () => {
  test("vi.spyOn(client, 'computeMonthlySpendCents') intercepts checkBudgetCap's inter-function call", async () => {
    // This test pins the CJS self-mocking seam pattern. checkBudgetCap
    // calls computeMonthlySpendCents internally via `module.exports.fn()`
    // rather than the local closure binding — so the spy below must fire.
    // Per CLAUDE.md 2026-05-24 cron-learning: sixth instance of this
    // pattern (after safeEmitEvent, adsGptClient, ratehawkClient,
    // callifiedClient, bookingExpediaClient).
    const c = loadClient();
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(1234);

    const evaluation = await c.checkBudgetCap(7);
    expect(spendSpy).toHaveBeenCalledWith(7);
    expect(evaluation.spentCents).toBe(1234);

    spendSpy.mockRestore();
  });
});
