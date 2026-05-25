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
});
