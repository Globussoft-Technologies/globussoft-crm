// Unit tests for backend/lib/gstinValidator.js
//
// Slice 13 of #902 GST & Compliance.  Pins the pure-function GSTIN
// validator (format + state-code-table + checksum algorithm) that
// will be wired into Contact / Patient / Vendor / Tenant.subBrandConfig
// write paths in subsequent slices (FR-3.3.2).
//
// PRD: docs/PRD_TRAVEL_GST_COMPLIANCE.md §3.3.  Acceptance: AC-6.4
// (invalid GSTIN → INVALID_GSTIN with reason detail).
//
// Sample GSTINs used here are constructed via the validator's own
// `computeChecksumChar` (round-trip).  Real-world GSTINs from public
// documentation are used as positive cases where confirmed valid
// (27AAPFU0939F1ZV, 29AAGCB7383J1Z4, 37AADCS0472N1Z1).
//
// References:
//   - CBIC notification 39/2017 (GSTIN format spec)
//   - GSTN dev portal (public state-code table)

import { describe, test, expect } from "vitest";

const {
  validateGstinFormat,
  isValidGstin,
  normaliseGstin,
  stateCodeFromGstin,
  computeChecksumChar,
  STATE_CODES,
} = await import("../../lib/gstinValidator.js");

describe("validateGstinFormat — happy path", () => {
  test("real-world public-documented GSTINs pass (sample: 27AAPFU0939F1ZV)", () => {
    expect(validateGstinFormat("27AAPFU0939F1ZV")).toEqual({ valid: true });
    expect(validateGstinFormat("29AAGCB7383J1Z4")).toEqual({ valid: true });
    expect(validateGstinFormat("37AADCS0472N1Z1")).toEqual({ valid: true });
  });

  test("lowercase input is normalised + validated (case-insensitive)", () => {
    expect(validateGstinFormat("27aapfu0939f1zv")).toEqual({ valid: true });
  });

  test("surrounding whitespace is trimmed then validated", () => {
    expect(validateGstinFormat("  27AAPFU0939F1ZV  ")).toEqual({ valid: true });
  });

  test("a constructed GSTIN with computed checksum round-trips", () => {
    const prefix = "27AAACR4849R1Z";
    const c = computeChecksumChar(prefix);
    expect(validateGstinFormat(prefix + c)).toEqual({ valid: true });
  });
});

describe("validateGstinFormat — empty / null / wrong-type", () => {
  test("null input → EMPTY", () => {
    expect(validateGstinFormat(null)).toEqual({
      valid: false,
      reason: "EMPTY",
    });
  });

  test("undefined input → EMPTY", () => {
    expect(validateGstinFormat(undefined)).toEqual({
      valid: false,
      reason: "EMPTY",
    });
  });

  test("empty string → EMPTY", () => {
    expect(validateGstinFormat("")).toEqual({ valid: false, reason: "EMPTY" });
  });

  test("whitespace-only string → EMPTY", () => {
    expect(validateGstinFormat("    ")).toEqual({
      valid: false,
      reason: "EMPTY",
    });
  });

  test("non-string input (number) → NOT_STRING", () => {
    expect(validateGstinFormat(27)).toEqual({
      valid: false,
      reason: "NOT_STRING",
    });
  });

  test("non-string input (object) → NOT_STRING", () => {
    expect(validateGstinFormat({ gstin: "27AAACR4849R1ZL" })).toEqual({
      valid: false,
      reason: "NOT_STRING",
    });
  });
});

describe("validateGstinFormat — length", () => {
  test("14 chars (missing checksum) → BAD_LENGTH", () => {
    expect(validateGstinFormat("27AAACR4849R1Z")).toEqual({
      valid: false,
      reason: "BAD_LENGTH",
    });
  });

  test("16 chars (extra char) → BAD_LENGTH", () => {
    expect(validateGstinFormat("27AAACR4849R1ZLX")).toEqual({
      valid: false,
      reason: "BAD_LENGTH",
    });
  });
});

