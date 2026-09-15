const express = require("express");
const router = express.Router();

// requireSuperAdmin is applied at the app.use() mount point in server.js
// (same pattern as the sibling /api/super-admin/* routers), not here.
const prisma = require("../lib/prisma");
const {
  getSuperAdminTenantsOverview,
  getSuperAdminTenantDetail,
  superAdminGrantSubscription,
  superAdminCancelPlatformSubscription,
  getSuperAdminRevenueSummary,
} = require("../lib/superAdminTenantManagement");
const landingFormConfig = require("../lib/landingFormConfig");

// ── Cross-tenant overview + detail ──────────────────────────────────────

router.get("/tenants", async (req, res) => {
  try {
    const overview = await getSuperAdminTenantsOverview({
      search: req.query.search,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(overview);
  } catch (err) {
    console.error("[super-admin-tenant-management] tenant list error:", err.message);
    res.status(500).json({ error: "Failed to load tenant overview" });
  }
});

// Super Admin landing-form selector. This uses the same tenant/form setting as
// the public landing page, without requiring the caller to be on the tenant's
// regular CRM session or listed in LANDING_FORM_ADMIN_EMAILS.
router.get("/landing-form", async (_req, res) => {
  try {
    const config = await landingFormConfig.readPublicConfig(prisma);
    const requestedTenantId = Number.parseInt(_req.query.tenantId, 10);
    const tenant = requestedTenantId ? await prisma.tenant.findFirst({ where: { id: requestedTenantId, vertical: "generic", isActive: true }, select: { id: true, name: true, slug: true } }) : config ? await prisma.tenant.findFirst({ where: { id: config.tenantId, vertical: "generic", isActive: true }, select: { id: true, name: true, slug: true } }) : null;
    if (!tenant) {
      const tenants = await prisma.tenant.findMany({ where: { vertical: "generic", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
      return res.json({ tenant: null, tenants, selectedId: "", forms: [], emails: [] });
    }
    const selectedId = await landingFormConfig.resolveLandingWebFormId(prisma, tenant.id);
    const forms = await prisma.webForm.findMany({ where: { tenantId: tenant.id, scope: "generic", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
    res.json({ tenant, selectedId, forms, emails: config?.emails || [] });
  } catch (err) { res.status(500).json({ error: err.message || "Failed to load landing forms", code: "LANDING_FORM_ADMIN_LOAD_FAILED" }); }
});

router.put("/landing-form", async (req, res) => {
  try {
    const webFormId = Number.parseInt(req.body?.webFormId, 10);
    if (!Number.isInteger(webFormId) || webFormId <= 0) return res.status(400).json({ error: "Invalid web form id", code: "INVALID_WEB_FORM_ID" });
    const tenant = await prisma.tenant.findFirst({ where: { id: Number(req.body?.tenantId), vertical: "generic", isActive: true }, select: { id: true } });
    const form = tenant && await prisma.webForm.findFirst({ where: { id: webFormId, tenantId: tenant.id, scope: "generic", isActive: true }, select: { id: true, name: true } });
    if (!tenant || !form) return res.status(400).json({ error: "Form must belong to the active public Generic tenant", code: "INVALID_WEB_FORM" });
    const emails = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId: tenant.id, key: landingFormConfig.LANDING_FORM_SETTING_KEY } }, create: { tenantId: tenant.id, key: landingFormConfig.LANDING_FORM_SETTING_KEY, value: JSON.stringify({ webFormId: form.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" }, update: { value: JSON.stringify({ webFormId: form.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" } });
    await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId: tenant.id, key: landingFormConfig.PUBLIC_CONFIG_KEY } }, create: { tenantId: tenant.id, key: landingFormConfig.PUBLIC_CONFIG_KEY, value: JSON.stringify({ tenantId: tenant.id, emails }), category: "landing" }, update: { value: JSON.stringify({ tenantId: tenant.id, emails }), category: "landing" } });
    res.json({ webFormId: form.id, webFormName: form.name });
  } catch (err) { res.status(500).json({ error: err.message || "Failed to update landing form", code: "LANDING_FORM_ADMIN_UPDATE_FAILED" }); }
});

router.put("/landing-form/emails", async (req, res) => {
  try {
    const emails = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    const existing = await landingFormConfig.readPublicConfig(prisma);
    let tenantId = existing?.tenantId;
    if (!tenantId) {
      const firstEmail = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).find(Boolean);
      const owner = firstEmail && await prisma.user.findFirst({ where: { email: firstEmail, tenant: { vertical: "generic", isActive: true } }, select: { tenantId: true } });
      tenantId = owner?.tenantId;
    }
    if (!tenantId) return res.status(400).json({ error: "Select a landing tenant before configuring emails", code: "LANDING_TENANT_REQUIRED" });
    if (!existing) {
      const firstForm = await prisma.webForm.findFirst({ where: { tenantId, scope: "generic", isActive: true }, orderBy: { id: "asc" }, select: { id: true } });
      if (!firstForm) return res.status(400).json({ error: "No active Generic web form exists for this email's tenant", code: "LANDING_FORM_REQUIRED" });
      await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY } }, create: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY, value: JSON.stringify({ webFormId: firstForm.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" }, update: { value: JSON.stringify({ webFormId: firstForm.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" } });
    }
    await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId, key: landingFormConfig.PUBLIC_CONFIG_KEY } }, create: { tenantId, key: landingFormConfig.PUBLIC_CONFIG_KEY, value: JSON.stringify({ tenantId, emails }), category: "landing" }, update: { value: JSON.stringify({ tenantId, emails }), category: "landing" } });
    res.json({ emails });
  } catch (err) { res.status(500).json({ error: err.message || "Failed to update landing form permissions", code: "LANDING_FORM_EMAILS_UPDATE_FAILED" }); }
});

