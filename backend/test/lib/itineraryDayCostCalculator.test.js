// Unit tests for #907 slice 1 — pure per-day cost aggregator for travel itinerary items.
//
// Verifies:
//   * groupItemsByDay buckets correctly across dayOffset / dayNumber / date precedence.
//   * Items missing day-resolution data or with negative offsets are silently skipped
//     (predictable for partial upstream data; callers validate shape separately).
//   * computeDayCosts returns sorted days, accurate totals (with half-up rounding),
//     by-type breakdown per day, and correct grandTotal + averageDailyCost.
//   * String-numeric coercion of `cost` ("100.50" → 100.50) works for JSON / DB string
//     columns; non-numeric / missing costs fall back to 0.
//
// Pure module — no Prisma, no fetch, no mocks needed.

import { describe, test, expect } from 'vitest';
import {
  groupItemsByDay,
  computeDayCosts,
} from '../../lib/itineraryDayCostCalculator.js';

describe('groupItemsByDay', () => {
  test('3 items on different dayOffsets → Map with 3 distinct keys', () => {
    const items = [
      { dayOffset: 0, cost: 10 },
      { dayOffset: 1, cost: 20 },
      { dayOffset: 2, cost: 30 },
    ];
    const m = groupItemsByDay(items);
    expect(m.size).toBe(3);
    expect(m.get(0)).toHaveLength(1);
    expect(m.get(1)).toHaveLength(1);
    expect(m.get(2)).toHaveLength(1);
  });

  test('2 items sharing dayOffset → Map with 1 key, 2 values', () => {
    const items = [
      { dayOffset: 1, cost: 10, itemType: 'hotel' },
      { dayOffset: 1, cost: 50, itemType: 'meal' },
    ];
    const m = groupItemsByDay(items);
    expect(m.size).toBe(1);
    expect(m.get(1)).toHaveLength(2);
  });

  test('dayNumber=1 resolves to dayOffset=0 (1-indexed → 0-indexed conversion)', () => {
    const items = [
      { dayNumber: 1, cost: 10 },
      { dayNumber: 3, cost: 30 },
    ];
    const m = groupItemsByDay(items);
    expect(m.has(0)).toBe(true);
    expect(m.has(2)).toBe(true);
    expect(m.has(1)).toBe(false);
  });

  test("date='2026-05-15' with tripStart='2026-05-13' resolves to dayOffset=2", () => {
    const items = [
      { date: '2026-05-15', cost: 100 },
      { date: '2026-05-13', cost: 50 }, // tripStart itself → day 0
    ];
    const tripStart = new Date(Date.UTC(2026, 4, 13)); // May 13 2026 UTC
    const m = groupItemsByDay(items, { tripStart });
    expect(m.has(0)).toBe(true);
    expect(m.has(2)).toBe(true);
    expect(m.get(2)[0].cost).toBe(100);
  });

  test('item with no day info (no dayOffset, no dayNumber, no date) → skipped', () => {
    const items = [
      { cost: 99, description: 'mystery line' },
      { dayOffset: 0, cost: 10 },
    ];
    const m = groupItemsByDay(items);
    expect(m.size).toBe(1);
    expect(m.get(0)).toHaveLength(1);
    expect(m.get(0)[0].cost).toBe(10);
  });

  test('negative dayOffset → skipped (defensive — bad upstream data)', () => {
    const items = [
      { dayOffset: -1, cost: 99 },
      { dayOffset: 0, cost: 10 },
    ];
    const m = groupItemsByDay(items);
    expect(m.size).toBe(1);
    expect(m.has(-1)).toBe(false);
    expect(m.has(0)).toBe(true);
  });

  test('unparseable date → skipped (no throw)', () => {
    const items = [
      { date: 'not-a-date', cost: 99 },
      { date: '2026-05-13', cost: 10 },
    ];
    const tripStart = new Date(Date.UTC(2026, 4, 13));
    expect(() => groupItemsByDay(items, { tripStart })).not.toThrow();
    const m = groupItemsByDay(items, { tripStart });
    expect(m.size).toBe(1);
    expect(m.get(0)[0].cost).toBe(10);
  });

  test('null / non-object entries → skipped (defensive)', () => {
    const items = [null, undefined, 'string', 42, { dayOffset: 0, cost: 10 }];
    const m = groupItemsByDay(items);
    expect(m.size).toBe(1);
    expect(m.get(0)).toHaveLength(1);
  });

  test('precedence: dayOffset wins over dayNumber wins over date', () => {
    const tripStart = new Date(Date.UTC(2026, 4, 13));
    // All three set — dayOffset (5) should win
    const m = groupItemsByDay(
      [{ dayOffset: 5, dayNumber: 99, date: '2026-12-25', cost: 10 }],
      { tripStart },
    );
    expect(m.has(5)).toBe(true);
    expect(m.size).toBe(1);
  });

  test('empty input → empty Map', () => {
    expect(groupItemsByDay([]).size).toBe(0);
    expect(groupItemsByDay(null).size).toBe(0);
    expect(groupItemsByDay(undefined).size).toBe(0);
  });
});

