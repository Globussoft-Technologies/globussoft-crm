// Unit tests for backend/lib/supplierReconciliation.js
//
// Pins the auto-match math behind the PRD_TRAVEL_SUPPLIER_MASTER G044
// (FR-3.4.a-c) supplier-statement reconciliation feature:
//   - PNR normalisation (case-insensitive + trimmed)
//   - Tolerance band acceptance / rejection
//   - Multi-candidate selection (lowest variance)
//   - Zero-supplier edge cases
//   - Input coercion (string / Prisma Decimal as string / JS Number)
//
// Pure-function tests — no Prisma, no I/O.

import { describe, test, expect } from "vitest";

const { matchLines, indexPoLinesByPnr, sumAmounts, _internal } = await import(
  "../../lib/supplierReconciliation.js"
);

describe("indexPoLinesByPnr", () => {
  test("groups PoLines by upper-cased trimmed PNR", () => {
    const idx = indexPoLinesByPnr([
      { id: 1, pnr: "abc123", lineTotal: 100 },
      { id: 2, pnr: " ABC123 ", lineTotal: 110 },
      { id: 3, pnr: "DEF999", lineTotal: 50 },
    ]);
    expect(idx.size).toBe(2);
    expect(idx.get("ABC123")).toHaveLength(2);
    expect(idx.get("DEF999")).toHaveLength(1);
  });

  test("skips rows with missing or empty PNR", () => {
    const idx = indexPoLinesByPnr([
      { id: 1, pnr: null, lineTotal: 100 },
      { id: 2, pnr: "", lineTotal: 100 },
      { id: 3, pnr: "   ", lineTotal: 100 },
      { id: 4, pnr: "OK1", lineTotal: 100 },
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get("OK1")).toHaveLength(1);
  });

  test("returns empty map on non-array input", () => {
    expect(indexPoLinesByPnr(null).size).toBe(0);
    expect(indexPoLinesByPnr(undefined).size).toBe(0);
    expect(indexPoLinesByPnr({}).size).toBe(0);
  });
});

describe("matchLines — happy paths", () => {
  test("exact-amount match within 1% tolerance → auto_matched", () => {
    const out = matchLines(
      [{ id: 10, pnr: "ABC123", supplierAmount: 1000 }],
      [{ id: 99, pnr: "ABC123", lineTotal: 1000 }],
      1,
    );
    expect(out).toEqual([
      {
        reconLineId: 10,
        decision: "auto_matched",
        matchedPoLineId: 99,
        varianceAmount: 0,
      },
    ]);
  });

  test("amount mismatch within tolerance accepts (0.5% off, tol=1%)", () => {
    const out = matchLines(
      [{ id: 10, pnr: "PNR1", supplierAmount: 1000 }],
      [{ id: 99, pnr: "PNR1", lineTotal: 1005 }], // 0.5% high
      1,
    );
    expect(out[0].decision).toBe("auto_matched");
    expect(out[0].varianceAmount).toBe(-5);
  });

  test("PNR matched case-insensitively (lowercase supplier vs upper PoLine)", () => {
    const out = matchLines(
      [{ id: 1, pnr: "abc-1", supplierAmount: 500 }],
      [{ id: 2, pnr: "ABC-1", lineTotal: 500 }],
      1,
    );
    expect(out[0].decision).toBe("auto_matched");
  });

  test("variance is supplierAmount - lineTotal (signed)", () => {
    const out = matchLines(
      [
        { id: 1, pnr: "P1", supplierAmount: 1000 },
        { id: 2, pnr: "P2", supplierAmount: 900 },
      ],
      [
        { id: 11, pnr: "P1", lineTotal: 990 }, // supplier > ours → +10
        { id: 22, pnr: "P2", lineTotal: 910 }, // supplier < ours → -10
      ],
      5,
    );
    expect(out[0].varianceAmount).toBe(10);
    expect(out[1].varianceAmount).toBe(-10);
  });

  test("multiple PoLine candidates: pick lowest abs variance", () => {
    const out = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: 1000 }],
      [
        { id: 11, pnr: "P1", lineTotal: 950 }, // variance 50
        { id: 12, pnr: "P1", lineTotal: 1010 }, // variance 10 ← best
        { id: 13, pnr: "P1", lineTotal: 900 }, // variance 100
      ],
      5,
    );
    expect(out[0].matchedPoLineId).toBe(12);
    expect(out[0].varianceAmount).toBe(-10);
  });

  test("string-typed amounts (Prisma Decimal as string) coerce safely", () => {
    const out = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: "1000.00" }],
      [{ id: 11, pnr: "P1", lineTotal: "999.99" }],
      1,
    );
    expect(out[0].decision).toBe("auto_matched");
    // Rounding to 2dp keeps the variance precise.
    expect(out[0].varianceAmount).toBe(0.01);
  });
});