router.get("/tenants/:tenantId", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const detail = await getSuperAdminTenantDetail(tenantId);
    res.json(detail);
  } catch (err) {
    console.error("[super-admin-tenant-management] tenant detail error:", err.message);
    const status = err.code === "TENANT_NOT_FOUND" ? 404 : 500;
    res.status(status).json({
      error: err.code === "TENANT_NOT_FOUND" ? "Tenant not found" : "Failed to load tenant details",
      code: err.code || "TENANT_DETAIL_FAILED",
    });
  }
});

// ── Plan catalog (read-only — CRUD stays owned by ManagePlans.jsx) ──────

router.get("/plans", async (_req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: "asc" },
    });
    res.json({ plans });
  } catch (err) {
    console.error("[super-admin-tenant-management] plans list error:", err.message);
    res.status(500).json({ error: "Failed to load subscription plans" });
  }
});

// ── Manual subscription grant / cancel ──────────────────────────────────

router.post("/tenants/:tenantId/subscription/grant", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const body = req.body || {};
    const subscription = await superAdminGrantSubscription({
      tenantId,
      planId: body.planId,
      superAdminUsername: req.superAdmin.username,
      reason: body.reason,
      customAmount: body.customAmount,
      customDurationDays: body.customDurationDays,
    });
    res.status(201).json({ ok: true, subscription });
  } catch (err) {
    console.error("[super-admin-tenant-management] grant error:", err.message);
    const status = ["INVALID_INPUT", "REASON_REQUIRED", "NO_ADMIN_USER"].includes(err.code)
      ? 400
      : err.code === "PLAN_NOT_FOUND"
        ? 404
        : 500;
    res.status(status).json({ error: err.message || "Failed to grant subscription", code: err.code || "GRANT_FAILED" });
  }
});

router.post("/tenants/:tenantId/subscription/cancel", async (req, res) => {
  try {
    const tenantId = Number(req.params.tenantId);
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: "Invalid tenant id", code: "INVALID_TENANT_ID" });
    }
    const body = req.body || {};
    const subscription = await superAdminCancelPlatformSubscription({
      tenantId,
      superAdminUsername: req.superAdmin.username,
      reason: body.reason,
    });
    res.json({ ok: true, subscription });
  } catch (err) {
    console.error("[super-admin-tenant-management] cancel error:", err.message);
    const status = ["REASON_REQUIRED", "NO_ACTIVE_SUBSCRIPTION"].includes(err.code) ? 400 : 500;
    res.status(status).json({ error: err.message || "Failed to cancel subscription", code: err.code || "CANCEL_FAILED" });
  }
});

// ── Combined revenue analytics ──────────────────────────────────────────

router.get("/revenue/summary", async (req, res) => {
  try {
    const summary = await getSuperAdminRevenueSummary({
      from: req.query.from,
      to: req.query.to,
    });
    res.json(summary);
  } catch (err) {
    console.error("[super-admin-tenant-management] revenue summary error:", err.message);
    res.status(500).json({ error: "Failed to load revenue summary" });
  }
});

module.exports = router;
