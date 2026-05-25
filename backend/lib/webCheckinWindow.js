// Travel CRM — per-airline web check-in window calculator (PRD §4.6).
//
// Pure function: no DB, no I/O. Given a departure DateTime and an
// airline IATA code, return the JS Date at which web check-in opens
// for that airline.
//
// Most airlines open T-48h before departure; some long-haul / Gulf
// carriers open T-24h. The table below is the codified-as-of-PRD §4.6
// list (Tier-1 in PRD W4, Tier-2 in Phase 1.5). Unknown airlines fall
// through to the 48h default — safe for downstream cron scheduling
// because the worst case is just "we'll start sweeping 24h earlier
// than we needed to," not "we'll miss the window."
//
// Adding a new airline: insert a row into AIRLINE_WINDOWS_HOURS keyed
// by uppercase IATA code. No other code changes needed — the cron's
// scheduler reads windowOpenAt off the WebCheckin row and is agnostic
// to which carrier set it.
//
// Used by:
//   routes/travel_itineraries.js  /accept   — auto-create row per flight
//   routes/travel_webcheckin.js   POST       — manual create defaults
//   backend/test/lib/webCheckinWindow.test.js

/**
 * Hours-before-departure that each airline's web check-in opens.
 * Keys are uppercase IATA carrier codes. Values are integer hours.
 *
 * PRD §4.6 (Tier-1 W4):
 *   6E IndiGo, AI Air India, IX Air India Express, UK Vistara,
 *   EK Emirates
 * PRD Phase 1.5 (Tier-2):
 *   SG SpiceJet, QP Akasa, EY Etihad, SV Saudia, QR Qatar,
 *   G9 Air Arabia
 */
const AIRLINE_WINDOWS_HOURS = Object.freeze({
  // Tier-1 (PRD §4.6 W4 commitment)
  "6E": 48, // IndiGo
  AI: 48,   // Air India
  IX: 48,   // Air India Express
  UK: 48,   // Vistara (subsumed by Air India 2026 but code still in flight DBs)
  EK: 48,   // Emirates
  // Tier-2 (Phase 1.5)
  SG: 48,   // SpiceJet
  QP: 48,   // Akasa
  EY: 24,   // Etihad
  SV: 24,   // Saudia
  QR: 48,   // Qatar
  G9: 24,   // Air Arabia
});
const DEFAULT_WINDOW_HOURS = 48;

/**
 * Compute the moment the check-in window opens for a flight.
 *
 * @param {Date|string|number|null|undefined} departureAt
 *   The flight's scheduled departure. Accepts a Date, an ISO-8601
 *   string, or an epoch-ms number. Null/undefined returns null.
 * @param {string|null|undefined} airlineCode
 *   IATA airline code (case-insensitive). Falsy or unrecognised codes
 *   fall back to DEFAULT_WINDOW_HOURS.
 * @returns {Date|null}
 *   The JS Date when the check-in window opens, or null if the input
 *   departure cannot be parsed.
 */
function computeWindowOpenAt(departureAt, airlineCode) {
  if (departureAt === null || departureAt === undefined) return null;
  const dep = departureAt instanceof Date ? departureAt : new Date(departureAt);
  if (!Number.isFinite(dep.getTime())) return null;
  const code = String(airlineCode || "").toUpperCase();
  const hours = Object.prototype.hasOwnProperty.call(AIRLINE_WINDOWS_HOURS, code)
    ? AIRLINE_WINDOWS_HOURS[code]
    : DEFAULT_WINDOW_HOURS;
  return new Date(dep.getTime() - hours * 60 * 60 * 1000);
}

module.exports = {
  computeWindowOpenAt,
  AIRLINE_WINDOWS_HOURS,
  DEFAULT_WINDOW_HOURS,
};
