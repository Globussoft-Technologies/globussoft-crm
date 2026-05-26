// Unit tests for backend/lib/travelFiscalYear.js
//
// Pins the Indian fiscal-year math (April 1 → March 31) + the
// sub-brand prefix builder feeding #901 slice 5's per-FY invoice
// numbering. UTC-based throughout — see lib/travelFiscalYear.js header
// for rationale (cron-safety + date-only ISO inputs + no DST in IST).

import { describe, test, expect } from "vitest";

const { fiscalYearLabel, fiscalYearStart, fiscalYearEnd, invoicePrefixFor } =
  await import("../../lib/travelFiscalYear.js");

describe("fiscalYearLabel", () => {
  test("April 1 is the FIRST day of the FY (boundary, inclusive)", () => {
    expect(fiscalYearLabel(new Date("2026-04-01"))).toBe("26-27");
  });

  test("mid-FY date (May) lands in the same FY label", () => {
    expect(fiscalYearLabel(new Date("2026-05-15"))).toBe("26-27");
  });

  test("March 31 is the LAST day of the FY (boundary, still 26-27)", () => {
    expect(fiscalYearLabel(new Date("2027-03-31"))).toBe("26-27");
  });

  test("April 1 of the NEXT calendar year rolls the FY label forward", () => {
    expect(fiscalYearLabel(new Date("2027-04-01"))).toBe("27-28");
  });

  test("January falls in the PRIOR FY (Jan/Feb/Mar are still 25-26)", () => {
    expect(fiscalYearLabel(new Date("2026-01-15"))).toBe("25-26");
  });

  test("March 31 of the prior calendar year is the very last day of FY 25-26", () => {
    expect(fiscalYearLabel(new Date("2026-03-31"))).toBe("25-26");
  });

  test("default-date overload returns a label matching /^\\d{2}-\\d{2}$/", () => {
    expect(fiscalYearLabel()).toMatch(/^\d{2}-\d{2}$/);
  });

  test("century rollover formats both years two-digit (e.g. 99-00, 00-01)", () => {
    expect(fiscalYearLabel(new Date("1999-05-01"))).toBe("99-00");
    expect(fiscalYearLabel(new Date("2000-05-01"))).toBe("00-01");
  });
});

describe("fiscalYearStart", () => {
  test("for a May date, FY-start is April 1 UTC of the same calendar year", () => {
    expect(fiscalYearStart(new Date("2026-05-15")).getTime()).toBe(
      new Date(Date.UTC(2026, 3, 1, 0, 0, 0, 0)).getTime()
    );
  });

  test("for a February date, FY-start is April 1 UTC of the PRIOR calendar year", () => {
    expect(fiscalYearStart(new Date("2026-02-15")).getTime()).toBe(
      new Date(Date.UTC(2025, 3, 1, 0, 0, 0, 0)).getTime()
    );
  });

  test("for April 1 itself, FY-start is the same instant (idempotent boundary)", () => {
    expect(fiscalYearStart(new Date("2026-04-01")).getTime()).toBe(
      new Date(Date.UTC(2026, 3, 1, 0, 0, 0, 0)).getTime()
    );
  });
});

describe("fiscalYearEnd", () => {
  test("for a May date, FY-end is April 1 UTC of the NEXT calendar year (exclusive)", () => {
    expect(fiscalYearEnd(new Date("2026-05-15")).getTime()).toBe(
      new Date(Date.UTC(2027, 3, 1, 0, 0, 0, 0)).getTime()
    );
  });

  test("FY range [start, end) covers exactly one year and excludes the next April 1", () => {
    const ref = new Date("2026-05-15");
    const start = fiscalYearStart(ref);
    const end = fiscalYearEnd(ref);
    // end - start = 365 or 366 days (depending on whether the FY contains Feb 29)
    const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect([365, 366]).toContain(days);
  });
});

describe("invoicePrefixFor", () => {
  test("tmc → TMC/26-27", () => {
    expect(invoicePrefixFor("tmc", new Date("2026-05-15"))).toBe("TMC/26-27");
  });

  test("rfu → RFU/26-27", () => {
    expect(invoicePrefixFor("rfu", new Date("2026-05-15"))).toBe("RFU/26-27");
  });

  test("travel_stall → TS/26-27 (short label, not uppercase slug)", () => {
    expect(invoicePrefixFor("travel_stall", new Date("2026-05-15"))).toBe(
      "TS/26-27"
    );
  });

  test("visa_sure → VS/26-27 (short label, not uppercase slug)", () => {
    expect(invoicePrefixFor("visa_sure", new Date("2026-05-15"))).toBe(
      "VS/26-27"
    );
  });

  test("unknown sub-brand falls back to upper-cased slug", () => {
    expect(invoicePrefixFor("unknown_brand", new Date("2026-05-15"))).toBe(
      "UNKNOWN_BRAND/26-27"
    );
  });

  test("date in PRIOR FY (Feb) uses the prior FY label", () => {
    expect(invoicePrefixFor("tmc", new Date("2026-02-15"))).toBe("TMC/25-26");
  });

  test("case-insensitive sub-brand slug (TMC / Tmc / tmc all resolve to TMC)", () => {
    expect(invoicePrefixFor("TMC", new Date("2026-05-15"))).toBe("TMC/26-27");
    expect(invoicePrefixFor("Tmc", new Date("2026-05-15"))).toBe("TMC/26-27");
  });

  // --- Extended coverage: falsy / odd inputs, FY-length boundary, UTC anchoring proof, round-trip ---

  test("null sub-brand → falls back to '' slug → prefix is just '/<fy>'", () => {
    // String(null || '') = '' → upper('') = '' → label = '' → "/26-27"
    expect(invoicePrefixFor(null, new Date("2026-05-15"))).toBe("/26-27");
  });

  test("undefined sub-brand → same '/<fy>' shape as null (falsy coalesce)", () => {
    expect(invoicePrefixFor(undefined, new Date("2026-05-15"))).toBe("/26-27");
  });

  test("empty-string sub-brand → '/<fy>' (no label, separator still present)", () => {
    expect(invoicePrefixFor("", new Date("2026-05-15"))).toBe("/26-27");
  });

  test("numeric 0 sub-brand (falsy) → '/<fy>' via the `|| ''` short-circuit", () => {
    expect(invoicePrefixFor(0, new Date("2026-05-15"))).toBe("/26-27");
  });

  test("uppercase 'TRAVEL_STALL' lowercases into the map key → 'TS/<fy>', not 'TRAVEL_STALL/<fy>'", () => {
    // Pins the lowercase-coercion step BEFORE map lookup; without it the call would
    // miss the map and fall through to the upper-cased-slug branch.
    expect(invoicePrefixFor("TRAVEL_STALL", new Date("2026-05-15"))).toBe("TS/26-27");
  });

  test("mixed-case 'Visa_Sure' also resolves to the short 'VS' label", () => {
    expect(invoicePrefixFor("Visa_Sure", new Date("2026-05-15"))).toBe("VS/26-27");
  });
});

