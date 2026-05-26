// @ts-check
/**
 * tdsCalculation.test.js — Arc 2 #901 slice 21
 *
 * Pin the pure-TDS-from-lines computation used by the /:id/issue handler
 * (and future PDF renderer / portal / reconciliation cron). The contract
 * surface is intentionally tiny: feed `lines`, get back `{ totalTds,
 * perLineTds }`. These tests pin:
 *
 *   1. Empty / falsy inputs return { totalTds: 0, perLineTds: [] }.
 *   2. Lines with lineType !== 'tds' are excluded from the sum.
 *   3. Multiple TDS lines sum half-up to 2dp.
 *   4. Decimal-as-string amounts (Prisma raw-query path) coerce correctly.
 *   5. Non-finite amounts (NaN, null, undefined, "abc") are skipped, not
 *      poisoning the running total.
 *   6. perLineTds preserves input order + carries the row's id.
 *   7. Half-up rounding: 0.005 → 0.01 (NOT 0.00 — the Number.EPSILON nudge
 *      catches the IEEE-754 banker's-rounding quirk).
 *
 * All assertions are exact-equality on Number outputs; no fixtures, no
 * Prisma. ~50ms total.
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { computeTdsFromLines, TDS_LINE_TYPE } = requireCJS('../../lib/tdsCalculation');

describe('computeTdsFromLines — pure TDS withholding sum', () => {
  test('exports TDS_LINE_TYPE = "tds"', () => {
    expect(TDS_LINE_TYPE).toBe('tds');
  });

  test('empty array → { totalTds: 0, perLineTds: [] }', () => {
    const r = computeTdsFromLines([]);
    expect(r).toEqual({ totalTds: 0, perLineTds: [] });
  });

  test('null / undefined / non-array input → safe zero', () => {
    expect(computeTdsFromLines(null)).toEqual({ totalTds: 0, perLineTds: [] });
    expect(computeTdsFromLines(undefined)).toEqual({ totalTds: 0, perLineTds: [] });
    // @ts-expect-error — intentionally passing a non-array to assert the guard
    expect(computeTdsFromLines('not-an-array')).toEqual({ totalTds: 0, perLineTds: [] });
  });

  test('no TDS lines (only per_pax + tax) → totalTds 0, empty perLineTds', () => {
    const lines = [
      { id: 1, lineType: 'per_pax', amount: '12000.00' },
      { id: 2, lineType: 'tax', amount: '2160.00' },
      { id: 3, lineType: 'fee', amount: '500.00' },
    ];
    expect(computeTdsFromLines(lines)).toEqual({ totalTds: 0, perLineTds: [] });
  });

  test('single TDS line → sum equals that line, perLineTds has 1 row', () => {
    const lines = [
      { id: 10, lineType: 'per_pax', amount: '100000.00' },
      { id: 11, lineType: 'tds', amount: '1000.00' }, // 1% TDS hypothetically
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(1000);
    expect(r.perLineTds).toEqual([{ lineId: 11, amount: 1000 }]);
  });

  test('multiple TDS lines → summed; only TDS lines contribute', () => {
    const lines = [
      { id: 20, lineType: 'per_pax', amount: '50000.00' },
      { id: 21, lineType: 'tds', amount: '500.50' },
      { id: 22, lineType: 'tax', amount: '9000.00' },
      { id: 23, lineType: 'tds', amount: '250.25' },
      { id: 24, lineType: 'addon', amount: '750.00' },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(750.75); // 500.50 + 250.25
    expect(r.perLineTds).toEqual([
      { lineId: 21, amount: 500.5 },
      { lineId: 23, amount: 250.25 },
    ]);
  });

  test('Decimal-as-string amount (Prisma raw path) coerces correctly', () => {
    // Prisma's Decimal column round-trips as a wrapper object whose
    // .toString() returns the canonical string. Number() coerces both
    // the wrapper and the plain string. Pin both shapes.
    const lines = [
      { id: 30, lineType: 'tds', amount: '1234.56' }, // string path
      { id: 31, lineType: 'tds', amount: 765.44 }, // number path
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(2000);
  });

  test('non-finite amounts (NaN / null / "abc") are SKIPPED, not poisoning the sum', () => {
    const lines = [
      { id: 40, lineType: 'tds', amount: null },
      { id: 41, lineType: 'tds', amount: undefined },
      { id: 42, lineType: 'tds', amount: 'not-a-number' },
      { id: 43, lineType: 'tds', amount: NaN },
      { id: 44, lineType: 'tds', amount: '500.00' }, // only this one counts
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(500);
    expect(r.perLineTds).toEqual([{ lineId: 44, amount: 500 }]);
  });

  test('perLineTds preserves input order', () => {
    const lines = [
      { id: 50, lineType: 'tds', amount: '100.00' },
      { id: 51, lineType: 'per_pax', amount: '5000.00' },
      { id: 52, lineType: 'tds', amount: '200.00' },
      { id: 53, lineType: 'tds', amount: '300.00' },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.perLineTds.map((p) => p.lineId)).toEqual([50, 52, 53]);
  });

  test('half-up rounding: 0.005 → 0.01 (not 0.00 via banker\'s)', () => {
    // The Number.EPSILON nudge in round2 is what keeps Math.round from
    // half-to-even-style flooring this. Pin the contract so a future
    // refactor doesn't regress to bare Math.round.
    const lines = [
      { id: 60, lineType: 'tds', amount: 0.005 },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(0.01);
  });

  test('row without id → perLineTds carries lineId: null', () => {
    const lines = [
      { lineType: 'tds', amount: '50.00' }, // no id
    ];
    const r = computeTdsFromLines(lines);
    expect(r.perLineTds).toEqual([{ lineId: null, amount: 50 }]);
  });

  test('malformed line entries (null / non-object) are skipped without throwing', () => {
    const lines = [
      null,
      undefined,
      'string-not-row',
      42,
      { id: 70, lineType: 'tds', amount: '777.00' },
    ];
    // @ts-expect-error — intentionally heterogeneous to assert the guard
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(777);
    expect(r.perLineTds).toEqual([{ lineId: 70, amount: 777 }]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Coverage extensions — pin under-covered branches in the SUT contract.
  // ──────────────────────────────────────────────────────────────────────────

  test('zero TDS amount is INCLUDED (only null/undefined skipped, not 0)', () => {
    // The SUT only skips when raw === null || raw === undefined.
    // amount: 0 is finite → goes through round2 → included with amount: 0.
    const lines = [
      { id: 80, lineType: 'tds', amount: 0 },
      { id: 81, lineType: 'tds', amount: '100.00' },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(100);
    expect(r.perLineTds).toEqual([
      { lineId: 80, amount: 0 },
      { lineId: 81, amount: 100 },
    ]);
  });

  test('negative TDS amount is summed verbatim (no clamp at 0)', () => {
    // Number(-500) is finite → included; total goes negative. The helper
    // is intentionally side-effect-free + clamp-free — if upstream needs a
    // floor, that's a call-site concern.
    const lines = [
      { id: 90, lineType: 'tds', amount: -500 },
      { id: 91, lineType: 'tds', amount: '200' },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(-300);
    expect(r.perLineTds).toEqual([
      { lineId: 90, amount: -500 },
      { lineId: 91, amount: 200 },
    ]);
  });

  test('round2 boundary: 0.004 → 0.00 (NOT 0.01) — confirms half-up only kicks in at .005', () => {
    const lines = [
      { id: 100, lineType: 'tds', amount: 0.004 },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(0);
    expect(r.perLineTds).toEqual([{ lineId: 100, amount: 0 }]);
  });

  test('round2 boundary: 0.006 → 0.01 — confirms direction of half-up', () => {
    const lines = [
      { id: 110, lineType: 'tds', amount: 0.006 },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(0.01);
    expect(r.perLineTds).toEqual([{ lineId: 110, amount: 0.01 }]);
  });

  test('per-line round2 BEFORE running-sum: [0.005, 0.005] → 0.02 (not 0.01)', () => {
    // Two half-pennies each round up to 0.01 INDIVIDUALLY before summing.
    // If the SUT ever regresses to sum-then-round, this would be 0.01.
    const lines = [
      { id: 120, lineType: 'tds', amount: 0.005 },
      { id: 121, lineType: 'tds', amount: 0.005 },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(0.02);
    expect(r.perLineTds).toEqual([
      { lineId: 120, amount: 0.01 },
      { lineId: 121, amount: 0.01 },
    ]);
  });

  test('TDS_LINE_TYPE is case-sensitive: lineType "TDS" (uppercase) is EXCLUDED', () => {
    // The check is strict-equality === 'tds'. Pin so a future refactor to
    // .toLowerCase() doesn't silently change the contract.
    const lines = [
      { id: 130, lineType: 'TDS', amount: '1000' },
      { id: 131, lineType: 'Tds', amount: '500' },
      { id: 132, lineType: 'tds', amount: '250' }, // only this one
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(250);
    expect(r.perLineTds).toEqual([{ lineId: 132, amount: 250 }]);
  });

  test('missing lineType key entirely → excluded (undefined !== "tds")', () => {
    const lines = [
      { id: 140, amount: '1000' }, // no lineType
      { id: 141, lineType: 'tds', amount: '300' },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(300);
    expect(r.perLineTds).toEqual([{ lineId: 141, amount: 300 }]);
  });

  test('string id is coerced to null via Number.isFinite strict check', () => {
    // Number.isFinite is the strict variant — it does NOT coerce its arg.
    // So `Number.isFinite('42')` is false → lineId becomes null even
    // though the string is parseable. Float ids like 1.5 ARE finite.
    const lines = [
      { id: '42', lineType: 'tds', amount: '100' },
      { id: 1.5, lineType: 'tds', amount: '200' },
    ];
    const r = computeTdsFromLines(lines);
    expect(r.totalTds).toBe(300);
    expect(r.perLineTds).toEqual([
      { lineId: null, amount: 100 }, // string id → null
      { lineId: 1.5, amount: 200 }, // float id → preserved
    ]);
  });
});
