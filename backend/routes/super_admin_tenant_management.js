const express = require("express");
const bcrypt = require("bcryptjs");
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
const emailOtp = require("../lib/emailOtp");
const { provisionTenantRbac } = require("../scripts/ensureRbacOnBoot");

function validatePasswordComplexity(password) {
  if (!password || typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters long";
  if (!/[A-Za-z]/.test(password)) return "Password must contain at least one letter";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number";
  return null;
}

function normalizeOrganizationName(name) {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

async function organizationNameTaken(name) {
  const normalizedName = normalizeOrganizationName(name);
  if (!normalizedName) return false;
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { organizationNameKey: normalizedName },
        { name: String(name || "").trim() },
      ],
    },
    select: { id: true },
  });
  return Boolean(tenant);
}

async function generateUniqueSlug(base) {
  const root = (base || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  let slug = root;
  for (let i = 1; i <= 100; i += 1) {
    if (!await prisma.tenant.findUnique({ where: { slug } })) return slug;
    slug = `${root}-${i + 1}`;
  }
  return `${root}-${require("crypto").randomUUID().slice(0, 8)}`;
}

async function provisionFreshTenant(tenantId, vertical, adminUserId) {
  try {
    await provisionTenantRbac(tenantId, { vertical });
    const adminRole = await prisma.role.findFirst({ where: { tenantId, key: "ADMIN" }, select: { id: true } });
    if (adminRole && adminUserId) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: adminUserId, roleId: adminRole.id } },
        update: {},
        create: { userId: adminUserId, roleId: adminRole.id },
      });
    }
  } catch (err) {
    console.error(`[super-admin] RBAC provisioning failed for tenant ${tenantId}:`, err.message);
  }
}

// ── Cross-tenant overview + detail ──────────────────────────────────────

// Super Admin organization creation is intentionally separate from public
// signup. A trusted platform operator does not need customer email OTP;
// public/customer registration keeps its existing verification rules.
router.post("/organizations", async (req, res) => {
  try {
    const { email: rawEmail, password, name, organizationName: rawOrganizationName, vertical, themePreference } = req.body || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    const organizationName = String(rawOrganizationName || "").trim().replace(/\s+/g, " ");
    const selectedVertical = ["generic", "wellness", "travel"].includes(vertical) ? vertical : "generic";
    const passwordError = validatePasswordComplexity(password);
    if (passwordError) return res.status(400).json({ error: passwordError, code: "INVALID_PASSWORD" });
    if (!emailOtp.isValidEmail(email)) return res.status(400).json({ error: "A valid email address is required", code: "EMAIL_REQUIRED" });
    if (!organizationName) return res.status(400).json({ error: "Organization name is required", code: "ORGANIZATION_NAME_REQUIRED" });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Full name is required", code: "NAME_REQUIRED" });

    // Match public signup: the same email may be used in a different CRM
    // vertical, but cannot be registered twice within the same vertical.
    const existingUser = await prisma.user.findFirst({ where: { email, tenant: { vertical: selectedVertical } }, select: { id: true } });
    if (existingUser) return res.status(409).json({ error: "This email is already registered. Please use a different email address.", code: "EMAIL_ALREADY_EXISTS" });
    if (await organizationNameTaken(organizationName)) return res.status(409).json({ error: "This organization name is already taken. Please use a different name.", code: "ORGANIZATION_NAME_ALREADY_EXISTS" });

    const trialDays = parseInt(process.env.FREE_TRIAL_DAYS || "15", 10);
    const now = new Date();
    const tenant = await prisma.tenant.create({
      data: {
        name: organizationName,
        organizationNameKey: normalizeOrganizationName(organizationName),
        slug: await generateUniqueSlug(organizationName),
        ownerEmail: email,
        plan: "TRIAL",
        vertical: selectedVertical,
        emailVerifiedAt: now,
      },
    });
    const user = await prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash(password, 10),
        name: String(name).trim(),
        role: "ADMIN",
        tenantId: tenant.id,
        trialStartDate: now,
        trialEndsAt: new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000),
        subscriptionStatus: "TRIAL",
        themePreference: ["light", "dark", "system"].includes(themePreference) ? themePreference : "system",
        emailVerifiedAt: now,
      },
    });
    await provisionFreshTenant(tenant.id, selectedVertical, user.id);
    res.status(201).json({
      organization: { id: tenant.id, name: tenant.name, slug: tenant.slug, ownerEmail: tenant.ownerEmail, plan: tenant.plan, vertical: tenant.vertical },
      owner: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error("[super-admin] organization creation error:", err.message);
    if (err?.code === "P2002") return res.status(409).json({ error: "This email or organization is already registered.", code: "DUPLICATE_ORGANIZATION" });
    res.status(500).json({ error: "Failed to create organization", code: "ORGANIZATION_CREATE_FAILED" });
  }
});

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
    const siteTenantId = Number(req.body?.siteTenantId);
    const tenant = await prisma.tenant.findFirst({ where: { id: siteTenantId, vertical: "generic", isActive: true }, select: { id: true } });
    const form = tenant && await prisma.webForm.findFirst({ where: { id: webFormId, tenantId: tenant.id, scope: "generic", isActive: true }, select: { id: true, name: true } });
    if (!tenant || !form) return res.status(400).json({ error: "Form must belong to the active public Generic tenant", code: "INVALID_WEB_FORM" });
    const emails = String(req.body?.emails || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
    await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId: tenant.id, key: landingFormConfig.LANDING_FORM_SETTING_KEY } }, create: { tenantId: tenant.id, key: landingFormConfig.LANDING_FORM_SETTING_KEY, value: JSON.stringify({ webFormId: form.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" }, update: { value: JSON.stringify({ webFormId: form.id, updatedBySuperAdmin: req.superAdmin.username }), category: "landing" } });
    await landingFormConfig.writePublicConfig(prisma, { tenantId: tenant.id, activeWebFormId: form.id, emails });
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
    const activeWebFormId = existing?.activeWebFormId || await landingFormConfig.resolveLandingWebFormId(prisma, tenantId);
    await landingFormConfig.writePublicConfig(prisma, { tenantId, activeWebFormId, emails });
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
