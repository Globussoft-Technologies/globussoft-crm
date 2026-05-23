// Unit tests for backend/services/ratehawkClient.js
//
// What this module does:
//   Stub-mode wrapper for RateHawk hotel-inventory integration. Real API
//   call lands when Q19 creds (Yasin partner onboarding) drop. Exports:
//     - INTEGRATION                  — short token ('ratehawk') for the cap helper
//     - checkBudgetCap(tenantId)     — pre-call cap check; throws RATEHAWK_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t)  — stub returns 0 (real sums RatehawkSearchLog)
//     - searchHotels({...})          — stub canned shape per PRD §3.1
//     - bookHotel({...})             — stub canned shape per PRD §3.2
//     - cancelBooking({...})         — stub canned envelope
//
// Surface area covered (5 cases):
//   1. searchHotels happy path returns stub shape with note + budget-check passes
//   2. searchHotels throws RATEHAWK_BUDGET_EXCEEDED when stubbed spend exceeds cap
//   3. bookHotel happy path returns stub confirmation envelope
//   4. cancelBooking returns stub cancel envelope
//   5. checkBudgetCap returns alertThreshold:true when stubbed spend ≥80% of cap
//
// Pin the contract the REAL implementation MUST honour when the stub is
// swapped — downstream consumers (RFU itinerary builder, unified-search
// page, lowest-rate auto-pick logic) depend on the returned envelope.

import { describe, test, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// PRD_RATEHAWK_INTEGRATION DC-1: $50/mo cap = 5000 cents (the env-var
// default from backend/lib/tenantSettings.js DEFAULTS map). Tests below
// override per case via mock of tenantSetting.findUnique.

// Hoisted Prisma mock — the cap helper does
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows.
// Installed into Node's Module._cache the same way as the adsGptClient
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
  // pristine. Same pattern as adsGptClient.test.js / digilockerClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/ratehawkClient.js')];
  return requireCjs('../../services/ratehawkClient.js');
}

describe('ratehawkClient — module shape', () => {
  test('exports the contract surface', () => {
    const c = loadClient();
    expect(typeof c.searchHotels).toBe('function');
    expect(typeof c.bookHotel).toBe('function');
    expect(typeof c.cancelBooking).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(c.INTEGRATION).toBe('ratehawk');
  });
});

describe('searchHotels', () => {
  test('happy path: returns stub shape with note + budget-check passes (zero spend)', async () => {
    // No cap row → falls back to DEFAULTS ($50 = 5000 cents); stub spend = 0
    // → withinCap = true, alertThreshold = false. Should not throw or warn.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchHotels({
      tenantId: 42,
      destinationCity: 'Mecca',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-05',
      guests: 3,
      rooms: 1,
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
      query: {
        destinationCity: 'Mecca',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
        guests: 3,
        rooms: 1,
      },
      hotels: [],
    });
    // Note must mention Q19 creds + Yasin so downstream UI can show
    // "integration pending" messaging deterministically.
    expect(out.note).toMatch(/Q19 creds/);
    expect(out.note).toMatch(/Yasin/);

    // Cap query was performed against the right (tenantId, key) tuple.
    expect(prismaMock.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 42, key: 'budgetCap_ratehawk_monthly_usd_cents' } },
      select: { value: true },
    });
    // Zero spend → no alert warning.
    const warnMsgs = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(warnMsgs).not.toMatch(/RateHawk/);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('throws RATEHAWK_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Cap row: 5000 cents ($50, the DC-1 default — explicit here for clarity).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '5000' });

    const c = loadClient();
    // Override computeMonthlySpendCents to return cap + 1 = 5001 cents
    // (over cap → evaluateCap.withinCap = false → throw). Spy works because
    // the SUT resolves the call via module.exports (CJS self-mocking seam).
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(5001);

    let caught;
    try {
      await c.searchHotels({
        tenantId: 99,
        destinationCity: 'Madinah',
        checkInDate: '2026-08-06',
        checkOutDate: '2026-08-10',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('RATEHAWK_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly RateHawk spend cap reached/);
    expect(caught.spentCents).toBe(5001);
    expect(caught.capCents).toBe(5000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('bookHotel', () => {
  test('happy path: returns stub confirmation envelope with pending-cred-drop status', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.bookHotel({
      tenantId: 42,
      hotelId: 'rh-hotel-12345',
      roomType: 'deluxe-double',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-05',
      guestNames: ['Ahmed Khan', 'Fatima Khan'],
    });

    expect(out).toMatchObject({
      stub: true,
      bookingId: null,
      status: 'pending-cred-drop',
      tenantId: 42,
      query: {
        hotelId: 'rh-hotel-12345',
        roomType: 'deluxe-double',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
        guestNames: ['Ahmed Khan', 'Fatima Khan'],
      },
    });
    expect(out.note).toMatch(/Q19 creds/);
    expect(out.note).toMatch(/Yasin/);

    logSpy.mockRestore();
  });
});

describe('cancelBooking', () => {
  test('returns stub cancel envelope with bookingId echoed back', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.cancelBooking({
      tenantId: 42,
      bookingId: 'rh-booking-67890',
      reason: 'Guest changed travel dates',
    });

    expect(out).toMatchObject({
      stub: true,
      bookingId: 'rh-booking-67890',
      status: 'pending-cred-drop',
      tenantId: 42,
      reason: 'Guest changed travel dates',
    });
    expect(out.note).toMatch(/Q19 creds/);

    logSpy.mockRestore();
  });
});

describe('checkBudgetCap', () => {
  test('returns alertThreshold:true when stubbed spend is ≥80% of cap (10000c cap, 8500c spend)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Cap row: 10000 cents ($100 — explicit per-tenant override above the DC-1 default).
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
    expect(warnMsgs).toMatch(/RateHawk/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
