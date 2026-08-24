# Wellness → Callified calling (Appointments)

How the **Call** action on `/wellness/appointments` works, and — more
importantly — the one place where we are working from an inference rather than
a documented contract.

Reference for the vendor surface: [`API_FLOW.md`](../API_FLOW.md).

---

## What was built vs. what was reused

The generic CRM already had a complete AI-calling stack. Wellness reuses it
rather than growing a parallel one:

| Concern | Where it lives | New? |
|---|---|---|
| Callified auth (API key → JWT, cached, refreshed on 401) | `backend/services/callifiedClient.js` | reused |
| Lead create / reuse / 409 recovery / stale-mapping repair | `callifiedClient.createLead` | reused |
| Campaign list | `callifiedClient.listCampaigns` | reused |
| AI dial | `callifiedClient.initiateCallForContact` | reused |
| Transcripts / reviews / recordings | `callifiedClient.getCallDetails`, `CallifiedCallDetailsDrawer` | reused |
| Redial cooldown | `backend/lib/callifiedRedialGuard.js` | promoted out of `routes/callified.js` |
| Patient → Contact link | `backend/lib/patientContactLink.js` | promoted out of `routes/wellness.js` |
| HTTP error mapping | `backend/lib/callifiedErrors.js` | new (shared by both surfaces) |
| **Browser / agent-bridge call** | `callifiedClient.browserCall` + `backend/lib/callifiedAgentBridge.js` + `frontend/src/utils/callifiedAgentBridge.js` | **new — did not exist anywhere** |

The manual-call feature is the genuinely new capability. Before this work the
CRM had no browser-call code at all: no `browser-call` request, no WebSocket
client, no agent audio UI. Everything else is a wellness-shaped entry point
over existing machinery.

---

## Appointment → Callified lead mapping

```
Visit ──▶ Patient ──▶ Contact ──▶ Callified lead
         (patientId)  (Patient.contactId)  (phone → id map in Integration.settings)
```

`Patient.contactId` is created lazily by `ensurePatientContact()` the first
time a call is placed — the read-only `…/context` endpoint deliberately does
**not** create it, so opening the dialog never writes to the database.

Duplicate prevention lives in `callifiedClient.createLead`, which is an
"ensure lead" primitive, not a blind create. In order it: reuses the stored
phone → lead mapping, verifies that lead still exists remotely, recovers the
remote id when Callified rejects the create with a 409 duplicate-phone, and
only then creates a new lead. Both call modes go through
`prepareContactCall()`, so they share one lifecycle.

---

## Endpoints

All under `/api/wellness/callified/`, gated by `verifyWellnessRole(["admin",
"manager", "telecaller", "receptionist"])` with an `appointments.write` /
`calendar.write` permission escape hatch for tenant-defined roles.

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | `{configured, enabled}` — the page hides the Call action when false |
| GET | `/campaigns` | campaign picker options |
| GET | `/visits/:visitId/context` | who is being called, is the number dialable, is there history |
| POST | `/visits/:visitId/ai-call` | 🤖 Callified's AI agent handles the conversation |
| POST | `/visits/:visitId/manual-call` | 👤 a staff member speaks, bridged through the browser |

The generic CRM gained the matching contact-keyed route
`POST /api/callified/leads/:leadId/browser-call`.

---

## The agent bridge

```
browser ──wss──▶ CRM /ws/callified-agent?ticket=… ──wss──▶ Callified /ws/agent?call_sid=…
        (single-use ticket)                    (tenant's Callified JWT)
```

**Why relay instead of connecting the browser straight to Callified.**
`agent_url` points at Callified's host and needs the tenant's Callified JWT —
an org-wide API credential covering leads, campaigns and billing. Handing that
to the browser would expose all of it to anything running on the page. So the
browser redeems a **single-use, 60-second ticket** (32 random bytes) against
the CRM relay, and the backend holds the credential.

The relay forwards frames **verbatim** in both directions, text and binary. It
is protocol-agnostic on purpose: it keeps working whatever envelope Callified's
agent socket speaks. The only frames it injects are namespaced
`{"type":"bridge", …}` control messages, which cannot collide with Callified's
own `{"event": …}` frames.

`attachCallifiedAgentBridge(server)` **must** run before `new Server(server)`
in `server.js` — engine.io snapshots the HTTP server's existing `upgrade`
listeners when it attaches and delegates non-socket.io upgrades back to them.
A listener registered afterwards would race engine.io's own `abortConnection`.

