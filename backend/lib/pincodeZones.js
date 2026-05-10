/**
 * Pincode zone lookup — Wave 8b residual closure.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  PURPOSE
 * ────────────────────────────────────────────────────────────────────────
 *
 * Replaces the flat `DEFAULT_TRAVEL_TIME_MIN = 30` constant in
 * routes/wellness.js IN_HOME booking handler with a coarse zone-based
 * estimate. No external API key needed — purely a lookup against a
 * static map keyed by the first 3 digits of an Indian 6-digit PIN code.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  CONTRACT
 * ────────────────────────────────────────────────────────────────────────
 *
 *   - estimateTravelMinutes(clinicPincode, patientPincode) → minutes (Int)
 *   - Same zone (first 3 digits match) → 30 min (within-metro hop)
 *   - Different zone within same metro → 60 min (cross-metro)
 *   - Outside any known metro / unknown PIN → 90 min (rural / fallback)
 *   - Either side missing → 30 (legacy default — preserves current
 *     behaviour for callers that don't yet collect both pincodes).
 *
 * Indian metro PIN prefixes (3-digit, leading zero preserved as string):
 *
 *   Bangalore     560xxx
 *   Mumbai        400xxx
 *   Delhi         110xxx
 *   Chennai       600xxx
 *   Hyderabad     500xxx
 *   Kolkata       700xxx
 *   Pune          411xxx
 *   Ahmedabad     380xxx
 *   Kochi         682xxx (Cochin)
 *   Jaipur        302xxx
 *
 * Adding a metro is a one-line entry in METRO_PREFIXES + zone map.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  RATIONALE — why static + coarse (alternatives considered)
 * ────────────────────────────────────────────────────────────────────────
 *
 * The Wave 8b ask was specifically a stub — a full distance-API
 * integration (Google Maps Distance Matrix, OpenStreetMap, etc.)
 * carries vendor cost + key management overhead that's premature for
 * the booking-widget MVP. The zone approach is "good enough" travel-
 * time guidance to populate `travelTimeMinutes` on the Visit row;
 * downstream the operations dashboard surfaces actual times for
 * calibration.
 *
 * If a future product call wants real distance / time API integration,
 * the seam is one function (estimateTravelMinutes). Provider integration
 * would replace the function body; the contract + callsites stay stable.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  TESTED + ADOPTED
 * ────────────────────────────────────────────────────────────────────────
 *
 * Tested at: backend/test/lib/pincodeZones.test.js
 *   (16 vitest cases pinning prefix extraction, metro mapping, time bands,
 *    monotonic-band ordering, legacy FALLBACK match)
 *
 * Adopted by:
 *   - routes/wellness.js — public-booking IN_HOME visitDate computation
 *     (sets Visit.travelTimeMinutes from estimateTravelMinutes output)
 *
 * NOT adopted by (deliberate):
 *   - generic CRM /api/booking routes — no travel-time concept;
 *     bookings are always at-clinic for generic vertical.
 */

// First 3 digits of an Indian 6-digit PIN code → metro identifier.
// Multiple PIN-3 prefixes can map to the same metro for cities with
// multiple postal-zone bands (Bangalore: 560, Pune: 411 + 412).
const METRO_PREFIXES = {
  "560": "BLR",
  "400": "MUM",
  "401": "MUM",  // Thane / Vasai outskirts
  "110": "DEL",
  "600": "CHE",
  "500": "HYD",
  "700": "KOL",
  "411": "PUN",
  "412": "PUN",  // Pune outskirts
  "380": "AMD",
  "682": "COK",
  "302": "JAI",
};

// Zone-based travel-time bands. Same zone = same metro identifier.
// Cross-zone but both metros = within-metropolitan-belt (e.g. Mumbai
// to Pune via expressway). Outside metro = unknown / rural fallback.
const SAME_ZONE_MINUTES = 30;
const CROSS_ZONE_MINUTES = 60;
const OUTSIDE_METRO_MINUTES = 90;
const FALLBACK_MINUTES = 30; // legacy default for missing pincodes

/**
 * Extract the 3-digit prefix from a 6-digit Indian PIN code. Non-digit
 * characters (whitespace, hyphens, formatting) are stripped before
 * slicing. Returns null for missing or short input.
 *
 * @param {string|number|null|undefined} pincode  raw PIN — string preferred
 * @returns {string|null}  3-digit string preserving leading zeros, or null
 */
function pinPrefix(pincode) {
  if (!pincode) return null;
  const digits = String(pincode).replace(/\D/g, "");
  if (digits.length < 6) return null;
  return digits.slice(0, 3);
}

/**
 * Map a PIN code to a metro identifier (BLR / MUM / DEL / etc.) or null
 * if the prefix isn't in the static METRO_PREFIXES table.
 *
 * @param {string|number|null|undefined} pincode  6-digit PIN
 * @returns {string|null}  metro short code, or null for rural / unknown
 */
function metroOf(pincode) {
  const prefix = pinPrefix(pincode);
  if (!prefix) return null;
  return METRO_PREFIXES[prefix] || null;
}

/**
 * Estimate travel time (minutes) between a clinic pincode and a
 * patient pincode for an IN_HOME booking.
 *
 * @param {string|null|undefined} clinicPincode  6-digit Indian PIN
 * @param {string|null|undefined} patientPincode 6-digit Indian PIN
 * @returns {number} minutes
 */
function estimateTravelMinutes(clinicPincode, patientPincode) {
  if (!clinicPincode || !patientPincode) return FALLBACK_MINUTES;

  const clinicMetro = metroOf(clinicPincode);
  const patientMetro = metroOf(patientPincode);

  // Both unknown — rural / generic fallback.
  if (!clinicMetro && !patientMetro) return OUTSIDE_METRO_MINUTES;

  // One side unknown — assume long haul.
  if (!clinicMetro || !patientMetro) return OUTSIDE_METRO_MINUTES;

  // Both known and equal — within-metro hop.
  if (clinicMetro === patientMetro) return SAME_ZONE_MINUTES;

  // Both known and different — cross-metro travel.
  return CROSS_ZONE_MINUTES;
}

module.exports = {
  estimateTravelMinutes,
  metroOf,
  pinPrefix,
  // exported for the unit test:
  METRO_PREFIXES,
  SAME_ZONE_MINUTES,
  CROSS_ZONE_MINUTES,
  OUTSIDE_METRO_MINUTES,
  FALLBACK_MINUTES,
};
