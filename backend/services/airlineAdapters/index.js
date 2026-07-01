// Travel CRM — airline web check-in adapter registry.
//
// PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md FR-2/FR-3. Each per-airline adapter
// drives that airline's public check-in portal (Playwright, once DC-1/DC-3/DC-5
// land) and exposes ONE method:
//
//   performCheckIn({ pnr, lastName, seatPref, airlineCode, flightNumber,
//                    departureAt }) -> Promise<AdapterResult>
//
//   AdapterResult (discriminated on `ok`):
//     { ok: true,  boardingPassUrl: string, seatAssigned?: string }
//     { ok: false, reason: 'captcha' | 'transient' | 'portal-down'
//                          | 'not-implemented', error?: string }
//
// The automation engine (cron/webCheckinAutomation.js) is the ONLY caller. It
// owns the state machine (retry/backoff, captcha->fallback, audit, health) —
// adapters are pure "given a PNR, produce a boarding pass or a typed failure".
// One airline's DOM change never touches another adapter (FR-2).
//
// The 4 Phase-1 airline adapters (IndiGo + Air India + Vistara + Emirates) are
// scaffolded but return `not-implemented` until the Playwright work is greenlit
// — the engine routes those rows straight to fallback-agent so a human completes
// the check-in via the existing /upload-boarding-pass path. No behaviour is
// lost; automation simply layers on top when an adapter goes live.
//
// Dev/demo: set WEBCHECKIN_AUTOMATION_STUB=1 to force the deterministic stub
// adapter for ALL airlines so the full engine loop can be exercised end-to-end
// without a live airline site. See _stub.js for the PNR-prefix outcome shims.

const stub = require("./_stub");
const indigo = require("./indigo");
const airindia = require("./airindia");
const vistara = require("./vistara");
const emirates = require("./emirates");

// IATA airline code -> adapter module. Phase-1 coverage per PRD DC-2.
const BY_CODE = Object.freeze({
  "6E": indigo, // IndiGo
  AI: airindia, // Air India
  UK: vistara, // Vistara (note: 2026 AI merger may collapse into AI)
  EK: emirates, // Emirates
});

function stubEnabled() {
  const v = process.env.WEBCHECKIN_AUTOMATION_STUB;
  return v === "1" || v === "true";
}

/**
 * Resolve the adapter for an airline code. Returns the stub when
 * WEBCHECKIN_AUTOMATION_STUB is on (dev/demo). Returns null for an airline
 * with no Phase-1 adapter — the engine treats null exactly like a
 * `not-implemented` result (route to fallback-agent).
 * @param {string} airlineCode IATA code, e.g. "6E"
 */
function resolveAdapter(airlineCode) {
  if (stubEnabled()) return stub;
  const code = String(airlineCode || "").toUpperCase();
  return BY_CODE[code] || null;
}

module.exports = { resolveAdapter, BY_CODE, stub, stubEnabled };
