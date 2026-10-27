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
// TenantSetting (`landing.form.webFormId`) under the tenant selected by
// PUBLIC_LEAD_TENANT_SLUG.

const express = require("express");
const fs = require("fs");
const path = require("path");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const landingFormConfig = require("../lib/landingFormConfig");
const { buildPublicFormPayload } = require("./web_forms");

const router = express.Router();
const embedDocumentPath = path.join(__dirname, "..", "..", "frontend", "public", "embed", "web-form.html");

async function loadPublicForm(includePayload = false) {
  const config = await landingFormConfig.readPublicConfig(prisma);
  const tenantSlug = landingFormConfig.resolvePublicLeadTenantSlug();
  if (!config && !tenantSlug) {
    throw Object.assign(new Error("Public lead tenant is not configured"), { statusCode: 503, code: "LANDING_FORM_NOT_CONFIGURED" });
  }
  const tenant = await prisma.tenant.findFirst({
    where: config
      ? { id: config.tenantId, vertical: "generic", isActive: true }
      : { slug: tenantSlug, vertical: "generic", isActive: true },
    select: { id: true },
  });
  if (!tenant) throw Object.assign(new Error("Public lead tenant is unavailable"), { statusCode: 503, code: "LANDING_FORM_NOT_CONFIGURED" });
  const tenantId = tenant.id;
  const webFormId = config?.activeWebFormId || await landingFormConfig.resolveLandingWebFormId(prisma, tenantId);
  if (!webFormId) {
    const err = new Error("No active web form available for the landing page");
    err.statusCode = 503;
    err.code = "LANDING_FORM_UNAVAILABLE";
    throw err;
  }
  const form = await prisma.webForm.findFirst({
    where: { id: webFormId, tenantId, scope: "generic", isActive: true },
    ...(includePayload ? {} : { select: { id: true, name: true } }),
  });
  if (!form) {
    throw Object.assign(new Error("The configured landing-page form is unavailable"), { statusCode: 503, code: "LANDING_FORM_UNAVAILABLE" });
  }
  return { tenantId, webFormId, webFormName: form.name, form };
}

// Resolve the caller's email from the DB and check the allowlist.
async function callerCanManage(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return landingFormConfig.isPublicConfigAdmin(prisma, user && user.email);
}

router.get("/embed", async (req, res) => {
  try {
    const { webFormId, form } = await loadPublicForm(true);
    const origin = `${req.protocol}://${req.get("host")}`;
    const publicForm = await buildPublicFormPayload(form, origin);
    const bootstrap = JSON.stringify(publicForm)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    const document = await fs.promises.readFile(embedDocumentPath, "utf8");
    const html = document.replace(
      "</head>",
      `<script>document.documentElement.classList.add("landing-embed");window.__GBS_INITIAL_FORM__=${bootstrap};window.__GBS_INITIAL_FORM_ID__=${webFormId};</script></head>`,
    );
    // Helmet denies framing globally. This document is intentionally framed
    // only by the same-origin landing page; keep cross-origin framing blocked.
    res.removeHeader("Content-Security-Policy");
    res.set("Content-Security-Policy", "frame-ancestors 'self'");
    res.set("X-Frame-Options", "SAMEORIGIN");
    res.set("Cache-Control", "no-store");
    res.type("html").send(html);
  } catch (err) {
    console.error("[landing-form-config] embed resolve failed:", err && err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to render landing-page form",
      code: err.code || "LANDING_FORM_RESOLVE_FAILED",
    });
  }
});

router.get("/", async (_req, res) => {
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

router.get("/mine", verifyToken, async (req, res) => {
  try {
    const tenantId = Number(req.user.tenantId);
    const config = await landingFormConfig.readPublicConfig(prisma);
    // Checkbox state is global: never fall back to a tenant-local setting.
    const webFormId = config?.activeWebFormId || null;
    const form = webFormId ? await prisma.webForm.findFirst({ where: { id: webFormId, tenantId, scope: "generic", isActive: true }, select: { id: true, name: true } }) : null;
    res.json({ webFormId: form?.id || null, webFormName: form?.name || "" });
  } catch (err) {
    console.error("[landing-form-config] account resolve failed:", err && err.message);
    res.status(500).json({ error: "Failed to resolve account landing form", code: "LANDING_FORM_RESOLVE_FAILED" });
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
    const tenantId = Number(req.user.tenantId);
    const form = await prisma.webForm.findFirst({
      where: { id: webFormId, tenantId, scope: "generic", isActive: true },
      select: { id: true, name: true, tenantId: true, isActive: true, scope: true },
    });
    if (!landingFormConfig.isSelectableLandingForm(form, tenantId)) {
      return res.status(400).json({
        error: "Form must exist, be active, generic-scope, and belong to the public lead tenant",
        code: "INVALID_WEB_FORM",
      });
    }
    // Replace the single global active form configuration.
    const publicConfig = await landingFormConfig.readPublicConfig(prisma);
    await prisma.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY } },
      create: { tenantId, key: landingFormConfig.LANDING_FORM_SETTING_KEY, value: JSON.stringify({ webFormId: form.id, updatedByUserId: req.user.userId }), category: "landing" },
      update: { value: JSON.stringify({ webFormId: form.id, updatedByUserId: req.user.userId }), category: "landing" },
    });
    await landingFormConfig.writePublicConfig(prisma, {
      tenantId,
      activeWebFormId: form.id,
      emails: publicConfig?.emails || [...landingFormConfig.getLandingFormAdminEmails()],
    });
    res.json({ webFormId: form.id, webFormName: form.name });
  } catch (err) {
    console.error("[landing-form-config] update failed:", err && err.message);
    res.status(500).json({ error: "Failed to update landing-page form", code: "LANDING_FORM_UPDATE_FAILED" });
  }
});

module.exports = router;