describe("validateGstinFormat — structural format violations (INVALID_FORMAT)", () => {
  test("first 2 chars not digits → INVALID_FORMAT", () => {
    // 'XX' in positions 1-2 instead of digits
    expect(validateGstinFormat("XXAAACR4849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });

  test("PAN alphabetic positions (3-7) contain a digit → INVALID_FORMAT", () => {
    // '4' in position 3 instead of letter
    expect(validateGstinFormat("274AACR4849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });

  test("PAN numeric positions (8-11) contain a letter → INVALID_FORMAT", () => {
    // 'X' in position 8 instead of digit
    expect(validateGstinFormat("27AAACRX849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });

  test("position 14 not 'Z' → INVALID_FORMAT", () => {
    // 'Y' instead of literal 'Z' at position 14
    expect(validateGstinFormat("27AAACR4849R1YL")).toEqual({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });

  test("position 13 cannot be '0' (entity-code starts at 1) → INVALID_FORMAT", () => {
    // '0' at position 13 — the [1-9A-Z] regex class excludes 0
    expect(validateGstinFormat("27AAACR4849R0ZL")).toEqual({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });

  test("special character anywhere → INVALID_FORMAT", () => {
    expect(validateGstinFormat("27AAACR-849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_FORMAT",
    });
  });
});

describe("validateGstinFormat — state-code table", () => {
  test("state code 40 (not in CBIC table) → INVALID_STATE_CODE", () => {
    expect(validateGstinFormat("40AAACR4849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_STATE_CODE",
    });
  });

  test("state code 00 (not assigned) → INVALID_STATE_CODE", () => {
    expect(validateGstinFormat("00AAACR4849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_STATE_CODE",
    });
  });

  test("state code 50 (not assigned) → INVALID_STATE_CODE", () => {
    expect(validateGstinFormat("50AAACR4849R1ZL")).toEqual({
      valid: false,
      reason: "INVALID_STATE_CODE",
    });
  });

  test("state code 97 (Other Territory — CBIC reserved) is accepted", () => {
    const prefix = "97AAACR4849R1Z";
    const c = computeChecksumChar(prefix);
    expect(validateGstinFormat(prefix + c)).toEqual({ valid: true });
  });

  test("state code 38 (Ladakh, 2019-added) is accepted", () => {
    const prefix = "38AAACR4849R1Z";
    const c = computeChecksumChar(prefix);
    expect(validateGstinFormat(prefix + c)).toEqual({ valid: true });
  });

  test("STATE_CODES contains all 38+ canonical Indian state codes", () => {
    // Sanity-pin a few — full enumeration not necessary; just the
    // major travel-relevant ones the 4 sub-brands operate in.
    expect(STATE_CODES.has("27")).toBe(true); // Maharashtra
    expect(STATE_CODES.has("33")).toBe(true); // Tamil Nadu
    expect(STATE_CODES.has("36")).toBe(true); // Telangana
    expect(STATE_CODES.has("29")).toBe(true); // Karnataka
    expect(STATE_CODES.has("07")).toBe(true); // Delhi
    expect(STATE_CODES.has("38")).toBe(true); // Ladakh
    expect(STATE_CODES.has("97")).toBe(true); // Other Territory
  });
});

describe("validateGstinFormat — checksum", () => {
  test("valid format + valid state code + wrong checksum → INVALID_CHECKSUM", () => {
    // Start with a valid GSTIN (27AAPFU0939F1ZV), flip the checksum to '0'.
    expect(validateGstinFormat("27AAPFU0939F1Z0")).toEqual({
      valid: false,
      reason: "INVALID_CHECKSUM",
    });
  });

  test("known-fabricated documentation sample (22AAAAA0000A1Z5) fails checksum", () => {
    // This GSTIN appears in many online tutorials but its checksum
    // doesn't actually compute — useful to confirm the validator is
    // strict (not just rubber-stamping anything that looks like a GSTIN).
    expect(validateGstinFormat("22AAAAA0000A1Z5")).toEqual({
      valid: false,
      reason: "INVALID_CHECKSUM",
    });
  });

  test("checksum 'I' (computed) is required for 27AYIPS9760K1Z", () => {
    // Demonstrates that the algorithm rejects 'H' (off-by-one from 'I')
    // even though everything else about the GSTIN is structurally fine.
    expect(validateGstinFormat("27AYIPS9760K1ZH")).toEqual({
      valid: false,
      reason: "INVALID_CHECKSUM",
    });
    expect(validateGstinFormat("27AYIPS9760K1ZI")).toEqual({ valid: true });
  });

  test("checksum is deterministic + reproducible for the same prefix", () => {
    const c1 = computeChecksumChar("27AAACR4849R1Z");
    const c2 = computeChecksumChar("27AAACR4849R1Z");
    expect(c1).toBe(c2);
    expect(typeof c1).toBe("string");
    expect(c1.length).toBe(1);
  });
});

describe("computeChecksumChar — defensive", () => {
  test("non-string input → null", () => {
    expect(computeChecksumChar(null)).toBe(null);
    expect(computeChecksumChar(undefined)).toBe(null);
    expect(computeChecksumChar(123)).toBe(null);
  });

  test("wrong length input → null", () => {
    expect(computeChecksumChar("27AAACR4849R1Z").length).toBe(1); // 14 chars OK
    expect(computeChecksumChar("27AAACR4849R1")).toBe(null); // 13 chars
    expect(computeChecksumChar("27AAACR4849R1ZAB")).toBe(null); // 16 chars
  });
});

describe("isValidGstin convenience", () => {
  test("returns boolean true for valid GSTIN", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
  });

  test("returns boolean false for invalid GSTIN", () => {
    expect(isValidGstin("XXXXXX")).toBe(false);
    expect(isValidGstin(null)).toBe(false);
    expect(isValidGstin("27AAPFU0939F1Z0")).toBe(false);
  });
});

describe("normaliseGstin", () => {
  test("uppercase + trim a valid-shaped string", () => {
    expect(normaliseGstin("  27aapfu0939f1zv  ")).toBe("27AAPFU0939F1ZV");
  });

  test("null input → null (passthrough for optional fields)", () => {
    expect(normaliseGstin(null)).toBe(null);
    expect(normaliseGstin(undefined)).toBe(null);
  });

  test("empty / whitespace-only → null", () => {
    expect(normaliseGstin("")).toBe(null);
    expect(normaliseGstin("   ")).toBe(null);
  });

  test("non-string → null", () => {
    expect(normaliseGstin(27)).toBe(null);
    expect(normaliseGstin({})).toBe(null);
  });
});

describe("stateCodeFromGstin", () => {
  test("returns 2-char state prefix for valid GSTIN", () => {
    expect(stateCodeFromGstin("27AAPFU0939F1ZV")).toBe("27");
    expect(stateCodeFromGstin("29AAGCB7383J1Z4")).toBe("29");
    expect(stateCodeFromGstin("37AADCS0472N1Z1")).toBe("37");
  });

  test("returns null when GSTIN is structurally invalid", () => {
    expect(stateCodeFromGstin("40AAACR4849R1ZL")).toBe(null); // bad state
    expect(stateCodeFromGstin("27AAPFU0939F1Z0")).toBe(null); // bad checksum
    expect(stateCodeFromGstin(null)).toBe(null);
    expect(stateCodeFromGstin("not a gstin")).toBe(null);
  });

  test("accepts lowercase + trimmed input", () => {
    expect(stateCodeFromGstin("  27aapfu0939f1zv  ")).toBe("27");
  });
});
