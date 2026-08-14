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
