const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const {
  getGoogleMapsConfig,
  saveGoogleMapsConfig,
  toPublicGoogleMapsConfig,
} = require("../lib/googleMapsConfig");

const router = express.Router();

async function requireGenericTenant(req, res, next) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    if (!tenant || tenant.vertical !== "generic") {
      return res.status(403).json({
        error: "Google Maps address settings are available only in Generic CRM.",
        code: "WRONG_VERTICAL",
      });
    }
    next();
  } catch (error) {
    console.error("[google-maps-settings] tenant check:", error);
    res.status(500).json({ error: "Failed to verify tenant configuration.", code: "TENANT_LOOKUP_FAILED" });
  }
}

router.get("/", verifyToken, verifyRole(["ADMIN"]), requireGenericTenant, async (req, res) => {
  try {
    const config = await getGoogleMapsConfig(req.user.tenantId);
    res.json(toPublicGoogleMapsConfig(config));
  } catch (error) {
    console.error("[google-maps-settings] GET:", error);
    res.status(500).json({ error: "Failed to load Google Maps settings.", code: "GOOGLE_MAPS_SETTINGS_READ_FAILED" });
  }
});

router.put("/", verifyToken, verifyRole(["ADMIN"]), requireGenericTenant, async (req, res) => {
  try {
    const config = await saveGoogleMapsConfig(req.user.tenantId, req.body || {});
    await writeAudit(
      "Integration",
      "UPDATE",
      config.row?.id || null,
      req.user.userId,
      req.user.tenantId,
      { provider: "google_maps", enabled: config.enabled, credentialRotated: Boolean(req.body?.apiKey) },
    );
    res.json({ success: true, ...toPublicGoogleMapsConfig(config) });
  } catch (error) {
    console.error("[google-maps-settings] PUT:", error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Failed to save Google Maps settings.",
      code: error.code || "GOOGLE_MAPS_SETTINGS_SAVE_FAILED",
    });
  }
});

module.exports = router;
