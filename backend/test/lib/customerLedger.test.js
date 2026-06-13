// Unit tests for backend/lib/customerLedger.js
//
// PRD_TRAVEL_GST_COMPLIANCE G030 (FR-3.4.4) — per-customer ledger across FY.
// Pure-math helpers tested in isolation; the Prisma load + auth gate lives at
// the route layer (backend/routes/travel_invoice_ledgers.js) and is covered by
// the Playwright spec e2e/tests/travel-invoice-ledgers-api.spec.js.
//
// Contracts pinned:
//   - toMoney rounds 2dp; null / NaN → 0
//   - computeOpeningBalance sums debit minus credit
//   - buildCustomerLedger: invoice → debit, credit-note → credit, payment → credit
//   - opening balance = pre-FY net debits
//   - running balance walks chronologically
//   - same-day ordering: invoice → credit-note → payment
//   - buildCustomerLedgerCsv emits header + opening row + N transactions + closing row
//   - csvEscape: RFC 4180 quote-wrap on commas / quotes / CR / LF
//   - fyBoundaries: round-trips a long FY label to UTC midnight boundaries

import { describe, test, expect } from "vitest";

const {
  toMoney,
  computeOpeningBalance,
  buildCustomerLedger,
  buildCustomerLedgerCsv,
  csvEscape,
  fyBoundaries,
} = await import("../../lib/customerLedger.js");

describe("toMoney", () => {
  test("rounds to 2dp", () => {
    expect(toMoney(1.235)).toBeCloseTo(1.24, 2);
    expect(toMoney(1.004)).toBe(1.0);
    expect(toMoney(123.456)).toBe(123.46);
  });
  test("null / NaN / undefined → 0", () => {
    expect(toMoney(null)).toBe(0);
    expect(toMoney(undefined)).toBe(0);
    expect(toMoney("not a number")).toBe(0);
  });
  test("accepts string-Decimal shape", () => {
    expect(toMoney("123.456")).toBe(123.46);
  });
});

describe("computeOpeningBalance", () => {
  test("empty array → 0", () => {
    expect(computeOpeningBalance([])).toBe(0);
  });
  test("debits minus credits", () => {
    expect(
      computeOpeningBalance([
        { debit: 1000, credit: 0 },
        { debit: 0, credit: 400 },
        { debit: 500, credit: 0 },
      ]),
    ).toBe(1100);
  });
  test("handles missing debit/credit keys", () => {
    expect(computeOpeningBalance([{}, { debit: 100 }, { credit: 50 }])).toBe(50);
  });
});