describe("matchLines — tolerance band rejection", () => {
  test("amount mismatch outside tolerance → unmatched OUT_OF_TOLERANCE", () => {
    const out = matchLines(
      [{ id: 10, pnr: "P1", supplierAmount: 1000 }],
      [{ id: 99, pnr: "P1", lineTotal: 1020 }], // 2% high
      1, // tolerance 1%
    );
    expect(out[0].decision).toBe("unmatched");
    expect(out[0].reason).toBe("OUT_OF_TOLERANCE");
    expect(out[0].varianceAmount).toBe(-20);
    expect(out[0].bestCandidatePoLineId).toBe(99);
  });

  test("tolerance=0 requires EXACT match (zero variance)", () => {
    const passing = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: 100 }],
      [{ id: 11, pnr: "P1", lineTotal: 100 }],
      0,
    );
    expect(passing[0].decision).toBe("auto_matched");

    const failing = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: 100 }],
      [{ id: 11, pnr: "P1", lineTotal: 100.01 }],
      0,
    );
    expect(failing[0].decision).toBe("unmatched");
    expect(failing[0].reason).toBe("OUT_OF_TOLERANCE");
  });

  test("tolerance=5% accepts the 4.9% case and rejects the 5.1% case", () => {
    const ok = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: 1000 }],
      [{ id: 11, pnr: "P1", lineTotal: 1049 }],
      5,
    );
    expect(ok[0].decision).toBe("auto_matched");

    const bad = matchLines(
      [{ id: 1, pnr: "P2", supplierAmount: 1000 }],
      [{ id: 22, pnr: "P2", lineTotal: 1051 }],
      5,
    );
    expect(bad[0].decision).toBe("unmatched");
  });
});

describe("matchLines — missing-input cases", () => {
  test("recon line with no PNR → unmatched NO_PNR", () => {
    const out = matchLines(
      [{ id: 1, supplierAmount: 100 }],
      [{ id: 11, pnr: "P1", lineTotal: 100 }],
      1,
    );
    expect(out[0].decision).toBe("unmatched");
    expect(out[0].reason).toBe("NO_PNR");
  });

  test("recon line with empty PNR string → NO_PNR", () => {
    const out = matchLines(
      [{ id: 1, pnr: "   ", supplierAmount: 100 }],
      [{ id: 11, pnr: "P1", lineTotal: 100 }],
      1,
    );
    expect(out[0].reason).toBe("NO_PNR");
  });

  test("recon line PNR not present in any PoLine → NO_CANDIDATE", () => {
    const out = matchLines(
      [{ id: 1, pnr: "ABSENT", supplierAmount: 100 }],
      [{ id: 11, pnr: "P1", lineTotal: 100 }],
      1,
    );
    expect(out[0].decision).toBe("unmatched");
    expect(out[0].reason).toBe("NO_CANDIDATE");
  });

  test("supplierAmount missing or non-finite → NO_PNR fallback", () => {
    const out = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: null }],
      [{ id: 11, pnr: "P1", lineTotal: 100 }],
      1,
    );
    expect(out[0].decision).toBe("unmatched");
  });

  test("PoLines all missing lineTotal → NO_CANDIDATE", () => {
    const out = matchLines(
      [{ id: 1, pnr: "P1", supplierAmount: 100 }],
      [{ id: 11, pnr: "P1", lineTotal: null }],
      1,
    );
    expect(out[0].decision).toBe("unmatched");
    expect(out[0].reason).toBe("NO_CANDIDATE");
  });
});

describe("matchLines — input-validation guards", () => {
  test("negative tolerancePct throws TypeError", () => {
    expect(() => matchLines([], [], -1)).toThrow(TypeError);
  });

  test("non-finite tolerancePct throws TypeError", () => {
    expect(() => matchLines([], [], NaN)).toThrow(TypeError);
    expect(() => matchLines([], [], "not-a-number")).toThrow(TypeError);
  });

  test("non-array reconLines returns empty decisions", () => {
    expect(matchLines(null, [], 1)).toEqual([]);
    expect(matchLines(undefined, [], 1)).toEqual([]);
  });
});

