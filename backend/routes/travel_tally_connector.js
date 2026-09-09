const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { requirePermission } = require("../middleware/requirePermission");
const { writeAudit } = require("../lib/audit");
const {
  CONNECTOR_PATH,
  CONNECTOR_PROVIDER,
  createConnectorCredentials,
  disconnectConnector,
  getConnectorStatus,
  parseTallyResponse,
  sendTallyJob,
} = require("../lib/tallyConnectorBridge");

const guards = [verifyToken, requireTravelTenant];
const activePushes = new Set();

function safeCredentials(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return { connectorId: parsed.connectorId || null, createdAt: parsed.createdAt || null };
  } catch (_) {
    return null;
  }
}

function connectorUrlFor(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const wsProtocol = (forwarded || req.protocol) === "https" ? "wss" : "ws";
  return `${wsProtocol}://${req.get("host")}${CONNECTOR_PATH}`;
}

function validXml(value) {
  const xml = String(value || "").trim();
  return /<ENVELOPE(?:\s|>)/i.test(xml) && /<\/ENVELOPE>\s*$/i.test(xml);
}

router.get("/status", ...guards, requirePermission("tally", "read"), async (req, res) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId: req.travelTenant.id, provider: CONNECTOR_PROVIDER } },
      select: { settings: true, isActive: true },
    });
    const credentials = integration?.isActive ? safeCredentials(integration.settings) : null;
    res.json({
      configured: Boolean(credentials),
      credentials,
      connectorUrl: connectorUrlFor(req),
      ...getConnectorStatus(req.travelTenant.id),
    });
  } catch (error) {
    console.error("[tally-connector] status failed:", error.message);
    res.status(500).json({ error: "Failed to load Tally connector status", code: "TALLY_CONNECTOR_STATUS_ERROR" });
  }
});

router.post("/credentials", ...guards, requirePermission("tally", "update"), async (req, res) => {
  try {
    const generated = createConnectorCredentials();
    await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId: req.travelTenant.id, provider: CONNECTOR_PROVIDER } },
      create: { tenantId: req.travelTenant.id, provider: CONNECTOR_PROVIDER, token: generated.stored.tokenHash, settings: JSON.stringify({ connectorId: generated.stored.connectorId, createdAt: generated.stored.createdAt }), isActive: true },
      update: { token: generated.stored.tokenHash, settings: JSON.stringify({ connectorId: generated.stored.connectorId, createdAt: generated.stored.createdAt }), isActive: true },
    });
    disconnectConnector(req.travelTenant.id);
    await writeAudit("TravelTally", "ROTATE_CONNECTOR_TOKEN", 0, req.user.userId, req.travelTenant.id, { connectorId: generated.stored.connectorId }).catch((error) => {
      console.warn("[tally-connector] credential audit failed:", error.message);
    });
    res.status(201).json({
      customerId: req.travelTenant.id,
      connectorId: generated.stored.connectorId,
      token: generated.token,
      connectorUrl: connectorUrlFor(req),
      message: "Save this token now. It is only returned once.",
    });
  } catch (error) {
    console.error("[tally-connector] credential generation failed:", error.message);
    res.status(500).json({ error: "Failed to generate connector credentials", code: "TALLY_CONNECTOR_CREDENTIAL_ERROR" });
  }
});

router.post("/push", ...guards, requirePermission("tally", "export"), async (req, res) => {
  const mastersXml = String(req.body?.mastersXml || "").trim();
  const vouchersXml = String(req.body?.vouchersXml || "").trim();
  if (!validXml(vouchersXml) || (mastersXml && !validXml(mastersXml))) {
    return res.status(400).json({ error: "Valid Tally ENVELOPE XML is required", code: "INVALID_TALLY_XML" });
  }
  if (!getConnectorStatus(req.travelTenant.id).online) {
    return res.status(503).json({ error: "Tally connector is offline. Start it on the Tally computer and try again.", code: "TALLY_CONNECTOR_OFFLINE" });
  }

  if (activePushes.has(req.travelTenant.id)) {
    return res.status(409).json({ error: "Another direct Tally push is already running for this account", code: "TALLY_PUSH_IN_PROGRESS" });
  }
  activePushes.add(req.travelTenant.id);
  try {
    const recentVoucherPushes = await prisma.travelTallySyncLog.findMany({
      where: { tenantId: req.travelTenant.id, sourceType: "DIRECT_EXPORT", voucherType: "VOUCHERS", status: "SYNCED" },
      select: { requestPayload: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    const duplicate = recentVoucherPushes.find((entry) => entry.requestPayload === vouchersXml);
    if (duplicate) {
      return res.status(409).json({ error: "This exact voucher export was already pushed successfully. Change the export selection before pushing again.", code: "TALLY_DUPLICATE_PUSH", pushedAt: duplicate.createdAt });
    }

    const stages = [...(mastersXml ? [{ name: "masters", xml: mastersXml }] : []), { name: "vouchers", xml: vouchersXml }];
    const results = [];
    for (const stage of stages) {
      try {
        const result = await sendTallyJob(req.travelTenant.id, stage.xml, { jobType: stage.name === "masters" ? "IMPORT_MASTERS" : "IMPORT_VOUCHERS" });
        const tally = result.tally || parseTallyResponse(result.responseXml);
        if (!tally.success) {
          throw Object.assign(new Error(tally.lineError || `Tally reported ${tally.errors + tally.exceptions} error(s)`), { code: "TALLY_IMPORT_FAILED", responseXml: result.responseXml, tally });
        }
        results.push({ stage: stage.name, status: "success", tally });
        await prisma.travelTallySyncLog.create({
          data: { tenantId: req.travelTenant.id, sourceType: "DIRECT_EXPORT", sourceId: 0, voucherType: stage.name.toUpperCase(), status: "SYNCED", triggeredByUserId: req.user.userId, requestPayload: stage.xml, responsePayload: result.responseXml },
        });
      } catch (error) {
        const tally = error.tally || parseTallyResponse(error.responseXml);
        await prisma.travelTallySyncLog.create({
          data: { tenantId: req.travelTenant.id, sourceType: "DIRECT_EXPORT", sourceId: 0, voucherType: stage.name.toUpperCase(), status: "FAILED", triggeredByUserId: req.user.userId, requestPayload: stage.xml, responsePayload: error.responseXml || null },
        }).catch(() => {});
        await writeAudit("TravelTally", "DIRECT_PUSH_FAILED", 0, req.user.userId, req.travelTenant.id, { stage: stage.name, code: error.code || "TALLY_IMPORT_FAILED" }).catch(() => {});
        return res.status(error.code === "TALLY_CONNECTOR_TIMEOUT" ? 504 : 502).json({ error: error.message || "Tally import failed", code: error.code || "TALLY_IMPORT_FAILED", stage: stage.name, tally });
      }
    }
    await writeAudit("TravelTally", "DIRECT_PUSH_SUCCESS", 0, req.user.userId, req.travelTenant.id, { stages: results.map((result) => result.stage) }).catch(() => {});
    return res.json({ success: true, results });
  } finally {
    activePushes.delete(req.travelTenant.id);
  }
});

module.exports = router;
