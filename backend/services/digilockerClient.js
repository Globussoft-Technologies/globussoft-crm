// DigiLocker integration — STUB MODE.
//
// Real OAuth + Aadhaar fetch wires in when Q3 creds land:
//   DIGILOCKER_CLIENT_ID + DIGILOCKER_CLIENT_SECRET in backend/.env
// Until then, this stub returns deterministic synthetic values so the
// parent/teacher registration portal flow is exercisable end-to-end in
// dev + demo + CI without any external dependency.
//
// Contract this stub pins (REAL implementation MUST honour the same):
//   initiateSession({ participantId, redirectUri }) →
//     { state, oauthUrl } — caller redirects browser to oauthUrl
//   exchangeCallback({ state, code }) →
//     { aadhaarLast4, aadhaarTokenId } — caller writes to TripParticipant
//
// See docs/DIGILOCKER_INTEGRATION_SPEC.md for the production sequence.

const crypto = require("crypto");

const STUB_DIGILOCKER_BASE = "https://digilocker-stub.invalid/oauth";

function digilockerEnabled() {
  return Boolean(process.env.DIGILOCKER_CLIENT_ID && process.env.DIGILOCKER_CLIENT_SECRET);
}

async function initiateSession({ participantId, redirectUri }) {
  // STUB: DigiLocker OAuth state generation. Real impl signs the state
  // with the client secret + opaque CSRF token. Pending Q3 creds.
  const state = crypto.randomBytes(16).toString("hex");
  const oauthUrl = `${STUB_DIGILOCKER_BASE}/authorize?` + new URLSearchParams({
    state,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "aadhaar",
  }).toString();
  console.log(`[digilocker-stub] initiate participant=${participantId} state=${state.slice(0, 8)}… (no real OAuth — pending Q3 creds)`);
  return { state, oauthUrl };
}

// `code` is unused by the stub (real impl POSTs state+code to
// DigiLocker's token endpoint); kept in the signature so the swap-in
// real implementation can drop in without changing callers.
async function exchangeCallback({ state, code: _code }) {
  if (!state) {
    throw new Error("exchangeCallback: state required");
  }
  // STUB: Real impl POSTs to DigiLocker token endpoint with state+code,
  // gets back signed Aadhaar XML, extracts last-4 + token id. Pending
  // Q3 creds. Stub returns deterministic synthetic values so tests can
  // pin the contract.
  const aadhaarLast4 = "9999";
  const aadhaarTokenId = `stub-token-${crypto.createHash("sha256").update(state).digest("hex").slice(0, 24)}`;
  console.log(`[digilocker-stub] callback state=${state.slice(0, 8)}… → last4=${aadhaarLast4} token=${aadhaarTokenId.slice(0, 16)}… (synthetic — pending Q3 creds)`);
  return { aadhaarLast4, aadhaarTokenId };
}

module.exports = {
  digilockerEnabled,
  initiateSession,
  exchangeCallback,
};
