// Unit tests for backend/lib/tdsRegister.js
//
// PRD_TRAVEL_GST_COMPLIANCE G031 (FR-3.4.6) — TDS Register helper.
// Pure-math contract pinned in isolation; the Prisma load + section filter
// + sub-brand isolation gates live at the route layer and are exercised by
// the Playwright spec e2e/tests/travel-invoice-ledgers-api.spec.js.
//
// Contracts pinned:
//   - VALID_SECTIONS gates the section filter to 194H/194J/194C/all
//   - fromCommissionEntry maps a TravelSupplierCommissionEntry to a 26Q row;
//     entries with tdsAmount = 0 are filtered out
//   - fromSupplierPayable returns null when tdsAmount column is absent
//     (forward-compat with a future Payable.tdsAmount column)
//   - buildTdsRegister: stable sort by (date asc, section, sourceId)
//   - byDeductee + bySection rollups are correct
//   - section filter narrows entries
//   - buildTdsRegisterCsv emits Form 26Q-friendly header + CRLF lines

import { describe, test, expect } from "vitest";

const {
  isValidSection,
  VALID_SECTIONS,
  fromCommissionEntry,
  fromSupplierPayable,
  buildTdsRegister,
  buildTdsRegisterCsv,
  TDS_26Q_HEADER,
} = await import("../../lib/tdsRegister.js");

describe("isValidSection / VALID_SECTIONS", () => {
  test("accepts the four canonical strings", () => {
    expect(VALID_SECTIONS).toEqual(["194H", "194J", "194C", "all"]);
    for (const s of VALID_SECTIONS) {
      expect(isValidSection(s)).toBe(true);
    }
  });
  test("accepts null (no-filter)", () => {
    expect(isValidSection(null)).toBe(true);
  });
  test("rejects unknown strings", () => {
    expect(isValidSection("194A")).toBe(false);
    expect(isValidSection("randomstring")).toBe(false);
  });
});

describe("fromCommissionEntry", () => {
  test("maps a populated entry", () => {
    const row = fromCommissionEntry({
      id: 42,
      supplierId: 7,
      commissionAmount: "1000",
      tdsAmount: "50",
      accruedAt: new Date(Date.UTC(2025, 5, 10)),
      fiscalYear: "FY2025-26",
      currency: "INR",
      supplier: {
        name: "IATA Air Co",
        gstin: "27ABCDE1234F1Z5",
        kyc: { panNumber: "ABCDE1234F" },
      },
    });
    expect(row.deducteeName).toBe("IATA Air Co");
    expect(row.deducteePan).toBe("ABCDE1234F");
    expect(row.deducteeGstin).toBe("27ABCDE1234F1Z5");
    expect(row.section).toBe("194H");
    expect(row.grossAmount).toBe(1000);
    expect(row.tdsAmount).toBe(50);
    expect(row.sourceModel).toBe("TravelSupplierCommissionEntry");
    expect(row.sourceId).toBe(42);
  });

  test("returns null when tdsAmount = 0", () => {
    expect(
      fromCommissionEntry({
        id: 1,
        supplierId: 7,
        commissionAmount: "1000",
        tdsAmount: "0",
      }),
    ).toBeNull();
  });

  test("returns null when tdsAmount is null", () => {
    expect(
      fromCommissionEntry({ id: 1, supplierId: 7, commissionAmount: "1000", tdsAmount: null }),
    ).toBeNull();
  });

  test("falls back when supplier is missing", () => {
    const row = fromCommissionEntry({
      id: 1,
      supplierId: 7,
      commissionAmount: "100",
      tdsAmount: "5",
    });
    expect(row.deducteeName).toBe("Supplier #7");
    expect(row.deducteePan).toBeNull();
  });
});

describe("fromSupplierPayable", () => {
  test("returns null when the column is absent (forward-compat)", () => {
    expect(fromSupplierPayable({ id: 1, supplierId: 7, amount: "1000" })).toBeNull();
  });

  test("maps a populated payable with explicit section", () => {
    const row = fromSupplierPayable({
      id: 99,
      supplierId: 7,
      amount: "5000",
      tdsAmount: "100",
      tdsSection: "194J",
      tdsNature: "Professional consultancy",
      paidAt: new Date(Date.UTC(2025, 5, 1)),
      supplier: { name: "Consultant Co", gstin: "27ABCDE1234F1Z5", kyc: { panNumber: "ABCDE1234F" } },
    });
    expect(row.section).toBe("194J");
    expect(row.natureOfPayment).toBe("Professional consultancy");
    expect(row.grossAmount).toBe(5000);
    expect(row.tdsAmount).toBe(100);
  });
});

