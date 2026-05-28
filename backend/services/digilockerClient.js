// DigiLocker / APISetu integration.
//
// Two modes:
//
// 1. STUB MODE (default — when no APISetu / DigiLocker env keys are set).
//    Returns deterministic synthetic values so dev + demo + CI flows are
//    exercisable end-to-end without any external dependency. Pinned by
//    test/services/digilockerClient.test.js.
//
// 2. REAL MODE — activated when APISETU_PARTNER_API_KEY (preferred) OR
//    DIGILOCKER_CLIENT_ID + DIGILOCKER_CLIENT_SECRET are present in .env.
//    The APISetu partner programme is the Indian government's gateway
//    (partners.apisetu.gov.in/home<partner-id>) that hosts the DigiLocker
//    Pull API on behalf of registered partners. The partner registers an
//    app, gets credentials, and points the OAuth flow at:
//        https://api.digitallocker.gov.in/public/oauth2/1/authorize?...
//    callback exchanges code → access_token → eAadhaar XML → last-4 +
//    DigiLocker token id. APISETU_PARTNER_API_KEY (single bearer token)
//    is the simplest auth path the marketplace exposes; the OAuth pair
//    is supported as an alternative for legacy partner integrations.
//
// Contract this module pins (REAL + STUB MUST honour the same shape):
//   initiateSession({ subjectId, subjectType, redirectUri })
//       → { state, oauthUrl }
//   exchangeCallback({ state, code })
//       → { aadhaarLast4, aadhaarTokenId }
//
// subjectType ∈ {"participant", "contact"} — only used for logging /
// audit; the schema-level dispatch (TripParticipant vs Contact write)
// happens in the route layer, not here.
//
// See docs/DIGILOCKER_INTEGRATION_SPEC.md for the production sequence
// and docs/DIGILOCKER_USE_CASE.md for the legal / Aadhaar Act §29
// constraints (never log full 12-digit Aadhaar; only last-4 + token).

const crypto = require("crypto");

const STUB_DIGILOCKER_BASE = "https://digilocker-stub.invalid/oauth";

// Real APISetu / DigiLocker endpoints. Confirmed against the public
// documentation at https://partners.apisetu.gov.in/sandbox (the partner
// portal URL the user is registered against). The /authorize and /token
// paths are stable across the OAuth2 + Partner-API-Key auth modes.
const DIGILOCKER_AUTHORIZE_URL = "https://api.digitallocker.gov.in/public/oauth2/1/authorize";
const DIGILOCKER_TOKEN_URL = "https://api.digitallocker.gov.in/public/oauth2/1/token";
const DIGILOCKER_AADHAAR_URL = "https://api.digitallocker.gov.in/public/oauth2/3/xml/eaadhaar";

function digilockerEnabled() {
  return Boolean(
    process.env.APISETU_PARTNER_API_KEY ||
    (process.env.DIGILOCKER_CLIENT_ID && process.env.DIGILOCKER_CLIENT_SECRET),
  );
}

function authMode() {
  if (process.env.APISETU_PARTNER_API_KEY) return "apisetu-partner";
  if (process.env.DIGILOCKER_CLIENT_ID) return "oauth2";
  return "stub";
}

async function initiateSession({ subjectId, subjectType, participantId, redirectUri }) {
  // Back-compat: existing callers (routes/travel_trips.js) pass
  // `participantId`; new customer-portal flow passes `subjectId` +
  // `subjectType`. Normalise to a single subject identifier for logs.
  const subject = subjectId != null ? subjectId : participantId;
  const kind = subjectType || "participant";
  const state = crypto.randomBytes(16).toString("hex");

  if (!digilockerEnabled()) {
    const oauthUrl = `${STUB_DIGILOCKER_BASE}/authorize?` + new URLSearchParams({
      state,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "aadhaar",
    }).toString();
    console.log(`[digilocker-stub] initiate ${kind}=${subject} state=${state.slice(0, 8)}… (no real OAuth — APISETU_PARTNER_API_KEY unset)`);
    return { state, oauthUrl };
  }

  // Real mode — build the DigiLocker authorize URL the user gets
  // redirected to. The user signs in to DigiLocker, consents to share
  // their eAadhaar with our partner app, and DigiLocker redirects back
  // to redirectUri with ?code=...&state=... .
  //
  // For APISETU_PARTNER_API_KEY mode the `client_id` is provisioned in
  // the APISetu partner dashboard at partners.apisetu.gov.in/home<id>;
  // we surface it via APISETU_CLIENT_ID env var (falls back to
  // DIGILOCKER_CLIENT_ID for OAuth2-only partners).
  const clientId = process.env.APISETU_CLIENT_ID || process.env.DIGILOCKER_CLIENT_ID;
  if (!clientId) {
    throw new Error("DigiLocker enabled but APISETU_CLIENT_ID / DIGILOCKER_CLIENT_ID missing");
  }
  const oauthUrl = `${DIGILOCKER_AUTHORIZE_URL}?` + new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  }).toString();
  console.log(`[digilocker] initiate ${kind}=${subject} state=${state.slice(0, 8)}… mode=${authMode()}`);
  return { state, oauthUrl };
}

