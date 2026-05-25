// Travel CRM — Indian GSTIN format + state-code + checksum validator (pure).
//
// Slice 13 of the #902 GST & Compliance module (PRD:
// docs/PRD_TRAVEL_GST_COMPLIANCE.md §3.3 FR-3.3.1).  Pure function — no
// Prisma, no fetch, no IO.  Re-used by future route layers (Contact write,
// Patient write, Vendor write, Tenant.subBrandConfigJson per-brand GSTIN
// — see FR-3.3.2).  Format-only validation; the optional GSTN reverse-check
// (FR-3.3.3, cred-blocked Q-GST-2) stays out of scope for this slice.
//
// The existing #903 slice-1 regex in `backend/routes/travel_suppliers.js`
// explicitly defers "deeper state-code-table + checksum validation" here
// (see comment at line 391-396).  Slice 13 ships that deeper validation
// in a shared helper so every GSTIN-write site can adopt the stricter
// check in subsequent slices.
//
// === GSTIN layout (15 chars) ===
//
//   positions 1-2   : 2-digit state code (must map to a real Indian state
//                     per `STATE_CODES` table below — CBIC list of 38
//                     state/UT codes as of 2026, including 97 for "Other
//                     Territory" used for cross-state-line corp registrations)
//   positions 3-7   : 5 letters (PAN alphabetic prefix — entity name)
//   positions 8-11  : 4 digits (PAN numeric — entity-specific)
//   position 12     : 1 letter (PAN entity-type code: P/F/C/A/T/B/L/J/G/H)
//   position 13     : 1 alphanumeric (entity-code within the state; '1' for
//                     first registration, '2' for second, etc.; rolls into
//                     A-Z after digit 9 exhausted)
//   position 14     : literal 'Z' (currently always Z; future-reserved)
//   position 15     : 1 alphanumeric (checksum digit; computed via the
//                     CBIC base-36 algorithm — see `computeChecksumChar`)
//
// === Checksum algorithm ===
//
// CBIC notification 39/2017 (public, see PRD §5 vendor docs section).
// Same family as Luhn, but in base 36 instead of base 10:
//
//   1. Map each of the first 14 characters to its base-36 value
//      (0-9 → 0-9, A-Z → 10-35).
//   2. Weight: positions 1,3,5,7,9,11,13 → weight 1; positions
//      2,4,6,8,10,12,14 → weight 2.
//   3. For each (value × weight), if the product >= 36, take
//      product/36 (int-div) + product%36 (digit-sum within base 36).
//      i.e. sum the base-36 digits of the product.
//   4. Sum all weighted-digit sums; take that sum mod 36; subtract
//      from 36 (or 0 if the result is 36).  Map back to base-36 char.
//
// === Stateless contract ===
//
//   validateGstinFormat(gstin)
//     → { valid: true } | { valid: false, reason: '<machine-readable>' }
//
// The route-layer caller is expected to map `{ valid: false }` to a 400
// with `error: { code: 'INVALID_GSTIN', detail: reason }` per AC-6.4.
// This module never throws; it returns a result object so the caller
// owns the HTTP shape.
//
// PRD: docs/PRD_TRAVEL_GST_COMPLIANCE.md §3.3.
"use strict";

// CBIC state codes 01-38 + 97 + 99 ("Centre Jurisdiction" / "Other Territory").
// 38 is Ladakh (2019 split from J&K); 96 reserved; 97 Other Territory; 99
// reserved for centre.  This list pins the universe of valid first-2-digit
// prefixes — a GSTIN with state code 40, for example, is structurally invalid.
const STATE_CODES = new Set([
  "01", // Jammu & Kashmir
  "02", // Himachal Pradesh
  "03", // Punjab
  "04", // Chandigarh
  "05", // Uttarakhand
  "06", // Haryana
  "07", // Delhi
  "08", // Rajasthan
  "09", // Uttar Pradesh
  "10", // Bihar
  "11", // Sikkim
  "12", // Arunachal Pradesh
  "13", // Nagaland
  "14", // Manipur
  "15", // Mizoram
  "16", // Tripura
  "17", // Meghalaya
  "18", // Assam
  "19", // West Bengal
  "20", // Jharkhand
  "21", // Odisha
  "22", // Chhattisgarh
  "23", // Madhya Pradesh
  "24", // Gujarat
  "25", // Daman & Diu (merged into 26 in 2020 but historic GSTINs persist)
  "26", // Dadra & Nagar Haveli and Daman & Diu (merged UT)
  "27", // Maharashtra
  "28", // Andhra Pradesh (pre-bifurcation; historic only)
  "29", // Karnataka
  "30", // Goa
  "31", // Lakshadweep
  "32", // Kerala
  "33", // Tamil Nadu
  "34", // Puducherry
  "35", // Andaman & Nicobar Islands
  "36", // Telangana
  "37", // Andhra Pradesh (post-bifurcation)
  "38", // Ladakh
  "97", // Other Territory
  "99", // Centre Jurisdiction
]);

