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
  parseServiceSessions,
  totalSessionsFrom,
  splitUpdateBlockReason,
  visitsFrom,
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

// ── Per-service session counts ──────────────────────────────────────

describe('parseServiceSessions', () => {
  test('accepts the map shape', () => {
    expect(parseServiceSessions({ 10: 3, 11: 2 })).toEqual({ 10: 3, 11: 2 });
  });

  test('accepts the array shape the builder holds in state', () => {
    expect(parseServiceSessions([
      { serviceId: 10, sessions: 3 },
      { serviceId: 11, sessions: 2 },
    ])).toEqual({ 10: 3, 11: 2 });
  });

  test('accepts the JSON string that comes back off the row', () => {
    expect(parseServiceSessions('{"10":3,"11":2}')).toEqual({ 10: 3, 11: 2 });
  });

  test('null for anything unusable, so a corrupt value cannot price at zero', () => {
    expect(parseServiceSessions(null)).toBeNull();
    expect(parseServiceSessions('')).toBeNull();
    expect(parseServiceSessions('not json')).toBeNull();
    expect(parseServiceSessions({})).toBeNull();
    // A zero or negative run is dropped, not stored.
    expect(parseServiceSessions({ 10: 0 })).toBeNull();
    expect(parseServiceSessions({ 10: -2 })).toBeNull();
    expect(parseServiceSessions({ 10: 2.5 })).toBeNull();
  });

  test('keeps the usable entries when only some are junk', () => {
    expect(parseServiceSessions({ 10: 3, 11: 0 })).toEqual({ 10: 3 });
  });
});

describe('totalSessionsFrom', () => {
  test('a split totals its parts — 3 + 2 is 5 sessions', () => {
    expect(totalSessionsFrom({ 10: 3, 11: 2 }, [10, 11], 6)).toBe(5);
  });

  test('no split reads the old way: every service runs `sessions` times', () => {
    // Two services x 6 was always 12 sittings; the flat number just never
    // said so out loud.
    expect(totalSessionsFrom(null, [10, 11], 6)).toBe(12);
    expect(totalSessionsFrom(null, [10], 6)).toBe(6);
  });
});

describe('normalizePackageBody — per-service sessions', () => {
  const base = { name: 'Glow', serviceIds: [10, 11], sessions: 6, discountPercent: 10 };

  test('a split becomes the source of truth for the session total', () => {
    const { error, data } = normalizePackageBody({ ...base, serviceSessions: { 10: 3, 11: 2 } });
    expect(error).toBeUndefined();
    expect(data.serviceSessions).toEqual({ 10: 3, 11: 2 });
    // `sessions` is recomputed as the VISIT count, because that is what the
    // treatment plan counts down. Combined (the default) delivers both services
    // in a visit, so 3 + 2 is three visits — two with both, one with the
    // leftover. The five runs are still what the price is built from.
    expect(data.sessions).toBe(3);
  });

  test('a package without a split is untouched', () => {
    const { data } = normalizePackageBody(base);
    expect(data.serviceSessions).toBeUndefined();
    expect(data.sessions).toBe(6);
  });

  test('an explicit null clears the split back to the flat shape', () => {
    const { data } = normalizePackageBody({ ...base, serviceSessions: null });
    expect(data.serviceSessions).toBeNull();
    expect(data.sessions).toBe(6);
  });

  test('the split must cover exactly the bundled services', () => {
    // Half-priced packages are worse than a rejected save.
    expect(normalizePackageBody({ ...base, serviceSessions: { 10: 3 } }).error.body.code)
      .toBe('SERVICE_SESSIONS_MISMATCH');
    expect(normalizePackageBody({ ...base, serviceSessions: { 10: 3, 11: 2, 99: 1 } }).error.body.code)
      .toBe('SERVICE_SESSIONS_MISMATCH');
  });

  test('the refusal names which service is missing', () => {
    const blocked = normalizePackageBody({ ...base, serviceSessions: { 10: 3 } });
    expect(blocked.error.body.missing).toEqual([11]);
  });

  test('a single service cannot exceed the session cap', () => {
    expect(normalizePackageBody({ ...base, serviceSessions: { 10: 61, 11: 2 } }).error.body.code)
      .toBe('INVALID_SERVICE_SESSIONS');
  });

  test('an unusable split is refused rather than silently ignored', () => {
    expect(normalizePackageBody({ ...base, serviceSessions: 'not json' }).error.body.code)
      .toBe('INVALID_SERVICE_SESSIONS');
  });
});

