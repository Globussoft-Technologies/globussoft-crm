/**
 * drugs-strength-validation.test.js
 *
 * Drug.strengthValue is a String (combination drugs are written "5/10") and
 * strengthUnit was free text, and NEITHER was validated on any write path. A
 * catalogue row was saved with strengthValue "-" and strengthUnit "-gm";
 * every prescription surface renders strength as `[value, unit].join("")`, so
 * that drug printed as "--gm" on the preview, the PDF and the ledger.
 *
 * These pin the repair-first rules. Repair-first rather than a closed unit
 * enum on purpose: an allow-list would reject legitimate units nobody listed
 * (mEq, mg/ml, gm) and break catalogues that already hold them.
 */
import { describe, test, expect } from 'vitest';

const { normaliseStrength } = require('../../routes/drugs');

describe('normaliseStrength — rejects', () => {
  test('a value with no digit is not a strength (the bug\'s exact input)', () => {
    const r = normaliseStrength('-', '-gm');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_STRENGTH_VALUE');
    // The message has to tell the admin what to type instead.
    expect(r.error).toMatch(/must contain a number/i);
  });

  test('a non-numeric value is rejected', () => {
    expect(normaliseStrength('n/a', 'mg').ok).toBe(false);
    expect(normaliseStrength('abc', 'mg').code).toBe('INVALID_STRENGTH_VALUE');
  });

  test('a unit that is only punctuation is rejected', () => {
    const r = normaliseStrength('500', '-');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_STRENGTH_UNIT');
  });

  test('absurdly long input is rejected rather than stored', () => {
    const r = normaliseStrength('5'.repeat(64), 'mg');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('STRENGTH_TOO_LONG');
  });
});

describe('normaliseStrength — repairs', () => {
  test('strips stray leading/trailing punctuation from the unit', () => {
    expect(normaliseStrength('500', '-gm')).toMatchObject({ ok: true, value: '500', unit: 'gm' });
  });

  test('strips stray punctuation from the value', () => {
    expect(normaliseStrength('-500', 'mg')).toMatchObject({ ok: true, value: '500', unit: 'mg' });
    expect(normaliseStrength('500-', 'mg')).toMatchObject({ ok: true, value: '500', unit: 'mg' });
  });

  test('drops a unit that has no value — "gm" alone tells a pharmacist nothing', () => {
    expect(normaliseStrength('', 'gm')).toMatchObject({ ok: true, value: null, unit: null });
  });

  test('empty input stays empty rather than erroring', () => {
    expect(normaliseStrength(null, null)).toMatchObject({ ok: true, value: null, unit: null });
    expect(normaliseStrength('', '')).toMatchObject({ ok: true, value: null, unit: null });
  });
});

describe('normaliseStrength — preserves every legitimate form', () => {
  // The point of repair-first: none of these may start failing, or existing
  // catalogues become uneditable.
  test.each([
    ['500', 'mg'],
    ['5/10', 'mg'],   // combination drug — why the column is a String
    ['2.5', 'ml'],
    ['0.5', 'mcg'],
    ['5', '%'],
    ['5', 'IU'],
    ['500', 'mg/ml'],
    ['10', 'mEq'],
    ['1', 'gm'],
  ])('accepts %s %s unchanged', (value, unit) => {
    expect(normaliseStrength(value, unit)).toMatchObject({ ok: true, value, unit });
  });

  test('a value with no unit is allowed', () => {
    expect(normaliseStrength('500', '')).toMatchObject({ ok: true, value: '500', unit: null });
  });
});
