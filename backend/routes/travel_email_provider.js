"use strict";

const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const travelSendGrid = require("../services/travelSendGrid");

const router = express.Router();

function requireTravel(req, res) {
  if (String(req.user?.vertical || req.user?.tenantVertical || "").toLowerCase() === "travel") return true;
  res.status(403).json({ error: "Travel email settings are available for travel tenants only", code: "TRAVEL_ONLY" });
  return false;
}

function encryptionFailure(error) {
  return ["TRAVEL_MEETING_ENCRYPTION_UNAVAILABLE", "TRAVEL_MEETING_CREDENTIAL_NOT_ENCRYPTED", "TRAVEL_MEETING_CREDENTIAL_INVALID"].includes(error.code);
}

router.get("/", verifyToken, async (req, res) => {
  if (!requireTravel(req, res)) return;
  try {
    const config = await travelSendGrid.readTenantConfig(req.user.tenantId);
    const status = travelSendGrid.publicStatus(config);
    if (String(req.user.role || "").toUpperCase() !== "ADMIN") {
      return res.json({ configured: status.configured, source: status.source });
    }
    return res.json(status);
  } catch (error) {
    const encrypted = encryptionFailure(error);
    res.status(encrypted ? 503 : 500).json({
      error: encrypted ? "Travel email credentials cannot be decrypted safely" : "Travel email settings could not be loaded",
      code: encrypted ? error.code : "TRAVEL_SENDGRID_READ_FAILED",
    });
  }
});

router.put("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  if (!requireTravel(req, res)) return;
  try {
    const saved = await travelSendGrid.saveTenantConfig(req.user.tenantId, req.body || {});
    await writeAudit("TenantSetting", "UPDATE", saved.row.id, req.user.userId, req.user.tenantId, {
      key: travelSendGrid.CONFIG_KEY,
      fromEmail: saved.config.fromEmail,
      fromName: saved.config.fromName,
    });
    res.json(travelSendGrid.publicStatus({ row: saved.row, config: saved.config }));
  } catch (error) {
    const encrypted = encryptionFailure(error);
    const status = encrypted ? 503 : (error.status || 500);
    res.status(status).json({
      error: encrypted ? "Travel email credential encryption is not configured" : (error.message || "Travel email settings could not be saved"),
      code: encrypted ? error.code : (error.code || "TRAVEL_SENDGRID_SAVE_FAILED"),
    });
  }
});

router.delete("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  if (!requireTravel(req, res)) return;
  try {
    const deleted = await travelSendGrid.deleteTenantConfig(req.user.tenantId);
    await writeAudit("TenantSetting", "DELETE", null, req.user.userId, req.user.tenantId, { key: travelSendGrid.CONFIG_KEY });
    res.json({ ...travelSendGrid.publicStatus(null), removed: deleted.count > 0 });
  } catch {
    res.status(500).json({ error: "Travel email settings could not be removed", code: "TRAVEL_SENDGRID_DELETE_FAILED" });
  }
});

module.exports = router;
