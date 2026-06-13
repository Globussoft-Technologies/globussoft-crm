// Unit tests for backend/lib/commissionLedger.js
//
// PRD_TRAVEL_GST_COMPLIANCE G032 (FR-3.4.7) — commission-ledger helper.
// Pure-math contract pinned in isolation; Prisma load + auth gate covered
// at the route + Playwright layer.
//
// Contracts pinned:
//   - VALID_TYPES gates the type filter
//   - categoryFromSupplier maps supplierCategory ⇒ commission category
//   - normalizeEntry strips Prisma decoration + adds derived category
//   - buildCommissionLedger: stable sort by date asc, accrued vs settled
//     vs reversed treated correctly in summary
//   - type filter narrows entries
//   - byCategory + bySupplier rollups
//   - reversed entries excluded from totals/by-category rollups
//   - buildCommissionLedgerCsv emits header + row per entry, CRLF-terminated

import { describe, test, expect } from "vitest";

const {
  isValidType,
  VALID_TYPES,
  categoryFromSupplier,
  normalizeEntry,
  buildCommissionLedger,
  buildCommissionLedgerCsv,
  COMMISSION_CSV_HEADER,
} = await import("../../lib/commissionLedger.js");

describe("isValidType / VALID_TYPES", () => {
  test("accepts the canonical categories + 'all'", () => {
    expect(VALID_TYPES).toEqual([
      "iata_inward",
      "hotel",
      "air",
      "tour",
      "visa",
      "other",
      "all",
    ]);
    for (const t of VALID_TYPES) {
      expect(isValidType(t)).toBe(true);
    }
  });
  test("null → true (no-filter)", () => {
    expect(isValidType(null)).toBe(true);
  });
  test("unknown → false", () => {
    expect(isValidType("foobar")).toBe(false);
  });
});

describe("categoryFromSupplier", () => {
  test("supplierCategory='flight' → iata_inward (most air is IATA)", () => {
    expect(categoryFromSupplier({ supplierCategory: "flight" })).toBe("iata_inward");
  });
  test("supplierCategory='hotel' → hotel", () => {
    expect(categoryFromSupplier({ supplierCategory: "hotel" })).toBe("hotel");
  });
  test("supplierCategory='visa-consul' → visa", () => {
    expect(categoryFromSupplier({ supplierCategory: "visa-consul" })).toBe("visa");
  });
  test("supplierCategory='transport' → other", () => {
    expect(categoryFromSupplier({ supplierCategory: "transport" })).toBe("other");
  });
  test("supplier.commissionType wins over derived category (future-compat)", () => {
    expect(
      categoryFromSupplier({ supplierCategory: "flight", commissionType: "hotel" }),
    ).toBe("hotel");
  });
  test("invalid commissionType falls back to 'other'", () => {
    expect(categoryFromSupplier({ supplierCategory: "flight", commissionType: "garbage" })).toBe(
      "other",
    );
  });
  test("null supplier → other", () => {
    expect(categoryFromSupplier(null)).toBe("other");
  });
});

describe("normalizeEntry", () => {
  test("populates derived fields + strips Prisma noise", () => {
    const row = normalizeEntry({
      id: 42,
      supplierId: 7,
      baseAmount: "1000",
      commissionPercent: "5.00",
      commissionAmount: "50",
      tdsAmount: "2.50",
      netAmount: "47.50",
      status: "accrued",
      fiscalYear: "FY2025-26",
      currency: "INR",
      accruedAt: new Date(Date.UTC(2025, 5, 10)),
      supplier: { name: "Vendor A", subBrand: "tmc", supplierCategory: "hotel" },
    });
    expect(row.supplierName).toBe("Vendor A");
    expect(row.subBrand).toBe("tmc");
    expect(row.category).toBe("hotel");
    expect(row.commissionAmount).toBe(50);
    expect(row.commissionPercent).toBe(5.0);
    expect(row.tdsAmount).toBe(2.5);
    expect(row.netAmount).toBe(47.5);
    expect(row.status).toBe("accrued");
  });
});

