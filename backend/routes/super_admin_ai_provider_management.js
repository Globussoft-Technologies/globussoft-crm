const express = require("express");
const router = express.Router();

// requireSuperAdmin is applied at the app.use() mount point in server.js
// (same pattern as the sibling /api/super-admin/* routers), not here.
const {
  getSuperAdminTenantOverview,
  getSuperAdminTenantDetail,
  superAdminAdjustCredits,
  superAdminSetSubscriptionStatus,
} = require("../lib/aiProviderManagement");
const { listAllPlans, createPlan, updatePlan, deactivatePlan, getPlanSubscriberAnalytics } = require("../lib/aiSubscriptionPlans");
const aiManagedApiKeys = require("../lib/aiManagedApiKeys");

// ── AI Subscription Plan catalog (replaces the old manual per-tenant
// custom-price approval) ────────────────────────────────────────────────

router.get("/plans", async (_req, res) => {
  try {
    const plans = await listAllPlans();
    res.json({ plans });
  } catch (err) {
    console.error("[super-admin-ai] plans list error:", err.message);
    res.status(500).json({ error: "Failed to load AI subscription plans" });
  }
});

router.post("/plans", async (req, res) => {
  try {
    const plan = await createPlan(req.body || {});
    res.status(201).json(plan);
  } catch (err) {
    console.error("[super-admin-ai] plan create error:", err.message);
    const status = err.code === "INVALID_PLAN_INPUT" ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to create AI subscription plan", code: err.code || "PLAN_CREATE_FAILED" });
  }
});

router.get("/plans/:planId/subscribers", async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: "Invalid plan id", code: "INVALID_PLAN_ID" });
    const analytics = await getPlanSubscriberAnalytics(planId, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json(analytics);
  } catch (err) {
    console.error("[super-admin-ai] plan subscribers error:", err.message);
    const status = err.code === "PLAN_NOT_FOUND" ? 404 : err.code === "INVALID_DATE" ? 400 : 500;
    res.status(status).json({
      error: err.message || "Failed to load plan subscribers",
      code: err.code || "PLAN_SUBSCRIBERS_FAILED",
    });
  }
});

router.put("/plans/:planId", async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: "Invalid plan id" });
    const plan = await updatePlan(planId, req.body || {});
    res.json(plan);
  } catch (err) {
    console.error("[super-admin-ai] plan update error:", err.message);
    const status = err.code === "INVALID_PLAN_INPUT" ? 400 : err.code === "P2025" ? 404 : 500;
    res.status(status).json({ error: err.message || "Failed to update AI subscription plan", code: err.code || "PLAN_UPDATE_FAILED" });
  }
});

router.delete("/plans/:planId", async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isFinite(planId)) return res.status(400).json({ error: "Invalid plan id" });
    const plan = await deactivatePlan(planId);
    res.json({ ok: true, plan });
  } catch (err) {
    console.error("[super-admin-ai] plan deactivate error:", err.message);
    const status = err.code === "P2025" ? 404 : 500;
    res.status(status).json({ error: "Failed to deactivate AI subscription plan" });
  }
});

// ── Cross-tenant usage analytics ────────────────────────────────────────

router.get("/tenants", async (req, res) => {
  try {
    const overview = await getSuperAdminTenantOverview({
      from: req.query.from,
      to: req.query.to,
      search: req.query.search,
      requestStatus: req.query.requestStatus,
    });
    res.json(overview);
  } catch (err) {
    console.error("[super-admin-ai] tenant list error:", err.message);
    res.status(500).json({ error: "Failed to load AI tenant overview" });
  }
});

router.get("/tenants/:tenantId", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const detail = await getSuperAdminTenantDetail(tenantId, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json(detail);
  } catch (err) {
    console.error("[super-admin-ai] tenant detail error:", err.message);
    const status = err.code === "TENANT_NOT_FOUND" ? 404 : 500;
    res.status(status).json({
      error: err.code === "TENANT_NOT_FOUND" ? "Tenant not found" : "Failed to load tenant AI details",
      code: err.code || "TENANT_AI_DETAIL_FAILED",
    });
  }
});

