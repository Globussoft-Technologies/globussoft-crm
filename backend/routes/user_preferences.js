/**
 * /api/user — per-user preference surface (theme, future per-user toggles).
 *
 * Closes #870 (Theme/Persistence): the chosen theme used to live only in
 * `localStorage` on the browser that picked it. A user logging in on a
 * second device or after clearing site data lost their preference. Per
 * DD-5.2 [RESOLVED 2026-05-24] "user preference wins — tenant default only
 * applies when the user has no preference set", we persist the choice on
 * the User row and rehydrate it on every login.
 *
 * What's pinned
 * -------------
 *   - GET   /theme                   returns { theme }; theme ∈ {light,dark,system}
 *                                    falls back to 'system' when User.themePreference null
 *   - PUT   /theme  { theme }        upserts the column + returns { theme }
 *                                    400 INVALID_THEME on out-of-set values
 *                                    400 INVALID_BODY on missing body.theme
 *
 * Tenant scoping
 * --------------
 * The preference is per-user, not per-tenant — but we still filter by
 * `tenantId` on the update so a stolen JWT can't cross-tenant flip a
 * user-row that's been moved between tenants. The {userId, tenantId} pair
 * is what `verifyToken` puts in `req.user` and what we trust here.
 *
 * Body strip-dangerous note: the global stripDangerous middleware deletes
 * `id`, `userId`, `tenantId`, `createdAt`, `updatedAt` from request bodies.
 * This route only reads `req.body.theme`, which is not stripped.
 */

const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const ALLOWED_THEMES = ["light", "dark", "system"];

// ─── GET /theme — read caller's persisted theme ──────────────────────────
//
// Returns the User.themePreference column verbatim, or 'system' when the
// column is null (per DD-5.2 fallback). Frontend uses this on mount after
// login to override whatever the localStorage cache had.
router.get("/theme", verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { themePreference: true },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    }
    const theme = user.themePreference || "system";
    res.json({ theme });
  } catch (_error) {
    res.status(500).json({ error: "Failed to fetch theme preference", code: "INTERNAL_ERROR" });
  }
});

// ─── PUT /theme — write caller's theme ───────────────────────────────────
//
// Validates against the closed set {light, dark, system}. Anything else
// gets a 400 with the allowed list so a misbehaving client can self-correct.
router.put("/theme", verifyToken, async (req, res) => {
  try {
    const { theme } = req.body || {};
    if (typeof theme !== "string" || theme.length === 0) {
      return res.status(400).json({
        error: "theme is required",
        code: "INVALID_BODY",
        allowed: ALLOWED_THEMES,
      });
    }
    if (!ALLOWED_THEMES.includes(theme)) {
      return res.status(400).json({
        error: `theme must be one of: ${ALLOWED_THEMES.join(", ")}`,
        code: "INVALID_THEME",
        allowed: ALLOWED_THEMES,
      });
    }

    // Scope the update to {id, tenantId} so a stolen JWT can't cross-tenant
    // flip a User row that's been moved between tenants. updateMany returns
    // a count; 0 means the user row vanished out from under us.
    const result = await prisma.user.updateMany({
      where: { id: req.user.userId, tenantId: req.user.tenantId },
      data: { themePreference: theme },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    }

    res.json({ theme });
  } catch (_error) {
    res.status(500).json({ error: "Failed to update theme preference", code: "INTERNAL_ERROR" });
  }
});

module.exports = router;
