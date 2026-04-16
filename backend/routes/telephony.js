const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { initiateCall, lookupContact, normalizePhone } = require("../services/telephonyProvider");

// POST /click-to-call — Initiate outbound call
router.post("/click-to-call", verifyToken, async (req, res) => {
  try {
    const { to, contactId } = req.body;
    if (!to) return res.status(400).json({ error: "Destination number (to) is required" });

    // Get active telephony config for this tenant
    const config = await prisma.telephonyConfig.findFirst({ where: { isActive: true, tenantId: req.user.tenantId } });
    if (!config) return res.status(400).json({ error: "No active telephony provider configured" });

    // Lookup contact if not provided
    let resolvedContactId = contactId || null;
    if (!resolvedContactId) {
      const contact = await lookupContact(to, prisma);
      if (contact && contact.tenantId === req.user.tenantId) resolvedContactId = contact.id;
    }

    const result = await initiateCall({
      from: config.agentNumber || config.virtualNumber,
      to,
      provider: config.provider,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      virtualNumber: config.virtualNumber,
    });

    // Create call log
    const callLog = await prisma.callLog.create({
      data: {
        direction: "OUTBOUND",
        callerNumber: config.virtualNumber,
        calleeNumber: normalizePhone(to),
        provider: config.provider,
        providerCallId: result.callId || null,
        status: result.success ? "INITIATED" : "FAILED",
        notes: result.success ? null : result.error,
        contactId: resolvedContactId,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });

    if (!result.success) {
      return res.status(502).json({ error: result.error, callLogId: callLog.id });
    }

    res.json({ success: true, callId: result.callId, callLogId: callLog.id });
  } catch (err) {
    console.error("Click-to-call error:", err);
    res.status(500).json({ error: "Failed to initiate call" });
  }
});

// POST /webhook/myoperator — MyOperator CDR webhook (no auth)
// Tenant is inferred from the existing call log or contact, defaulting to 1.
router.post("/webhook/myoperator", async (req, res) => {
  try {
    const data = req.body;
    const caller = data.caller_number || data.caller || data.from;
    const callee = data.callee_number || data.callee || data.to;
    const duration = parseInt(data.duration || data.call_duration || 0, 10);
    const recordingUrl = data.recording_url || data.recording || null;
    const status = data.status || data.call_status || "COMPLETED";
    const providerCallId = data.call_id || data.id || null;
    const direction = data.direction === "inbound" || data.type === "incoming" ? "INBOUND" : "OUTBOUND";

    let callLog = null;
    if (providerCallId) {
      callLog = await prisma.callLog.findFirst({ where: { providerCallId } });
    }

    const contactPhone = direction === "INBOUND" ? caller : callee;
    const contact = contactPhone ? await lookupContact(contactPhone, prisma) : null;
    const tenantId = callLog?.tenantId || contact?.tenantId || 1;

    if (callLog) {
      callLog = await prisma.callLog.update({
        where: { id: callLog.id },
        data: {
          duration,
          recordingUrl,
          status: status.toUpperCase(),
          callerNumber: caller ? normalizePhone(caller) : callLog.callerNumber,
          calleeNumber: callee ? normalizePhone(callee) : callLog.calleeNumber,
          contactId: contact ? contact.id : callLog.contactId,
        },
      });
    } else {
      callLog = await prisma.callLog.create({
        data: {
          direction,
          callerNumber: caller ? normalizePhone(caller) : null,
          calleeNumber: callee ? normalizePhone(callee) : null,
          duration,
          recordingUrl,
          status: status.toUpperCase(),
          provider: "myoperator",
          providerCallId,
          contactId: contact ? contact.id : null,
          tenantId,
        },
      });
    }

    if (req.io) {
      if (direction === "INBOUND" && (status === "ringing" || status === "incoming")) {
        req.io.emit("incoming_call", { callLog, contact });
      } else {
        req.io.emit("call_status_update", { callLog });
      }
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("MyOperator webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// POST /webhook/knowlarity — Knowlarity CDR webhook (no auth)
router.post("/webhook/knowlarity", async (req, res) => {
  try {
    const data = req.body;
    const caller = data.caller_id || data.from || data.agent_number;
    const callee = data.destination || data.to || data.customer_number;
    const duration = parseInt(data.call_duration || data.duration || 0, 10);
    const recordingUrl = data.recording_url || data.rec_url || null;
    const status = data.call_status || data.status || "COMPLETED";
    const providerCallId = data.call_id || data.uuid || null;
    const direction = data.call_type === "incoming" || data.direction === "inbound" ? "INBOUND" : "OUTBOUND";

    let callLog = null;
    if (providerCallId) {
      callLog = await prisma.callLog.findFirst({ where: { providerCallId } });
    }

    const contactPhone = direction === "INBOUND" ? caller : callee;
    const contact = contactPhone ? await lookupContact(contactPhone, prisma) : null;
    const tenantId = callLog?.tenantId || contact?.tenantId || 1;

    if (callLog) {
      callLog = await prisma.callLog.update({
        where: { id: callLog.id },
        data: {
          duration,
          recordingUrl,
          status: status.toUpperCase(),
          callerNumber: caller ? normalizePhone(caller) : callLog.callerNumber,
          calleeNumber: callee ? normalizePhone(callee) : callLog.calleeNumber,
          contactId: contact ? contact.id : callLog.contactId,
        },
      });
    } else {
      callLog = await prisma.callLog.create({
        data: {
          direction,
          callerNumber: caller ? normalizePhone(caller) : null,
          calleeNumber: callee ? normalizePhone(callee) : null,
          duration,
          recordingUrl,
          status: status.toUpperCase(),
          provider: "knowlarity",
          providerCallId,
          contactId: contact ? contact.id : null,
          tenantId,
        },
      });
    }

    if (req.io) {
      if (direction === "INBOUND" && (status === "ringing" || status === "incoming")) {
        req.io.emit("incoming_call", { callLog, contact });
      } else {
        req.io.emit("call_status_update", { callLog });
      }
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Knowlarity webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// GET /config — Get telephony configs (ADMIN only)
router.get("/config", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const configs = await prisma.telephonyConfig.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });
    // Mask secrets in response
    const masked = configs.map((c) => ({
      ...c,
      apiKey: c.apiKey ? `${c.apiKey.slice(0, 4)}****` : null,
      apiSecret: c.apiSecret ? "****" : null,
    }));
    res.json(masked);
  } catch (err) {
    console.error("Get telephony config error:", err);
    res.status(500).json({ error: "Failed to fetch configs" });
  }
});

// PUT /config/:provider — Upsert telephony config (ADMIN only)
router.put("/config/:provider", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider } = req.params;
    const { apiKey, apiSecret, virtualNumber, agentNumber, isActive, settings } = req.body;

    if (!["myoperator", "knowlarity"].includes(provider.toLowerCase())) {
      return res.status(400).json({ error: "Provider must be myoperator or knowlarity" });
    }

    const config = await prisma.telephonyConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider: provider.toLowerCase() } },
      update: {
        ...(apiKey !== undefined && { apiKey }),
        ...(apiSecret !== undefined && { apiSecret }),
        ...(virtualNumber !== undefined && { virtualNumber }),
        ...(agentNumber !== undefined && { agentNumber }),
        ...(isActive !== undefined && { isActive }),
        ...(settings !== undefined && { settings: typeof settings === "string" ? settings : JSON.stringify(settings) }),
      },
      create: {
        provider: provider.toLowerCase(),
        apiKey: apiKey || "",
        apiSecret: apiSecret || "",
        virtualNumber: virtualNumber || "",
        agentNumber: agentNumber || "",
        isActive: isActive !== undefined ? isActive : true,
        settings: settings ? (typeof settings === "string" ? settings : JSON.stringify(settings)) : null,
        tenantId: req.user.tenantId,
      },
    });

    res.json(config);
  } catch (err) {
    console.error("Upsert telephony config error:", err);
    res.status(500).json({ error: "Failed to save config" });
  }
});

// GET /recordings/:callLogId
router.get("/recordings/:callLogId", verifyToken, async (req, res) => {
  try {
    const callLog = await prisma.callLog.findFirst({
      where: { id: parseInt(req.params.callLogId, 10), tenantId: req.user.tenantId },
    });

    if (!callLog) return res.status(404).json({ error: "Call log not found" });
    if (!callLog.recordingUrl) return res.status(404).json({ error: "No recording available" });

    res.json({ recordingUrl: callLog.recordingUrl });
  } catch (err) {
    console.error("Get recording error:", err);
    res.status(500).json({ error: "Failed to fetch recording" });
  }
});

module.exports = router;