### ⚠️ The audio frame format is an inference, not a documented contract

`API_FLOW.md` documents that `/ws/agent?call_sid=…` exists and what
`browser-call` returns. It does **not** document the audio envelope that socket
speaks. The surrounding evidence — Exotel call_sids, an `exotel_account_id`
parameter — points at Exotel's Voice Streaming convention, so that is what
`frontend/src/utils/callifiedAgentBridge.js` sends:

```jsonc
// out, once on connect
{"event":"start","start":{"call_sid":"…","media_format":{"encoding":"audio/l16","sample_rate":8000,"channels":1}}}
// out, ~50/s
{"event":"media","media":{"payload":"<base64 PCM16-LE 8 kHz mono>"}}
// out, on hang up
{"event":"stop","stop":{"call_sid":"…"}}
```

The **receive** path is deliberately liberal and self-adapting: it accepts
binary frames, `media.payload`, a bare `payload`/`audio` field, and switches
codec + sample rate to whatever `media_format` the server announces in its
`start`/`connected` frame. Both PCM16-LE and G.711 µ-law are decoded.

**If Callified confirms a different envelope, two places change and nothing
else:** the `MEDIA_DEFAULTS` constant and `parseInboundFrame()` in
`frontend/src/utils/callifiedAgentBridge.js`. The backend relay needs no change
at all, because it never inspects the frames.

Ask the Callified team for: the exact frame schema on `/ws/agent`, how that
socket authenticates, and whether the agent leg expects µ-law or L16.

### Agent socket authentication

Also undocumented. The relay sends the Callified JWT **both** as an
`Authorization: Bearer` header on the WS handshake and as a `token` query
param. A tenant whose deployment rejects the query param sets
`agentBridgeTokenInQuery: false` in `Integration.settings` — no code change.

---

## Infrastructure this feature required

Three pieces of plumbing are easy to miss when deploying:

1. **`Permissions-Policy` was `microphone=()`** — a hard block that makes
   `getUserMedia({audio:true})` reject outright. Now `microphone=(self)`
   (`backend/middleware/security.js`). The header governs the *document*, and
   the SPA shell is one document for the whole app, so per-route granularity
   is not available; `(self)` is the narrowest grant that works. Third-party
   iframes still get nothing and the browser prompt still gates first use.
2. **WebSocket proxying** — `/ws` needs `ws: true` in `frontend/vite.config.js`
   for dev, and an `Upgrade`/`Connection` location block with a long
   `proxy_read_timeout` in `frontend/nginx.conf` for production. Nginx's 60s
   default would cut a quiet caller off mid-conversation.
3. **CSP** already allows `wss:` in `connectSrc`, so no change was needed
   there. Under the *enforced* CSP the AudioWorklet blob URL is blocked
   (`script-src` has no `blob:`); the capture path detects this and falls back
   to `ScriptProcessorNode`, which works. Adding `blob:` to `script-src` would
   buy a slightly better audio path at a real CSP cost — not taken.

`ws@8` is now an explicit dependency in `backend/package.json` (it was already
present transitively via socket.io).

---

## Call history

Browser calls write a `CallLog` row whose `providerCallId` is the **Callified
lead id**, not the `call_sid` — deliberately, so the existing details,
attempts, and call-status lookups find manual calls exactly the way they find
AI ones. The `call_sid` lives in `CallLog.notes` alongside `mode: "browser"`.

That is what lets the dialog's **Call history** button reuse
`CallifiedCallDetailsDrawer` unchanged: transcripts, recording, duration, AI
review, sentiment, summary, and quality score all render for both modes.

The relay also reflects live state onto the row — `CONNECTED` when the bridge
opens, `COMPLETED` with a real duration when it closes, `FAILED` if it never
connected.

---

## Tests

| Layer | File |
|---|---|
| Ticket lifecycle, upstream URL, startBrowserCall | `backend/test/lib/callifiedAgentBridge.test.js` |
| HTTP error mapping | `backend/test/lib/callifiedErrors.test.js` |
| Shared preflight, tolerant enroll, browser-call flow | `backend/test/services/callifiedClient.browserCall.test.js` |
| Call dialog: mode split, double-click guard, states | `frontend/src/__tests__/CallifiedCallDialog.test.jsx` |
| Frame parsing (the inferred protocol) | `frontend/src/__tests__/callifiedAgentBridge.test.js` |
| Route contract, auth + tenant gates | `e2e/tests/wellness-callified-api.spec.js` |
