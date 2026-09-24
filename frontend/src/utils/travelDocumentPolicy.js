// Passport is required only for international TMC trips. Missing or unknown
// values remain international for backwards compatibility with legacy trips.
export function normalizeTripType(value) {
  const normalized = String(value || "international")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ["domestic", "international", "day_trip"].includes(normalized)
    ? normalized
    : "international";
}

export function tripRequiresPassport(value) {
  return normalizeTripType(value) === "international";
}

export function requiredParentDocumentTypes(value) {
  return tripRequiresPassport(value)
    ? ["passport", "aadhaar", "consent-form", "visa"]
    : ["aadhaar", "consent-form"];
}
