/**
 * Globus Phone (softphone) mock — issue #137 sandbox skeleton.
 *
 * Drives the call lifecycle (INITIATED → RINGING → CONNECTED → COMPLETED)
 * against the local CRM's /api/v1/external/calls endpoint, so cron + workflow
 * engines that depend on call events can be exercised without a real phone.
 *
 * NOT auto-started. Run manually:  node backend/scripts/sandbox/globusphone-mock.js
 * See backend/scripts/sandbox/README.md for env vars.
 */
const express = require("express");

const PORT = process.env.GLOBUSPHONE_MOCK_PORT || 5103;
const CRM_BASE = process.env.CRM_BASE_URL || "http://localhost:5000";
const API_KEY = process.env.CRM_SANDBOX_API_KEY || "glbs_sandbox_globusphone";

const app = express();
app.use(express.json({ limit: "1mb" }));

const fetchJson = async (path, body, method = "POST") => {
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`${CRM_BASE}/api/v1/external${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify(body),
  });
  return r.json();
};

// ── CRM-side: pretend the softphone has an outbound-dial API ──────────
app.post("/api/dial", (req, res) => {
  res.json({
    ok: true,
    callId: `gp_${Date.now()}`,
    to: req.body.to,
    status: "INITIATED",
  });
});

// ── Operator-side: walk the full lifecycle into the CRM ───────────────
app.post("/simulate/call-lifecycle", async (req, res) => {
  const phone = req.body.phone || "+919000000000";
  const providerCallId = `gp_${Date.now()}`;
  const events = [];

  // The CRM accepts a single /calls POST per call; we simulate the lifecycle
  // by posting once with the final state, plus optional PATCH for transcripts.
  const created = await fetchJson("/calls", {
    phone,
    direction: req.body.direction || "OUTBOUND",
    status: "COMPLETED",
    durationSec: req.body.durationSec || 17,
    provider: "globus-phone",
    providerCallId,
  });
  events.push({ stage: "completed", crm: created });

  if (req.body.includeTranscript && created?.id) {
    const patched = await fetchJson(
      `/calls/${created.id}`,
      { transcript: "Sandbox transcript — globusphone-mock", recordingUrl: "https://mock.gp/r.mp3" },
      "PATCH"
    );
    events.push({ stage: "transcript", crm: patched });
  }

  res.json({ ok: true, providerCallId, events });
});

app.get("/health", (_req, res) => res.json({ ok: true, mock: "globusphone" }));

app.listen(PORT, () => {
  console.log(`[globusphone-mock] listening on :${PORT}, CRM=${CRM_BASE}`);
});
