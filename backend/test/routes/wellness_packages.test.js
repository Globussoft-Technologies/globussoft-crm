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
const { parseServiceIds, normalizePackageBody } = requireCJS('../../routes/wellness_packages');

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
