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
// `prisma.tenantSetting.findUnique(...)` to read per-tenant cap rows; the
// S68 resolver (`getRatehawkCreds`) does `prisma.supplierCredential.findFirst`.
// Installed into Node's Module._cache the same way as the adsGptClient
// test (vitest's ESM-level vi.mock can't intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(null), // default → DEFAULTS fallback
    },
    supplierCredential: {
      findFirst: vi.fn().mockResolvedValue(null), // default → ENV fallback
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

// Hoisted fieldEncryption mock — `getRatehawkCreds` lazy-requires this to
// decrypt SupplierCredential.{loginIdEncrypted,passwordEncrypted}. We
// install a Module._cache shim so the decrypt() call inside the SUT
// returns a known plaintext per test. Same shape as the adsGptClient test.
const fieldEncryptionMock = vi.hoisted(() => {
  const mock = {
    decrypt: vi.fn((cipher) => {
      // Default behaviour: strip a known "ENC:" prefix if present, else
      // return the input verbatim. Per-test cases override via mockReturnValue.
      if (typeof cipher === 'string' && cipher.startsWith('ENC:')) {
        return cipher.slice(4);
      }
      return cipher;
    }),
    encrypt: vi.fn((plain) => `ENC:${plain}`),
    isEncrypted: vi.fn((s) => typeof s === 'string' && s.startsWith('ENC:')),
  };
  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const fePath = requireFromCwd.resolve('./lib/fieldEncryption');
  Module._cache[fePath] = {
    id: fePath,
    filename: fePath,
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
  prismaMock.supplierCredential.findFirst.mockReset();
  prismaMock.supplierCredential.findFirst.mockResolvedValue(null);
  fieldEncryptionMock.decrypt.mockReset();
  fieldEncryptionMock.decrypt.mockImplementation((cipher) => {
    if (typeof cipher === 'string' && cipher.startsWith('ENC:')) {
      return cipher.slice(4);
    }
    return cipher;
  });
  // Clean RATEHAWK_API_ID + RATEHAWK_API_KEY between tests so ENV-fallback
  // cases are deterministic.
  delete process.env.RATEHAWK_API_ID;
  delete process.env.RATEHAWK_API_KEY;
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
    expect(typeof c.getRatehawkCreds).toBe('function');
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

// ───────────────────────────────────────────────────────────────────────
// Extended coverage (tick #N — +8 cases)
//
// Surface area:
//   - Required-arg validation: searchHotels / bookHotel / cancelBooking all
//     reject when tenantId is falsy BEFORE any budget-cap query fires
//     (cheap fail-fast guard at the top of each handler).
//   - Optional-arg defaulting: bookHotel guestNames → [], cancelBooking
//     reason → null, searchHotels guests/rooms → 2/1 (PRD §3.1 defaults).
//   - Stub spend-stub: computeMonthlySpendCents returns 0 in stub mode
//     regardless of tenantId — pins the cred-blocked behaviour so the
//     real-mode swap target is unambiguous.
//   - CJS self-mocking seam: checkBudgetCap MUST call
//     computeMonthlySpendCents via module.exports indirection so the
//     spy in the test intercepts it. Pin the seam with a spy + once()
//     assertion — silent regression to local-closure binding would
//     re-break this client's testability (same class as the 2026-05-24
//     cron-learning across adsGpt/ratehawk/callified/safeEmitEvent).
// ───────────────────────────────────────────────────────────────────────

describe('searchHotels — argument validation + defaults', () => {
  test('throws when tenantId is missing BEFORE budget-cap query fires', async () => {
    const c = loadClient();
    await expect(
      c.searchHotels({
        destinationCity: 'Mecca',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      }),
    ).rejects.toThrow(/tenantId required/);
    // Fail-fast guard: cap query should NOT have been made.
    expect(prismaMock.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('throws when tenantId is 0 (falsy)', async () => {
    const c = loadClient();
    await expect(
      c.searchHotels({
        tenantId: 0,
        destinationCity: 'Madinah',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      }),
    ).rejects.toThrow(/tenantId required/);
    expect(prismaMock.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('happy path: guests + rooms default to 2 / 1 when omitted (PRD §3.1 defaults)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.searchHotels({
      tenantId: 5,
      destinationCity: 'Jeddah',
      checkInDate: '2026-09-01',
      checkOutDate: '2026-09-03',
      // guests + rooms intentionally omitted.
    });

    expect(out.query.guests).toBe(2);
    expect(out.query.rooms).toBe(1);
    expect(out.stub).toBe(true);
    expect(out.hotels).toEqual([]);

    logSpy.mockRestore();
  });
});

describe('bookHotel — argument validation + defaults', () => {
  test('throws when tenantId is missing BEFORE budget-cap query fires', async () => {
    const c = loadClient();
    await expect(
      c.bookHotel({
        hotelId: 'rh-hotel-12345',
        roomType: 'deluxe-double',
        checkInDate: '2026-08-01',
        checkOutDate: '2026-08-05',
      }),
    ).rejects.toThrow(/tenantId required/);
    expect(prismaMock.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('happy path: guestNames defaults to empty array when omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.bookHotel({
      tenantId: 11,
      hotelId: 'rh-hotel-77777',
      roomType: 'standard-twin',
      checkInDate: '2026-08-10',
      checkOutDate: '2026-08-12',
      // guestNames intentionally omitted.
    });

    expect(out.query.guestNames).toEqual([]);
    expect(out.stub).toBe(true);
    expect(out.status).toBe('pending-cred-drop');

    logSpy.mockRestore();
  });
});

describe('cancelBooking — argument validation + defaults', () => {
  test('throws when tenantId is missing BEFORE budget-cap query fires', async () => {
    const c = loadClient();
    await expect(
      c.cancelBooking({
        bookingId: 'rh-booking-67890',
        reason: 'Date change',
      }),
    ).rejects.toThrow(/tenantId required/);
    expect(prismaMock.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('reason defaults to null when omitted (envelope echoes null, not undefined)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const out = await c.cancelBooking({
      tenantId: 42,
      bookingId: 'rh-booking-99999',
      // reason intentionally omitted.
    });

    expect(out.reason).toBeNull();
    expect(out.bookingId).toBe('rh-booking-99999');
    expect(out.status).toBe('pending-cred-drop');

    logSpy.mockRestore();
  });
});

describe('computeMonthlySpendCents (stub mode)', () => {
  test('returns 0 regardless of tenantId (pin stub behaviour pending Q19 cred drop)', async () => {
    // Pin the stub returns 0 for ALL inputs. When the real RatehawkSearchLog
    // sum lands post-cred, this assertion will flip to "returns sum" and
    // future maintainers will see the swap point unambiguously.
    const c = loadClient();
    expect(await c.computeMonthlySpendCents(1)).toBe(0);
    expect(await c.computeMonthlySpendCents(42)).toBe(0);
    expect(await c.computeMonthlySpendCents(99999)).toBe(0);
    // Even falsy tenantId → 0 (stub is intentionally permissive).
    expect(await c.computeMonthlySpendCents(0)).toBe(0);
    expect(await c.computeMonthlySpendCents(null)).toBe(0);
  });
});

describe('checkBudgetCap — CJS self-mocking seam (regression pin)', () => {
  test('inter-function call goes through module.exports.computeMonthlySpendCents (spy intercepts)', async () => {
    // REGRESSION PIN for the CJS self-mocking seam pattern. The SUT MUST
    // call computeMonthlySpendCents via `module.exports.computeMonthlySpendCents(...)`
    // — NOT via the local closure binding — so that vi.spyOn(c, ...) can
    // intercept it. If a future refactor reverts to the local-binding form
    // (e.g. `const spentCents = await computeMonthlySpendCents(tenantId)`),
    // this test will fail because the spy will never be invoked AND the
    // mocked return value (12345) will be ignored.
    //
    // This is the same pattern documented in the 2026-05-24 cron-learning
    // across safeEmitEvent / adsGptClient / ratehawkClient / callifiedClient.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Cap row: 100000 cents ($1000 — way above the spy value to ensure
    // withinCap is true and the test isolates the seam, not the cap math).
    prismaMock.tenantSetting.findUnique.mockResolvedValueOnce({ value: '100000' });

    const c = loadClient();
    const spendSpy = vi.spyOn(c, 'computeMonthlySpendCents').mockResolvedValue(12345);

    const evaluation = await c.checkBudgetCap(7);

    // Seam pin: spy MUST have been called exactly once with the tenant arg.
    expect(spendSpy).toHaveBeenCalledTimes(1);
    expect(spendSpy).toHaveBeenCalledWith(7);
    // And the spy's return value MUST have flowed through to evaluateCap.
    expect(evaluation.spentCents).toBe(12345);
    expect(evaluation.capCents).toBe(100000);
    expect(evaluation.withinCap).toBe(true);

    spendSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ───────────────────────────────────────────────────────────────────────
// S68 — per-tenant SupplierCredential resolver (multi-field shape)
//
// Mirror of S67's getAdsGptKey resolver — but the resolver returns a
// multi-field object `{ keyId, apiKey }` instead of a single string,
// because RateHawk auths with BOTH the API ID (key-id, stored in
// loginIdEncrypted) AND the API key (stored in passwordEncrypted).
// Partial creds (only one field populated on either side) are treated as
// a miss because the upstream HTTP call would fail without both.
//
// Cases (8):
//   1. SupplierCredential row with both fields present → returns decrypted pair (wins over ENV)
//   2. SupplierCredential row with only loginIdEncrypted → falls back to ENV
//   3. SupplierCredential row with only passwordEncrypted → falls back to ENV
//   4. SupplierCredential absent + both ENVs present → returns ENV pair
//   5. SupplierCredential absent + only one ENV → returns null (incomplete is null, not partial)
//   6. Both absent → returns null (integration-disabled signal)
//   7. No tenantId → ENV-only (skips DB lookup)
//   8. Prisma lookup throws → logs + falls back to ENV (never throws)
// + decrypt-returns-falsy + model-unavailable + searchHotels-integration
// (CJS self-mocking seam pin) + null-creds-still-returns-stub-envelope.
// ───────────────────────────────────────────────────────────────────────

describe('getRatehawkCreds — per-tenant SupplierCredential resolver (S68)', () => {
  test('SupplierCredential row with both fields present → returns decrypted pair (wins over ENV)', async () => {
    // Operator has seeded a tenant-scoped row with the real creds encrypted.
    // ENV is also set to a different value to prove SupplierCredential wins.
    process.env.RATEHAWK_API_ID = 'env-only-key-id';
    process.env.RATEHAWK_API_KEY = 'env-only-api-key';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      loginIdEncrypted: 'ENC:tenant-scoped-key-id',
      passwordEncrypted: 'ENC:tenant-scoped-api-key',
    });

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toEqual({
      keyId: 'tenant-scoped-key-id',
      apiKey: 'tenant-scoped-api-key',
    });

    // Lookup MUST have been by (tenantId, category='ratehawk-cred') and
    // selected BOTH encrypted columns.
    expect(prismaMock.supplierCredential.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 42, category: 'ratehawk-cred' },
      select: { loginIdEncrypted: true, passwordEncrypted: true },
    });
    // Both columns must have been decrypted.
    expect(fieldEncryptionMock.decrypt).toHaveBeenCalledWith('ENC:tenant-scoped-key-id');
    expect(fieldEncryptionMock.decrypt).toHaveBeenCalledWith('ENC:tenant-scoped-api-key');
  });

  test('SupplierCredential row with only loginIdEncrypted → falls back to ENV pair', async () => {
    // Partial-row hazard: operator seeded the key-id but forgot the api-key
    // (e.g. UI bug or partial migration). Must NOT return half a cred.
    process.env.RATEHAWK_API_ID = 'env-key-id-fallback';
    process.env.RATEHAWK_API_KEY = 'env-api-key-fallback';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      loginIdEncrypted: 'ENC:tenant-key-id',
      passwordEncrypted: null,
    });

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toEqual({
      keyId: 'env-key-id-fallback',
      apiKey: 'env-api-key-fallback',
    });
    // The partial row's loginIdEncrypted must NOT have been decrypted —
    // truthiness guard fires before decrypt() runs.
    expect(fieldEncryptionMock.decrypt).not.toHaveBeenCalled();
  });

  test('SupplierCredential row with only passwordEncrypted → falls back to ENV pair', async () => {
    process.env.RATEHAWK_API_ID = 'env-key-id-fallback';
    process.env.RATEHAWK_API_KEY = 'env-api-key-fallback';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      loginIdEncrypted: null,
      passwordEncrypted: 'ENC:tenant-api-key',
    });

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toEqual({
      keyId: 'env-key-id-fallback',
      apiKey: 'env-api-key-fallback',
    });
    expect(fieldEncryptionMock.decrypt).not.toHaveBeenCalled();
  });

  test('SupplierCredential absent + both ENVs present → returns ENV pair', async () => {
    process.env.RATEHAWK_API_ID = 'env-pair-key-id';
    process.env.RATEHAWK_API_KEY = 'env-pair-api-key';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce(null);

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toEqual({
      keyId: 'env-pair-key-id',
      apiKey: 'env-pair-api-key',
    });
    // Lookup was attempted before the ENV fallback fired.
    expect(prismaMock.supplierCredential.findFirst).toHaveBeenCalledTimes(1);
  });

  test('SupplierCredential absent + only one ENV present → returns null (incomplete is not partial)', async () => {
    // The "incomplete cred is null, not partial" contract: if ENV has only
    // one of the two vars set, do NOT return `{ keyId, apiKey: null }` —
    // the upstream HTTP call needs BOTH or nothing.
    process.env.RATEHAWK_API_ID = 'env-only-key-id';
    delete process.env.RATEHAWK_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce(null);

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toBeNull();
  });

  test('SupplierCredential absent + ENV absent → returns null (integration disabled signal)', async () => {
    // Pre-cred-drop production state: no row seeded, no env-vars set.
    // getRatehawkCreds returns null. Future searchHotels (post-stub) will
    // branch on this and throw RATEHAWK_NOT_YET_ENABLED.
    delete process.env.RATEHAWK_API_ID;
    delete process.env.RATEHAWK_API_KEY;
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce(null);

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toBeNull();
  });

  test('no tenantId + both ENVs present → returns ENV pair without DB hit', async () => {
    process.env.RATEHAWK_API_ID = 'env-only-key-id';
    process.env.RATEHAWK_API_KEY = 'env-only-api-key';

    const c = loadClient();
    const creds = await c.getRatehawkCreds();
    expect(creds).toEqual({
      keyId: 'env-only-key-id',
      apiKey: 'env-only-api-key',
    });
    // Critical: NO DB hit when tenantId is missing. Saves a round-trip on
    // sync probes (matches getLlmKey / getAdsGptKey behaviour).
    expect(prismaMock.supplierCredential.findFirst).not.toHaveBeenCalled();
  });

  test('no tenantId + no ENV → returns null without DB hit', async () => {
    delete process.env.RATEHAWK_API_ID;
    delete process.env.RATEHAWK_API_KEY;

    const c = loadClient();
    const creds = await c.getRatehawkCreds();
    expect(creds).toBeNull();
    expect(prismaMock.supplierCredential.findFirst).not.toHaveBeenCalled();
  });

  test('Prisma lookup throws → logs error + falls back to ENV (never throws out)', async () => {
    // Best-effort discipline: a transient DB error must NOT crash the
    // caller; falls through to ENV. Matches getAdsGptKey semantics.
    process.env.RATEHAWK_API_ID = 'env-after-error-key-id';
    process.env.RATEHAWK_API_KEY = 'env-after-error-api-key';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.supplierCredential.findFirst.mockRejectedValueOnce(
      new Error('connection reset'),
    );

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toEqual({
      keyId: 'env-after-error-key-id',
      apiKey: 'env-after-error-api-key',
    });

    const errMsgs = errSpy.mock.calls.flat().map(String).join(' ');
    expect(errMsgs).toMatch(/\[ratehawkClient\] getRatehawkCreds/);
    expect(errMsgs).toMatch(/connection reset/);
    expect(errMsgs).toMatch(/non-fatal/);

    errSpy.mockRestore();
  });

  test('decrypt returns falsy for either field → falls back to ENV', async () => {
    // Corrupt/legacy SupplierCredential row where decrypt fails (e.g.
    // WELLNESS_FIELD_KEY rotated). Must NOT surface garbage to caller;
    // falls back to ENV. Pinned on the api-key field; same guard fires
    // when the key-id decrypt returns falsy.
    process.env.RATEHAWK_API_ID = 'env-after-decrypt-fail-key-id';
    process.env.RATEHAWK_API_KEY = 'env-after-decrypt-fail-api-key';
    prismaMock.supplierCredential.findFirst.mockResolvedValueOnce({
      loginIdEncrypted: 'ENC:tenant-key-id',
      passwordEncrypted: 'ENC:bogus',
    });
    // First decrypt (loginId) returns plaintext; second (password) returns null.
    fieldEncryptionMock.decrypt
      .mockReturnValueOnce('tenant-key-id')
      .mockReturnValueOnce(null);

    const c = loadClient();
    const creds = await c.getRatehawkCreds(42);
    expect(creds).toEqual({
      keyId: 'env-after-decrypt-fail-key-id',
      apiKey: 'env-after-decrypt-fail-api-key',
    });
  });

  test('prisma.supplierCredential model unavailable → ENV fallback without throwing', async () => {
    // Test-harness scenario or partial Prisma client: the model isn't
    // registered. Module must NOT throw; falls back to ENV pair.
    process.env.RATEHAWK_API_ID = 'env-no-model-key-id';
    process.env.RATEHAWK_API_KEY = 'env-no-model-api-key';
    const Module = require('node:module');
    const requireFromCwd = Module.createRequire(process.cwd() + '/');
    const prismaLibPath = requireFromCwd.resolve('./lib/prisma');
    const saved = Module._cache[prismaLibPath].exports.supplierCredential;
    // Simulate the model being absent for this test only.
    Module._cache[prismaLibPath].exports.supplierCredential = undefined;

    try {
      const c = loadClient();
      const creds = await c.getRatehawkCreds(42);
      expect(creds).toEqual({
        keyId: 'env-no-model-key-id',
        apiKey: 'env-no-model-api-key',
      });
    } finally {
      Module._cache[prismaLibPath].exports.supplierCredential = saved;
    }
  });
});

describe('searchHotels / bookHotel / cancelBooking — getRatehawkCreds integration', () => {
  // Post-S68 contract: each handler calls module.exports.getRatehawkCreds
  // exactly once with the request's tenantId. The CJS self-mocking seam
  // is critical — future post-cred swap-in will replace `void creds` with
  // a real fetch() using the resolved `{ keyId, apiKey }`; downstream
  // tests must be able to spy on the resolver to control that fetch path.

  test('CJS self-mocking seam: searchHotels calls getRatehawkCreds via module.exports indirection (regression-pin)', async () => {
    // Mirrors the computeMonthlySpendCents seam regression test above. If a
    // future refactor switches back to a local-name call, this test reds —
    // protecting the post-cred swap-in.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const credsSpy = vi.spyOn(c, 'getRatehawkCreds').mockResolvedValue({
      keyId: 'spied-key-id',
      apiKey: 'spied-api-key',
    });

    await c.searchHotels({
      tenantId: 91,
      destinationCity: 'Mecca',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-05',
    });

    expect(credsSpy).toHaveBeenCalledTimes(1);
    expect(credsSpy).toHaveBeenCalledWith(91);

    credsSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('CJS self-mocking seam: bookHotel calls getRatehawkCreds via module.exports indirection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const credsSpy = vi.spyOn(c, 'getRatehawkCreds').mockResolvedValue({
      keyId: 'spied-key-id',
      apiKey: 'spied-api-key',
    });

    await c.bookHotel({
      tenantId: 73,
      hotelId: 'rh-hotel-abc',
      roomType: 'standard',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-05',
    });

    expect(credsSpy).toHaveBeenCalledTimes(1);
    expect(credsSpy).toHaveBeenCalledWith(73);

    credsSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('CJS self-mocking seam: cancelBooking calls getRatehawkCreds via module.exports indirection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const credsSpy = vi.spyOn(c, 'getRatehawkCreds').mockResolvedValue({
      keyId: 'spied-key-id',
      apiKey: 'spied-api-key',
    });

    await c.cancelBooking({
      tenantId: 73,
      bookingId: 'rh-booking-xyz',
    });

    expect(credsSpy).toHaveBeenCalledTimes(1);
    expect(credsSpy).toHaveBeenCalledWith(73);

    credsSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('null-creds path: searchHotels still returns the stub envelope (no integration enabled yet)', async () => {
    // Stub-mode contract: even when getRatehawkCreds returns null (pre-cred
    // production), searchHotels returns the canned envelope. Downstream UI
    // keeps rendering the "integration pending" message. Post-cred
    // implementation will branch on null and throw RATEHAWK_NOT_YET_ENABLED.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const c = loadClient();
    const credsSpy = vi.spyOn(c, 'getRatehawkCreds').mockResolvedValue(null);

    const out = await c.searchHotels({
      tenantId: 73,
      destinationCity: 'Mecca',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-05',
    });

    expect(out.stub).toBe(true);
    expect(out.note).toMatch(/Q19 creds/);
    expect(credsSpy).toHaveBeenCalledTimes(1);

    credsSpy.mockRestore();
    logSpy.mockRestore();
  });
});