// ── Manual credit adjustments + subscription hold/resume ───────────────

router.post("/tenants/:tenantId/credits/adjust", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const body = req.body || {};
    const result = await superAdminAdjustCredits({
      tenantId,
      superAdminUsername: req.superAdmin.username,
      tokens: body.tokens,
      direction: body.direction === "debit" ? "debit" : "credit",
      reason: body.reason ? String(body.reason).slice(0, 2000) : "",
    });
    res.json({ ok: true, wallet: result.wallet, transaction: result.transaction });
  } catch (err) {
    console.error("[super-admin-ai] credit adjustment error:", err.message);
    const status = err.code === "INVALID_ADJUSTMENT" ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to adjust AI credits", code: err.code || "CREDIT_ADJUST_FAILED" });
  }
});

router.post("/tenants/:tenantId/suspend", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    const subscription = await superAdminSetSubscriptionStatus({
      tenantId,
      superAdminUsername: req.superAdmin.username,
      action: "suspend",
    });
    res.json({ ok: true, subscription });
  } catch (err) {
    console.error("[super-admin-ai] suspend error:", err.message);
    const status = err.code === "NO_ACTIVE_SUBSCRIPTION" ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to suspend AI access", code: err.code || "SUSPEND_FAILED" });
  }
});

router.post("/tenants/:tenantId/resume", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    const subscription = await superAdminSetSubscriptionStatus({
      tenantId,
      superAdminUsername: req.superAdmin.username,
      action: "resume",
    });
    res.json({ ok: true, subscription });
  } catch (err) {
    console.error("[super-admin-ai] resume error:", err.message);
    const status = err.code === "NO_ELIGIBLE_SUBSCRIPTION" ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to resume AI access", code: err.code || "RESUME_FAILED" });
  }
});

// ── Managed AI API Keys ─────────────────────────────────────────────────
// Reusable provider keys that can be attached to AI subscription plans.

router.get("/api-keys", async (_req, res) => {
  try {
    const keys = await aiManagedApiKeys.listKeys();
    res.json({ keys });
  } catch (err) {
    console.error("[super-admin-ai] api-keys list error:", err.message);
    res.status(500).json({ error: "Failed to load managed API keys" });
  }
});

router.post("/api-keys", async (req, res) => {
  try {
    const key = await aiManagedApiKeys.createKey(req.body || {});
    res.status(201).json({ key });
  } catch (err) {
    console.error("[super-admin-ai] api-key create error:", err.message);
    const status = err.code === "INVALID_KEY_INPUT" ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to create API key", code: err.code || "API_KEY_CREATE_FAILED" });
  }
});

router.put("/api-keys/:keyId", async (req, res) => {
  try {
    const keyId = Number(req.params.keyId);
    if (!Number.isFinite(keyId)) return res.status(400).json({ error: "Invalid key id" });
    const key = await aiManagedApiKeys.updateKey(keyId, req.body || {});
    res.json({ key });
  } catch (err) {
    console.error("[super-admin-ai] api-key update error:", err.message);
    const status = err.code === "INVALID_KEY_INPUT" ? 400 : err.code === "INVALID_KEY_ID" ? 400 : err.code === "P2025" ? 404 : 500;
    res.status(status).json({ error: err.message || "Failed to update API key", code: err.code || "API_KEY_UPDATE_FAILED" });
  }
});

router.delete("/api-keys/:keyId", async (req, res) => {
  try {
    const keyId = Number(req.params.keyId);
    if (!Number.isFinite(keyId)) return res.status(400).json({ error: "Invalid key id" });
    await aiManagedApiKeys.deleteKey(keyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[super-admin-ai] api-key delete error:", err.message);
    const status = err.code === "INVALID_KEY_ID" ? 400 : err.code === "P2025" ? 404 : 500;
    res.status(status).json({ error: err.message || "Failed to delete API key", code: err.code || "API_KEY_DELETE_FAILED" });
  }
});

module.exports = router;
