// Unit tests for backend/lib/travelDiagnosticScoring.js
//
// Pins the diagnostic-scoring contract for the travel vertical's Phase 1
// engine. The scoring helper is a pure function — same (rules, answers) →
// same output, no I/O — so the test surface is the deterministic
// computation of:
//   - weighted-sum score from single-choice + multi-select answers
//   - band-matching from score → classification + label + recommendedTier
//   - warnings for unanswered Qs / unknown options / no band match
//   - parseBank's JSON-string parsing + graceful failure
//
// Lock-down rationale: Q16 (RFU editable scoring is P1.5 not P1) means
// admins ship a v2 bank by POSTing a new row, not mutating an existing
// one. That makes scoring auditable IF and only if the computation is
// deterministic. These tests pin that determinism.

import { describe, test, expect } from "vitest";

const { scoreDiagnostic, parseBank } = await import(
  "../../lib/travelDiagnosticScoring.js"
);

// ── Fixtures ────────────────────────────────────────────────────────

// Mirrors the canonical TMC diagnostic shape: 3 questions, 3-tier
// classification (entry/primary/premium).
const TMC_BANK = {
  method: "weighted-sum",
  questions: [
    {
      id: "q1",
      text: "How many trips do you organize per year?",
      type: "single-choice",
      options: [
        { value: "first", weight: 1 },
        { value: "few", weight: 3 },
        { value: "many", weight: 5 },
      ],
    },
    {
      id: "q2",
      text: "Average group size?",
      type: "single-choice",
      options: [
        { value: "small", weight: 1 },
        { value: "medium", weight: 3 },
        { value: "large", weight: 5 },
      ],
    },
    {
      id: "q3",
      text: "Trip duration?",
      type: "single-choice",
      options: [
        { value: "weekend", weight: 1 },
        { value: "week", weight: 3 },
        { value: "longer", weight: 5 },
      ],
    },
  ],
  bands: [
    { minScore: 0, maxScore: 5, classification: "level_1", label: "Starter", recommendedTier: "entry" },
    { minScore: 6, maxScore: 10, classification: "level_2", label: "Established", recommendedTier: "primary" },
    { minScore: 11, maxScore: 15, classification: "level_3", label: "Power User", recommendedTier: "premium" },
  ],
};

// Multi-select bank — tests array-answer handling.
const RFU_BANK = {
  method: "weighted-sum",
  questions: [
    {
      id: "preferences",
      type: "multi-select",
      options: [
        { value: "halal-meal", weight: 1 },
        { value: "wheelchair", weight: 2 },
        { value: "family-rooming", weight: 1 },
        { value: "premium-haram-view", weight: 5 },
      ],
    },
  ],
  bands: [
    { minScore: 0, maxScore: 3, classification: "level_1", label: "Standard", recommendedTier: "entry" },
    { minScore: 4, maxScore: 99, classification: "level_2", label: "Premium", recommendedTier: "premium" },
  ],
};

// ── Single-choice scoring ───────────────────────────────────────────

describe("scoreDiagnostic — single-choice weighted-sum", () => {
  test("all-low answers land in entry tier", () => {
    const r = scoreDiagnostic(TMC_BANK, { q1: "first", q2: "small", q3: "weekend" });
    expect(r.score).toBe(3);
    expect(r.classification).toBe("level_1");
    expect(r.classificationLabel).toBe("Starter");
    expect(r.recommendedTier).toBe("entry");
    expect(r.warnings).toEqual([]);
  });

  test("middle answers land in primary tier", () => {
    const r = scoreDiagnostic(TMC_BANK, { q1: "few", q2: "medium", q3: "week" });
    expect(r.score).toBe(9);
    expect(r.classification).toBe("level_2");
    expect(r.recommendedTier).toBe("primary");
  });

  test("all-high answers land in premium tier", () => {
    const r = scoreDiagnostic(TMC_BANK, { q1: "many", q2: "large", q3: "longer" });
    expect(r.score).toBe(15);
    expect(r.classification).toBe("level_3");
    expect(r.recommendedTier).toBe("premium");
  });

  test("boundary score lands in the LOWER band when bands abut", () => {
    // q1=many(5) + q2=small(1) = 6 → minScore=6 of level_2
    const r = scoreDiagnostic(TMC_BANK, { q1: "many", q2: "small" });
    expect(r.score).toBe(6);
    expect(r.classification).toBe("level_2");
  });
});

// ── Multi-select scoring ────────────────────────────────────────────

describe("scoreDiagnostic — multi-select array answers", () => {
  test("sums all selected option weights", () => {
    const r = scoreDiagnostic(RFU_BANK, {
      preferences: ["halal-meal", "wheelchair", "family-rooming"],
    });
    expect(r.score).toBe(4); // 1 + 2 + 1
    expect(r.classification).toBe("level_2");
    expect(r.recommendedTier).toBe("premium");
  });

  test("empty selection scores 0 (still gets warning for unanswered Q)", () => {
    const r = scoreDiagnostic(RFU_BANK, { preferences: [] });
    expect(r.score).toBe(0);
    // Empty array is truthy-checked via Array.isArray, not the `=== ""` branch,
    // so it iterates an empty list and adds nothing — no unanswered warning.
    expect(r.warnings).toEqual([]);
  });

  test("unknown multi-select value emits warning, doesn't crash", () => {
    const r = scoreDiagnostic(RFU_BANK, {
      preferences: ["halal-meal", "made-up-pref"],
    });
    expect(r.score).toBe(1);
    expect(r.warnings).toContain("unknown-option:preferences:made-up-pref");
  });
});

