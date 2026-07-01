// Vistara (UK) web check-in adapter — Playwright DOM automation.
//
// STATUS: NOT IMPLEMENTED. Returns `not-implemented` so the automation engine
// routes the row straight to fallback-agent (human completes via airline portal
// + POST /upload-boarding-pass). Real implementation blocked on PRD
// DC-1/DC-3/DC-5 — see docs/PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md FR-2/FR-3.
// Note: the 2026 Vistara->Air India merger may collapse this adapter into AI by
// Phase 2 (PRD DC-2).

async function performCheckIn() {
  return {
    ok: false,
    reason: "not-implemented",
    error: "Vistara (UK) adapter not yet implemented — blocked on PRD DC-1/DC-3/DC-5",
  };
}

module.exports = { airline: "vistara", airlineCodes: ["UK"], performCheckIn };