describe('splitUpdateBlockReason', () => {
  const SPLIT = { 21: 3, 22: 2 };

  test('a package without a split is never blocked', () => {
    expect(
      splitUpdateBlockReason({
        perServiceSessions: null,
        serviceIds: [21, 22],
        sessionsChanged: true,
        splitProvided: false,
      }),
    ).toBeNull();
  });

  test('refuses a bare sessions edit — there is no honest way to spread it', () => {
    const blocked = splitUpdateBlockReason({
      perServiceSessions: SPLIT,
      serviceIds: [21, 22],
      sessionsChanged: true,
      splitProvided: false,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('SESSIONS_SET_BY_SPLIT');
  });

  test('allows sessions to move when the new split comes with it', () => {
    expect(
      splitUpdateBlockReason({
        perServiceSessions: { 21: 4, 22: 2 },
        serviceIds: [21, 22],
        sessionsChanged: true,
        splitProvided: true,
      }),
    ).toBeNull();
  });

  test('refuses a service added without a count — it would price at zero', () => {
    const blocked = splitUpdateBlockReason({
      perServiceSessions: SPLIT,
      serviceIds: [21, 22, 23],
      sessionsChanged: false,
      splitProvided: false,
    });
    expect(blocked.body.code).toBe('SERVICE_SESSIONS_MISMATCH');
    expect(blocked.body.missing).toEqual([23]);
  });

  test('refuses a count left behind by a dropped service', () => {
    const blocked = splitUpdateBlockReason({
      perServiceSessions: SPLIT,
      serviceIds: [21],
      sessionsChanged: false,
      splitProvided: false,
    });
    expect(blocked.body.code).toBe('SERVICE_SESSIONS_MISMATCH');
    expect(blocked.body.extra).toEqual([22]);
  });

  test('numeric and string ids are the same id', () => {
    expect(
      splitUpdateBlockReason({
        perServiceSessions: SPLIT,
        serviceIds: ['21', '22'],
        sessionsChanged: false,
        splitProvided: false,
      }),
    ).toBeNull();
  });

  test('an untouched split with an unchanged bundle passes', () => {
    expect(
      splitUpdateBlockReason({
        perServiceSessions: SPLIT,
        serviceIds: [21, 22],
        sessionsChanged: false,
        splitProvided: false,
      }),
    ).toBeNull();
  });
});

/**
 * Service-sessions vs visits.
 *
 * Two services at 3 and 4 runs is 7 runs either way — that is what the price is
 * built from. But the patient attends either 4 appointments (three with both
 * services, one with the leftover) or 7 (one service each), and THAT is the
 * number the treatment plan counts down. The clinic decides which.
 */
describe('visitsFrom — packing runs into visits', () => {
  const SPLIT = { 10: 3, 11: 4 };

  test('combined: three visits with both, one with the leftover', () => {
    expect(visitsFrom(SPLIT, [10, 11], 6, 'combined')).toBe(4);
  });

  test('separate: one service per visit', () => {
    expect(visitsFrom(SPLIT, [10, 11], 6, 'separate')).toBe(7);
  });

  test('the runs are 7 whichever way they are delivered', () => {
    expect(totalSessionsFrom(SPLIT, [10, 11], 6)).toBe(7);
  });

  test('combined is the default, because that is what a package always meant', () => {
    expect(visitsFrom(SPLIT, [10, 11], 6)).toBe(4);
  });

  test('an even split under combined is the legacy number exactly', () => {
    // 6 sessions of a two-service bundle has always been 6 visits, not 12.
    expect(visitsFrom({ 10: 6, 11: 6 }, [10, 11], 6, 'combined')).toBe(6);
  });

  test('no split at all keeps the stored count untouched', () => {
    expect(visitsFrom(null, [10, 11], 6, 'combined')).toBe(6);
    expect(visitsFrom(null, [10, 11], 6, 'separate')).toBe(6);
  });

  test('a single service is the same number both ways', () => {
    expect(visitsFrom({ 10: 5 }, [10], 5, 'combined')).toBe(5);
    expect(visitsFrom({ 10: 5 }, [10], 5, 'separate')).toBe(5);
  });
});

describe('normalizePackageBody — session mode', () => {
  const base = { serviceIds: [10, 11], serviceSessions: { 10: 3, 11: 4 }, sessions: 6 };

  test('combined derives 4 visits from a 3 + 4 split', () => {
    const { error, data } = normalizePackageBody({ ...base, name: 'P', sessionMode: 'combined' });
    expect(error).toBeUndefined();
    expect(data.sessionMode).toBe('combined');
    expect(data.sessions).toBe(4);
  });

  test('separate derives 7 visits from the same split', () => {
    const { data } = normalizePackageBody({ ...base, name: 'P', sessionMode: 'separate' });
    expect(data.sessions).toBe(7);
  });

  test('defaults to combined when the mode is not given', () => {
    const { data } = normalizePackageBody({ ...base, name: 'P' });
    expect(data.sessions).toBe(4);
  });

  test('rejects a mode that is neither', () => {
    const { error } = normalizePackageBody({ ...base, name: 'P', sessionMode: 'whenever' });
    expect(error.status).toBe(400);
    expect(error.body.code).toBe('INVALID_SESSION_MODE');
  });

  test('accepts the mode however it is cased', () => {
    const { data } = normalizePackageBody({ ...base, name: 'P', sessionMode: 'SEPARATE' });
    expect(data.sessionMode).toBe('separate');
    expect(data.sessions).toBe(7);
  });
});

describe('normalizePackageBody — the visit cap survives the split', () => {
  test('one service per visit cannot sum past the package cap', () => {
    // Each count is a legal 40, but "one per visit" makes 80 appointments and
    // a treatment plan to match.
    const { error } = normalizePackageBody({
      name: 'Marathon',
      serviceIds: [10, 11],
      sessions: 6,
      serviceSessions: { 10: 40, 11: 40 },
      sessionMode: 'separate',
    });
    expect(error.status).toBe(400);
    expect(error.body.code).toBe('TOO_MANY_SESSIONS');
  });

  test('the same runs pass when the services share a visit', () => {
    // 40 visits, each delivering both services — comfortably under the cap.
    const { error, data } = normalizePackageBody({
      name: 'Marathon',
      serviceIds: [10, 11],
      sessions: 6,
      serviceSessions: { 10: 40, 11: 40 },
      sessionMode: 'combined',
    });
    expect(error).toBeUndefined();
    expect(data.sessions).toBe(40);
  });
});