describe('computeDayCosts', () => {
  test('3 days with 1 item each → days.length === 3, totalDays === 3', () => {
    const items = [
      { dayOffset: 0, cost: 100, itemType: 'hotel' },
      { dayOffset: 1, cost: 200, itemType: 'flight' },
      { dayOffset: 2, cost: 50, itemType: 'meal' },
    ];
    const r = computeDayCosts(items);
    expect(r.days).toHaveLength(3);
    expect(r.totalDays).toBe(3);
    expect(r.grandTotal).toBe(350);
  });

  test('empty items → grandTotal=0, totalDays=0, averageDailyCost=0 (no division by zero)', () => {
    const r = computeDayCosts([]);
    expect(r.grandTotal).toBe(0);
    expect(r.totalDays).toBe(0);
    expect(r.averageDailyCost).toBe(0);
    expect(r.days).toEqual([]);
  });

  test('grandTotal = sum of per-day totalCosts (rounded)', () => {
    const items = [
      { dayOffset: 0, cost: 33.33 },
      { dayOffset: 1, cost: 33.33 },
      { dayOffset: 2, cost: 33.34 },
    ];
    const r = computeDayCosts(items);
    expect(r.grandTotal).toBe(100);
    expect(r.days.map((d) => d.totalCost)).toEqual([33.33, 33.33, 33.34]);
  });

  test('averageDailyCost = grandTotal / totalDays (rounded to 2dp)', () => {
    const items = [
      { dayOffset: 0, cost: 100 },
      { dayOffset: 1, cost: 200 },
      { dayOffset: 2, cost: 50 },
    ];
    const r = computeDayCosts(items);
    expect(r.grandTotal).toBe(350);
    expect(r.averageDailyCost).toBe(116.67); // 350 / 3 = 116.6667 → 116.67
  });

  test('byType groups costs by itemType within each day', () => {
    const items = [
      { dayOffset: 0, cost: 100, itemType: 'hotel' },
      { dayOffset: 0, cost: 50, itemType: 'meal' },
      { dayOffset: 0, cost: 25, itemType: 'meal' },
      { dayOffset: 0, cost: 200, itemType: 'flight' },
    ];
    const r = computeDayCosts(items);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].byType).toEqual({
      hotel: 100,
      meal: 75,
      flight: 200,
    });
    expect(r.days[0].totalCost).toBe(375);
    expect(r.days[0].itemCount).toBe(4);
  });

  test('byType defaults missing itemType to "other"', () => {
    const items = [
      { dayOffset: 0, cost: 100 }, // no itemType
      { dayOffset: 0, cost: 50, itemType: 'hotel' },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].byType).toEqual({
      other: 100,
      hotel: 50,
    });
  });

  test('days are sorted by dayOffset ascending (regardless of input order)', () => {
    const items = [
      { dayOffset: 5, cost: 10 },
      { dayOffset: 0, cost: 20 },
      { dayOffset: 3, cost: 30 },
      { dayOffset: 1, cost: 40 },
    ];
    const r = computeDayCosts(items);
    expect(r.days.map((d) => d.dayOffset)).toEqual([0, 1, 3, 5]);
  });

  test('rounding edge — 33.33 + 33.33 + 33.34 = 100.00 exact (no float drift)', () => {
    const items = [
      { dayOffset: 0, cost: 33.33 },
      { dayOffset: 0, cost: 33.33 },
      { dayOffset: 0, cost: 33.34 },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].totalCost).toBe(100);
    expect(r.grandTotal).toBe(100);
  });

  test('numeric coercion — cost as string "100.50" treated as 100.50', () => {
    const items = [
      { dayOffset: 0, cost: '100.50', itemType: 'hotel' },
      { dayOffset: 0, cost: '50.25', itemType: 'meal' },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].totalCost).toBe(150.75);
    expect(r.days[0].byType).toEqual({ hotel: 100.5, meal: 50.25 });
  });

  test('missing / NaN cost falls back to 0 (no NaN propagation)', () => {
    const items = [
      { dayOffset: 0, cost: undefined, itemType: 'hotel' },
      { dayOffset: 0, cost: 'abc', itemType: 'meal' },
      { dayOffset: 0, cost: 100, itemType: 'flight' },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].totalCost).toBe(100);
    expect(Number.isNaN(r.grandTotal)).toBe(false);
    expect(r.grandTotal).toBe(100);
  });

  test('mixed precedence (dayOffset + dayNumber + date) end-to-end aggregation', () => {
    const tripStart = new Date(Date.UTC(2026, 4, 13)); // May 13 2026 UTC
    const items = [
      { dayOffset: 0, cost: 100, itemType: 'hotel' },        // day 0
      { dayNumber: 2, cost: 200, itemType: 'flight' },       // day 1
      { date: '2026-05-15', cost: 50, itemType: 'meal' },    // day 2
      { date: '2026-05-15', cost: 25, itemType: 'transport' }, // day 2
    ];
    const r = computeDayCosts(items, { tripStart });
    expect(r.totalDays).toBe(3);
    expect(r.grandTotal).toBe(375);
    expect(r.days[2].byType).toEqual({ meal: 50, transport: 25 });
    expect(r.days[2].itemCount).toBe(2);
  });
});