const FORMAT_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

// Base-36 value of one character: '0'-'9' → 0-9, 'A'-'Z' → 10-35.
function charToValue(c) {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 90) return code - 65 + 10; // A-Z
  return -1; // unreachable when input has passed FORMAT_REGEX
}

function valueToChar(v) {
  if (v < 10) return String.fromCharCode(48 + v);
  return String.fromCharCode(65 + (v - 10));
}

// Sum the base-36 digits of an integer.  E.g. value=37 → 37 in base-36 is
// "11" → sum 2.  Used to fold (value × weight) when the product ≥ 36.
function sumBase36Digits(n) {
  let s = 0;
  while (n > 0) {
    s += n % 36;
    n = Math.floor(n / 36);
  }
  return s;
}

// Compute the expected checksum character for a 14-char GSTIN prefix.
// Returns null if the prefix is malformed (defensive — caller has already
// regex-checked).
function computeChecksumChar(first14) {
  if (typeof first14 !== "string" || first14.length !== 14) return null;
  let factor = 2;
  let sum = 0;
  // CBIC: process left-to-right starting with factor=1 at position 1,
  // factor=2 at position 2, etc.  Loop iterates positions 1..14 → indices 0..13.
  for (let i = 0; i < 14; i++) {
    const v = charToValue(first14[i]);
    if (v < 0) return null;
    factor = (i % 2 === 0) ? 1 : 2;
    const product = v * factor;
    sum += sumBase36Digits(product);
  }
  const remainder = sum % 36;
  const checksumValue = (36 - remainder) % 36;
  return valueToChar(checksumValue);
}

// Public entry point — never throws.
//   validateGstinFormat('27AAACR4849R1ZW')
//     → { valid: true }
//   validateGstinFormat('XXAAACR4849R1ZW')
//     → { valid: false, reason: 'INVALID_FORMAT' }
//   validateGstinFormat('40AAACR4849R1ZW')
//     → { valid: false, reason: 'INVALID_STATE_CODE' }
//   validateGstinFormat('27AAACR4849R1ZX')   // wrong checksum
//     → { valid: false, reason: 'INVALID_CHECKSUM' }
function validateGstinFormat(gstin) {
  if (gstin == null) return { valid: false, reason: "EMPTY" };
  if (typeof gstin !== "string") return { valid: false, reason: "NOT_STRING" };
  const trimmed = gstin.trim().toUpperCase();
  if (trimmed === "") return { valid: false, reason: "EMPTY" };
  if (trimmed.length !== 15) return { valid: false, reason: "BAD_LENGTH" };
  if (!FORMAT_REGEX.test(trimmed)) return { valid: false, reason: "INVALID_FORMAT" };
  const stateCode = trimmed.slice(0, 2);
  if (!STATE_CODES.has(stateCode)) return { valid: false, reason: "INVALID_STATE_CODE" };
  const expected = computeChecksumChar(trimmed.slice(0, 14));
  if (expected !== trimmed[14]) return { valid: false, reason: "INVALID_CHECKSUM" };
  return { valid: true };
}

// Convenience boolean variant — for call-sites that only want a yes/no.
function isValidGstin(gstin) {
  return validateGstinFormat(gstin).valid === true;
}

// Convenience normaliser — uppercase + trim.  Returns null if input is
// nullish so callers can pass through optional fields without branching.
function normaliseGstin(gstin) {
  if (gstin == null) return null;
  if (typeof gstin !== "string") return null;
  const t = gstin.trim().toUpperCase();
  return t === "" ? null : t;
}

// State-code lookup — returns the 2-char state code prefix of a valid
// GSTIN, or null if the input doesn't pass format validation.  Used by
// the future place-of-supply router (FR-3.5.2) to derive seller-state
// from a GSTIN string when no separate `stateCode` field is stored.
function stateCodeFromGstin(gstin) {
  const r = validateGstinFormat(gstin);
  if (!r.valid) return null;
  return gstin.trim().toUpperCase().slice(0, 2);
}

module.exports = {
  validateGstinFormat,
  isValidGstin,
  normaliseGstin,
  stateCodeFromGstin,
  // Exposed for tests + future tax-rate-master seeders.
  STATE_CODES,
  computeChecksumChar,
};
