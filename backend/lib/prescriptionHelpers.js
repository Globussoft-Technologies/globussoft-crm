/**
 * Prescription response normalization helpers.
 *
 * Prescription.drugs is stored as a JSON string in the DB (String @db.Text).
 * These helpers convert it back to a real JSON array on the way out so the API
 * returns a usable shape instead of a string that clients must JSON.parse, and
 * normalise each drug to the canonical response format expected by the UI:
 *   - name is enriched with the catalogue strength (e.g. "Amoxicillin 500mg")
 *   - dosage, frequency and duration are returned as integers
 */

const WORD_TO_NUMBER = {
  one: 1,
  once: 1,
  two: 2,
  twice: 2,
  three: 3,
  thrice: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function extractInteger(value) {
  if (value === null || value === undefined || value === "" || Number.isNaN(value)) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : Math.floor(value);
  }

  const str = String(value).trim();
  if (str === "") return null;

  // Direct integer string (e.g. "1", "5").
  const direct = parseInt(str, 10);
  if (!Number.isNaN(direct)) return direct;

  // Common English / clinical phrasing (e.g. "once", "twice", "three times").
  const firstWord = str.toLowerCase().split(/\s+/)[0];
  if (WORD_TO_NUMBER[firstWord]) return WORD_TO_NUMBER[firstWord];

  // Extract the leading numeric token from strings like "1 capsule" or "5 days".
  const match = str.match(/\d+/);
  if (match) return parseInt(match[0], 10);

  return null;
}

function buildDisplayName(drug) {
  const baseName = drug.name || drug.drugName || "";
  // A strength VALUE with no digit in it is not a strength. The Drug
  // catalogue accepted strengthValue "-" with strengthUnit "-gm" before its
  // write path was validated, and joining those blind produced "---gm", which
  // this function then welded onto the drug name — so the junk followed the
  // prescription onto the patient portal, the ledger and the PDF as part of
  // the name itself, where no downstream guard could strip it.
  const value = drug.strengthValue == null ? "" : String(drug.strengthValue).trim();
  const unit = drug.strengthUnit == null ? "" : String(drug.strengthUnit).trim();
  const strength = /[0-9]/.test(value) ? [value, unit].filter(Boolean).join("") : "";
  if (!strength) return baseName;

  // Avoid duplicating the strength if it is already part of the stored name.
  if (baseName.toLowerCase().includes(strength.toLowerCase())) return baseName;

  return `${baseName} ${strength}`.trim();
}

function normalizeDrug(drug) {
  if (!drug || typeof drug !== "object") return drug;
  return {
    ...drug,
    name: buildDisplayName(drug),
    dosage: extractInteger(drug.dosage),
    frequency: extractInteger(drug.frequency),
    duration: extractInteger(drug.duration),
  };
}

function normalizePrescriptionDrugs(rx) {
  if (!rx) return rx;
  let drugs = rx.drugs;
  if (typeof drugs === "string") {
    try {
      drugs = JSON.parse(drugs);
    } catch {
      drugs = [];
    }
  }
  if (Array.isArray(drugs)) {
    drugs = drugs.map(normalizeDrug);
  }
  return { ...rx, drugs };
}

function normalizePrescriptionList(prescriptions) {
  if (!Array.isArray(prescriptions)) return prescriptions;
  return prescriptions.map(normalizePrescriptionDrugs);
}

/**
 * Prescription validity — how long the prescribed course is meant to last.
 *
 * Lives here rather than inline in the route so the create and the amend path
 * cannot disagree about the bounds, and so the renewal engine can reuse the
 * same derivation when it starts reminding patients.
 */

// A course longer than a year is not a prescription, it is a repeat
// arrangement — and an unbounded value would put `validUntil` somewhere the
// reminder sweep will never reach. Matches the cap on renewal-request
// durations in lib/prescriptionRenewalService.js.
const MAX_VALIDITY_DAYS = 365;

/**
 * Normalise the clinician-entered validity.
 *
 * @returns {number|null} whole days, or null when the field was left blank
 *   (null means "no stated validity" — NOT expired, and nothing downstream
 *   may treat it as such).
 * @throws {Error} with `.code = 'INVALID_VALIDITY_DAYS'` on a value that is
 *   present but unusable, so the route can map it to a 400 rather than
 *   silently dropping what the doctor typed.
 */
function parseValidityDays(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > MAX_VALIDITY_DAYS) {
    const err = new Error(
      `validityDays must be a whole number of days between 1 and ${MAX_VALIDITY_DAYS}`,
    );
    err.code = "INVALID_VALIDITY_DAYS";
    throw err;
  }
  return n;
}

/**
 * Derive the lapse date from the day the prescription was ISSUED — not from
 * "now". On an amendment that matters: a 30-day course written last week has
 * three weeks left, not thirty days. Passing the original `createdAt` keeps
 * the window anchored to when the patient actually started the medication.
 */
function computeValidUntil(issuedAt, validityDays) {
  if (!validityDays) return null;
  const start = issuedAt ? new Date(issuedAt) : new Date();
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + validityDays * 24 * 60 * 60 * 1000);
}

module.exports = {
  normalizePrescriptionDrugs,
  normalizePrescriptionList,
  parseValidityDays,
  computeValidUntil,
  MAX_VALIDITY_DAYS,
};
