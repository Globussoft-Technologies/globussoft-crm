// Unit tests for the consumption-unit helper.
//
// Pin the allowed-unit list + the conversion table so the applier + the
// rule-create/PUT route stay in lockstep.

import { describe, test, expect } from 'vitest';
import {
  ALLOWED_UNITS,
  isAllowedUnit,
  isConvertible,
  convertQuantity,
} from '../../lib/consumptionUnits.js';

describe('lib/consumptionUnits — ALLOWED_UNITS', () => {
  test('contains the canonical wellness units', () => {
    for (const u of ['ml', 'gm', 'kg', 'piece', 'unit', 'bottle', 'tube', 'pack', 'ltr']) {
      expect(ALLOWED_UNITS).toContain(u);
    }
  });
});

describe('lib/consumptionUnits — isAllowedUnit', () => {
  test('accepts allowed units', () => {
    expect(isAllowedUnit('ml')).toBe(true);
    expect(isAllowedUnit('bottle')).toBe(true);
  });
  test('rejects nonsense / wrong-case / non-strings', () => {
    expect(isAllowedUnit('mL')).toBe(false);
    expect(isAllowedUnit('liter')).toBe(false);
    expect(isAllowedUnit('')).toBe(false);
    expect(isAllowedUnit(null)).toBe(false);
    expect(isAllowedUnit(undefined)).toBe(false);
    expect(isAllowedUnit(15)).toBe(false);
  });
});

describe('lib/consumptionUnits — isConvertible', () => {
  test('same unit is always convertible', () => {
    expect(isConvertible('ml', 'ml')).toBe(true);
    expect(isConvertible('piece', 'piece')).toBe(true);
  });
  test('volume family: ml ↔ ltr', () => {
    expect(isConvertible('ml', 'ltr')).toBe(true);
    expect(isConvertible('ltr', 'ml')).toBe(true);
  });
  test('mass family: gm ↔ kg', () => {
    expect(isConvertible('gm', 'kg')).toBe(true);
    expect(isConvertible('kg', 'gm')).toBe(true);
  });
  test('count-style units only convert to themselves', () => {
    expect(isConvertible('piece', 'unit')).toBe(false);
    expect(isConvertible('bottle', 'tube')).toBe(false);
    expect(isConvertible('pack', 'bottle')).toBe(false);
  });
  test('cross-family conversions are rejected', () => {
    expect(isConvertible('ml', 'gm')).toBe(false);
    expect(isConvertible('kg', 'ltr')).toBe(false);
    expect(isConvertible('piece', 'ml')).toBe(false);
  });
  test('unknown units are not convertible', () => {
    expect(isConvertible('foo', 'ml')).toBe(false);
    expect(isConvertible('ml', 'foo')).toBe(false);
    expect(isConvertible(null, 'ml')).toBe(false);
  });
});

describe('lib/consumptionUnits — convertQuantity', () => {
  test('same-unit conversion is a no-op', () => {
    expect(convertQuantity(15, 'ml', 'ml')).toBe(15);
    expect(convertQuantity(3.5, 'piece', 'piece')).toBe(3.5);
  });
  test('ml → ltr divides by 1000', () => {
    expect(convertQuantity(1500, 'ml', 'ltr')).toBe(1.5);
    expect(convertQuantity(15, 'ml', 'ltr')).toBeCloseTo(0.015, 5);
  });
  test('ltr → ml multiplies by 1000', () => {
    expect(convertQuantity(0.5, 'ltr', 'ml')).toBe(500);
    expect(convertQuantity(2, 'ltr', 'ml')).toBe(2000);
  });
  test('gm → kg divides by 1000', () => {
    expect(convertQuantity(500, 'gm', 'kg')).toBe(0.5);
    expect(convertQuantity(2500, 'gm', 'kg')).toBe(2.5);
  });
  test('kg → gm multiplies by 1000', () => {
    expect(convertQuantity(1.5, 'kg', 'gm')).toBe(1500);
  });
  test('throws on incompatible pair', () => {
    expect(() => convertQuantity(15, 'ml', 'gm')).toThrow(/Cannot convert/);
    expect(() => convertQuantity(1, 'piece', 'bottle')).toThrow(/Cannot convert/);
  });
});
