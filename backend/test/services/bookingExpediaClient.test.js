// Unit tests for backend/services/bookingExpediaClient.js
//
// What this module does:
//   Stub-mode wrapper for Booking.com (Phase 1) and Expedia EAN (Phase 2,
//   deferred) hotel-inventory integrations. Real API calls land when
//   Q-cluster B6/C creds drop. Fifth consumer of the cross-cutting
//   per-tenant budget-cap pattern (after llmRouter + adsGptClient +
//   ratehawkClient + callifiedClient).
//
//   Wrinkles on top of the shared cap pattern:
//     - TWO named providers ('booking' + 'expedia') sharing ONE cap key
//       ('booking_expedia') — they're alternative sources of the same
//       hotel-inventory budget per DC-1.
//     - Phase 2 gate: provider='expedia' throws EXPEDIA_NOT_YET_ENABLED
//       per DC-4 (demand-driven flip, not in scope today).
//     - tenantSettings.KEYS does NOT yet include 'booking_expedia' —
//       client reads cap via getSetting() with explicit fallback rather
//       than getBudgetCap(). See client header NOTE for the rationale.
//
//   Exports:
//     - INTEGRATION             — short token ('booking_expedia') for cap helper
//     - BUDGET_CAP_KEY          — TenantSetting key for the cap row
//     - PROVIDERS               — ['booking', 'expedia']
//     - PHASE_2_PROVIDERS       — ['expedia'] (DC-4 deferred)
//     - DEFAULT_CAP_CENTS       — 10000 (= $100/mo, mirrors AI_CALLING/LLM defaults)
//     - checkBudgetCap(t)       — pre-call cap check; throws BOOKING_EXPEDIA_BUDGET_EXCEEDED
//     - computeMonthlySpendCents(t) — stub returns 0 (real will sum HotelBookingLog)
//     - assertProviderEnabled(p) — throws UNKNOWN_PROVIDER / EXPEDIA_NOT_YET_ENABLED
//     - searchHotels({...})     — stub canned shape, runs provider-gate + cap pre-checks
//     - bookHotel({...})        — stub canned shape with status 'pending-cred-drop'
//     - cancelBooking({...})    — stub canned shape with status 'pending-cred-drop'
//
// Surface area covered:
//   1. Module shape — exports + constants
//   2. searchHotels happy path (provider='booking') returns stub envelope
//   3. searchHotels throws EXPEDIA_NOT_YET_ENABLED for provider='expedia' (Phase 2)
//   4. searchHotels throws UNKNOWN_PROVIDER for unknown provider name
//   5. searchHotels throws BOOKING_EXPEDIA_BUDGET_EXCEEDED when stubbed spend exceeds cap
//   6. bookHotel happy path returns stub confirmation with provider field
//   7. cancelBooking happy path returns stub envelope
//   8. checkBudgetCap returns alertThreshold:true at 80% spend
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
// ratehawkClient / callifiedClient tests (vitest's ESM-level vi.mock
// can't intercept CJS require()).
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
  // pristine. Same pattern as ratehawkClient.test.js / callifiedClient.test.js.
  delete requireCjs.cache[requireCjs.resolve('../../services/bookingExpediaClient.js')];
  // Also reload tenantSettings so its imported prisma binding re-resolves
  // to the mocked module in Module._cache.
  delete requireCjs.cache[requireCjs.resolve('../../lib/tenantSettings.js')];
  return requireCjs('../../services/bookingExpediaClient.js');
}

describe('bookingExpediaClient — module shape', () => {
  test('exports the contract surface + constants', () => {
    const c = loadClient();
    expect(typeof c.searchHotels).toBe('function');
    expect(typeof c.bookHotel).toBe('function');
    expect(typeof c.cancelBooking).toBe('function');
    expect(typeof c.checkBudgetCap).toBe('function');
    expect(typeof c.computeMonthlySpendCents).toBe('function');
    expect(typeof c.assertProviderEnabled).toBe('function');
    expect(c.INTEGRATION).toBe('booking_expedia');
    expect(c.BUDGET_CAP_KEY).toBe('budgetCap_booking_expedia_monthly_usd_cents');
    expect(c.PROVIDERS).toEqual(['booking', 'expedia']);
    expect(c.PHASE_2_PROVIDERS).toEqual(['expedia']);
    expect(c.DEFAULT_CAP_CENTS).toBe(10000);
  });
});