describe("buildCommissionLedger", () => {
  const baseSupplier = { name: "Air Co", subBrand: "tmc", supplierCategory: "flight" };
  const otherSupplier = { name: "Hotel Co", subBrand: "rfu", supplierCategory: "hotel" };
  const e1 = {
    id: 1,
    supplierId: 7,
    baseAmount: "10000",
    commissionPercent: "7.50",
    commissionAmount: "750",
    tdsAmount: "37.50",
    netAmount: "712.50",
    status: "accrued",
    accruedAt: new Date(Date.UTC(2025, 5, 5)),
    fiscalYear: "FY2025-26",
    supplier: baseSupplier,
  };
  const e2 = {
    id: 2,
    supplierId: 7,
    baseAmount: "5000",
    commissionPercent: "7.50",
    commissionAmount: "375",
    tdsAmount: "18.75",
    netAmount: "356.25",
    status: "settled",
    settledAt: new Date(Date.UTC(2025, 5, 20)),
    accruedAt: new Date(Date.UTC(2025, 5, 10)),
    fiscalYear: "FY2025-26",
    supplier: baseSupplier,
  };
  const e3 = {
    id: 3,
    supplierId: 8,
    baseAmount: "3000",
    commissionPercent: "10.00",
    commissionAmount: "300",
    tdsAmount: "15",
    netAmount: "285",
    status: "accrued",
    accruedAt: new Date(Date.UTC(2025, 5, 15)),
    fiscalYear: "FY2025-26",
    supplier: otherSupplier,
  };
  const eReversed = {
    id: 4,
    supplierId: 7,
    baseAmount: "1000",
    commissionPercent: "5.00",
    commissionAmount: "50",
    tdsAmount: "0",
    netAmount: "50",
    status: "reversed",
    accruedAt: new Date(Date.UTC(2025, 5, 18)),
    fiscalYear: "FY2025-26",
    supplier: baseSupplier,
  };

  test("entries sorted by date asc", () => {
    const r = buildCommissionLedger({ entries: [e2, e3, e1], type: "all", fiscalYear: "FY2025-26" });
    expect(r.entries.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  test("summary: accrued totals + settled totals", () => {
    const r = buildCommissionLedger({
      entries: [e1, e2, e3],
      type: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.summary.totalAccrued).toBe(1050); // 750 + 300
    expect(r.summary.totalSettled).toBe(375);  // 375
    expect(r.summary.totalTds).toBe(71.25);    // 37.5 + 18.75 + 15
    expect(r.summary.totalNet).toBe(997.5);    // 712.5 + 285 (accrued only)
  });

  test("reversed entries roll into totalReversed but skip totals/by-rollups", () => {
    const r = buildCommissionLedger({
      entries: [e1, e2, eReversed],
      type: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.summary.totalReversed).toBe(50);
    expect(r.summary.byCategory.iata_inward.totalCommission).toBe(1125); // 750 + 375
    expect(r.summary.bySupplier[0].entryCount).toBe(2); // e1, e2 (NOT eReversed)
  });

  test("byCategory groups under iata_inward + hotel", () => {
    const r = buildCommissionLedger({
      entries: [e1, e3],
      type: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.summary.byCategory.iata_inward.totalCommission).toBe(750);
    expect(r.summary.byCategory.hotel.totalCommission).toBe(300);
  });

  test("type filter narrows entries (only iata_inward)", () => {
    const r = buildCommissionLedger({
      entries: [e1, e3],
      type: "iata_inward",
      fiscalYear: "FY2025-26",
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].id).toBe(1);
  });

  test("bySupplier ordered by totalCommission desc", () => {
    const r = buildCommissionLedger({
      entries: [e1, e2, e3],
      type: "all",
      fiscalYear: "FY2025-26",
    });
    expect(r.summary.bySupplier[0].supplierName).toBe("Air Co"); // 750 + 375 = 1125
    expect(r.summary.bySupplier[1].supplierName).toBe("Hotel Co"); // 300
  });

  test("empty inputs yield zero-balance ledger", () => {
    const r = buildCommissionLedger({ entries: [], type: "all", fiscalYear: "FY2025-26" });
    expect(r.entries).toHaveLength(0);
    expect(r.summary.totalAccrued).toBe(0);
    expect(r.summary.totalSettled).toBe(0);
    expect(r.summary.bySupplier).toEqual([]);
  });
});

describe("buildCommissionLedgerCsv", () => {
  test("emits pinned header + entry rows, CRLF-terminated", () => {
    const ledger = buildCommissionLedger({
      entries: [
        {
          id: 1,
          supplierId: 7,
          baseAmount: "10000",
          commissionPercent: "7.50",
          commissionAmount: "750",
          tdsAmount: "37.50",
          netAmount: "712.50",
          status: "accrued",
          accruedAt: new Date(Date.UTC(2025, 5, 5)),
          fiscalYear: "FY2025-26",
          currency: "INR",
          supplier: { name: "Air Co", subBrand: "tmc", supplierCategory: "flight" },
        },
      ],
      type: "all",
      fiscalYear: "FY2025-26",
    });
    const csv = buildCommissionLedgerCsv(ledger);
    expect(csv.startsWith(COMMISSION_CSV_HEADER.join(","))).toBe(true);
    expect(csv.includes("\r\n")).toBe(true);
    expect(csv.includes("Air Co")).toBe(true);
    expect(csv.includes("750.00")).toBe(true);
    expect(csv.includes("iata_inward")).toBe(true);
  });

  test("empty ledger → header only", () => {
    const ledger = buildCommissionLedger({ entries: [], type: "all", fiscalYear: "FY2025-26" });
    const csv = buildCommissionLedgerCsv(ledger);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(COMMISSION_CSV_HEADER.join(","));
  });
});
