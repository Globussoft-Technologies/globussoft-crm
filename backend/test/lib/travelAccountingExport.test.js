// Unit tests for backend/lib/travelAccountingExport.js
//
// Pins the Tally-XML + CA-CSV contracts used by
//   GET /api/travel/invoices/export/tally.xml
//   GET /api/travel/invoices/export/ca.csv
// (TRAVEL_CRM_PRD §4.4 — gap A2, docs/TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md).
// The helpers are PURE — no Prisma, no I/O — so this file mocks nothing.
// Voided-invoice exclusion + date-range/sub-brand filtering live at the
// ROUTE layer (travel_invoices.js) and are covered by the Playwright spec
// e2e/tests/travel-invoices-export-api.spec.js, not here.
//
// Contracts pinned:
//   - escapeXml round-trips & < > " '
//   - fmtTallyDate emits YYYYMMDD; empty on invalid
//   - money2 renders 2dp; non-finite → "0.00"
//   - csvEscape wraps comma/quote/CR/LF per RFC 4180, doubles inner quotes
//   - Tally: empty list → well-formed <ENVELOPE>, zero <TALLYMESSAGE>
//   - Tally: voucher number = invoiceNum, date = YYYYMMDD, party ledger =
//     customer name, narration carries subBrand + legalEntityCode
//   - Tally: intrastate → CGST+SGST blocks, no IGST; interstate → IGST only
//   - Tally: TCS Payable (206C) ledger when tcsAmount > 0, absent at 0
//   - Tally: double-entry invariant — all <AMOUNT>s sum to 0 per voucher
//   - CSV: pinned header; one row per invoice LINE; TCS + Invoice Total
//     only on the first row of each invoice (sum-safe columns)
//   - CSV: zero-line invoice still emits one reconcilable row
//   - CSV: CRLF line endings + trailing CRLF; empty list → header only

import { describe, test, expect } from "vitest";

const {
  buildTallyXml,
  buildCaCsv,
  buildAccountingXlsx,
  escapeXml,
  fmtTallyDate,
  money2,
  round2,
  csvEscape,
  CA_CSV_HEADER,
  ACCOUNTING_XLSX_HEADER,
} = await import("../../lib/travelAccountingExport.js");

const XLSX = (await import("xlsx")).default;

// Parse an XLSX buffer back to an array-of-arrays for assertions.
function xlsxToAoa(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return { sheetNames: wb.SheetNames, aoa: XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) };
}

// Fixture factory — a fully-populated normalized invoice row (the shape
// the route layer hands to both exporters).
function makeInvoice(overrides = {}) {
  return {
    invoiceNum: "TINV-2026-0001",
    date: new Date(2026, 5, 10), // 2026-06-10 local
    customerName: "Ravi Kumar",
    customerGstin: "29ABCDE1234F1Z5",
    subBrand: "tmc",
    legalEntityCode: "GLOB-TMC-PL",
    status: "Issued",
    taxableAmount: 1000,
    cgstAmount: 90,
    sgstAmount: 90,
    igstAmount: 0,
    tcsAmount: 0,
    totalAmount: 1180,
    lines: [
      {
        description: "Bali package — 2 pax",
        sacCode: "9985",
        taxableValue: 1000,
        cgst: 90,
        sgst: 90,
        igst: 0,
      },
    ],
    ...overrides,
  };
}

describe("escapeXml", () => {
  test("escapes the 5 XML metacharacters", () => {
    expect(escapeXml(`<a href="x">"Sharma & Sons" — it's good</a>`)).toBe(
      `&lt;a href=&quot;x&quot;&gt;&quot;Sharma &amp; Sons&quot; — it&apos;s good&lt;/a&gt;`,
    );
  });
  test("returns empty string for null / undefined", () => {
    expect(escapeXml(null)).toBe("");
    expect(escapeXml(undefined)).toBe("");
  });
});

