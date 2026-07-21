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
