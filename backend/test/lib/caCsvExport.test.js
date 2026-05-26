// Unit tests for backend/lib/caCsvExport.js
//
// Pins the CA-friendly CSV contract used by GET /api/billing/export/ca-summary.csv
// (PRD §4.4 CA / Tally export). Pure helper — no Prisma, no I/O.
//
// Contracts pinned:
//   - csvEscape doubles embedded quotes; wraps when value contains
//     `,` / `"` / `\n` / `\r`; leaves clean strings unwrapped
//   - Empty invoices array → just the header row + trailing newline
//   - One invoice → header + 1 data row
//   - Contact names with embedded commas are quoted properly
//   - Amounts are 2dp
//   - Newlines in notes → row is quoted and newline preserved (RFC 4180)
//   - Header order is the pinned canonical sequence (changing it
//     breaks the accountant's downstream spreadsheets — gated)

import { describe, test, expect } from "vitest";

const { buildCaCsv, csvEscape, CSV_HEADER } = await import(
  "../../lib/caCsvExport.js"
);

describe("csvEscape", () => {
  test("clean string is returned unwrapped", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape("INV-001")).toBe("INV-001");
  });
  test("wraps in quotes when value contains a comma", () => {
    expect(csvEscape("Sharma, Sons")).toBe(`"Sharma, Sons"`);
  });
  test("wraps in quotes when value contains a newline (LF) or CR", () => {
    expect(csvEscape("line1\nline2")).toBe(`"line1\nline2"`);
    expect(csvEscape("line1\r\nline2")).toBe(`"line1\r\nline2"`);
  });
  test("doubles embedded quotes and wraps", () => {
    expect(csvEscape(`She said "hi"`)).toBe(`"She said ""hi"""`);
  });
  test("null / undefined → empty string", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
  test("multiple embedded quotes are all doubled", () => {
    // 4 quotes in the input → 8 doubled quotes inside + 2 wrapping quotes
    expect(csvEscape(`"a"b"c"`)).toBe(`"""a""b""c"""`);
  });
  test("object input coerces via String() → '[object Object]'", () => {
    // Defensive: a downstream caller passing an accidentally non-string
    // (e.g. a Prisma Decimal that wasn't stringified) must not crash.
    expect(csvEscape({})).toBe("[object Object]");
  });
});

