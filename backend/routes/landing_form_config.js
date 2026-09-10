// Landing-page hero form config — which WebForm the public marketing page
// embeds (frontend/src/pages/Landing.jsx).
//
//   GET  /api/landing-form-config         public — { webFormId, webFormName }
//   GET  /api/landing-form-config/access  auth   — { canManage } for the caller
//   PUT  /api/landing-form-config         auth + LANDING_FORM_ADMIN_EMAILS allowlist — { webFormId, webFormName }
//
// The management gate is the caller's DB email (resolved server-side from
// req.user.userId — the JWT carries no email claim, and a client-supplied
// address is never trusted). The allowlist itself is never sent to clients:
// /access returns only a boolean for the caller. The selection is stored in
// TenantSetting (`landing.form.webFormId`) under PUBLIC_LEAD_TENANT_ID.

const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const landingFormConfig = require("../lib/landingFormConfig");

const router = express.Router();

async function loadPublicForm() {
  const legacyTenantId = landingFormConfig.resolvePublicLeadTenantId();
  const tenantSlug = legacyTenantId ? null : landingFormConfig.resolvePublicLeadTenantSlug();
  if (!tenantSlug && !legacyTenantId) {
    const err = new Error("Public lead tenant is not configured (PUBLIC_LEAD_TENANT_SLUG)");
    err.statusCode = 503;
    err.code = "LANDING_FORM_NOT_CONFIGURED";
    throw err;
  }
  const tenant = tenantSlug
    ? await prisma.tenant.findFirst({ where: { slug: tenantSlug, vertical: "generic", isActive: true }, select: { id: true } })
    : { id: legacyTenantId };
  if (!tenant) throw Object.assign(new Error("Public lead tenant is unavailable"), { statusCode: 503, code: "LANDING_FORM_NOT_CONFIGURED" });
  const tenantId = tenant.id;
  const webFormId = await landingFormConfig.resolveLandingWebFormId(prisma, tenantId);
  if (!webFormId) {
    const err = new Error("No active web form available for the landing page");
    err.statusCode = 503;
    err.code = "LANDING_FORM_UNAVAILABLE";
    throw err;
  }
  const form = await prisma.webForm.findFirst({
    where: { id: webFormId },
    select: { id: true, name: true },
  });
  return { tenantId, webFormId, webFormName: form ? form.name : "" };
}

// Resolve the caller's email from the DB and check the allowlist.
async function callerCanManage(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return landingFormConfig.isLandingFormAdminEmail(user && user.email);
}

router.get("/", async (req, res) => {
  try {
    const { webFormId, webFormName } = await loadPublicForm();
    res.json({ webFormId, webFormName });
  } catch (err) {
    console.error("[landing-form-config] public resolve failed:", err && err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to resolve landing-page form",
      code: err.code || "LANDING_FORM_RESOLVE_FAILED",
    });
  }
});

router.get("/access", verifyToken, async (req, res) => {
  try {
    const canManage = await callerCanManage(req.user.userId);
    res.json({ canManage });
  } catch (err) {
    console.error("[landing-form-config] access check failed:", err && err.message);
    res.status(500).json({ error: "Failed to check landing-page access", code: "LANDING_FORM_ACCESS_FAILED" });
  }
});

router.put("/", verifyToken, async (req, res) => {
  try {
    const canManage = await callerCanManage(req.user.userId);
    if (!canManage) {
      return res.status(403).json({
        error: "Only the designated landing-page form admin can change this form",
        code: "LANDING_FORM_FORBIDDEN",
      });
    }
    const webFormId = Number.parseInt(req.body && req.body.webFormId, 10);
    if (!Number.isInteger(webFormId) || webFormId <= 0) {
      return res.status(400).json({ error: "webFormId must be a positive integer", code: "INVALID_WEB_FORM_ID" });
    }
    const legacyTenantId = landingFormConfig.resolvePublicLeadTenantId();
    const tenantSlug = legacyTenantId ? null : landingFormConfig.resolvePublicLeadTenantSlug();
    const tenantRow = tenantSlug && await prisma.tenant.findFirst({ where: { slug: tenantSlug, vertical: "generic", isActive: true }, select: { id: true } });
    const tenantId = tenantRow?.id || (!tenantSlug && legacyTenantId);
    if (!tenantId) {
      return res.status(503).json({
        error: "Public lead tenant is not configured (PUBLIC_LEAD_TENANT_SLUG)",
        code: "LANDING_FORM_NOT_CONFIGURED",
      });
    }
    const form = await prisma.webForm.findFirst({
      where: { id: webFormId },
      select: { id: true, name: true, tenantId: true, isActive: true, scope: true },
    });
    if (!landingFormConfig.isSelectableLandingForm(form, tenantId)) {
      return res.status(400).json({
        error: "Form must exist, be active, generic-scope, and belong to the public lead tenant",
        code: "INVALID_WEB_FORM",
      });
    }
    await prisma.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY } },
      create: {
        tenantId,
        key: landingFormConfig.LANDING_FORM_SETTING_KEY,
        value: JSON.stringify({ webFormId: form.id, updatedByUserId: req.user.userId, updatedAt: new Date().toISOString() }),
        category: "landing",
      },
      update: {
        value: JSON.stringify({ webFormId: form.id, updatedByUserId: req.user.userId, updatedAt: new Date().toISOString() }),
        category: "landing",
      },
    });
    res.json({ webFormId: form.id, webFormName: form.name });
  } catch (err) {
    console.error("[landing-form-config] update failed:", err && err.message);
    res.status(500).json({ error: "Failed to update landing-page form", code: "LANDING_FORM_UPDATE_FAILED" });
  }
});

module.exports = router;
