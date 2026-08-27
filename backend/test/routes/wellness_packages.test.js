// @ts-check
/**
 * Tests for the validation + pricing helpers in routes/wellness_packages.js.
 *
 * The load-bearing property of a package is that its PRICE IS A SNAPSHOT: a
 * bundled service being repriced or retired later must not retroactively
 * change what a customer was quoted. That is why `grossPrice`/`price` are
 * stored and only recomputed on an explicit bundle/sessions/discount change —
 * and why the read path never derives them.
 *
 * These tests pin the input validation that guards that stored value.
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  parseServiceIds,
  normalizePackageBody,
  saleBlockReason,
  priceBreakdown,
  planRequestBlockReason,
  alreadyHeldBlockReason,
  validatePreferredRequestDate,
  validateAcceptSlot,
} = requireCJS('../../routes/wellness_packages');

describe('parseServiceIds', () => {
  test('reads the stored JSON id array', () => {
    expect(parseServiceIds('[10,11]')).toEqual([10, 11]);
  });

  test('coerces numeric strings, which is how a form post arrives', () => {
    expect(parseServiceIds('["10","11"]')).toEqual([10, 11]);
  });

  test('survives corrupt or empty stored values instead of throwing', () => {
    // A package row that fails to parse must render as "no services", never
    // take down the whole list endpoint.
    expect(parseServiceIds('not json')).toEqual([]);
    expect(parseServiceIds('')).toEqual([]);
    expect(parseServiceIds(null)).toEqual([]);
    expect(parseServiceIds('{"a":1}')).toEqual([]);
  });

  test('drops non-numeric entries rather than emitting NaN ids', () => {
    expect(parseServiceIds('[10,"abc",null,12]')).toEqual([10, 12]);
  });
});

describe('normalizePackageBody — create', () => {
  const valid = { name: 'Glow Bundle', serviceIds: [10, 11], sessions: 6, discountPercent: 15 };

  test('accepts a well-formed package', () => {
    const { error, data } = normalizePackageBody(valid);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      name: 'Glow Bundle',
      serviceIds: [10, 11],
      sessions: 6,
      discountPercent: 15,
    });
  });

  test('requires a name', () => {
    expect(normalizePackageBody({ ...valid, name: '   ' }).error?.body.code).toBe('MISSING_NAME');
    expect(normalizePackageBody({ ...valid, name: undefined }).error?.body.code).toBe('MISSING_NAME');
  });

  test('requires at least one service — an empty bundle has no meaning', () => {
    expect(normalizePackageBody({ ...valid, serviceIds: [] }).error?.body.code).toBe('NO_SERVICES');
    expect(normalizePackageBody({ ...valid, serviceIds: 'nope' }).error?.body.code).toBe('NO_SERVICES');
  });

  test('de-duplicates service ids so a service cannot be double-charged', () => {
    const { data } = normalizePackageBody({ ...valid, serviceIds: [10, 10, 11] });
    expect(data.serviceIds).toEqual([10, 11]);
  });

  test('rejects an absurd bundle size', () => {
    const many = Array.from({ length: 26 }, (_, i) => i + 1);
    expect(normalizePackageBody({ ...valid, serviceIds: many }).error?.body.code).toBe('TOO_MANY_SERVICES');
  });

  test('bounds the session count', () => {
    expect(normalizePackageBody({ ...valid, sessions: 0 }).error?.body.code).toBe('INVALID_SESSIONS');
    expect(normalizePackageBody({ ...valid, sessions: 61 }).error?.body.code).toBe('INVALID_SESSIONS');
    expect(normalizePackageBody({ ...valid, sessions: 'six' }).error?.body.code).toBe('INVALID_SESSIONS');
    expect(normalizePackageBody({ ...valid, sessions: 60 }).error).toBeUndefined();
  });

  test('bounds the discount to 0-100 — a negative discount would raise the price', () => {
    expect(normalizePackageBody({ ...valid, discountPercent: -1 }).error?.body.code).toBe('INVALID_DISCOUNT');
    expect(normalizePackageBody({ ...valid, discountPercent: 101 }).error?.body.code).toBe('INVALID_DISCOUNT');
    expect(normalizePackageBody({ ...valid, discountPercent: 0 }).error).toBeUndefined();
    expect(normalizePackageBody({ ...valid, discountPercent: 100 }).error).toBeUndefined();
  });

  test('a package is never public by omission — publishing is deliberate', () => {
    const { data } = normalizePackageBody(valid);
    expect(data.isPublic).toBeUndefined(); // route defaults this to false
  });

  test('normalizes visibility flags to real booleans', () => {
    const { data } = normalizePackageBody({ ...valid, isPublic: 'yes', isActive: 0 });
    expect(data.isPublic).toBe(true);
    expect(data.isActive).toBe(false);
  });
});

describe('normalizePackageBody — tax, validity and sell-by', () => {
  const valid = { name: 'Glow Bundle', serviceIds: [10, 11], sessions: 6, discountPercent: 15 };

  test('all three are optional — a package without them is still valid', () => {
    const { error, data } = normalizePackageBody(valid);
    expect(error).toBeUndefined();
    expect(data.taxPercent).toBeUndefined();   // route defaults to 0
    expect(data.validityDays).toBeUndefined(); // route defaults to null
    expect(data.sellByDate).toBeUndefined();
  });

  test('accepts the slabs the builder offers', () => {
    for (const tax of [0, 5, 18]) {
      const { error, data } = normalizePackageBody({ ...valid, taxPercent: tax });
      expect(error).toBeUndefined();
      expect(data.taxPercent).toBe(tax);
    }
  });

  test('bounds the tax rate — a negative rate would refund the government', () => {
    expect(normalizePackageBody({ ...valid, taxPercent: -1 }).error?.body.code).toBe('INVALID_TAX');
    expect(normalizePackageBody({ ...valid, taxPercent: 101 }).error?.body.code).toBe('INVALID_TAX');
    expect(normalizePackageBody({ ...valid, taxPercent: 'GST' }).error?.body.code).toBe('INVALID_TAX');
  });

  test('an explicitly cleared tax reads as no tax, not as "unchanged"', () => {
    expect(normalizePackageBody({ ...valid, taxPercent: '' }).data.taxPercent).toBe(0);
    expect(normalizePackageBody({ ...valid, taxPercent: null }).data.taxPercent).toBe(0);
  });

  test('validity accepts the preset day counts and clears to null', () => {
    for (const days of [1, 7, 14, 30, 180, 365]) {
      expect(normalizePackageBody({ ...valid, validityDays: days }).data.validityDays).toBe(days);
    }
    expect(normalizePackageBody({ ...valid, validityDays: '' }).data.validityDays).toBeNull();
    expect(normalizePackageBody({ ...valid, validityDays: null }).data.validityDays).toBeNull();
  });

  test('rejects a validity that is zero, fractional or absurd', () => {
    expect(normalizePackageBody({ ...valid, validityDays: 0 }).error?.body.code).toBe('INVALID_VALIDITY');
    expect(normalizePackageBody({ ...valid, validityDays: 1.5 }).error?.body.code).toBe('INVALID_VALIDITY');
    expect(normalizePackageBody({ ...valid, validityDays: 3651 }).error?.body.code).toBe('INVALID_VALIDITY');
    expect(normalizePackageBody({ ...valid, validityDays: 'forever' }).error?.body.code).toBe('INVALID_VALIDITY');
  });

  test('sell-by parses a date input and clears to null', () => {
    const { error, data } = normalizePackageBody({ ...valid, sellByDate: '2026-12-31' });
    expect(error).toBeUndefined();
    expect(data.sellByDate).toBeInstanceOf(Date);
    expect(data.sellByDate.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(normalizePackageBody({ ...valid, sellByDate: '' }).data.sellByDate).toBeNull();
  });

  test('rejects an unparseable sell-by date', () => {
    expect(normalizePackageBody({ ...valid, sellByDate: 'next winter' }).error?.body.code).toBe('INVALID_SELL_BY');
  });

  test('a past sell-by date is allowed — a closed season is a real thing to record', () => {
    expect(normalizePackageBody({ ...valid, sellByDate: '2020-01-01' }).error).toBeUndefined();
  });

  test('they patch independently of pricing', () => {
    // Same property as the visibility-only patch: changing the GST slab must
    // not drag the bundle through a reprice at today's service prices.
    const { data } = normalizePackageBody({ taxPercent: 18 }, { partial: true });
    expect(data).toEqual({ taxPercent: 18 });
  });
});

describe('normalizePackageBody — partial update', () => {
  test('a visibility-only patch carries no pricing fields', () => {
    // This is what stops "Publish" silently re-pricing a package at today's
    // service prices: with no bundle/sessions/discount in the patch, the route
    // skips repricing entirely.
    const { error, data } = normalizePackageBody({ isPublic: true }, { partial: true });
    expect(error).toBeUndefined();
    expect(data).toEqual({ isPublic: true });
    expect(data.serviceIds).toBeUndefined();
    expect(data.sessions).toBeUndefined();
    expect(data.discountPercent).toBeUndefined();
  });

  test('omitted fields are not required on a partial update', () => {
    expect(normalizePackageBody({ name: 'Renamed' }, { partial: true }).error).toBeUndefined();
  });

  test('still validates the fields that ARE present', () => {
    expect(normalizePackageBody({ sessions: 999 }, { partial: true }).error?.body.code).toBe('INVALID_SESSIONS');
    expect(normalizePackageBody({ serviceIds: [] }, { partial: true }).error?.body.code).toBe('NO_SERVICES');
    expect(normalizePackageBody({ name: '' }, { partial: true }).error?.body.code).toBe('MISSING_NAME');
  });

  test('description can be cleared', () => {
    expect(normalizePackageBody({ description: '' }, { partial: true }).data.description).toBeNull();
  });
});

// ── Buying a package ────────────────────────────────────────────────

describe('saleBlockReason', () => {
  const onSale = { isActive: true, isPublic: true, sellByDate: null };

  test('a live package with no sell-by date is buyable', () => {
    expect(saleBlockReason(onSale)).toBeNull();
  });

  test('a retired package cannot be bought', () => {
    expect(saleBlockReason({ ...onSale, isActive: false }).code).toBe('PACKAGE_RETIRED');
  });

  test('an unpublished draft cannot be bought even with its id in hand', () => {
    expect(saleBlockReason({ ...onSale, isPublic: false }).code).toBe('PACKAGE_NOT_PUBLIC');
  });

  test('a lapsed sell-by date closes the sale', () => {
    expect(saleBlockReason({ ...onSale, sellByDate: '2020-01-01T00:00:00.000Z' }).code)
      .toBe('PACKAGE_PAST_SELL_BY');
  });

  test('a future sell-by date does not', () => {
    expect(saleBlockReason({ ...onSale, sellByDate: '2099-12-31T00:00:00.000Z' })).toBeNull();
  });
});

describe('priceBreakdown', () => {
  test('adds the GST slab on top of the stored price', () => {
    expect(priceBreakdown({ price: 50993, taxPercent: 5 })).toEqual({
      baseAmount: 50993,
      taxPercent: 5,
      tax: 2550,
      total: 53543,
    });
  });

  test('rounds tax the way the builder quoted it', () => {
    // 50993 x 5% is 2549.65. The builder showed the customer 2,550, so that is
    // what gets charged — being billed 35 paise off the quote is a support
    // ticket waiting to happen.
    expect(priceBreakdown({ price: 50993, taxPercent: 5 }).tax).toBe(2550);
  });

  test('no tax means the total is the price', () => {
    expect(priceBreakdown({ price: 1200, taxPercent: 0 })).toMatchObject({ tax: 0, total: 1200 });
    expect(priceBreakdown({ price: 1200 })).toMatchObject({ tax: 0, total: 1200 });
  });

  test('a priceless package totals zero rather than NaN', () => {
    // The route rejects this with PACKAGE_NOT_PAYABLE; it must not reach the
    // gateway as a NaN amount.
    expect(priceBreakdown({}).total).toBe(0);
    expect(priceBreakdown({ price: null, taxPercent: null }).total).toBe(0);
  });

  test('GST 18% on a round price', () => {
    expect(priceBreakdown({ price: 10000, taxPercent: 18 })).toMatchObject({ tax: 1800, total: 11800 });
  });
});

// ── Asking for a session out of a bought package ────────────────────

describe('planRequestBlockReason', () => {
  const usable = { status: 'active', totalSessions: 4, completedSessions: 1, nextDueAt: null };

  test('an active package with sessions left and no expiry is bookable', () => {
    expect(planRequestBlockReason(usable)).toBeNull();
  });

  test('a future use-by date does not block it', () => {
    expect(planRequestBlockReason({ ...usable, nextDueAt: '2099-01-01T00:00:00.000Z' })).toBeNull();
  });

  test('a package with every session used cannot take another request', () => {
    expect(planRequestBlockReason({ ...usable, completedSessions: 4 }).body.code).toBe('PLAN_EXHAUSTED');
    // Over-run defensively too: a courtesy sitting must not reopen the package.
    expect(planRequestBlockReason({ ...usable, completedSessions: 5 }).body.code).toBe('PLAN_EXHAUSTED');
  });

  test('a finished or cancelled package is closed to requests', () => {
    expect(planRequestBlockReason({ ...usable, status: 'completed' }).body.code).toBe('PLAN_NOT_ACTIVE');
    expect(planRequestBlockReason({ ...usable, status: 'cancelled' }).body.code).toBe('PLAN_NOT_ACTIVE');
    expect(planRequestBlockReason({ ...usable, status: 'paused' }).body.code).toBe('PLAN_NOT_ACTIVE');
  });

  test('a lapsed use-by date sends the customer to the clinic rather than silently failing', () => {
    const blocked = planRequestBlockReason({ ...usable, nextDueAt: '2020-01-01T00:00:00.000Z' });
    expect(blocked.body.code).toBe('PLAN_LAPSED');
    expect(blocked.body.error).toMatch(/contact the clinic/i);
  });

  test('every refusal is a 409, not a 500 — these are states, not faults', () => {
    for (const plan of [
      { ...usable, status: 'completed' },
      { ...usable, completedSessions: 4 },
      { ...usable, nextDueAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      expect(planRequestBlockReason(plan).status).toBe(409);
    }
  });
});

describe('validatePreferredRequestDate', () => {
  const activePlan = { nextDueAt: '2026-09-03T13:00:00.000Z' };
  const now = new Date('2026-08-27T12:00:00+05:30');

  test('allows no preferred date', () => {
    expect(validatePreferredRequestDate(null, activePlan, now)).toBeNull();
  });

  test('rejects a preferred date before Thursday, August 27, 2026', () => {
    expect(
      validatePreferredRequestDate(new Date('2026-08-26T12:00:00+05:30'), activePlan, now)?.body.code,
    ).toBe('PAST_PREFERRED_DATE');
  });

  test('rejects a preferred date after the package validity day', () => {
    const result = validatePreferredRequestDate(new Date('2026-09-04T12:00:00+05:30'), activePlan, now);
    expect(result?.body.code).toBe('PREFERRED_DATE_AFTER_VALIDITY');
    expect(result?.body.latestDate).toBe('2026-09-03');
  });

  test('allows today and the last valid day', () => {
    expect(validatePreferredRequestDate(new Date('2026-08-27T09:00:00+05:30'), activePlan, now)).toBeNull();
    expect(validatePreferredRequestDate(new Date('2026-09-03T09:00:00+05:30'), activePlan, now)).toBeNull();
  });
});

// ── Buying a package you already hold ───────────────────────────────

describe('alreadyHeldBlockReason', () => {
  const held = { id: 77, totalSessions: 4, completedSessions: 0, nextDueAt: null };

  test('a package never bought is buyable', () => {
    expect(alreadyHeldBlockReason(null)).toBeNull();
  });

  test('holding it with every session unused blocks a second purchase', () => {
    // The reported bug: a customer could buy the same package again while
    // holding it untouched — money taken for something they have not used, and
    // a second plan the catalog cannot show them.
    const blocked = alreadyHeldBlockReason(held);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PACKAGE_ALREADY_HELD');
    expect(blocked.body.sessionsLeft).toBe(4);
    expect(blocked.body.treatmentPlanId).toBe(77);
  });

  test('the refusal says how much is left, so it reads as help not a wall', () => {
    expect(alreadyHeldBlockReason({ ...held, completedSessions: 1 }).body.error)
      .toMatch(/3 of 4 sessions left/);
  });

  test('a part-used package is still blocked', () => {
    expect(alreadyHeldBlockReason({ ...held, completedSessions: 3 }).body.code)
      .toBe('PACKAGE_ALREADY_HELD');
  });

  test('an exhausted package can be bought again — that is the whole point', () => {
    expect(alreadyHeldBlockReason({ ...held, completedSessions: 4 })).toBeNull();
    expect(alreadyHeldBlockReason({ ...held, completedSessions: 5 })).toBeNull();
  });

  test('a lapsed window frees it too — those sessions can no longer be used', () => {
    expect(alreadyHeldBlockReason({ ...held, nextDueAt: '2020-01-01T00:00:00.000Z' })).toBeNull();
  });

  test('a future window keeps the block', () => {
    expect(alreadyHeldBlockReason({ ...held, nextDueAt: '2099-01-01T00:00:00.000Z' }).body.code)
      .toBe('PACKAGE_ALREADY_HELD');
  });
});

// ── Confirming a slot ───────────────────────────────────────────────

describe('validateAcceptSlot', () => {
  const now = new Date('2026-08-27T17:01:40.000Z');

  test('a slot later today is fine', () => {
    expect(validateAcceptSlot(new Date('2026-08-27T18:00:00.000Z'), now)).toBeNull();
  });

  test('the current minute is fine — seconds must not lose the slot', () => {
    // The picker carries minutes. Choosing 17:01 and pressing Accept at
    // 17:01:40 has to work, or every on-the-hour booking is a coin flip.
    expect(validateAcceptSlot(new Date('2026-08-27T17:01:00.000Z'), now)).toBeNull();
  });

  test('a minute ago is refused', () => {
    expect(validateAcceptSlot(new Date('2026-08-27T17:00:59.000Z'), now).body.code)
      .toBe('PAST_VISIT_DATE');
  });

  test('the date the patient asked for, now gone by, is refused', () => {
    // The queue pre-fills this, so it is the case that actually happens: a
    // request sits for a few days and the requested date passes.
    const blocked = validateAcceptSlot(new Date('2026-08-24T10:00:00.000Z'), now);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/already passed/i);
  });

  test('no slot at all is not an error here', () => {
    expect(validateAcceptSlot(null, now)).toBeNull();
  });
});
