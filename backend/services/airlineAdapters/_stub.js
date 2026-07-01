// Deterministic stub airline adapter (dev/demo + manual verification).
//
// Enabled for ALL airlines when WEBCHECKIN_AUTOMATION_STUB=1. Lets the full
// automation engine loop run end-to-end without a live airline site. Outcome
// is driven by a PNR prefix so a dev can create WebCheckin rows that exercise
// every engine branch:
//
//   PNR starts with "CAPTCHA" -> captcha    (engine -> fallback-agent, no retry)
//   PNR starts with "FAIL"    -> transient  (engine retries, then fallback-agent)
//   PNR starts with "DOWN"    -> portal-down (engine retries, then fallback-agent)
//   anything else             -> success    (engine -> done + boarding pass)
//
// Never throws — always resolves a typed AdapterResult.

async function performCheckIn({ pnr, airlineCode } = {}) {
  const p = String(pnr || "").toUpperCase();
  if (p.startsWith("CAPTCHA")) {
    return { ok: false, reason: "captcha", error: "Captcha challenge presented (stub)" };
  }
  if (p.startsWith("FAIL")) {
    return { ok: false, reason: "transient", error: "Simulated transient failure (stub)" };
  }
  if (p.startsWith("DOWN")) {
    return { ok: false, reason: "portal-down", error: "Airline portal unreachable (stub)" };
  }
  const code = String(airlineCode || "XX").toUpperCase();
  const safePnr = (p || "NOPNR").replace(/[^A-Z0-9]/g, "");
  return {
    ok: true,
    boardingPassUrl: `/uploads/boarding-passes/stub-${code}-${safePnr}.pdf`,
    seatAssigned: "auto",
  };
}

module.exports = { airline: "stub", performCheckIn };
