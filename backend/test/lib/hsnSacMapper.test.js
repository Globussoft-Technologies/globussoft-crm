// Unit tests for backend/lib/hsnSacMapper.js
//
// Pins the pure SAC-code mapper feeding #902 slice 6+ (GSTR-1 HSN
// summary export + PDF render):
//   - line-type → SAC mapping for every PRD §3 travel line type
//   - null returned for tax/fee/tcs/tds (don't get their own SAC row)
//   - DEFAULT_SAC fallback for unknown / falsy / non-string inputs
//   - descriptionForSac happy path + "Other services" fallback
//   - groupLinesBySac: bucketing by (sacCode, gstPercent), summing
//     taxableValue with half-up 2dp rounding, skipping non-SAC lines,
//     stable sort by sacCode then gstPercent
//
// PRD: docs/PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4.3.

import { describe, test, expect } from "vitest";

const {
  TRAVEL_SAC_CODES,
  SAC_DESCRIPTIONS,
  DEFAULT_SAC,
  sacForLineType,
  descriptionForSac,
  groupLinesBySac,
} = await import("../../lib/hsnSacMapper.js");

describe("sacForLineType — canonical travel line types", () => {
  test("hotel → 9963 (Accommodation services)", () => {
    expect(sacForLineType("hotel")).toBe("9963");
  });

  test("flight → 9964 (Passenger transport)", () => {
    expect(sacForLineType("flight")).toBe("9964");
  });

  test("transport → 9964 (Passenger transport)", () => {
    expect(sacForLineType("transport")).toBe("9964");
  });

  test("visa → 9982 (Legal and accounting services)", () => {
    expect(sacForLineType("visa")).toBe("9982");
  });

  test("tour_package → 9985 (Support services to travel & tourism)", () => {
    expect(sacForLineType("tour_package")).toBe("9985");
  });

  test("service → 9985 (generic travel-service catch-all)", () => {
    expect(sacForLineType("service")).toBe("9985");
  });

  test("per_pax → 9985 (tour-package pricing flavour)", () => {
    expect(sacForLineType("per_pax")).toBe("9985");
  });

  test("per_room → 9963 (room pricing → accommodation)", () => {
    expect(sacForLineType("per_room")).toBe("9963");
  });

  test("per_night → 9963 (nightly pricing → accommodation)", () => {
    expect(sacForLineType("per_night")).toBe("9963");
  });

  test("per_trip → 9985 (trip pricing → tour package)", () => {
    expect(sacForLineType("per_trip")).toBe("9985");
  });

  test("addon → 9985 (addon ride-along → tour package)", () => {
    expect(sacForLineType("addon")).toBe("9985");
  });
});

describe("sacForLineType — line types that don't carry their own SAC", () => {
  test("tax → null (GST output rides parent line, not its own HSN row)", () => {
    expect(sacForLineType("tax")).toBeNull();
  });

  test("fee → null (piggybacks on parent service line)", () => {
    expect(sacForLineType("fee")).toBeNull();
  });

  test("tcs → null (withholding under §206C(1G), not GST output)", () => {
    expect(sacForLineType("tcs")).toBeNull();
  });

  test("tds → null (withholding, not GST output)", () => {
    expect(sacForLineType("tds")).toBeNull();
  });
});

describe("sacForLineType — fallback semantics", () => {
  test("unknown lineType string → DEFAULT_SAC (9985)", () => {
    expect(sacForLineType("unknown_type")).toBe(DEFAULT_SAC);
    expect(sacForLineType("unknown_type")).toBe("9985");
  });

  test("null input → DEFAULT_SAC", () => {
    expect(sacForLineType(null)).toBe("9985");
  });

  test("undefined input → DEFAULT_SAC", () => {
    expect(sacForLineType(undefined)).toBe("9985");
  });

  test("empty string → DEFAULT_SAC", () => {
    expect(sacForLineType("")).toBe("9985");
  });

  test("non-string (number) input → DEFAULT_SAC", () => {
    expect(sacForLineType(42)).toBe("9985");
  });

  test("non-string (object) input → DEFAULT_SAC", () => {
    expect(sacForLineType({})).toBe("9985");
  });
});