describe("buildCustomerLedger", () => {
  const fyStart = new Date(Date.UTC(2025, 3, 1)); // FY2025-26 start
  const fyEnd = new Date(Date.UTC(2026, 3, 1));   // FY2025-26 end exclusive

  test("opening balance carries forward from pre-FY events", () => {
    const invoices = [
      // Pre-FY invoice
      {
        id: 1,
        invoiceNum: "TINV-2024-0099",
        totalAmount: 5000,
        createdAt: new Date(Date.UTC(2024, 5, 15)),
        docType: "TaxInvoice",
      },
    ];
    const payments = [];
    const result = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });
    expect(result.openingBalance).toBe(5000);
    expect(result.transactions).toHaveLength(0);
    expect(result.closingBalance).toBe(5000);
    expect(result.summary.invoiceCount).toBe(0); // in-FY only
  });

  test("invoice + payment in same FY", () => {
    const invoices = [
      {
        id: 2,
        invoiceNum: "TINV-2025-0001",
        totalAmount: 1200,
        createdAt: new Date(Date.UTC(2025, 5, 10)),
        docType: "TaxInvoice",
      },
    ];
    const payments = [
      {
        id: 11,
        invoiceId: 2,
        invoiceNum: "TINV-2025-0001",
        milestoneOrder: 1,
        receivedAmount: 1200,
        paidAt: new Date(Date.UTC(2025, 5, 25)),
      },
    ];
    const result = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });
    expect(result.openingBalance).toBe(0);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].type).toBe("invoice");
    expect(result.transactions[0].debit).toBe(1200);
    expect(result.transactions[0].runningBalance).toBe(1200);
    expect(result.transactions[1].type).toBe("payment");
    expect(result.transactions[1].credit).toBe(1200);
    expect(result.transactions[1].runningBalance).toBe(0);
    expect(result.closingBalance).toBe(0);
    expect(result.summary.totalInvoiced).toBe(1200);
    expect(result.summary.totalPaid).toBe(1200);
    expect(result.summary.totalOutstanding).toBe(0);
    expect(result.summary.invoiceCount).toBe(1);
    expect(result.summary.paymentCount).toBe(1);
  });

  test("credit-note reduces running balance", () => {
    const invoices = [
      {
        id: 1,
        invoiceNum: "TINV-2025-0001",
        totalAmount: 1000,
        createdAt: new Date(Date.UTC(2025, 5, 10)),
        docType: "TaxInvoice",
      },
      {
        id: 2,
        invoiceNum: "CR-2025-0001",
        totalAmount: 200,
        createdAt: new Date(Date.UTC(2025, 5, 12)),
        docType: "CreditNote",
      },
    ];
    const result = buildCustomerLedger({ invoices, payments: [], fyStart, fyEnd });
    expect(result.transactions[0].debit).toBe(1000);
    expect(result.transactions[1].type).toBe("credit-note");
    expect(result.transactions[1].credit).toBe(200);
    expect(result.transactions[1].runningBalance).toBe(800);
    expect(result.closingBalance).toBe(800);
    expect(result.summary.totalInvoiced).toBe(800); // 1000 - 200 credit-note
  });

  test("same-day ordering: invoice before payment", () => {
    const day = new Date(Date.UTC(2025, 5, 10));
    const invoices = [
      { id: 1, invoiceNum: "I1", totalAmount: 500, createdAt: day, docType: "TaxInvoice" },
    ];
    const payments = [
      { id: 11, invoiceId: 1, invoiceNum: "I1", milestoneOrder: 1, receivedAmount: 500, paidAt: day },
    ];
    const result = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });
    expect(result.transactions[0].type).toBe("invoice");
    expect(result.transactions[1].type).toBe("payment");
  });

  test("partial payment leaves outstanding amount", () => {
    const invoices = [
      {
        id: 1,
        invoiceNum: "TINV-2025-0001",
        totalAmount: 1000,
        createdAt: new Date(Date.UTC(2025, 5, 10)),
        docType: "TaxInvoice",
      },
    ];
    const payments = [
      {
        id: 11,
        invoiceId: 1,
        invoiceNum: "TINV-2025-0001",
        milestoneOrder: 1,
        receivedAmount: 400,
        paidAt: new Date(Date.UTC(2025, 5, 20)),
      },
    ];
    const result = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });
    expect(result.closingBalance).toBe(600);
    expect(result.summary.totalOutstanding).toBe(600);
  });

  test("payment without paidAt is skipped", () => {
    const invoices = [];
    const payments = [
      { id: 11, invoiceId: 1, invoiceNum: "I1", receivedAmount: 100, paidAt: null },
    ];
    const result = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });
    expect(result.transactions).toHaveLength(0);
  });

  test("zero-receivedAmount payment is skipped", () => {
    const invoices = [];
    const payments = [
      { id: 11, invoiceId: 1, invoiceNum: "I1", receivedAmount: 0, paidAt: new Date(Date.UTC(2025, 5, 20)) },
    ];
    const result = buildCustomerLedger({ invoices, payments, fyStart, fyEnd });
    expect(result.transactions).toHaveLength(0);
  });

  test("invoice without issue date is skipped", () => {
    const invoices = [{ id: 1, invoiceNum: "I1", totalAmount: 100 /* no createdAt */ }];
    const result = buildCustomerLedger({ invoices, payments: [], fyStart, fyEnd });
    expect(result.transactions).toHaveLength(0);
  });

  test("empty inputs yield zero-balance ledger", () => {
    const result = buildCustomerLedger({ invoices: [], payments: [], fyStart, fyEnd });
    expect(result.openingBalance).toBe(0);
    expect(result.closingBalance).toBe(0);
    expect(result.transactions).toHaveLength(0);
    expect(result.summary).toEqual({
      totalInvoiced: 0,
      totalPaid: 0,
      totalOutstanding: 0,
      invoiceCount: 0,
      paymentCount: 0,
    });
  });
});

describe("buildCustomerLedgerCsv", () => {
  test("emits header + opening + transactions + closing row", () => {
    const fyStart = new Date(Date.UTC(2025, 3, 1));
    const fyEnd = new Date(Date.UTC(2026, 3, 1));
    const ledger = buildCustomerLedger({
      invoices: [
        {
          id: 1,
          invoiceNum: "TINV-2025-0001",
          totalAmount: 1000,
          createdAt: new Date(Date.UTC(2025, 5, 10)),
          docType: "TaxInvoice",
        },
      ],
      payments: [],
      fyStart,
      fyEnd,
    });
    const csv = buildCustomerLedgerCsv(ledger, { fiscalYear: "FY2025-26" });
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("date,type,refNumber,debit,credit,runningBalance");
    expect(lines[1]).toContain("opening");
    expect(lines[2]).toContain("invoice");
    expect(lines[lines.length - 1]).toContain("closing");
  });
  test("CRLF line endings", () => {
    const ledger = buildCustomerLedger({
      invoices: [],
      payments: [],
      fyStart: new Date(Date.UTC(2025, 3, 1)),
      fyEnd: new Date(Date.UTC(2026, 3, 1)),
    });
    const csv = buildCustomerLedgerCsv(ledger, { fiscalYear: "FY2025-26" });
    expect(csv.split("\r\n").length).toBeGreaterThan(1);
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("csvEscape", () => {
  test("plain string passes through", () => {
    expect(csvEscape("hello")).toBe("hello");
  });
  test("string with comma → quote-wrapped", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });
  test("string with quote → quote-wrapped + doubled inner quote", () => {
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });
  test("string with CRLF → quote-wrapped", () => {
    expect(csvEscape("a\r\nb")).toBe('"a\r\nb"');
  });
  test("null → empty string", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("fyBoundaries", () => {
  test("FY2025-26 → April 2025 → April 2026 UTC midnight", () => {
    const { fyStart, fyEnd } = fyBoundaries("FY2025-26");
    expect(fyStart.toISOString()).toBe("2025-04-01T00:00:00.000Z");
    expect(fyEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
  test("invalid label throws INVALID_FISCAL_YEAR", () => {
    expect(() => fyBoundaries("2025-26")).toThrow(/INVALID_FISCAL_YEAR|fy/i);
    expect(() => fyBoundaries("FY2025-27")).toThrow(/INVALID_FISCAL_YEAR|fy/i);
  });
});
