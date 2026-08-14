const express = require("express");
const router = express.Router();

const { verifyToken, verifyRole } = require("../middleware/auth");
const {
  PROVIDER_CATALOG,
  getTenantAiState,
  saveByokConfig,
  removeByokConfig,
  testProviderConnection,
  discoverModels,
  cancelTenantSubscription,
} = require("../lib/aiProviderManagement");

router.get("/providers", verifyToken, (_req, res) => {
  res.json({
    providers: Object.values(PROVIDER_CATALOG).map((provider) => ({
      id: provider.id,
      label: provider.label,
      family: provider.family,
      defaultModel: provider.defaultModel,
      allowCustomBaseUrl: provider.allowCustomBaseUrl,
    })),
  });
});

// Tenant-wide AI access status — BYOK config (if any) + CRM-managed
// subscription/credit wallet state. Drives OrganizationAiSettingsCard and
// the "your AI credits are exhausted" gate shown by AI features.
router.get("/status", verifyToken, async (req, res) => {
  try {
    const state = await getTenantAiState(req.user.tenantId);
    res.json(state);
  } catch (err) {
    console.error("[ai-provider-management] status error:", err.message);
    res.status(500).json({ error: "Failed to load AI settings" });
  }
});

router.post("/byok", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await saveByokConfig({
      tenantId: req.user.tenantId,
      actorUserId: req.user.userId,
      providerId: body.providerId || body.provider,
      providerName: body.providerName || "",
      apiKey: body.apiKey || "",
      model: body.model || "",
      baseUrl: body.baseUrl || "",
    });
    res.json(saved);
  } catch (err) {
    const status = err.code && /INVALID|MISSING|UNSUPPORTED/.test(err.code) ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code || "AI_PROVIDER_SAVE_FAILED" });
  }
});

router.post("/byok/test", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const body = req.body || {};
    const result = await testProviderConnection({
      providerId: body.providerId || body.provider,
      apiKey: body.apiKey,
      model: body.model,
      baseUrl: body.baseUrl,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error:
        "The provided AI provider could not be verified. Check the API key, model, and Base URL, then try again.",
      code: err.code || "AI_PROVIDER_TEST_FAILED",
    });
  }
});

router.post("/byok/discover-models", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const body = req.body || {};
    const models = await discoverModels({
      providerId: body.providerId || body.provider,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });
    res.json({ models });
  } catch (err) {
    res.status(502).json({
      error:
        "Unable to load models for this provider right now. Verify the API key and Base URL, then try again.",
      code: err.code || "MODEL_DISCOVERY_FAILED",
    });
  }
});

router.delete("/byok", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    await removeByokConfig({
      tenantId: req.user.tenantId,
      actorUserId: req.user.userId,
    });
    res.status(204).end();
  } catch (err) {
    console.error("[ai-provider-management] delete error:", err.message);
    res.status(500).json({ error: "Failed to remove AI provider config" });
  }
});

// Tenant ADMIN cancels their active CRM-managed AI subscription. Purchasing
// a new one, and all credit/plan browsing, lives under /api/ai-subscriptions
// (routes/ai_subscriptions.js) — this route only handles the cancel action
// since it's a lifecycle change to state this router already surfaces via
// GET /status.
router.post("/crm-access/cancel", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    await cancelTenantSubscription({
      tenantId: req.user.tenantId,
      actorUserId: req.user.userId,
    });
    res.json({ ok: true, message: "CRM-managed AI subscription cancelled." });
  } catch (err) {
    const status = err.code === "NO_ACTIVE_SUBSCRIPTION" ? 400 : 500;
    res.status(status).json({
      error: err.code === "NO_ACTIVE_SUBSCRIPTION" ? "No active AI subscription to cancel." : "Failed to cancel AI subscription",
      code: err.code || "AI_SUBSCRIPTION_CANCEL_FAILED",
    });
  }
});

module.exports = router;