// ─── #907 slice 5 — per-day margin breakdown (supplier / markup / gst) ─
//
// PRD §3.6(d) pricing transparency: operators need to see the customer-
// facing total (already shipped as `totalCost`) PLUS the supplier-payable
// vs operator-markup vs GST breakdown for the same day. The helper now
// surfaces `supplierCost`, `markupTotal`, `gstTotal` per day AND
// `grandSupplierCost` / `grandMarkupTotal` / `grandGstTotal` on the
// envelope. These tests pin the breakdown contract:
//   * unitCost / markup / gstAmount flow through additively.
//   * Missing components default to 0 (no NaN).
//   * supplierCost falls back to `cost` when unitCost is absent (so
//     callers that only pass top-line cost still get a non-zero supplier
//     figure, with markup/gst=0 — the safe degenerate case).
//   * Grand-totals mirror the per-day shape exactly.
//   * Half-up rounding holds on the new fields.
describe('computeDayCosts — per-day margin breakdown (#907 slice 5)', () => {
  test('exposes supplierCost + markupTotal + gstTotal per day', () => {
    const items = [
      { dayOffset: 0, cost: 10500, unitCost: 8500, markup: 1500, gstAmount: 500, itemType: 'flight' },
      { dayOffset: 0, cost: 7920, unitCost: 6000, markup: 1200, gstAmount: 720, itemType: 'hotel' },
    ];
    const r = computeDayCosts(items);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].totalCost).toBe(18420);
    expect(r.days[0].supplierCost).toBe(14500); // 8500 + 6000
    expect(r.days[0].markupTotal).toBe(2700);   // 1500 + 1200
    expect(r.days[0].gstTotal).toBe(1220);      // 500 + 720
  });

  test('missing markup / gstAmount default to 0 (no NaN propagation)', () => {
    const items = [
      { dayOffset: 0, cost: 100, unitCost: 80, itemType: 'meal' }, // no markup, no gst
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].markupTotal).toBe(0);
    expect(r.days[0].gstTotal).toBe(0);
    expect(r.days[0].supplierCost).toBe(80);
    expect(Number.isNaN(r.days[0].markupTotal)).toBe(false);
    expect(Number.isNaN(r.days[0].gstTotal)).toBe(false);
  });

  test('supplierCost falls back to `cost` when unitCost is absent', () => {
    // Caller only passed top-line cost — supplierCost takes the whole
    // line; markup/gst stay 0. The safe degenerate case.
    const items = [
      { dayOffset: 0, cost: 500, itemType: 'activity' },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].supplierCost).toBe(500);
    expect(r.days[0].markupTotal).toBe(0);
    expect(r.days[0].gstTotal).toBe(0);
  });

  test('grand-totals mirror per-day shape (sum across all days)', () => {
    const items = [
      { dayOffset: 0, cost: 10500, unitCost: 8500, markup: 1500, gstAmount: 500 },
      { dayOffset: 1, cost: 7920, unitCost: 6000, markup: 1200, gstAmount: 720 },
      { dayOffset: 2, cost: 3000, unitCost: 2400, markup: 500, gstAmount: 100 },
    ];
    const r = computeDayCosts(items);
    expect(r.grandTotal).toBe(21420);
    expect(r.grandSupplierCost).toBe(16900); // 8500 + 6000 + 2400
    expect(r.grandMarkupTotal).toBe(3200);   // 1500 + 1200 + 500
    expect(r.grandGstTotal).toBe(1320);      // 500 + 720 + 100
  });

  test('empty items → all grand-totals are 0 (no division-by-zero on derived fields)', () => {
    const r = computeDayCosts([]);
    expect(r.grandSupplierCost).toBe(0);
    expect(r.grandMarkupTotal).toBe(0);
    expect(r.grandGstTotal).toBe(0);
  });

  test('half-up rounding holds for markup/gst/supplier sums', () => {
    // 33.33 × 3 = 99.99 (exact float).
    // 0.555 × 3 = 1.665 (exact-ish float) → round2(1.665 + EPSILON) = 1.67.
    // 1.005 in float is actually 1.00499999... so 1.005 × 3 sums to
    // 3.01499... → round2 = 3.01 (not 3.02 — this is the expected IEEE-754
    // behaviour; the helper's round2 + EPSILON trick still applies but
    // can't compensate for input that's already short of its decimal
    // representation). Pinning the observed values keeps the test honest
    // about what float-precision summation actually produces.
    const items = [
      { dayOffset: 0, cost: 100, unitCost: 33.33, markup: 0.555, gstAmount: 1.005 },
      { dayOffset: 0, cost: 100, unitCost: 33.33, markup: 0.555, gstAmount: 1.005 },
      { dayOffset: 0, cost: 100, unitCost: 33.33, markup: 0.555, gstAmount: 1.005 },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].supplierCost).toBe(99.99);
    expect(r.days[0].markupTotal).toBe(1.67);
    expect(r.days[0].gstTotal).toBe(3.01);
  });

  test('string-numeric coercion holds for markup / gstAmount / unitCost', () => {
    const items = [
      { dayOffset: 0, cost: '100', unitCost: '80', markup: '15', gstAmount: '5' },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].supplierCost).toBe(80);
    expect(r.days[0].markupTotal).toBe(15);
    expect(r.days[0].gstTotal).toBe(5);
  });

  test('back-compat — `totalCost` + `byType` still computed unchanged', () => {
    // Existing consumers (#907 slice 2 + slice 4) read these fields; the
    // slice-5 additions must not alter them.
    const items = [
      { dayOffset: 0, cost: 100, unitCost: 80, markup: 15, gstAmount: 5, itemType: 'hotel' },
      { dayOffset: 0, cost: 50, unitCost: 40, markup: 8, gstAmount: 2, itemType: 'meal' },
    ];
    const r = computeDayCosts(items);
    expect(r.days[0].totalCost).toBe(150);
    expect(r.days[0].byType).toEqual({ hotel: 100, meal: 50 });
    expect(r.totalDays).toBe(1);
    expect(r.grandTotal).toBe(150);
    expect(r.averageDailyCost).toBe(150);
  });
});