describe("buildTdsRegister", () => {
  const baseSupplier = {
    name: "Vendor A",
    gstin: "27ABCDE1234F1Z5",
    kyc: { panNumber: "ABCDE1234F" },
  };
  const e1 = {
    id: 1,
    supplierId: 7,
    commissionAmount: "1000",
    tdsAmount: "50",
    accruedAt: new Date(Date.UTC(2025, 5, 10)),
    fiscalYear: "FY2025-26",
    supplier: baseSupplier,
  };
  const e2 = {
    id: 2,
    supplierId: 7,
    commissionAmount: "2000",
    tdsAmount: "100",
    accruedAt: new Date(Date.UTC(2025, 5, 5)),
    fiscalYear: "FY2025-26",
    supplier: baseSupplier,
  };
  const e3 = {
    id: 3,
    supplierId: 8,
    commissionAmount: "500",
    tdsAmount: "25",
    accruedAt: new Date(Date.UTC(2025, 5, 15)),
    fiscalYear: "FY2025-26",
    supplier: { name: "Vendor B", gstin: "29ABCDE5678X1Z2", kyc: { panNumber: "PQRST6789K" } },
  };

  test("entries sorted by date asc", () => {
    const r = buildTdsRegister({
      commissionEntries: [e1, e2, e3],
      section: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.entries.map((x) => x.sourceId)).toEqual([2, 1, 3]);
  });

  test("summary totals + counts", () => {
    const r = buildTdsRegister({
      commissionEntries: [e1, e2, e3],
      section: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.summary.totalEntries).toBe(3);
    expect(r.summary.totalDeducted).toBe(175);
    expect(r.summary.totalGross).toBe(3500);
  });

  test("byDeductee groups + sorts by totalTds desc", () => {
    const r = buildTdsRegister({
      commissionEntries: [e1, e2, e3],
      section: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.summary.byDeductee[0].deducteeName).toBe("Vendor A");
    expect(r.summary.byDeductee[0].totalTds).toBe(150);
    expect(r.summary.byDeductee[1].deducteeName).toBe("Vendor B");
    expect(r.summary.byDeductee[1].totalTds).toBe(25);
  });

  test("section filter narrows entries", () => {
    const r = buildTdsRegister({
      commissionEntries: [e1, e2, e3],
      section: "194H",
      fiscalYear: "FY2025-26",
    });
    expect(r.entries).toHaveLength(3);
    const r2 = buildTdsRegister({
      commissionEntries: [e1, e2, e3],
      section: "194J",
      fiscalYear: "FY2025-26",
    });
    expect(r2.entries).toHaveLength(0);
  });

  test("zero-TDS entries excluded", () => {
    const r = buildTdsRegister({
      commissionEntries: [
        { ...e1, tdsAmount: "0" },
        e2,
      ],
      section: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].sourceId).toBe(2);
  });

  test("empty inputs yield empty register with proper summary", () => {
    const r = buildTdsRegister({ commissionEntries: [], section: "all", fiscalYear: "FY2025-26" });
    expect(r.entries).toHaveLength(0);
    expect(r.summary.totalDeducted).toBe(0);
    expect(r.summary.totalEntries).toBe(0);
    expect(r.summary.byDeductee).toEqual([]);
  });
});

describe("buildTdsRegisterCsv", () => {
  test("emits Form 26Q header + row per entry, CRLF-terminated", () => {
    const register = buildTdsRegister({
      commissionEntries: [
        {
          id: 1,
          supplierId: 7,
          commissionAmount: "1000",
          tdsAmount: "50",
          accruedAt: new Date(Date.UTC(2025, 5, 10)),
          fiscalYear: "FY2025-26",
          currency: "INR",
          supplier: {
            name: "IATA Air Co",
            gstin: "27ABCDE1234F1Z5",
            kyc: { panNumber: "ABCDE1234F" },
          },
        },
      ],
      section: "all",
      fiscalYear: "FY2025-26",
    });
    const csv = buildTdsRegisterCsv(register);
    expect(csv.startsWith(TDS_26Q_HEADER.join(","))).toBe(true);
    expect(csv.includes("\r\n")).toBe(true);
    expect(csv.includes("ABCDE1234F")).toBe(true);
    expect(csv.includes("50.00")).toBe(true);
    expect(csv.includes("1000.00")).toBe(true);
  });

  test("empty register → header only", () => {
    const register = buildTdsRegister({
      commissionEntries: [],
      section: "all",
      fiscalYear: "FY2025-26",
    });
    const csv = buildTdsRegisterCsv(register);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(TDS_26Q_HEADER.join(","));
  });
});
