// Unit tests for backend/lib/tenantSettings.js
//   (Phase 2 PRD §4.7 + 2026-05-24 product-call budget-cap pattern).
//
// Two cohorts of tests:
//
// 1) PRD §4.7 originals — `getTenantSetting` / `getTravelAdvanceRatio`
//    accept `prisma` as a parameter, so these tests pass a synthetic
//    mock object directly.
//
// 2) 2026-05-24 budget-cap helpers — `getSetting` / `setSetting` /
//    `getBudgetCap` / `evaluateCap` use the imported prisma singleton.
//    Mirroring backend/test/lib/eventBus.test.js's pattern, we
//    monkey-patch model methods on the imported singleton inside
//    beforeAll/beforeEach — vitest.config.js inlines `backend/lib/`
//    so the SUT and test see the same patched object.
//
// What's covered:
//   1. getTenantSetting — happy path (row found), miss (fallback used),
//      missing tenantId/key bail-out, undefined fallback path.
//   2. getTravelAdvanceRatio — sub-brand-scoped key wins, falls back to
//      tenant default, falls back to 0.5 hard-coded when neither set.
//   3. Bounds-check defence — negative / >1 / NaN / non-numeric values
//      are REJECTED at each layer, so a fat-fingered admin setting
//      doesn't poison the booking flow. Falls through to the next
//      layer (sub-brand bad → tenant default; tenant default bad →
//      hard-coded 0.5) rather than returning the bad value.
//   4. getSetting (singleton) — DEFAULTS used when no row; stored
//      value used when row exists; explicit fallback override; coerce
//      function applied.
//   5. setSetting — upsert shape matches @@unique([tenantId, key]).
//   6. getBudgetCap — returns DEFAULTS for each known integration when
//      no row exists; rejects unknown integration name.
//   7. evaluateCap — boundary cases (0, 80%, cap, over).

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import singletonPrisma from '../../lib/prisma.js';
import {
  getTenantSetting,
  getTravelAdvanceRatio,
  KEYS,
  DEFAULTS,
  getSetting,
  setSetting,
  getBudgetCap,
  evaluateCap,
} from '../../lib/tenantSettings.js';

// Synthetic mock for the prisma-as-arg helpers (PRD §4.7 originals) —
// only the surface the helper actually touches.
let prisma;

beforeEach(() => {
  prisma = {
    tenantSetting: {
      findUnique: vi.fn(),
    },
  };
});