describe("descriptionForSac", () => {
  test("9963 → 'Accommodation services'", () => {
    expect(descriptionForSac("9963")).toBe("Accommodation services");
  });

  test("9964 → 'Passenger transport services'", () => {
    expect(descriptionForSac("9964")).toBe("Passenger transport services");
  });

  test("9982 → 'Legal and accounting services'", () => {
    expect(descriptionForSac("9982")).toBe("Legal and accounting services");
  });

  test("9985 → 'Support services to travel & tourism'", () => {
    expect(descriptionForSac("9985")).toBe("Support services to travel & tourism");
  });

  test("unknown SAC code → 'Other services' fallback", () => {
    expect(descriptionForSac("9999")).toBe("Other services");
  });

  test("null / undefined → 'Other services' fallback", () => {
    expect(descriptionForSac(null)).toBe("Other services");
    expect(descriptionForSac(undefined)).toBe("Other services");
  });
});

describe("groupLinesBySac — bucketing + aggregation", () => {
  test("2 hotel @ 12% + 1 flight @ 5% → 2 buckets [9963/12, 9964/5]", () => {
    const lines = [
      { lineType: "hotel", taxableValue: 5000, gstPercent: 12 },
      { lineType: "hotel", taxableValue: 3000, gstPercent: 12 },
      { lineType: "flight", taxableValue: 8000, gstPercent: 5 },
    ];
    const result = groupLinesBySac(lines);
    expect(result).toHaveLength(2);
    // sort: 9963 < 9964
    expect(result[0]).toEqual({
      sacCode: "9963",
      description: "Accommodation services",
      gstPercent: 12,
      taxableValue: 8000,
      count: 2,
    });
    expect(result[1]).toEqual({
      sacCode: "9964",
      description: "Passenger transport services",
      gstPercent: 5,
      taxableValue: 8000,
      count: 1,
    });
  });

  test("empty array → []", () => {
    expect(groupLinesBySac([])).toEqual([]);
  });

  test("null input → [] (defensive)", () => {
    expect(groupLinesBySac(null)).toEqual([]);
  });

  test("undefined input → [] (defensive)", () => {
    expect(groupLinesBySac(undefined)).toEqual([]);
  });

  test("lines with tax/fee/tcs/tds types are skipped (no SAC row)", () => {
    const lines = [
      { lineType: "tax", taxableValue: 500, gstPercent: 18 },
      { lineType: "fee", taxableValue: 100, gstPercent: 18 },
      { lineType: "tcs", taxableValue: 50, gstPercent: 0 },
      { lineType: "tds", taxableValue: 25, gstPercent: 0 },
      { lineType: "hotel", taxableValue: 1000, gstPercent: 12 },
    ];
    const result = groupLinesBySac(lines);
    expect(result).toHaveLength(1);
    expect(result[0].sacCode).toBe("9963");
    expect(result[0].count).toBe(1);
  });

  test("same SAC + same gstPercent → 1 bucket with summed taxableValue + count", () => {
    const lines = [
      { lineType: "hotel", taxableValue: 1234.55, gstPercent: 18 },
      { lineType: "per_room", taxableValue: 2765.45, gstPercent: 18 },
    ];
    const result = groupLinesBySac(lines);
    expect(result).toHaveLength(1);
    expect(result[0].sacCode).toBe("9963");
    expect(result[0].gstPercent).toBe(18);
    expect(result[0].taxableValue).toBe(4000);
    expect(result[0].count).toBe(2);
  });

  test("same SAC + DIFFERENT gstPercent → separate buckets", () => {
    const lines = [
      { lineType: "tour_package", taxableValue: 1000, gstPercent: 5 },
      { lineType: "tour_package", taxableValue: 2000, gstPercent: 18 },
    ];
    const result = groupLinesBySac(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ sacCode: "9985", gstPercent: 5, taxableValue: 1000, count: 1 });
    expect(result[1]).toMatchObject({ sacCode: "9985", gstPercent: 18, taxableValue: 2000, count: 1 });
  });

  test("sort order: by sacCode ascending, then gstPercent ascending", () => {
    const lines = [
      { lineType: "tour_package", taxableValue: 100, gstPercent: 18 }, // 9985/18
      { lineType: "hotel", taxableValue: 100, gstPercent: 12 }, // 9963/12
      { lineType: "visa", taxableValue: 100, gstPercent: 18 }, // 9982/18
      { lineType: "tour_package", taxableValue: 100, gstPercent: 5 }, // 9985/5
      { lineType: "flight", taxableValue: 100, gstPercent: 5 }, // 9964/5
    ];
    const result = groupLinesBySac(lines);
    expect(result.map((r) => `${r.sacCode}/${r.gstPercent}`)).toEqual([
      "9963/12",
      "9964/5",
      "9982/18",
      "9985/5",
      "9985/18",
    ]);
  });

  test("half-up rounding to 2dp on summed taxableValue", () => {
    // The helper rounds the running total per-iteration with
    // Math.round(n * 100) / 100. 333.335 * 100 = 33333.5 → Math.round
    // = 33334 → 333.34. Second iteration: (333.34 + 333.335) * 100 =
    // 66667.5 → Math.round = 66668 → 666.68. Matches the half-up
    // rule (.5 rounds away from zero for positives) used across
    // lib/gstCalculation.js for reconciliation parity.
    const lines = [
      { lineType: "hotel", taxableValue: 333.335, gstPercent: 12 },
      { lineType: "hotel", taxableValue: 333.335, gstPercent: 12 },
    ];
    const result = groupLinesBySac(lines);
    expect(result[0].taxableValue).toBe(666.68);
  });

  test("running-total rounding produces 2dp output even when inputs have more precision", () => {
    const lines = [
      { lineType: "hotel", taxableValue: 100.123, gstPercent: 18 },
      { lineType: "hotel", taxableValue: 200.456, gstPercent: 18 },
      { lineType: "hotel", taxableValue: 300.789, gstPercent: 18 },
    ];
    const result = groupLinesBySac(lines);
    // taxableValue must be cleanly 2dp (no float drift)
    expect(result[0].taxableValue).toBe(601.37);
    // count cleanly 3
    expect(result[0].count).toBe(3);
  });

  test("string-typed taxableValue / gstPercent are coerced", () => {
    const lines = [
      { lineType: "hotel", taxableValue: "1500.50", gstPercent: "12" },
      { lineType: "hotel", taxableValue: "2499.50", gstPercent: "12" },
    ];
    const result = groupLinesBySac(lines);
    expect(result[0].taxableValue).toBe(4000);
    expect(result[0].gstPercent).toBe(12);
  });

  test("missing taxableValue / gstPercent default to 0", () => {
    const lines = [
      { lineType: "hotel" }, // no taxableValue, no gstPercent
      { lineType: "hotel", taxableValue: 500, gstPercent: 0 },
    ];
    const result = groupLinesBySac(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ gstPercent: 0, taxableValue: 500, count: 2 });
  });

  test("unknown line type falls into DEFAULT_SAC bucket (9985)", () => {
    const lines = [
      { lineType: "weird_custom_type", taxableValue: 1000, gstPercent: 18 },
      { lineType: "tour_package", taxableValue: 2000, gstPercent: 18 },
    ];
    const result = groupLinesBySac(lines);
    // both land in 9985/18 bucket
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sacCode: "9985", taxableValue: 3000, count: 2 });
  });

  test("null entries inside the array are silently skipped (defensive)", () => {
    const lines = [
      null,
      { lineType: "hotel", taxableValue: 1000, gstPercent: 12 },
      undefined,
    ];
    const result = groupLinesBySac(lines);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(1);
  });
});

describe("module surface — exports", () => {
  test("TRAVEL_SAC_CODES + SAC_DESCRIPTIONS + DEFAULT_SAC are exported as constants", () => {
    expect(typeof TRAVEL_SAC_CODES).toBe("object");
    expect(typeof SAC_DESCRIPTIONS).toBe("object");
    expect(DEFAULT_SAC).toBe("9985");
  });

  test("every SAC value in TRAVEL_SAC_CODES (non-null) has a description", () => {
    const sacValues = new Set(
      Object.values(TRAVEL_SAC_CODES).filter((v) => v !== null)
    );
    for (const sac of sacValues) {
      expect(SAC_DESCRIPTIONS[sac]).toBeDefined();
      expect(typeof SAC_DESCRIPTIONS[sac]).toBe("string");
    }
  });
});