describe("matchLines — supplier amount zero edge cases", () => {
  test("zero supplier amount + zero PoLine total → exact match accepted", () => {
    const out = matchLines(
      [{ id: 1, pnr: "FREE", supplierAmount: 0 }],
      [{ id: 11, pnr: "FREE", lineTotal: 0 }],
      1,
    );
    expect(out[0].decision).toBe("auto_matched");
    expect(out[0].varianceAmount).toBe(0);
  });

  test("zero supplier amount + non-zero PoLine → out of tolerance", () => {
    const out = matchLines(
      [{ id: 1, pnr: "FREE", supplierAmount: 0 }],
      [{ id: 11, pnr: "FREE", lineTotal: 5 }],
      1,
    );
    expect(out[0].decision).toBe("unmatched");
    expect(out[0].reason).toBe("OUT_OF_TOLERANCE");
  });
});

describe("matchLines — many-line batch correctness", () => {
  test("mixed batch — some match, some unmatched, some out-of-tolerance", () => {
    const recon = [
      { id: 1, pnr: "P1", supplierAmount: 100 }, // exact match
      { id: 2, pnr: "P2", supplierAmount: 200 }, // within tolerance
      { id: 3, pnr: "P3", supplierAmount: 300 }, // out of tolerance
      { id: 4, pnr: "P4", supplierAmount: 400 }, // no candidate
      { id: 5, supplierAmount: 500 }, // no PNR
    ];
    const poLines = [
      { id: 11, pnr: "P1", lineTotal: 100 },
      { id: 22, pnr: "P2", lineTotal: 201 }, // 0.5% off
      { id: 33, pnr: "P3", lineTotal: 350 }, // ~17% off
    ];
    const out = matchLines(recon, poLines, 1);
    expect(out).toHaveLength(5);
    expect(out[0].decision).toBe("auto_matched");
    expect(out[1].decision).toBe("auto_matched");
    expect(out[2].decision).toBe("unmatched");
    expect(out[2].reason).toBe("OUT_OF_TOLERANCE");
    expect(out[3].decision).toBe("unmatched");
    expect(out[3].reason).toBe("NO_CANDIDATE");
    expect(out[4].decision).toBe("unmatched");
    expect(out[4].reason).toBe("NO_PNR");
  });
});

describe("sumAmounts", () => {
  test("sums supplierAmount across rows, rounds to 2dp", () => {
    expect(
      sumAmounts(
        [
          { supplierAmount: 100.123 },
          { supplierAmount: "200.456" },
          { supplierAmount: 50 },
        ],
        "supplierAmount",
      ),
    ).toBe(350.58);
  });

  test("non-array input returns 0", () => {
    expect(sumAmounts(null, "supplierAmount")).toBe(0);
    expect(sumAmounts(undefined, "supplierAmount")).toBe(0);
  });

  test("missing / non-finite keys skipped", () => {
    expect(
      sumAmounts(
        [
          { x: 1 },
          { x: null },
          { x: "abc" },
          { x: Infinity },
          { x: 2 },
        ],
        "x",
      ),
    ).toBe(3);
  });
});

describe("_internal helpers", () => {
  test("normPnr trims + uppercases + null on empty/whitespace", () => {
    expect(_internal.normPnr(" abc ")).toBe("ABC");
    expect(_internal.normPnr("")).toBe(null);
    expect(_internal.normPnr("   ")).toBe(null);
    expect(_internal.normPnr(null)).toBe(null);
  });

  test("toNum accepts numbers, finite-string, and rejects NaN/null", () => {
    expect(_internal.toNum(5)).toBe(5);
    expect(_internal.toNum("5.5")).toBe(5.5);
    expect(_internal.toNum("foo")).toBe(null);
    expect(_internal.toNum(null)).toBe(null);
    expect(_internal.toNum(Infinity)).toBe(null);
  });

  test("round2 rounds to 2 decimal places (JS float-mul semantics)", () => {
    // Math.round(n * 100) / 100 — float-multiplication may push x.5 cases
    // to x.49999..., so we don't assert tie-breaking direction here;
    // we only pin the behaviour for unambiguous inputs.
    expect(_internal.round2(1.234)).toBe(1.23);
    expect(_internal.round2(1.236)).toBe(1.24);
    expect(_internal.round2(1.004)).toBe(1);
    expect(_internal.round2(null)).toBe(null);
  });
});