// `code` is unused by the stub; the real impl POSTs it to DigiLocker's
// token endpoint and then fetches the signed Aadhaar XML.
async function exchangeCallback({ state, code }) {
  if (!state) {
    throw new Error("exchangeCallback: state required");
  }

  if (!digilockerEnabled()) {
    const aadhaarLast4 = "9999";
    const aadhaarTokenId = `stub-token-${crypto.createHash("sha256").update(state).digest("hex").slice(0, 24)}`;
    console.log(`[digilocker-stub] callback state=${state.slice(0, 8)}… → last4=${aadhaarLast4} token=${aadhaarTokenId.slice(0, 16)}… (synthetic — APISETU_PARTNER_API_KEY unset)`);
    return { aadhaarLast4, aadhaarTokenId };
  }

  if (!code) {
    throw new Error("exchangeCallback: code required in real mode");
  }

  const clientId = process.env.APISETU_CLIENT_ID || process.env.DIGILOCKER_CLIENT_ID;
  const clientSecret = process.env.DIGILOCKER_CLIENT_SECRET;
  const apiKey = process.env.APISETU_PARTNER_API_KEY;

  // Step 1: exchange code → access_token at DigiLocker token endpoint.
  // APISetu partners auth via the partner API key in the X-APISetu-Key
  // header; legacy OAuth2 partners use HTTP Basic with client_id +
  // client_secret. The body shape is identical.
  const tokenHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (apiKey) {
    tokenHeaders["X-APISetu-ClientId"] = clientId;
    tokenHeaders["X-APISetu-ApiKey"] = apiKey;
  } else {
    tokenHeaders.Authorization = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  }
  const tokenRes = await fetch(DIGILOCKER_TOKEN_URL, {
    method: "POST",
    headers: tokenHeaders,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.DIGILOCKER_REDIRECT_URI || "",
    }).toString(),
  });
  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => "");
    throw new Error(`DigiLocker token exchange failed: ${tokenRes.status} ${errBody.slice(0, 200)}`);
  }
  const tokenJson = await tokenRes.json();
  const accessToken = tokenJson.access_token;
  const aadhaarTokenId = tokenJson.digilockerid || tokenJson.access_token; // partner-dependent

  // Step 2: fetch signed eAadhaar XML. Returns a base64 XML blob; we
  // only need the last-4 digits, which appear in the <Poi uid="XXXX9999"/>
  // attribute. Server-side parse — never log the full 12-digit Aadhaar.
  const xmlRes = await fetch(DIGILOCKER_AADHAAR_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!xmlRes.ok) {
    const errBody = await xmlRes.text().catch(() => "");
    throw new Error(`DigiLocker eAadhaar fetch failed: ${xmlRes.status} ${errBody.slice(0, 200)}`);
  }
  const xmlBody = await xmlRes.text();
  const uidMatch = xmlBody.match(/uid="[X\d]*?(\d{4})"/);
  const aadhaarLast4 = uidMatch ? uidMatch[1] : null;
  if (!aadhaarLast4) {
    throw new Error("DigiLocker eAadhaar XML did not contain a parseable uid attribute");
  }
  console.log(`[digilocker] callback state=${state.slice(0, 8)}… → last4=${aadhaarLast4} mode=${authMode()}`);
  return { aadhaarLast4, aadhaarTokenId };
}

module.exports = {
  digilockerEnabled,
  authMode,
  initiateSession,
  exchangeCallback,
};
