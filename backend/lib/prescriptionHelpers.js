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
  const strength = [drug.strengthValue, drug.strengthUnit]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .join("");
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

module.exports = { normalizePrescriptionDrugs, normalizePrescriptionList };
