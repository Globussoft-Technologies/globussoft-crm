"use strict";

const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const genericSendGrid = require("../services/genericSendGrid");

const router = express.Router();

function requireGeneric(req, res) {
  if (String(req.user?.vertical || req.user?.tenantVertical || "").toLowerCase() === "generic") return true;
  res.status(403).json({ error: "SendGrid settings are available for Generic CRM tenants only", code: "GENERIC_ONLY" });
  return false;
}

function encryptionFailure(error) {
  return ["GENERIC_SENDGRID_ENCRYPTION_UNAVAILABLE", "GENERIC_SENDGRID_CREDENTIAL_NOT_ENCRYPTED", "GENERIC_SENDGRID_CREDENTIAL_INVALID"].includes(error.code);
}

router.get("/", verifyToken, async (req, res) => {
  if (!requireGeneric(req, res)) return;
  try {
    const config = await genericSendGrid.readTenantConfig(req.user.tenantId);
    const status = genericSendGrid.publicStatus(config);
    if (String(req.user.role || "").toUpperCase() !== "ADMIN") {
      return res.json({ configured: status.configured, source: status.source });
    }
    return res.json(status);
  } catch (error) {
    const encrypted = encryptionFailure(error);
    return res.status(encrypted ? 503 : 500).json({
      error: encrypted ? "SendGrid credentials cannot be decrypted safely" : "SendGrid settings could not be loaded",
      code: encrypted ? error.code : "GENERIC_SENDGRID_READ_FAILED",
    });
  }
});

router.put("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  if (!requireGeneric(req, res)) return;
  try {
    const saved = await genericSendGrid.saveTenantConfig(req.user.tenantId, req.body || {});
    await writeAudit("TenantSetting", "UPDATE", saved.row.id, req.user.userId, req.user.tenantId, {
      key: genericSendGrid.CONFIG_KEY,
      fromEmail: saved.config.fromEmail,
      fromName: saved.config.fromName,
    });
    return res.json(genericSendGrid.publicStatus({ row: saved.row, config: saved.config }));
  } catch (error) {
    const encrypted = encryptionFailure(error);
    return res.status(encrypted ? 503 : (error.status || 500)).json({
      error: encrypted ? "Credential encryption is not configured" : (error.message || "SendGrid settings could not be saved"),
      code: encrypted ? error.code : (error.code || "GENERIC_SENDGRID_SAVE_FAILED"),
    });
  }
});

router.delete("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  if (!requireGeneric(req, res)) return;
  try {
    const deleted = await genericSendGrid.deleteTenantConfig(req.user.tenantId);
    await writeAudit("TenantSetting", "DELETE", null, req.user.userId, req.user.tenantId, { key: genericSendGrid.CONFIG_KEY });
    return res.json({ ...genericSendGrid.publicStatus(null), removed: deleted.count > 0 });
  } catch {
    return res.status(500).json({ error: "SendGrid settings could not be removed", code: "GENERIC_SENDGRID_DELETE_FAILED" });
  }
});

module.exports = router;