describe('tenantSettings — getTenantSetting', () => {
  test('returns the row value when present', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: '0.3' });
    const out = await getTenantSetting(prisma, 1, 'travel.advanceRatio.rfu', 'def');
    expect(out).toBe('0.3');
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: 'travel.advanceRatio.rfu' } },
      select: { value: true },
    });
  });

  test('returns supplied fallback when row missing', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTenantSetting(prisma, 1, 'travel.advanceRatio.rfu', 'fallback-val');
    expect(out).toBe('fallback-val');
  });

  test('default fallback is null when caller omits it', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTenantSetting(prisma, 1, 'k');
    expect(out).toBeNull();
  });

  test('returns fallback immediately when tenantId missing (no prisma call)', async () => {
    const out = await getTenantSetting(prisma, null, 'k', 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('returns fallback immediately when tenantId is 0', async () => {
    const out = await getTenantSetting(prisma, 0, 'k', 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('returns fallback immediately when key missing (no prisma call)', async () => {
    const out = await getTenantSetting(prisma, 1, '', 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('returns fallback immediately when key is null', async () => {
    const out = await getTenantSetting(prisma, 1, null, 'def');
    expect(out).toBe('def');
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });
});

describe('tenantSettings — getTravelAdvanceRatio (PRD §4.7)', () => {
  test('sub-brand-scoped key wins over tenant default + hard-coded', async () => {
    // First lookup: sub-brand key returns 0.3 → used immediately.
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '0.3' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.3);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: 'travel.advanceRatio.rfu' } },
      select: { value: true },
    });
  });

  test('falls back to tenant default when sub-brand key absent', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce(null) // travel.advanceRatio.rfu missing
      .mockResolvedValueOnce({ value: '0.4' }); // travel.advanceRatio.default
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.4);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.tenantSetting.findUnique.mock.calls[1][0]).toEqual({
      where: { tenantId_key: { tenantId: 1, key: 'travel.advanceRatio.default' } },
      select: { value: true },
    });
  });

  test('falls back to 0.5 when neither sub-brand nor tenant default set', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTravelAdvanceRatio(prisma, 1, 'travelstall');
    expect(out).toBe(0.5);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  test('falls back to 0.5 when subBrand missing — only checks tenant default', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValue(null);
    const out = await getTravelAdvanceRatio(prisma, 1, null);
    expect(out).toBe(0.5);
    // Sub-brand lookup is skipped entirely when subBrand is falsy.
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenantSetting.findUnique.mock.calls[0][0].where.tenantId_key.key)
      .toBe('travel.advanceRatio.default');
  });

  test('falls back to 0.5 when tenantId missing (helper short-circuits)', async () => {
    const out = await getTravelAdvanceRatio(prisma, null, 'rfu');
    expect(out).toBe(0.5);
    expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });

  test('rejects negative sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '-0.1' })
      .mockResolvedValueOnce({ value: '0.7' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.7);
  });

  test('rejects zero sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '0' })
      .mockResolvedValueOnce({ value: '0.6' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.6);
  });

  test('rejects >1 sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '1.5' })
      .mockResolvedValueOnce({ value: '0.45' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.45);
  });

  test('rejects non-numeric sub-brand value → falls through to default', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: 'half' })
      .mockResolvedValueOnce({ value: '0.5' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.5);
  });

  test('rejects bad value at BOTH layers → falls all the way to 0.5', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '-1' })
      .mockResolvedValueOnce({ value: 'NaN' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.5);
  });

  test('accepts boundary 1.0 (full advance — pay-upfront subbrands)', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '1' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'visasure');
    expect(out).toBe(1);
  });

  test('rejects ratio at strict-zero boundary (must be >0)', async () => {
    prisma.tenantSetting.findUnique
      .mockResolvedValueOnce({ value: '0' })
      .mockResolvedValueOnce(null);
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.5);
  });

  test('accepts a small ratio like 0.1', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '0.1' });
    const out = await getTravelAdvanceRatio(prisma, 1, 'rfu');
    expect(out).toBe(0.1);
  });
});

// ─── 2026-05-24 budget-cap helpers (singleton-patch pattern) ─────────
// These helpers use the imported prisma singleton (not prisma-as-arg).
// We monkey-patch tenantSetting on the imported singleton — vitest.config
// inlines `backend/lib/` so the SUT sees the same patched object. Pattern
// mirrors backend/test/lib/eventBus.test.js.

beforeAll(() => {
  singletonPrisma.tenantSetting = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  };
});

beforeEach(() => {
  singletonPrisma.tenantSetting.findUnique.mockReset().mockResolvedValue(null);
  singletonPrisma.tenantSetting.upsert.mockReset().mockResolvedValue({
    id: 1, tenantId: 1, key: 'x', value: 'y', category: null,
  });
});

describe('budget-cap helpers — KEYS + DEFAULTS shape', () => {
  test('KEYS exposes all canonical integration keys (4 base + booking_expedia)', () => {
    expect(KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS).toBe('budgetCap_adsgpt_monthly_usd_cents');
    expect(KEYS.AI_CALLING_MONTHLY_CAP_USD_CENTS).toBe('budgetCap_ai_calling_monthly_usd_cents');
    expect(KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS).toBe('budgetCap_ratehawk_monthly_usd_cents');
    expect(KEYS.LLM_MONTHLY_CAP_USD_CENTS).toBe('budgetCap_llm_monthly_usd_cents');
    // Tick #101: booking_expedia added so bookingExpediaClient can drop
    // its getSetting() workaround in favour of canonical getBudgetCap().
    expect(KEYS.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS).toBe('budgetCap_booking_expedia_monthly_usd_cents');
  });

  test('DEFAULTS map covers every KEYS entry', () => {
    for (const k of Object.values(KEYS)) {
      expect(DEFAULTS).toHaveProperty(k);
      expect(typeof DEFAULTS[k]).toBe('number');
      expect(Number.isFinite(DEFAULTS[k])).toBe(true);
    }
  });

  test('DEFAULTS env-fallback values match product-call resolution', () => {
    // $50 = 5000 cents, $100 = 10000 cents per the 2026-05-24 product-call.
    // These ALWAYS hold when env vars are unset; if a future env override
    // moves them this test will alert.
    if (process.env.ADSGPT_MONTHLY_CAP_USD_CENTS == null) {
      expect(DEFAULTS[KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS]).toBe(5000);
    }
    if (process.env.AI_CALLING_MONTHLY_CAP_USD_CENTS == null) {
      expect(DEFAULTS[KEYS.AI_CALLING_MONTHLY_CAP_USD_CENTS]).toBe(10000);
    }
    if (process.env.RATEHAWK_MONTHLY_CAP_USD_CENTS == null) {
      expect(DEFAULTS[KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS]).toBe(5000);
    }
    if (process.env.LLM_MONTHLY_CAP_USD_CENTS == null) {
      expect(DEFAULTS[KEYS.LLM_MONTHLY_CAP_USD_CENTS]).toBe(10000);
    }
    if (process.env.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS == null) {
      expect(DEFAULTS[KEYS.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS]).toBe(10000);
    }
  });
});