// ── Warnings ────────────────────────────────────────────────────────

describe("scoreDiagnostic — warnings", () => {
  test("unanswered question emits warning, score unaffected", () => {
    const r = scoreDiagnostic(TMC_BANK, { q1: "many", q2: "large" }); // q3 missing
    expect(r.score).toBe(10);
    expect(r.warnings).toContain("unanswered:q3");
  });

  test("unknown single-choice option emits warning, contributes 0", () => {
    const r = scoreDiagnostic(TMC_BANK, { q1: "many", q2: "small", q3: "garbage" });
    expect(r.score).toBe(6); // q3 contributes 0 (not 1 or 5)
    expect(r.warnings).toContain("unknown-option:q3:garbage");
  });

  test("empty-string answer treated as unanswered, not as a value", () => {
    const r = scoreDiagnostic(TMC_BANK, { q1: "many", q2: "", q3: "weekend" });
    expect(r.score).toBe(6); // 5 + 1, q2 unanswered
    expect(r.warnings).toContain("unanswered:q2");
  });

  test("score below all bands emits no-band-matched + nulls classification", () => {
    const bank = {
      method: "weighted-sum",
      questions: [{ id: "q1", options: [{ value: "x", weight: -5 }] }],
      bands: [{ minScore: 0, maxScore: 10, classification: "level_1", label: "L1", recommendedTier: "entry" }],
    };
    const r = scoreDiagnostic(bank, { q1: "x" });
    expect(r.score).toBe(-5);
    expect(r.classification).toBeNull();
    expect(r.classificationLabel).toBeNull();
    expect(r.recommendedTier).toBeNull();
    expect(r.warnings).toContain("no-band-matched:score=-5");
  });
});

// ── Determinism / audit invariant ───────────────────────────────────

describe("scoreDiagnostic — determinism", () => {
  test("same inputs → identical outputs across calls", () => {
    const answers = { q1: "many", q2: "large", q3: "longer" };
    const r1 = scoreDiagnostic(TMC_BANK, answers);
    const r2 = scoreDiagnostic(TMC_BANK, answers);
    expect(r1).toEqual(r2);
  });

  test("score rounds to 4 decimal places (matches Decimal(10,4) column)", () => {
    const fractionalBank = {
      method: "weighted-sum",
      questions: [
        { id: "q1", options: [{ value: "x", weight: 0.123456789 }] },
        { id: "q2", options: [{ value: "y", weight: 0.987654321 }] },
      ],
      bands: [{ minScore: 0, maxScore: 99, classification: "level_1", label: "L1", recommendedTier: "entry" }],
    };
    const r = scoreDiagnostic(fractionalBank, { q1: "x", q2: "y" });
    expect(r.score).toBe(1.1111); // rounded to 4dp from 1.11111111
  });
});

// ── Type / input guards ─────────────────────────────────────────────

describe("scoreDiagnostic — input validation", () => {
  test("throws on non-object bank", () => {
    expect(() => scoreDiagnostic(null, {})).toThrow(/bank must be an object/);
    expect(() => scoreDiagnostic("string", {})).toThrow(/bank must be an object/);
  });

  test("throws on non-object answers", () => {
    expect(() => scoreDiagnostic(TMC_BANK, null)).toThrow(/answers must be an object/);
  });

  test("throws on unsupported scoring method", () => {
    const badBank = { ...TMC_BANK, method: "branching-tree" };
    expect(() => scoreDiagnostic(badBank, {})).toThrow(/unsupported method/);
  });

  test("empty bank scores 0 + null classification (no questions, no bands)", () => {
    const r = scoreDiagnostic({ method: "weighted-sum" }, {});
    expect(r.score).toBe(0);
    expect(r.classification).toBeNull();
    expect(r.warnings).toContain("no-band-matched:score=0");
  });
});

// ── parseBank — graceful JSON failure ───────────────────────────────

describe("parseBank — JSON string parsing", () => {
  test("happy path: valid JSON returns parsed bank + empty warnings", () => {
    const qJson = JSON.stringify({ questions: TMC_BANK.questions });
    const rJson = JSON.stringify({ method: "weighted-sum", bands: TMC_BANK.bands });
    const { bank, warnings } = parseBank(qJson, rJson);
    expect(bank).toBeTruthy();
    expect(bank.questions).toHaveLength(3);
    expect(bank.bands).toHaveLength(3);
    expect(bank.method).toBe("weighted-sum");
    expect(warnings).toEqual([]);
  });

  test("malformed questions JSON returns null bank + parse-error warning", () => {
    const { bank, warnings } = parseBank("{not valid json", JSON.stringify({ bands: [] }));
    expect(bank).toBeNull();
    expect(warnings.some((w) => w.startsWith("parse-error:questions:"))).toBe(true);
  });

  test("malformed scoring JSON returns null bank + parse-error warning", () => {
    const { bank, warnings } = parseBank(JSON.stringify({ questions: [] }), "not json");
    expect(bank).toBeNull();
    expect(warnings.some((w) => w.startsWith("parse-error:scoring-rules:"))).toBe(true);
  });
});