describe('searchHotels', () => {
  test("happy path (provider='booking'): returns stub envelope with provider + query echo", async () => {
    // No tenantSetting rows → cap falls back to DEFAULT_CAP_CENTS (10000);
    // stub spend = 0 → withinCap = true.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchHotels({
      tenantId: 42,
      provider: 'booking',
      destinationCity: 'Mecca',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-07',
      guests: 2,
      rooms: 1,
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
      provider: 'booking',
      hotels: [],
    });
    expect(out.query).toMatchObject({
      destinationCity: 'Mecca',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-07',
      guests: 2,
      rooms: 1,
    });
    // Note must mention Q-cluster B6/C + Phase 2 framing so downstream UI
    // can show "integration pending" messaging deterministically.
    expect(out.note).toMatch(/B6\/C creds/);
    expect(out.note).toMatch(/Phase 2/);

    logSpy.mockRestore();
  });

  test("throws EXPEDIA_NOT_YET_ENABLED for provider='expedia' (DC-4 Phase 2 deferred)", async () => {
    const c = loadClient();
    let caught;
    try {
      await c.searchHotels({
        tenantId: 42,
        provider: 'expedia',
        destinationCity: 'London',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EXPEDIA_NOT_YET_ENABLED');
    expect(caught.message).toMatch(/Phase 2/);
    expect(caught.message).toMatch(/expedia/);
  });

  test('throws UNKNOWN_PROVIDER for unknown provider name', async () => {
    const c = loadClient();
    let caught;
    try {
      await c.searchHotels({
        tenantId: 42,
        provider: 'agoda', // not in PROVIDERS
        destinationCity: 'Bali',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('UNKNOWN_PROVIDER');
    expect(caught.message).toMatch(/Unknown provider: agoda/);
    expect(caught.message).toMatch(/Allowed: booking, expedia/);
  });

  test('throws BOOKING_EXPEDIA_BUDGET_EXCEEDED when stubbed spend exceeds cap', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Cap row: 5000 cents ($50, override below DEFAULT_CAP_CENTS).
    prismaMock.tenantSetting.findUnique.mockImplementation(({ where }) => {
      if (
        where &&
        where.tenantId_key &&
        where.tenantId_key.key === 'budgetCap_booking_expedia_monthly_usd_cents'
      ) {
        return Promise.resolve({ value: '5000' });
      }
      return Promise.resolve(null);
    });

    const c = loadClient();
    // Override computeMonthlySpendCents to return cap + 1 = 5001 cents
    // (over cap → evaluateCap.withinCap = false → throw). Spy works because
    // the SUT resolves the call via module.exports (CJS self-mocking seam
    // — 4th instance of this pattern).
    const spendSpy = vi
      .spyOn(c, 'computeMonthlySpendCents')
      .mockResolvedValue(5001);

    let caught;
    try {
      await c.searchHotels({
        tenantId: 7,
        provider: 'booking',
        destinationCity: 'Mecca',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('BOOKING_EXPEDIA_BUDGET_EXCEEDED');
    expect(caught.message).toMatch(/Monthly Booking\/Expedia hotel-inventory cap reached/);
    expect(caught.spentCents).toBe(5001);
    expect(caught.capCents).toBe(5000);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('throws when tenantId missing', async () => {
    const c = loadClient();
    await expect(
      c.searchHotels({
        provider: 'booking',
        destinationCity: 'Mecca',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      }),
    ).rejects.toThrow(/tenantId required/);
  });
});

describe('bookHotel', () => {
  test("happy path (provider='booking'): returns stub confirmation with provider + hotelId echo", async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.bookHotel({
      tenantId: 42,
      provider: 'booking',
      hotelId: 'hotel-mecca-clock-royal-tower',
      roomType: 'deluxe',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-07',
      guestNames: ['Khan, Imran', 'Khan, Sara'],
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
      provider: 'booking',
      bookingId: null,
      hotelId: 'hotel-mecca-clock-royal-tower',
      status: 'pending-cred-drop',
    });
    expect(out.note).toMatch(/B6\/C creds/);

    logSpy.mockRestore();
  });

  test("throws EXPEDIA_NOT_YET_ENABLED for provider='expedia'", async () => {
    const c = loadClient();
    await expect(
      c.bookHotel({
        tenantId: 42,
        provider: 'expedia',
        hotelId: 'h-london',
        roomType: 'std',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-03',
        guestNames: ['Smith, John'],
      }),
    ).rejects.toMatchObject({ code: 'EXPEDIA_NOT_YET_ENABLED' });
  });
});

describe('cancelBooking', () => {
  test("happy path (provider='booking'): returns stub envelope with bookingId + reason echo", async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.cancelBooking({
      tenantId: 42,
      provider: 'booking',
      bookingId: 'bkg-xyz789',
      reason: 'customer-requested',
    });

    expect(out).toMatchObject({
      stub: true,
      tenantId: 42,
      provider: 'booking',
      bookingId: 'bkg-xyz789',
      status: 'pending-cred-drop',
      reason: 'customer-requested',
    });
    expect(out.note).toMatch(/B6\/C creds/);

    logSpy.mockRestore();
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
        where.tenantId_key.key === 'budgetCap_booking_expedia_monthly_usd_cents'
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
    expect(warnMsgs).toMatch(/Booking\/Expedia/);

    spendSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('assertProviderEnabled', () => {
  test('returns undefined for booking; throws for expedia + unknown', () => {
    const c = loadClient();
    expect(c.assertProviderEnabled('booking')).toBeUndefined();
    expect(() => c.assertProviderEnabled('expedia')).toThrow(/Phase 2/);
    expect(() => c.assertProviderEnabled('agoda')).toThrow(/Unknown provider/);
  });
});
