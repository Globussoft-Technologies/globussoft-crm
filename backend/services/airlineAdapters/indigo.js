// IndiGo (6E) web check-in adapter — Playwright DOM automation.
//
// STATUS: NOT IMPLEMENTED. Returns `not-implemented` so the automation engine
// routes the row straight to fallback-agent (a human completes the check-in via
// the airline portal + POST /upload-boarding-pass). The real Playwright
// implementation is blocked on PRD DC-1 (browser runtime), DC-3 (containerized
// Chromium) and DC-5 (per-airline ToS legal review) — see
// docs/PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md FR-2/FR-3.
//
// When implemented, performCheckIn loads https://www.goindigo.in/web-check-in.html,
// fills PNR + last name, selects the seat per `seatPref` (default aisle),
// downloads the boarding-pass PDF, uploads it via the Attachment store, and
// returns { ok:true, boardingPassUrl }.

async function performCheckIn() {
  return {
    ok: false,
    reason: "not-implemented",
    error: "IndiGo (6E) adapter not yet implemented — blocked on PRD DC-1/DC-3/DC-5",
  };
}

module.exports = { airline: "indigo", airlineCodes: ["6E"], performCheckIn };
