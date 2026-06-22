// Zoom meeting creation via Server-to-Server OAuth.
//
// Lets a calendar event optionally carry a Zoom join link (alongside the
// existing Google Meet option). Env (set in backend/.env):
//   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
// (create a "Server-to-Server OAuth" app at https://marketplace.zoom.us with the
// `meeting:write:admin` scope; the three values are on the app's App Credentials tab.)
//
// When any are unset, isEnabled() is false and createMeeting() returns null, so
// the calendar-event create path simply skips attaching a Zoom link (no throw).
// Mirrors the other opt-in service clients (ratehawk / digilocker / passportOcr).

const OAUTH_URL = "https://zoom.us/oauth/token";
const API_BASE = "https://api.zoom.us/v2";

// Read creds at call time (not module load) so a late-loaded .env still applies
// and so config changes don't require a process restart.
function creds() {
  return {
    accountId: process.env.ZOOM_ACCOUNT_ID || "",
    clientId: process.env.ZOOM_CLIENT_ID || "",
    clientSecret: process.env.ZOOM_CLIENT_SECRET || "",
  };
}

// True only when all three credentials are present.
function isEnabled() {
  const { accountId, clientId, clientSecret } = creds();
  return Boolean(accountId && clientId && clientSecret);
}

// Exchange the Server-to-Server credentials for a short-lived access token.
async function getAccessToken() {
  const { accountId, clientId, clientSecret } = creds();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const url = `${OAUTH_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Zoom OAuth failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  if (!d.access_token) throw new Error("Zoom OAuth returned no access_token");
  return d.access_token;
}

// Create a scheduled Zoom meeting. Returns { joinUrl, startUrl, meetingId,
// password } on success, or null when Zoom isn't configured. Throws only on a
// real API error so the caller can log + fall back gracefully.
async function createMeeting({ topic, startTime, durationMins, timezone, agenda } = {}) {
  if (!isEnabled()) return null;
  const token = await module.exports.getAccessToken();
  const body = {
    topic: String(topic || "Meeting").slice(0, 200),
    type: 2, // scheduled meeting
    start_time: startTime ? new Date(startTime).toISOString() : undefined,
    duration: durationMins && durationMins > 0 ? Math.round(durationMins) : 30,
    timezone: timezone || "UTC",
    agenda: agenda ? String(agenda).slice(0, 2000) : undefined,
    settings: { join_before_host: true, waiting_room: false },
  };
  const r = await fetch(`${API_BASE}/users/me/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Zoom create-meeting failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  return {
    joinUrl: d.join_url || null,
    startUrl: d.start_url || null,
    meetingId: d.id || null,
    password: d.password || null,
  };
}

module.exports = { isEnabled, getAccessToken, createMeeting };
