/**
 * Callified.ai mock — issue #137 sandbox skeleton.
 *
 * Pretends to be Callified for two purposes:
 *   1. Accepts outbound calls from the CRM that would normally hit Callified
 *      (e.g. "trigger an auto-dial") — returns a canned 200 with a fake
 *      providerCallId.
 *   2. Exposes /simulate/* endpoints the operator can POST to, which then
 *      forward Callified-shaped payloads INTO the local CRM at
 *      /api/v1/external/{leads,calls,messages} using a sandbox API key.
 *
 * NOT auto-started. Run manually:  node backend/scripts/sandbox/callified-mock.js
 * See backend/scripts/sandbox/README.md for env vars.
 */
const express = require("express");

const PORT = process.env.CALLIFIED_MOCK_PORT || 5101;
const CRM_BASE = process.env.CRM_BASE_URL || "http://localhost:5000";
const API_KEY = process.env.CRM_SANDBOX_API_KEY || "glbs_sandbox_callified";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Outbound side: CRM thinks it's calling Callified ──────────────────
app.post("/api/auto-dial", (req, res) => {
  res.json({ ok: true, providerCallId: `cl_${Date.now()}`, status: "QUEUED" });
});

app.post("/api/transcribe", (req, res) => {
  res.json({ ok: true, jobId: `tx_${Date.now()}`, status: "PROCESSING" });
});

// ── Inbound side: simulate Callified pushing TO the CRM ───────────────
async function pushToCrm(path, body) {
  const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
  return (await fetch)(`${CRM_BASE}/api/v1/external${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

app.post("/simulate/lead", async (req, res) => {
  const out = await pushToCrm("/leads", {
    name: req.body.name || "Sandbox Caller",
    phone: req.body.phone || "+919999999999",
    source: "callified",
    note: req.body.note || "Mock inbound from callified-mock.js",
  });
  res.json(out);
});

app.post("/simulate/call", async (req, res) => {
  const out = await pushToCrm("/calls", {
    phone: req.body.phone || "+919999999999",
    direction: "INBOUND",
    durationSec: req.body.durationSec || 42,
    status: "COMPLETED",
    provider: "callified",
    providerCallId: `cl_${Date.now()}`,
    recordingUrl: req.body.recordingUrl || "https://mock.callified/r/sandbox.mp3",
  });
  res.json(out);
});

app.post("/simulate/message", async (req, res) => {
  const out = await pushToCrm("/messages", {
    channel: req.body.channel || "whatsapp",
    direction: "INBOUND",
    phone: req.body.phone || "+919999999999",
    body: req.body.body || "Sandbox WhatsApp from callified-mock",
  });
  res.json(out);
});

app.get("/health", (_req, res) => res.json({ ok: true, mock: "callified" }));

app.listen(PORT, () => {
  console.log(`[callified-mock] listening on :${PORT}, forwarding to ${CRM_BASE}`);
});