describe("fmtTallyDate", () => {
  test("emits YYYYMMDD with zero padding", () => {
    expect(fmtTallyDate(new Date(2026, 0, 3))).toBe("20260103");
    expect(fmtTallyDate(new Date(2026, 5, 10))).toBe("20260610");
  });
  test("empty string on null / invalid input", () => {
    expect(fmtTallyDate(null)).toBe("");
    expect(fmtTallyDate(undefined)).toBe("");
    expect(fmtTallyDate("not-a-date")).toBe("");
    expect(fmtTallyDate("")).toBe("");
  });
});

describe("money2", () => {
  test("renders 2dp; negatives verbatim", () => {
    expect(money2(1234.5)).toBe("1234.50");
    expect(money2(0)).toBe("0.00");
    expect(money2(-1180)).toBe("-1180.00");
  });
  test("non-finite / null / undefined → 0.00", () => {
    expect(money2(NaN)).toBe("0.00");
    expect(money2(Infinity)).toBe("0.00");
    expect(money2(null)).toBe("0.00");
    expect(money2(undefined)).toBe("0.00");
  });
});

describe("csvEscape", () => {
  test("wraps fields containing comma / quote / newline, doubling quotes", () => {
    expect(csvEscape("Sharma, Sons")).toBe('"Sharma, Sons"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  test("plain strings pass through; null/undefined → empty", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("buildTallyXml", () => {
  test("empty invoices array → well-formed <ENVELOPE>, zero <TALLYMESSAGE>", () => {
    const xml = buildTallyXml([], { tenantName: "Travelstall Pvt Ltd" });
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain("<ENVELOPE>");
    expect(xml).toContain("</ENVELOPE>");
    expect(xml).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
    expect(xml).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    expect(xml).toContain(
      "<SVCURRENTCOMPANY>Travelstall Pvt Ltd</SVCURRENTCOMPANY>",
    );
    expect(xml).not.toContain("<TALLYMESSAGE>");
  });

  test("one invoice → 1 Sales voucher: number, YYYYMMDD date, party ledger", () => {
    const xml = buildTallyXml([makeInvoice()], { tenantName: "Travelstall" });
    expect((xml.match(/<TALLYMESSAGE>/g) || []).length).toBe(1);
    expect(xml).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create">');
    expect(xml).toContain("<VOUCHERNUMBER>TINV-2026-0001</VOUCHERNUMBER>");
    expect(xml).toContain("<DATE>20260610</DATE>");
    expect(xml).toContain("<PARTYLEDGERNAME>Ravi Kumar</PARTYLEDGERNAME>");
    expect(xml).toContain("<AMOUNT>1000.00</AMOUNT>"); // Sales Account leg
    expect(xml).toContain("<AMOUNT>-1180.00</AMOUNT>"); // party receivable leg
  });

  test("narration carries subBrand + legalEntityCode", () => {
    const xml = buildTallyXml([makeInvoice()], { tenantName: "T" });
    expect(xml).toContain(
      "<NARRATION>subBrand=tmc | legalEntity=GLOB-TMC-PL</NARRATION>",
    );
  });

  test("narration omits legalEntity when code is absent", () => {
    const xml = buildTallyXml([makeInvoice({ legalEntityCode: null })], {
      tenantName: "T",
    });
    expect(xml).toContain("<NARRATION>subBrand=tmc</NARRATION>");
    expect(xml).not.toContain("legalEntity=");
  });

  test("intrastate split → CGST + SGST output ledgers, NO IGST", () => {
    const xml = buildTallyXml([makeInvoice()], { tenantName: "T" });
    expect(xml).toContain("<LEDGERNAME>CGST Output</LEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>SGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>IGST Output</LEDGERNAME>");
  });

  test("interstate split → IGST output ledger only, NO CGST / SGST", () => {
    const xml = buildTallyXml(
      [
        makeInvoice({
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 180,
          totalAmount: 1180,
        }),
      ],
      { tenantName: "T" },
    );
    expect(xml).toContain("<LEDGERNAME>IGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>CGST Output</LEDGERNAME>");
    expect(xml).not.toContain("<LEDGERNAME>SGST Output</LEDGERNAME>");
  });

  test("TCS > 0 → TCS Payable (206C) ledger; absent at 0", () => {
    const withTcs = buildTallyXml(
      [
        makeInvoice({
          tcsAmount: 250,
          totalAmount: 1430,
        }),
      ],
      { tenantName: "T" },
    );
    expect(withTcs).toContain("<LEDGERNAME>TCS Payable (206C)</LEDGERNAME>");
    expect(withTcs).toContain("<AMOUNT>250.00</AMOUNT>");

    const noTcs = buildTallyXml([makeInvoice({ tcsAmount: 0 })], {
      tenantName: "T",
    });
    expect(noTcs).not.toContain("TCS Payable");
  });

  test("double-entry invariant: all <AMOUNT>s sum to zero (incl. TCS leg)", () => {
    const xml = buildTallyXml(
      [makeInvoice({ tcsAmount: 250, totalAmount: 1430 })],
      { tenantName: "T" },
    );
    const amounts = Array.from(
      xml.matchAll(/<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g),
    ).map((m) => Number(m[1]));
    // Sales + CGST + SGST + TCS + party = 5 legs
    expect(amounts.length).toBe(5);
    const sum = amounts.reduce((a, n) => a + n, 0);
    expect(Math.abs(sum)).toBeLessThan(0.005);
  });

  test("customer name + tenant name with & are XML-escaped; raw form never leaks", () => {
    const xml = buildTallyXml(
      [makeInvoice({ customerName: "Sharma & Sons" })],
      { tenantName: "Travel & Stall" },
    );
    expect(xml).toContain("<SVCURRENTCOMPANY>Travel &amp; Stall</SVCURRENTCOMPANY>");
    expect(xml).toContain("<PARTYLEDGERNAME>Sharma &amp; Sons</PARTYLEDGERNAME>");
    expect(xml).toContain("<LEDGERNAME>Sharma &amp; Sons</LEDGERNAME>");
    expect(xml).not.toContain("Sharma & Sons");
  });

  test("multiple invoices → one <TALLYMESSAGE> per row", () => {
    const xml = buildTallyXml(
      [
        makeInvoice({ invoiceNum: "TINV-2026-0001" }),
        makeInvoice({ invoiceNum: "TINV-2026-0002", subBrand: "rfu" }),
        makeInvoice({ invoiceNum: "TINV-2026-0003", subBrand: "visasure" }),
      ],
      { tenantName: "T" },
    );
    expect((xml.match(/<TALLYMESSAGE>/g) || []).length).toBe(3);
    expect(xml).toContain("<VOUCHERNUMBER>TINV-2026-0002</VOUCHERNUMBER>");
    expect(xml).toContain("<VOUCHERNUMBER>TINV-2026-0003</VOUCHERNUMBER>");
  });
});

describe("buildCaCsv", () => {
  test("pinned header row (changing it breaks CA spreadsheets)", () => {
    expect(CA_CSV_HEADER).toEqual([
      "Invoice Number",
      "Invoice Date",
      "Customer",
      "Customer GSTIN",
      "Sub-Brand",
      "Legal Entity",
      "Line Description",
      "HSN/SAC",
      "Taxable Value",
      "CGST",
      "SGST",
      "IGST",
      "TCS",
      "Invoice Total",
      "Status",
    ]);
    const csv = buildCaCsv([]);
    expect(csv.split("\r\n")[0]).toBe(CA_CSV_HEADER.join(","));
  });

  test("empty invoice list → header row only, trailing CRLF", () => {
    const csv = buildCaCsv([]);
    expect(csv).toBe(CA_CSV_HEADER.join(",") + "\r\n");
  });

  test("one row per invoice LINE with invoice-identity columns repeated", () => {
    const inv = makeInvoice({
      lines: [
        { description: "Hotel", sacCode: "9963", taxableValue: 600, cgst: 54, sgst: 54, igst: 0 },
        { description: "Transfers", sacCode: "9985", taxableValue: 400, cgst: 36, sgst: 36, igst: 0 },
      ],
    });
    const rows = buildCaCsv([inv]).trimEnd().split("\r\n");
    expect(rows.length).toBe(3); // header + 2 line rows
    const r1 = rows[1].split(",");
    const r2 = rows[2].split(",");
    // identity columns repeat
    expect(r1[0]).toBe("TINV-2026-0001");
    expect(r2[0]).toBe("TINV-2026-0001");
    expect(r1[1]).toBe("2026-06-10");
    expect(r2[1]).toBe("2026-06-10");
    expect(r1[2]).toBe("Ravi Kumar");
    expect(r1[3]).toBe("29ABCDE1234F1Z5");
    expect(r1[4]).toBe("tmc");
    expect(r1[5]).toBe("GLOB-TMC-PL");
    // line columns differ
    expect(r1[6]).toBe("Hotel");
    expect(r1[7]).toBe("9963");
    expect(r1[8]).toBe("600.00");
    expect(r2[6]).toBe("Transfers");
    expect(r2[7]).toBe("9985");
    expect(r2[8]).toBe("400.00");
    // status on every row
    expect(r1[14]).toBe("Issued");
    expect(r2[14]).toBe("Issued");
  });

  test("TCS + Invoice Total emitted only on the FIRST row of each invoice (sum-safe)", () => {
    const inv = makeInvoice({
      tcsAmount: 250,
      totalAmount: 1430,
      lines: [
        { description: "A", sacCode: "9985", taxableValue: 600, cgst: 54, sgst: 54, igst: 0 },
        { description: "B", sacCode: "9985", taxableValue: 400, cgst: 36, sgst: 36, igst: 0 },
      ],
    });
    const rows = buildCaCsv([inv]).trimEnd().split("\r\n");
    const r1 = rows[1].split(",");
    const r2 = rows[2].split(",");
    expect(r1[12]).toBe("250.00"); // TCS, first row
    expect(r1[13]).toBe("1430.00"); // Invoice Total, first row
    expect(r2[12]).toBe(""); // continuation row blank
    expect(r2[13]).toBe("");
  });

  test("zero-line invoice still emits one reconcilable row", () => {
    const inv = makeInvoice({ lines: [], taxableAmount: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, totalAmount: 0 });
    const rows = buildCaCsv([inv]).trimEnd().split("\r\n");
    expect(rows.length).toBe(2);
    const r = rows[1].split(",");
    expect(r[0]).toBe("TINV-2026-0001");
    expect(r[6]).toBe(""); // no line description
    expect(r[7]).toBe(""); // no SAC
    expect(r[8]).toBe("0.00");
    expect(r[13]).toBe("0.00");
    expect(r[14]).toBe("Issued");
  });

  test("missing GSTIN / legalEntity render as empty cells, not 'null'", () => {
    const inv = makeInvoice({ customerGstin: null, legalEntityCode: null });
    const rows = buildCaCsv([inv]).trimEnd().split("\r\n");
    const r = rows[1].split(",");
    expect(r[3]).toBe("");
    expect(r[5]).toBe("");
    expect(rows[1]).not.toContain("null");
    expect(rows[1]).not.toContain("undefined");
  });

  test("commas / quotes / newlines in customer + description are RFC-4180 escaped", () => {
    const inv = makeInvoice({
      customerName: 'Sharma, "Sons" & Co',
      lines: [
        {
          description: "Line with, comma\nand newline",
          sacCode: "9985",
          taxableValue: 1000,
          cgst: 90,
          sgst: 90,
          igst: 0,
        },
      ],
    });
    const csv = buildCaCsv([inv]);
    expect(csv).toContain('"Sharma, ""Sons"" & Co"');
    expect(csv).toContain('"Line with, comma\nand newline"');
  });

  test("uses CRLF line endings throughout", () => {
    const csv = buildCaCsv([makeInvoice()]);
    expect(csv.endsWith("\r\n")).toBe(true);
    // No bare-LF rows: every \n is preceded by \r outside quoted cells.
    const withoutQuoted = csv.replace(/"[^"]*"/g, "");
    expect(withoutQuoted.includes("\n")).toBe(true);
    expect(/[^\r]\n/.test(withoutQuoted)).toBe(false);
  });
});

describe("round2", () => {
  test("rounds to 2dp as a NUMBER (not a string)", () => {
    expect(round2(1.005)).toBe(1.0); // float-repr: 1.005 → 1.00 (binary), documented
    expect(round2(90.126)).toBe(90.13);
    expect(round2(1000)).toBe(1000);
    expect(typeof round2(5)).toBe("number");
  });
  test("non-finite / null / undefined → 0", () => {
    expect(round2(null)).toBe(0);
    expect(round2(undefined)).toBe(0);
    expect(round2(NaN)).toBe(0);
    expect(round2("abc")).toBe(0);
  });
});

describe("buildAccountingXlsx", () => {
  test("empty list → header row + zeroed TOTAL row, single 'Invoices' sheet", () => {
    const { sheetNames, aoa } = xlsxToAoa(buildAccountingXlsx([]));
    expect(sheetNames).toEqual(["Invoices"]);
    expect(aoa[0]).toEqual(ACCOUNTING_XLSX_HEADER);
    const totalRow = aoa[aoa.length - 1];
    expect(totalRow[0]).toBe("TOTAL");
    // money columns (7..12) all zero
    [7, 8, 9, 10, 11, 12].forEach((c) => expect(Number(totalRow[c])).toBe(0));
  });

  test("one row per invoice with identity + numeric money cells", () => {
    const { aoa } = xlsxToAoa(buildAccountingXlsx([makeInvoice()]));
    expect(aoa[0]).toEqual(ACCOUNTING_XLSX_HEADER);
    const r = aoa[1];
    expect(r[0]).toBe("TINV-2026-0001");
    expect(r[1]).toBe("2026-06-10");
    expect(r[2]).toBe("Ravi Kumar");
    expect(r[3]).toBe("29ABCDE1234F1Z5");
    expect(r[4]).toBe("tmc");
    expect(r[5]).toBe("GLOB-TMC-PL");
    expect(r[6]).toBe("Issued");
    // money cells are REAL numbers, so SUM works in Excel
    expect(r[7]).toBe(1000); // taxable
    expect(r[8]).toBe(90); // cgst
    expect(r[9]).toBe(90); // sgst
    expect(r[10]).toBe(0); // igst
    expect(r[11]).toBe(0); // tcs
    expect(r[12]).toBe(1180); // total
    expect(typeof r[7]).toBe("number");
  });

  test("TOTAL row sums every money column across invoices", () => {
    const a = makeInvoice({ invoiceNum: "A", taxableAmount: 1000, cgstAmount: 90, sgstAmount: 90, igstAmount: 0, tcsAmount: 0, totalAmount: 1180 });
    const b = makeInvoice({ invoiceNum: "B", taxableAmount: 500, cgstAmount: 0, sgstAmount: 0, igstAmount: 90, tcsAmount: 25, totalAmount: 615 });
    const { aoa } = xlsxToAoa(buildAccountingXlsx([a, b]));
    const totalRow = aoa[aoa.length - 1];
    expect(totalRow[0]).toBe("TOTAL");
    expect(Number(totalRow[7])).toBe(1500); // taxable
    expect(Number(totalRow[8])).toBe(90); // cgst
    expect(Number(totalRow[9])).toBe(90); // sgst
    expect(Number(totalRow[10])).toBe(90); // igst
    expect(Number(totalRow[11])).toBe(25); // tcs
    expect(Number(totalRow[12])).toBe(1795); // grand total
  });

  test("total falls back to taxable+gst+tcs when totalAmount missing/zero", () => {
    const inv = makeInvoice({ totalAmount: 0, taxableAmount: 1000, cgstAmount: 90, sgstAmount: 90, igstAmount: 0, tcsAmount: 0 });
    const { aoa } = xlsxToAoa(buildAccountingXlsx([inv]));
    expect(aoa[1][12]).toBe(1180);
  });

  test("missing GSTIN / legalEntity render as empty cells, never 'null'", () => {
    const { aoa } = xlsxToAoa(buildAccountingXlsx([makeInvoice({ customerGstin: null, legalEntityCode: null })]));
    expect(aoa[1][3]).toBe("");
    expect(aoa[1][5]).toBe("");
  });

  test("custom sheetName honoured and clamped to 31 chars", () => {
    const { sheetNames } = xlsxToAoa(buildAccountingXlsx([], { sheetName: "x".repeat(40) }));
    expect(sheetNames[0].length).toBe(31);
  });
});