describe('budget-cap helpers — getSetting (singleton)', () => {
  test('returns the DEFAULT value when no TenantSetting row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getSetting(1, KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS);
    expect(out).toBe(DEFAULTS[KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS]);
  });

  test('returns the STORED value when a TenantSetting row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '7500' });
    const out = await getSetting(1, KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS);
    expect(out).toBe(7500);
    expect(singletonPrisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS } },
      select: { value: true },
    });
  });

  test('coerce: Number turns "7500" into the number 7500', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '7500' });
    const out = await getSetting(1, KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS, { coerce: Number });
    expect(out).toBe(7500);
    expect(typeof out).toBe('number');
  });

  test('coerce: identity returns the raw string', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: 'on' });
    const out = await getSetting(1, 'somekey', { coerce: (x) => x, fallback: 'off' });
    expect(out).toBe('on');
  });

  test('coerce: JSON.parse returns a parsed object', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '{"a":1}' });
    const out = await getSetting(1, 'jsonkey', { coerce: JSON.parse, fallback: {} });
    expect(out).toEqual({ a: 1 });
  });

  test('explicit fallback overrides the DEFAULTS map', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getSetting(1, KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS, { fallback: 999 });
    expect(out).toBe(999);
  });

  test('returns null when no row, no fallback, and key not in DEFAULTS', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getSetting(1, 'unknown.key');
    expect(out).toBeNull();
  });

  test('short-circuits when tenantId missing — no DB call', async () => {
    const out = await getSetting(null, KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS);
    expect(out).toBe(DEFAULTS[KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS]);
    expect(singletonPrisma.tenantSetting.findUnique).not.toHaveBeenCalled();
  });
});

describe('budget-cap helpers — setSetting (upsert)', () => {
  test('upserts a row with the unique-by-tenantId-and-key where clause', async () => {
    await setSetting(1, KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS, 7500, { category: 'budget' });
    expect(singletonPrisma.tenantSetting.upsert).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 1, key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS } },
      create: {
        tenantId: 1,
        key: KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS,
        value: '7500',
        category: 'budget',
      },
      update: { value: '7500', category: 'budget' },
    });
  });

  test('coerces numeric value to string for storage (matches DB schema)', async () => {
    await setSetting(1, 'k', 42);
    const args = singletonPrisma.tenantSetting.upsert.mock.calls[0][0];
    expect(args.create.value).toBe('42');
    expect(args.update.value).toBe('42');
  });

  test('category defaults to null when not provided', async () => {
    await setSetting(1, 'k', 'v');
    const args = singletonPrisma.tenantSetting.upsert.mock.calls[0][0];
    expect(args.create.category).toBeNull();
    expect(args.update.category).toBeNull();
  });

  test('throws when tenantId missing', async () => {
    await expect(setSetting(null, 'k', 'v')).rejects.toThrow(/tenantId/);
  });

  test('throws when key missing', async () => {
    await expect(setSetting(1, '', 'v')).rejects.toThrow(/key/);
  });
});

