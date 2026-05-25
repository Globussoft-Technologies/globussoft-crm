/**
 * /api/tenant/sub-brand-themes — per-tenant per-sub-brand default theme
 * (#876 + DD-5.3 RESOLVED 2026-05-24).
 *
 * The Tenant.subBrandThemes column (String? @db.Text, shipped tick #182 commit
 * 9fef1c80) stores per-sub-brand default theme preferences as JSON. The
 * frontend resolution chain (future #876 wire-in) is:
 *   user.themePreference → tenant.subBrandThemes[activeSubBrand] → 'system'
 *
 * Endpoints
 * ---------
 *   GET /api/tenant/sub-brand-themes  — authenticated read of the current
 *                                       tenant's stored map. Returns
 *                                       { themes: { tmc, rfu, travelstall,
 *                                       visasure } }, defaulting missing
 *                                       sub-brands to null (frontend then
 *                                       applies its 'system' fallback).
 *   PUT /api/tenant/sub-brand-themes  — ADMIN-only update. Body
 *                                       { themes: { [subBrand]: 'light'|
 *                                       'dark'|'system' } }. Merges with the
 *                                       existing stored map so a partial PUT
 *                                       only updates the keys it carries.
 *
 * Validation
 * ----------
 *   - Body MUST be { themes: { ... } } object. Reject otherwise →
 *     400 INVALID_PAYLOAD.
 *   - Every sub-brand key MUST be in {tmc, rfu, travelstall, visasure} →
 *     400 INVALID_SUB_BRAND otherwise.
 *   - Every value MUST be in {light, dark, system} →
 *     400 INVALID_THEME_VALUE otherwise.
 *
 * Storage convention
 * ------------------
 *   The column is `String? @db.Text` storing JSON. Per CLAUDE.md's
 *   "JSON-string columns" standing rule, the CALL SITE stringifies via
 *   JSON.stringify; sanitizeJson (shape-preserving) is used to scrub
 *   string values BEFORE stringifying. Read path JSON.parses and tolerates
 *   legacy null / "" / malformed values (returns {} in those cases).
 *
 * Tenant scoping
 * --------------
 *   Both endpoints scope on req.user.tenantId; no body-supplied tenant
 *   override is honoured (the stripDangerous middleware drops req.body.tenantId
 *   anyway, AND the handler never reads it).
 *
 * Error envelope (matches the standard {error, code} shape used across
 * routes/embassy_rules.js, routes/travel_curriculum.js, etc.):
 *   400 INVALID_PAYLOAD        — body shape not { themes: {...} }
 *   400 INVALID_SUB_BRAND      — unknown sub-brand key in themes
 *   400 INVALID_THEME_VALUE    — value not in {light, dark, system}
 *   403 RBAC_DENIED            — verifyRole gate on PUT
 *   404 TENANT_NOT_FOUND       — req.user.tenantId resolves to no row
 *                                (defensive — shouldn't happen via verifyToken)
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { sanitizeJson } = require("../lib/sanitizeJson");

const VALID_SUB_BRANDS = ["tmc", "rfu", "travelstall", "visasure"];
const VALID_THEME_VALUES = ["light", "dark", "system"];

// Read + parse the stored JSON-string column. Tolerates null / "" / malformed
// values by returning {} so the read path is never a 500 due to legacy bad data.
function parseStoredThemes(raw) {
  if (raw == null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (_e) {
    return {};
  }
}

// Validate the incoming { themes: {...} } payload. Throws a tagged Error with
// .status + .code on the first failure; returns the sanitised themes object
// otherwise.
function validateThemesPayload(body) {
  if (!body || typeof body !== "object") {
    const err = new Error("Body must be an object with a 'themes' field");
    err.status = 400;
    err.code = "INVALID_PAYLOAD";
    throw err;
  }
  const { themes } = body;
  if (!themes || typeof themes !== "object" || Array.isArray(themes)) {
    const err = new Error("Body must be { themes: { ... } }");
    err.status = 400;
    err.code = "INVALID_PAYLOAD";
    throw err;
  }
  for (const key of Object.keys(themes)) {
    if (!VALID_SUB_BRANDS.includes(key)) {
      const err = new Error(
        `Unknown sub-brand '${key}'. Allowed: ${VALID_SUB_BRANDS.join(", ")}`,
      );
      err.status = 400;
      err.code = "INVALID_SUB_BRAND";
      throw err;
    }
    const val = themes[key];
    if (!VALID_THEME_VALUES.includes(val)) {
      const err = new Error(
        `Invalid theme value '${val}' for '${key}'. Allowed: ${VALID_THEME_VALUES.join(", ")}`,
      );
      err.status = 400;
      err.code = "INVALID_THEME_VALUE";
      throw err;
    }
  }
  return themes;
}

// GET /api/tenant/sub-brand-themes — authenticated read.
//
// No role gate: any signed-in user under the tenant can read the configured
// defaults (operators need visibility so the resolved theme is explainable;
// PUT remains ADMIN-only).
router.get("/", verifyToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { subBrandThemes: true },
    });
    if (!tenant) {
      return res.status(404).json({
        error: "Tenant not found",
        code: "TENANT_NOT_FOUND",
      });
    }
    const themes = parseStoredThemes(tenant.subBrandThemes);
    res.json({ themes });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[sub-brand-themes] get error:", e.message);
    res.status(500).json({ error: "Failed to read sub-brand themes" });
  }
});

// PUT /api/tenant/sub-brand-themes — ADMIN-only update.
//
// Merges the incoming themes object with the existing stored map so a partial
// PUT only updates the keys it carries (e.g. PUT {themes:{tmc:'light'}} leaves
// rfu / travelstall / visasure intact).
router.put(
  "/",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const incoming = validateThemesPayload(req.body);

      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { subBrandThemes: true },
      });
      if (!tenant) {
        return res.status(404).json({
          error: "Tenant not found",
          code: "TENANT_NOT_FOUND",
        });
      }

      const existing = parseStoredThemes(tenant.subBrandThemes);
      const merged = { ...existing, ...incoming };

      // Sanitize string values BEFORE stringifying. sanitizeJson is shape-
      // preserving so the object stays an object; the call site stringifies
      // per CLAUDE.md's JSON-string-column convention.
      const cleaned = sanitizeJson(merged);
      const stringified = JSON.stringify(cleaned);

      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: { subBrandThemes: stringified },
      });

      res.json({ themes: cleaned });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[sub-brand-themes] update error:", e.message);
      res.status(500).json({ error: "Failed to update sub-brand themes" });
    }
  },
);

module.exports = router;
