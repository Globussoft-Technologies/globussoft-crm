// @ts-check
/**
 * Unit tests for backend/lib/prescriptionHelpers.js.
 *
 * Pins the response-shape normalization for Prescription.drugs. The DB stores
 * it as a JSON string; the API must return it as a usable array without
 * breaking existing consumers that might still see a string (e.g. cached data
 * or callers that have not migrated).
 *
 * Normalisation rules:
 *   - dosage, frequency and duration are returned as integers
 *   - drug name is enriched with catalogue strengthValue + strengthUnit
 */

import { describe, test, expect } from "vitest";
import {
  normalizePrescriptionDrugs,
  normalizePrescriptionList,
  parseValidityDays,
  computeValidUntil,
  MAX_VALIDITY_DAYS,
} from "../../lib/prescriptionHelpers";

describe("normalizePrescriptionDrugs", () => {
  test("parses a JSON string into an array", () => {
    const rx = {
      id: 1,
      drugs: '[{"name":"Amoxicillin","dosage":"1 capsule","frequency":"three times daily"}]',
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([
      { name: "Amoxicillin", dosage: 1, frequency: 3, duration: null },
    ]);
    expect(result.id).toBe(1);
  });

  test("leaves an already-parsed array untouched except for normalisation", () => {
    const rx = {
      id: 2,
      drugs: [{ name: "Crocin Advance", dosage: "1 tablet", frequency: 1 }],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([
      { name: "Crocin Advance", dosage: 1, frequency: 1, duration: null },
    ]);
  });

  test("extracts integers from dosage, frequency and duration strings", () => {
    const rx = {
      id: 3,
      drugs: [
        { name: "Amoxicillin", dosage: "1 capsule", frequency: "three times daily", duration: "5 days" },
        { name: "Crocin Advance", dosage: "2 tablets", frequency: "twice daily", duration: "3 days" },
        { name: "Azithromycin", dosage: "500 mg", frequency: "once daily", duration: "7 days" },
      ],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([
      { name: "Amoxicillin", dosage: 1, frequency: 3, duration: 5 },
      { name: "Crocin Advance", dosage: 2, frequency: 2, duration: 3 },
      { name: "Azithromycin", dosage: 500, frequency: 1, duration: 7 },
    ]);
  });

  test("keeps numeric dosage, frequency and duration as integers", () => {
    const rx = {
      id: 4,
      drugs: [{ name: "Amoxicillin", dosage: 1, frequency: 3, duration: 5 }],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([
      { name: "Amoxicillin", dosage: 1, frequency: 3, duration: 5 },
    ]);
  });

  test("treats NaN and unparseable values as null", () => {
    const rx = {
      id: 4,
      drugs: [
        { name: "Amoxicillin", dosage: NaN, frequency: "as needed", duration: "" },
      ],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([
      { name: "Amoxicillin", dosage: null, frequency: null, duration: null },
    ]);
  });

  test("enriches drug name with catalogue strength", () => {
    const rx = {
      id: 5,
      drugs: [
        { name: "Amoxicillin", strengthValue: "500", strengthUnit: "mg", dosage: 1, frequency: 3, duration: 5 },
      ],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([
      { name: "Amoxicillin 500mg", strengthValue: "500", strengthUnit: "mg", dosage: 1, frequency: 3, duration: 5 },
    ]);
  });

  test("does not duplicate strength when it is already part of the name", () => {
    const rx = {
      id: 6,
      drugs: [
        { name: "Amoxicillin 500mg", strengthValue: "500", strengthUnit: "mg", dosage: 1 },
        { name: "AMOXICILLIN 500MG", strengthValue: "500", strengthUnit: "mg", dosage: 1 },
      ],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs[0].name).toBe("Amoxicillin 500mg");
    expect(result.drugs[1].name).toBe("AMOXICILLIN 500MG");
  });

  test("preserves other drug fields while normalising", () => {
    const rx = {
      id: 7,
      drugs: [
        {
          name: "Atorvastatin",
          strengthValue: "10",
          strengthUnit: "mg",
          dosage: "1",
          frequency: "once",
          duration: "30",
          drugId: 42,
        },
      ],
    };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs[0]).toEqual({
      name: "Atorvastatin 10mg",
      strengthValue: "10",
      strengthUnit: "mg",
      dosage: 1,
      frequency: 1,
      duration: 30,
      drugId: 42,
    });
  });

  test("falls back to an empty array for invalid JSON", () => {
    const rx = { id: 8, drugs: "not-json" };
    const result = normalizePrescriptionDrugs(rx);
    expect(result.drugs).toEqual([]);
  });

  test("preserves null / missing drugs as-is", () => {
    const nullRx = { id: 9, drugs: null };
    expect(normalizePrescriptionDrugs(nullRx).drugs).toBeNull();

    const missingRx = { id: 10 };
    expect(normalizePrescriptionDrugs(missingRx).drugs).toBeUndefined();
  });

  test("returns null for a null input", () => {
    expect(normalizePrescriptionDrugs(null)).toBeNull();
  });
});

describe("normalizePrescriptionList", () => {
  test("maps every prescription in an array", () => {
    const prescriptions = [
      { id: 1, drugs: '[{"name":"A","dosage":"1"}]' },
      { id: 2, drugs: '[{"name":"B","frequency":"2"}]' },
    ];
    const result = normalizePrescriptionList(prescriptions);
    expect(result).toHaveLength(2);
    expect(result[0].drugs).toEqual([{ name: "A", dosage: 1, frequency: null, duration: null }]);
    expect(result[1].drugs).toEqual([{ name: "B", dosage: null, frequency: 2, duration: null }]);
  });

  test("returns non-array input unchanged", () => {
    expect(normalizePrescriptionList(null)).toBeNull();
    expect(normalizePrescriptionList(undefined)).toBeUndefined();
  });

  test("returns an empty array unchanged", () => {
    expect(normalizePrescriptionList([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Prescription validity — how long the course runs.
//
// Pinned here because two routes (create + amend) and, later, the renewal
// reminder sweep all depend on the same two rules: what counts as a usable
// value, and that the lapse date is anchored to the ISSUE date rather than
// to "now".
// ─────────────────────────────────────────────────────────────────────────

describe("parseValidityDays", () => {
  test("blank means 'no stated validity', not zero", () => {
    expect(parseValidityDays(undefined)).toBeNull();
    expect(parseValidityDays(null)).toBeNull();
    expect(parseValidityDays("")).toBeNull();
  });

  test("accepts a positive whole number of days, as string or number", () => {
    expect(parseValidityDays(30)).toBe(30);
    expect(parseValidityDays("30")).toBe(30);
    expect(parseValidityDays(1)).toBe(1);
    expect(parseValidityDays(MAX_VALIDITY_DAYS)).toBe(MAX_VALIDITY_DAYS);
  });

  test("rejects zero, negatives, fractions and junk rather than dropping them", () => {
    // Silently coercing these would lose what the clinician typed, so each
    // must surface as a 400-mappable error.
    for (const bad of [0, -5, 1.5, "soon", "30 days", {}]) {
      expect(() => parseValidityDays(bad)).toThrow(/whole number of days/);
    }
  });

  test("caps at one year and tags the error for the route layer", () => {
    try {
      parseValidityDays(MAX_VALIDITY_DAYS + 1);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.code).toBe("INVALID_VALIDITY_DAYS");
    }
  });
});

describe("computeValidUntil", () => {
  test("no validity means no lapse date", () => {
    expect(computeValidUntil(new Date(), null)).toBeNull();
    expect(computeValidUntil(new Date(), 0)).toBeNull();
  });

  test("adds the days to the ISSUE date, not to now", () => {
    const issued = new Date("2026-06-01T09:00:00.000Z");
    expect(computeValidUntil(issued, 30).toISOString()).toBe(
      "2026-07-01T09:00:00.000Z",
    );
  });

  test("an amendment re-anchors to the original issue date", () => {
    // A 30-day course written on 1 June still lapses on 1 July when the
    // validity is edited weeks later — amending must not restart the clock.
    const issued = new Date("2026-06-01T09:00:00.000Z");
    const amendedLater = computeValidUntil(issued, 30);
    expect(amendedLater.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });

  test("accepts an ISO string issue date", () => {
    expect(computeValidUntil("2026-06-01T00:00:00.000Z", 7).toISOString()).toBe(
      "2026-06-08T00:00:00.000Z",
    );
  });

  test("an unparseable issue date yields null rather than an Invalid Date", () => {
    expect(computeValidUntil("not a date", 30)).toBeNull();
  });
});

// ── Junk strength must never be welded onto the drug name ──────────
//
// The Drug catalogue accepted strengthValue "-" with strengthUnit "-gm"
// before its write path was validated. buildDisplayName joined those blind
// into "---gm" and appended it to the drug NAME, so the junk travelled with
// the prescription onto the patient portal, the ledger and the PDF as part
// of the name itself — where no downstream display guard could strip it.
describe('buildDisplayName — junk strength', () => {
  test('a strength value with no digit is not appended to the name', () => {
    const [drug] = normalizePrescriptionDrugs({
      drugs: [{ name: '360 Block Sunscreen', strengthValue: '-', strengthUnit: '-gm' }],
    }).drugs;
    expect(drug.name).toBe('360 Block Sunscreen');
  });

  test('the "----" case from the reported portal screenshot', () => {
    const [drug] = normalizePrescriptionDrugs({
      drugs: [{ name: 'Anti acne face wash', strengthValue: '--', strengthUnit: '--' }],
    }).drugs;
    expect(drug.name).toBe('Anti acne face wash');
  });

  test('a real strength is still appended', () => {
    const [drug] = normalizePrescriptionDrugs({
      drugs: [{ name: 'Amoxicillin', strengthValue: '500', strengthUnit: 'mg' }],
    }).drugs;
    expect(drug.name).toBe('Amoxicillin 500mg');
  });

  test('a strength already inside the name is not duplicated', () => {
    const [drug] = normalizePrescriptionDrugs({
      drugs: [{ name: 'Amoxicillin 500mg', strengthValue: '500', strengthUnit: 'mg' }],
    }).drugs;
    expect(drug.name).toBe('Amoxicillin 500mg');
  });
});