describe("buildCaCsv", () => {
  test("empty invoices array → just the pinned header row + trailing newline", () => {
    const csv = buildCaCsv([]);
    expect(csv).toBe(CSV_HEADER.join(",") + "\n");
    expect(csv.endsWith("\n")).toBe(true);
  });

  test("header order is the canonical sequence (regression: changing the order breaks accountant spreadsheets)", () => {
    const csv = buildCaCsv([]);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe(
      "Invoice Number,Issue Date,Contact Name,Billing State,Subtotal (Taxable),CGST,SGST,IGST,Total,Status,Sub-Brand,Notes"
    );
  });

  test("one invoice → header + 1 data row, comma-separated", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-001",
        issueDate: new Date(2026, 4, 21),
        contactName: "Ravi Kumar",
        billingState: "Karnataka",
        subtotal: 1000,
        cgstAmount: 90,
        sgstAmount: 90,
        igstAmount: 0,
        totalAmount: 1180,
        status: "UNPAID",
        subBrand: "travelstall",
        notes: "Bali package",
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toBe(
      "INV-001,2026-05-21,Ravi Kumar,Karnataka,1000.00,90.00,90.00,0.00,1180.00,UNPAID,travelstall,Bali package"
    );
  });

  test("contact name with embedded comma is quoted properly", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-002",
        issueDate: new Date(2026, 4, 21),
        contactName: "Sharma, Sons & Co",
        billingState: "Karnataka",
        subtotal: 500,
        totalAmount: 500,
      },
    ]);
    const dataRow = csv.trim().split("\n")[1];
    expect(dataRow).toContain(`"Sharma, Sons & Co"`);
  });

  test("amounts formatted to 2dp", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-003",
        issueDate: new Date(2026, 4, 21),
        contactName: "C",
        subtotal: 123.456,
        cgstAmount: 11.1,
        sgstAmount: 11.1,
        totalAmount: 145.66,
      },
    ]);
    const dataRow = csv.trim().split("\n")[1];
    expect(dataRow).toContain("123.46");
    expect(dataRow).toContain("11.10");
    expect(dataRow).toContain("145.66");
  });

  test("newline in notes field → row is quoted and the newline is preserved (RFC 4180)", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-004",
        issueDate: new Date(2026, 4, 21),
        contactName: "Customer",
        subtotal: 100,
        totalAmount: 100,
        notes: "line one\nline two",
      },
    ]);
    // Trim trailing newline only, then assert the inner CRLF/LF stays.
    expect(csv.endsWith("\n")).toBe(true);
    // The notes column is the last one — it must contain a quoted
    // multi-line value. Easiest check: a literal `"line one\nline two"`
    // substring is present anywhere in the file.
    expect(csv).toContain(`"line one\nline two"`);
  });

  test("multiple invoices produce one row per invoice plus header", () => {
    const csv = buildCaCsv([
      { invoiceNumber: "A", issueDate: new Date(2026, 4, 1), contactName: "A", subtotal: 100, totalAmount: 100 },
      { invoiceNumber: "B", issueDate: new Date(2026, 4, 2), contactName: "B", subtotal: 200, totalAmount: 200 },
      { invoiceNumber: "C", issueDate: new Date(2026, 4, 3), contactName: "C", subtotal: 300, totalAmount: 300 },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines.length).toBe(4); // header + 3 rows
  });

  test("non-finite amounts default to 0.00 (graceful degradation)", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-005",
        issueDate: new Date(2026, 4, 21),
        contactName: "C",
        subtotal: NaN,
        totalAmount: undefined,
      },
    ]);
    const dataRow = csv.trim().split("\n")[1];
    // Subtotal + Total columns both render 0.00 instead of "NaN" / "undefined".
    expect(dataRow).toMatch(/,0\.00,/);
  });

  test("non-array input (null / undefined / string) → just the header + trailing newline", () => {
    // Defensive: `Array.isArray` falls through to [] so a misbehaving
    // caller passing null can't crash the route.
    const expected = CSV_HEADER.join(",") + "\n";
    expect(buildCaCsv(null)).toBe(expected);
    expect(buildCaCsv(undefined)).toBe(expected);
    expect(buildCaCsv("not-array")).toBe(expected);
    expect(buildCaCsv({ length: 1 })).toBe(expected); // array-like but not an Array
  });

  test("invalid Date → empty cell (column count stays stable)", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-006",
        issueDate: new Date("not-a-real-date"),
        contactName: "Customer",
        subtotal: 100,
        totalAmount: 100,
      },
    ]);
    const dataRow = csv.trim().split("\n")[1];
    // Issue Date is the 2nd column → must render as empty between the commas
    // (NOT "Invalid Date" or "NaN-NaN-NaN").
    expect(dataRow.startsWith("INV-006,,Customer,")).toBe(true);
    // Total column count is still 12 (header has 11 commas; data row too).
    expect((dataRow.match(/,/g) || []).length).toBe(11);
  });

  test("Infinity amount → '0.00' (Number.isFinite gate)", () => {
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-007",
        issueDate: new Date(2026, 4, 21),
        contactName: "C",
        subtotal: Infinity,
        totalAmount: -Infinity,
      },
    ]);
    const dataRow = csv.trim().split("\n")[1];
    // Both subtotal + total degrade to 0.00 — not "Infinity" / "-Infinity".
    expect(dataRow).not.toContain("Infinity");
    expect(dataRow).toMatch(/,0\.00,/);
  });

  test("Dec 31 boundary → month index 11 padded to '12', day padded to '31'", () => {
    // Regression guard: getMonth() is 0-indexed; off-by-one would render
    // "2026-11-31" or "2026-12-1" instead of "2026-12-31".
    const csv = buildCaCsv([
      {
        invoiceNumber: "INV-008",
        issueDate: new Date(2026, 11, 31),
        contactName: "C",
        subtotal: 100,
        totalAmount: 100,
      },
    ]);
    const dataRow = csv.trim().split("\n")[1];
    expect(dataRow).toContain("2026-12-31");
  });

  test("both empty array and non-empty list end with exactly ONE trailing newline (no doubling)", () => {
    const emptyCsv = buildCaCsv([]);
    expect(emptyCsv.endsWith("\n")).toBe(true);
    expect(emptyCsv.endsWith("\n\n")).toBe(false);

    const oneRowCsv = buildCaCsv([
      {
        invoiceNumber: "X",
        issueDate: new Date(2026, 4, 21),
        contactName: "Y",
        subtotal: 100,
        totalAmount: 100,
      },
    ]);
    expect(oneRowCsv.endsWith("\n")).toBe(true);
    expect(oneRowCsv.endsWith("\n\n")).toBe(false);
  });
});

describe("CSV_HEADER export shape", () => {
  test("has exactly 12 columns in the canonical order", () => {
    // Pinned — accountants build downstream spreadsheets keyed on this
    // exact sequence. Changing it is a breaking-shape change.
    expect(CSV_HEADER).toEqual([
      "Invoice Number",
      "Issue Date",
      "Contact Name",
      "Billing State",
      "Subtotal (Taxable)",
      "CGST",
      "SGST",
      "IGST",
      "Total",
      "Status",
      "Sub-Brand",
      "Notes",
    ]);
    expect(CSV_HEADER).toHaveLength(12);
    expect(CSV_HEADER[0]).toBe("Invoice Number");
    expect(CSV_HEADER[CSV_HEADER.length - 1]).toBe("Notes");
  });
});
