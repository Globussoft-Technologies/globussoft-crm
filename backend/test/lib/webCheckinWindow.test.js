// Unit tests for backend/lib/webCheckinWindow.js
//
// Pins the per-airline T-window calculation. The cron scheduler reads
// windowOpenAt off WebCheckin rows verbatim, so this helper is the
// single source of truth — getting it right at row-creation time is
// load-bearing.

import { describe, test, expect } from "vitest";

const {
  computeWindowOpenAt,
  AIRLINE_WINDOWS_HOURS,
  DEFAULT_WINDOW_HOURS,
} = await import("../../lib/webCheckinWindow.js");

const HOUR_MS = 60 * 60 * 1000;

describe("computeWindowOpenAt", () => {
  test("IndiGo (6E) → T-48h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "6E");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
  });

  test("Air India (AI) → T-48h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "AI");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
  });

  test("Etihad (EY) → T-24h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "EY");
    expect(win.getTime()).toBe(dep.getTime() - 24 * HOUR_MS);
  });

  test("Saudia (SV) → T-24h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "SV");
    expect(win.getTime()).toBe(dep.getTime() - 24 * HOUR_MS);
  });

  test("Air Arabia (G9) → T-24h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "G9");
    expect(win.getTime()).toBe(dep.getTime() - 24 * HOUR_MS);
  });

  test("Unknown airline → DEFAULT_WINDOW_HOURS (48h)", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "ZZ");
    expect(win.getTime()).toBe(dep.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS);
    expect(DEFAULT_WINDOW_HOURS).toBe(48);
  });

  test("Lowercase IATA code is normalised to uppercase (ek → EK)", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "ek");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
  });

  test("Mixed-case alphanumeric IATA code is normalised (6e → 6E → 48h)", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "6e");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
  });

  test("null departureAt → returns null", () => {
    expect(computeWindowOpenAt(null, "6E")).toBeNull();
  });

  test("undefined departureAt → returns null", () => {
    expect(computeWindowOpenAt(undefined, "6E")).toBeNull();
  });

  test("Invalid date string → returns null", () => {
    expect(computeWindowOpenAt("not-a-date", "6E")).toBeNull();
  });

  test("ISO string input is accepted", () => {
    const win = computeWindowOpenAt("2026-06-15T10:00:00Z", "6E");
    expect(win).toBeInstanceOf(Date);
    expect(win.toISOString()).toBe("2026-06-13T10:00:00.000Z");
  });

  test("Date object input is accepted", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "6E");
    expect(win).toBeInstanceOf(Date);
    expect(win.toISOString()).toBe("2026-06-13T10:00:00.000Z");
  });

  test("epoch-ms numeric input is accepted", () => {
    const dep = new Date("2026-06-15T10:00:00Z").getTime();
    const win = computeWindowOpenAt(dep, "6E");
    expect(win.getTime()).toBe(dep - 48 * HOUR_MS);
  });

  test("Result is exactly departure - hours * 3_600_000 ms (millisecond precise)", () => {
    const dep = new Date("2026-06-15T10:30:45.123Z");
    const win = computeWindowOpenAt(dep, "EY"); // 24h
    expect(win.getTime()).toBe(dep.getTime() - 24 * 3_600_000);
  });

  test("Falsy airlineCode (empty string) falls back to default 48h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "");
    expect(win.getTime()).toBe(dep.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS);
  });

  test("Null airlineCode falls back to default 48h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, null);
    expect(win.getTime()).toBe(dep.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS);
  });

  test("AIRLINE_WINDOWS_HOURS table contains all PRD §4.6 Tier-1 carriers", () => {
    // Pins the contract: if a future refactor removes a Tier-1 entry,
    // the cron's window logic silently degrades to 48h default for
    // that carrier — which is wrong for any Tier-1 we ever set to 24h.
    // Keep this assertion in lockstep with the PRD §4.6 table.
    expect(AIRLINE_WINDOWS_HOURS["6E"]).toBe(48);
    expect(AIRLINE_WINDOWS_HOURS.AI).toBe(48);
    expect(AIRLINE_WINDOWS_HOURS.IX).toBe(48);
    expect(AIRLINE_WINDOWS_HOURS.UK).toBe(48);
    expect(AIRLINE_WINDOWS_HOURS.EK).toBe(48);
  });

  // ── Tier-2 (Phase 1.5) 48h carriers explicit pin ──────────────────
  // PRD §4.6 Phase 1.5 promotion: SpiceJet, Akasa, Qatar all open
  // T-48h. If a future refactor flips any of these to 24h (e.g. "we
  // want to start sweeping closer in to save quota") the cron's row
  // creation silently shrinks the window — and downstream sweepers
  // miss the early-bird Tier-2 traveller flow that PRD §4.6 commits to.
  test("SpiceJet (SG) → T-48h (Tier-2)", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "SG");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
    expect(AIRLINE_WINDOWS_HOURS.SG).toBe(48);
  });

  test("Akasa (QP) → T-48h (Tier-2)", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "QP");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
    expect(AIRLINE_WINDOWS_HOURS.QP).toBe(48);
  });

  test("Qatar (QR) → T-48h (Tier-2)", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, "QR");
    expect(win.getTime()).toBe(dep.getTime() - 48 * HOUR_MS);
    expect(AIRLINE_WINDOWS_HOURS.QR).toBe(48);
  });

  // ── Table contract: size, frozen, defaults ────────────────────────
  // Pin the AIRLINE_WINDOWS_HOURS export shape. If a refactor changes
  // the export (e.g. lazy-evaluated getter, mutable object, table-loaded
  // from JSON-with-typos) these are the load-bearing invariants.
  test("AIRLINE_WINDOWS_HOURS table size = 11 + Object.isFrozen", () => {
    expect(Object.keys(AIRLINE_WINDOWS_HOURS).length).toBe(11);
    expect(Object.isFrozen(AIRLINE_WINDOWS_HOURS)).toBe(true);
    expect(DEFAULT_WINDOW_HOURS).toBe(48);
  });

  // ── Defensive coercion: non-string airline codes ──────────────────
  // The SUT does `String(code || "").toUpperCase()`. Boolean true
  // coerces to "true" → "TRUE", not in table → 48h default. Numeric 6
  // coerces to "6", not "6E", so even an IndiGo-passenger-typing-a-number
  // edge case correctly falls through to default rather than silently
  // mismatching "6E". Pins the defensive degrade-to-default behaviour.
  test("Boolean airline code coerces via String() → defaults to 48h", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, true);
    // String(true) === 'true' → 'TRUE' → not in table → default
    expect(win.getTime()).toBe(dep.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS);
  });

  test("Numeric airline code coerces via String() → defaults to 48h (6 ≠ '6E')", () => {
    const dep = new Date("2026-06-15T10:00:00Z");
    const win = computeWindowOpenAt(dep, 6);
    // String(6) === '6' → '6' → not in table (key is '6E' not '6') → default
    expect(win.getTime()).toBe(dep.getTime() - DEFAULT_WINDOW_HOURS * HOUR_MS);
  });

  // ── NaN departure (Number.isFinite gate) ──────────────────────────
  // Distinct from "invalid date string": NaN bypasses the new-Date
  // constructor and lands as departure timestamp directly. Pins that
  // the Number.isFinite check catches it.
  test("NaN departure → null (Number.isFinite gate)", () => {
    expect(computeWindowOpenAt(NaN, "6E")).toBeNull();
  });
});
