// @ts-check
// lib/cancellationRefund.js — cancellation-policy refund math (pure functions).
import { describe, test, expect } from "vitest";
import { createRequire } from "module";

const requireCJS = createRequire(import.meta.url);
const { daysUntil, pickRefundPercent, computeRefund } = requireCJS("../../lib/cancellationRefund");

const TIERS = [
  { daysBeforeServiceStart: 30, refundPercent: 100 },
  { daysBeforeServiceStart: 7, refundPercent: 50 },
  { daysBeforeServiceStart: 0, refundPercent: 0 },
];

describe("daysUntil", () => {
  test("floors whole days from now to start", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    expect(daysUntil(new Date("2026-07-21T00:00:00Z"), now)).toBe(20);
    expect(daysUntil(new Date("2026-07-01T12:00:00Z"), now)).toBe(0); // same day, hours don't count
  });
  test("negative once the trip has started; null when no/invalid date", () => {
    const now = new Date("2026-07-10T00:00:00Z");
    expect(daysUntil(new Date("2026-07-05T00:00:00Z"), now)).toBe(-5);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("not-a-date", now)).toBeNull();
  });
});

describe("pickRefundPercent", () => {
  test("selects the largest tier whose threshold is <= days remaining", () => {
    expect(pickRefundPercent(TIERS, 45)).toBe(100); // 45 >= 30
    expect(pickRefundPercent(TIERS, 30)).toBe(100); // boundary
    expect(pickRefundPercent(TIERS, 20)).toBe(50);  // 7 <= 20 < 30
    expect(pickRefundPercent(TIERS, 7)).toBe(50);   // boundary
    expect(pickRefundPercent(TIERS, 3)).toBe(0);    // 0 <= 3 < 7
  });
  test("trip already started → most restrictive (0)", () => {
    expect(pickRefundPercent(TIERS, -2)).toBe(0);
  });
  test("null when tiers empty or days unknown", () => {
    expect(pickRefundPercent([], 10)).toBeNull();
    expect(pickRefundPercent(TIERS, null)).toBeNull();
    expect(pickRefundPercent(undefined, 10)).toBeNull();
  });
  test("clamps a bad percent into [0,100]", () => {
    expect(pickRefundPercent([{ daysBeforeServiceStart: 0, refundPercent: 150 }], 5)).toBe(100);
    expect(pickRefundPercent([{ daysBeforeServiceStart: 0, refundPercent: -10 }], 5)).toBe(0);
  });
});

describe("computeRefund", () => {
  test("applies the percent to the paid amount", () => {
    expect(computeRefund({ tiers: TIERS, daysRemaining: 20, paidAmount: 10000 }))
      .toEqual({ refundPercent: 50, retentionPercent: 50, refundAmount: 5000, computable: true });
  });
  test("full refund well before the trip", () => {
    expect(computeRefund({ tiers: TIERS, daysRemaining: 45, paidAmount: 9416.5 }))
      .toMatchObject({ refundPercent: 100, refundAmount: 9416.5, computable: true });
  });
  test("rounds to 2 decimals", () => {
    const r = computeRefund({ tiers: [{ daysBeforeServiceStart: 0, refundPercent: 33 }], daysRemaining: 1, paidAmount: 100 });
    expect(r.refundAmount).toBe(33); // 100 * 33% = 33
  });
  test("not computable without a policy or a date → caller decides manually", () => {
    expect(computeRefund({ tiers: [], daysRemaining: 10, paidAmount: 5000 }))
      .toMatchObject({ computable: false, refundAmount: null });
    expect(computeRefund({ tiers: TIERS, daysRemaining: null, paidAmount: 5000 }))
      .toMatchObject({ computable: false });
  });
});
