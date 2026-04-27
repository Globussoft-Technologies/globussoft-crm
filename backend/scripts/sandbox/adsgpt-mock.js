/**
 * AdsGPT mock — issue #137 sandbox skeleton.
 *
 * Pretends to be the AdsGPT campaign-management API. The CRM calls AdsGPT
 * outbound (orchestratorEngine budget-bump task, integrations.js silent SSO
 * impersonation). Tests need a deterministic 200 + fake campaign ID instead
 * of a real network call.
 *
 * Endpoints mirror what the CRM expects to hit; see TODOS.md PRD §6.6.
 *
 * NOT auto-started. Run manually:  node backend/scripts/sandbox/adsgpt-mock.js
 * Point CRM at it via env:        ADSGPT_BASE_URL=http://localhost:5102
 */
const express = require("express");

const PORT = process.env.ADSGPT_MOCK_PORT || 5102;
const SHARED_SECRET = process.env.ADSGPT_SANDBOX_SECRET || "sandbox_secret";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Bearer auth for parity with real AdsGPT — accepts anything in sandbox.
app.use((req, _res, next) => {
  req._sandboxAuth = req.headers.authorization || null;
  next();
});

// ── Campaigns ─────────────────────────────────────────────────────────
app.post("/api/campaigns", (req, res) => {
  const id = `adsgpt_camp_${Date.now()}`;
  res.status(201).json({
    id,
    name: req.body.name || "Sandbox campaign",
    objective: req.body.objective || "LEAD_GEN",
    status: "DRAFT",
    backToCrmUrl: `http://localhost:5102/back-to-crm?campaign=${id}&token=mock_jwt`,
    createdAt: new Date().toISOString(),
  });
});

app.patch("/api/campaigns/:id/budget", (req, res) => {
  res.json({
    id: req.params.id,
    budget: req.body.budget,
    appliedAt: new Date().toISOString(),
    note: "Sandbox budget bump — no real spend",
  });
});

app.post("/api/campaigns/:id/creatives", (req, res) => {
  res.status(201).json({
    id: `adsgpt_cre_${Date.now()}`,
    campaignId: req.params.id,
    headline: req.body.headline || "Mock creative",
    status: "PENDING_REVIEW",
  });
});

// ── Silent SSO handshake (AdsGPT side) ────────────────────────────────
app.post("/api/sso/impersonate", (req, res) => {
  res.json({
    impersonationToken: `mock_jwt.${Buffer.from(
      JSON.stringify({ sub: req.body.userId || "demo", iss: "adsgpt-mock" })
    ).toString("base64")}.sig`,
    redirectUrl: `http://localhost:5102/dashboard?token=mock_jwt`,
  });
});

app.get("/back-to-crm", (req, res) => {
  // Stand-in for the still-pending "back to CRM" link from AdsGPT side.
  res.redirect(`http://localhost:5173/integrations/adsgpt?campaign=${req.query.campaign || ""}`);
});

app.get("/health", (_req, res) =>
  res.json({ ok: true, mock: "adsgpt", sharedSecretConfigured: !!SHARED_SECRET }));

app.listen(PORT, () => {
  console.log(`[adsgpt-mock] listening on :${PORT}`);
});