describe("UTC anchoring + boundary semantics", () => {
  test("fiscalYearStart returns UTC midnight (getUTCHours/Minutes/Seconds/ms all 0)", () => {
    const s = fiscalYearStart(new Date("2026-05-15"));
    expect(s.getUTCHours()).toBe(0);
    expect(s.getUTCMinutes()).toBe(0);
    expect(s.getUTCSeconds()).toBe(0);
    expect(s.getUTCMilliseconds()).toBe(0);
    expect(s.getUTCMonth()).toBe(3); // April
    expect(s.getUTCDate()).toBe(1);
    expect(s.getUTCFullYear()).toBe(2026);
  });

  test("fiscalYearEnd returns UTC midnight of next FY's April 1 (exclusive boundary, ISO ends T00:00:00.000Z)", () => {
    const e = fiscalYearEnd(new Date("2026-05-15"));
    expect(e.toISOString()).toBe("2027-04-01T00:00:00.000Z");
  });

  test("FY 26-27 is exactly 365 days (April 2026 → April 2027 contains Feb 2027, NOT a leap year)", () => {
    const ref = new Date("2026-08-15");
    const days = (fiscalYearEnd(ref).getTime() - fiscalYearStart(ref).getTime()) / 86_400_000;
    expect(days).toBe(365);
  });

  test("FY 23-24 is exactly 366 days (contains Feb 29 2024 — leap year proof)", () => {
    // Sanity-check the other branch of the [365,366] envelope. Feb 29 2024 falls
    // inside the FY 23-24 window (April 2023 → April 2024).
    const ref = new Date("2023-08-15");
    const days = (fiscalYearEnd(ref).getTime() - fiscalYearStart(ref).getTime()) / 86_400_000;
    expect(days).toBe(366);
  });

  test("Dec 31 and Jan 1 across a calendar-year boundary share the same FY label (boundary != FY edge)", () => {
    expect(fiscalYearLabel(new Date("2026-12-31"))).toBe("26-27");
    expect(fiscalYearLabel(new Date("2027-01-01"))).toBe("26-27");
  });

  test("mid-FY date d satisfies start <= d < end (half-open window)", () => {
    const d = new Date("2026-08-15");
    expect(fiscalYearStart(d).getTime()).toBeLessThanOrEqual(d.getTime());
    expect(d.getTime()).toBeLessThan(fiscalYearEnd(d).getTime());
  });

  test("invoicePrefixFor round-trip: prefix derived from fiscalYearStart(d) == prefix from d itself", () => {
    const d = new Date("2026-08-15");
    expect(invoicePrefixFor("tmc", d)).toBe(invoicePrefixFor("tmc", fiscalYearStart(d)));
  });

  test("default-date overload of fiscalYearStart / fiscalYearEnd returns finite valid Dates", () => {
    expect(Number.isFinite(fiscalYearStart().getTime())).toBe(true);
    expect(Number.isFinite(fiscalYearEnd().getTime())).toBe(true);
  });

  test("label uses '-' as separator (no underscore / slash / em-dash leak)", () => {
    expect(fiscalYearLabel(new Date("2026-05-15"))).toMatch(/^\d{2}-\d{2}$/);
    expect(fiscalYearLabel(new Date("2026-05-15"))).toContain("-");
  });
});

describe("module export surface", () => {
  test("SUB_BRAND_LABEL is NOT exported — only the four public functions are", async () => {
    const mod = await import("../../lib/travelFiscalYear.js");
    // Private internal map should not leak. If a future refactor exposes it,
    // this test fires so we can decide consciously whether to widen the surface.
    expect(mod.SUB_BRAND_LABEL).toBeUndefined();
    expect(typeof mod.fiscalYearLabel).toBe("function");
    expect(typeof mod.fiscalYearStart).toBe("function");
    expect(typeof mod.fiscalYearEnd).toBe("function");
    expect(typeof mod.invoicePrefixFor).toBe("function");
  });
});