describe('budget-cap helpers — getBudgetCap', () => {
  test('returns the DEFAULTS $50 cap for adsgpt when no row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getBudgetCap(1, 'adsgpt');
    expect(out).toBe(DEFAULTS[KEYS.ADSGPT_MONTHLY_CAP_USD_CENTS]);
  });

  test('returns the DEFAULTS $100 cap for ai_calling when no row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getBudgetCap(1, 'ai_calling');
    expect(out).toBe(DEFAULTS[KEYS.AI_CALLING_MONTHLY_CAP_USD_CENTS]);
  });

  test('returns the DEFAULTS $50 cap for ratehawk when no row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getBudgetCap(1, 'ratehawk');
    expect(out).toBe(DEFAULTS[KEYS.RATEHAWK_MONTHLY_CAP_USD_CENTS]);
  });

  test('returns the per-tenant override when a row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '7777' });
    const out = await getBudgetCap(1, 'adsgpt');
    expect(out).toBe(7777);
  });

  test('returns the DEFAULTS $100 cap for booking_expedia when no row exists', async () => {
    // Regression guard for tick #101 — KEYS extension lets bookingExpediaClient
    // drop its getSetting() workaround in favour of getBudgetCap('booking_expedia').
    // Pre-extension this call would have thrown 'Unknown integration'.
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const out = await getBudgetCap(1, 'booking_expedia');
    expect(out).toBe(DEFAULTS[KEYS.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS]);
  });

  test('returns the per-tenant override for booking_expedia when a row exists', async () => {
    singletonPrisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: '12345' });
    const out = await getBudgetCap(1, 'booking_expedia');
    expect(out).toBe(12345);
  });

  test('throws on unknown integration name', async () => {
    await expect(getBudgetCap(1, 'not-a-real-integration')).rejects.toThrow(
      /Unknown integration/,
    );
  });

  test('throw-on-unknown path still works after booking_expedia addition (regression guard)', async () => {
    // Adding a 5th KEYS entry must not weaken the throw-on-unknown contract —
    // unknown names still throw, only the 5 canonical names are accepted.
    await expect(getBudgetCap(1, 'expedia')).rejects.toThrow(/Unknown integration/);
    await expect(getBudgetCap(1, 'booking')).rejects.toThrow(/Unknown integration/);
    await expect(getBudgetCap(1, 'BOOKING_EXPEDIA')).rejects.toThrow(/Unknown integration/);
  });
});

describe('budget-cap helpers — evaluateCap', () => {
  test('spent=0 → withinCap true, alertThreshold false', () => {
    const r = evaluateCap(0, 5000);
    expect(r.spentCents).toBe(0);
    expect(r.capCents).toBe(5000);
    expect(r.percent).toBe(0);
    expect(r.withinCap).toBe(true);
    expect(r.alertThreshold).toBe(false);
  });

  test('spent=50% → withinCap true, alertThreshold false', () => {
    const r = evaluateCap(2500, 5000);
    expect(r.percent).toBe(0.5);
    expect(r.withinCap).toBe(true);
    expect(r.alertThreshold).toBe(false);
  });

  test('spent=80% → withinCap true, alertThreshold true (boundary)', () => {
    const r = evaluateCap(4000, 5000);
    expect(r.percent).toBe(0.8);
    expect(r.withinCap).toBe(true);
    expect(r.alertThreshold).toBe(true);
  });

  test('spent=79.99% → alertThreshold false (just under boundary)', () => {
    const r = evaluateCap(3999, 5000);
    expect(r.percent).toBeCloseTo(0.7998, 4);
    expect(r.withinCap).toBe(true);
    expect(r.alertThreshold).toBe(false);
  });

  test('spent=cap → withinCap false (strict — at-cap blocks), alertThreshold true', () => {
    const r = evaluateCap(5000, 5000);
    expect(r.percent).toBe(1);
    expect(r.withinCap).toBe(false);
    expect(r.alertThreshold).toBe(true);
  });

  test('spent>cap → withinCap false, alertThreshold true', () => {
    const r = evaluateCap(6000, 5000);
    expect(r.percent).toBe(1.2);
    expect(r.withinCap).toBe(false);
    expect(r.alertThreshold).toBe(true);
  });

  test('cap=0 → treated as no-spend-allowed (defensive)', () => {
    const r = evaluateCap(100, 0);
    expect(r.percent).toBe(1);
    expect(r.withinCap).toBe(false);
    expect(r.alertThreshold).toBe(true);
  });

  test('cap=negative → treated as no-spend-allowed (defensive)', () => {
    const r = evaluateCap(100, -50);
    expect(r.withinCap).toBe(false);
  });

  test('non-numeric inputs coerce to 0', () => {
    const r = evaluateCap('not-a-number', 'nope');
    expect(r.spentCents).toBe(0);
    expect(r.capCents).toBe(0);
    expect(r.withinCap).toBe(false);
  });
});
