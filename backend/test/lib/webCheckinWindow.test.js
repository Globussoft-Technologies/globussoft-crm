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
});
