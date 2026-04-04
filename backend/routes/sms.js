const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { normalizePhone, substituteVars, sendSms } = require("../services/smsProvider");

// ─── Send SMS ────────────────────────────────────────────────────────────────
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { to, body, contactId, templateId } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: "to and body are required" });
    }

    // Get active provider config
    const config = await prisma.smsConfig.findFirst({ where: { isActive: true } });
    if (!config) {
      return res.status(400).json({ error: "No active SMS provider configured" });
    }

    // If template specified, substitute variables
    let messageBody = body;
    if (templateId && contactId) {
      const template = await prisma.smsTemplate.findUnique({ where: { id: templateId } });
      const contact = await prisma.contact.findUnique({ where: { id: contactId } });
      if (template && contact) {
        messageBody = substituteVars(template.body, contact);
      }
    }

    const normalizedTo = normalizePhone(to);

    // Create message record
    const message = await prisma.smsMessage.create({
      data: {
        to: normalizedTo,
        from: config.senderId || "",
        body: messageBody,
        direction: "OUTBOUND",
        status: "QUEUED",
        provider: config.provider,
        dltTemplateId: templateId ? (await prisma.smsTemplate.findUnique({ where: { id: templateId } }))?.dltTemplateId : null,
        contactId: contactId || null,
        userId: req.user.id,
      },
    });

    // Send via provider
    const result = await sendSms({
      to: normalizedTo,
      body: messageBody,
      provider: config.provider,
      apiKey: config.apiKey,
      senderId: config.senderId,
      authToken: config.authToken,
    });

    // Update message status
    await prisma.smsMessage.update({
      where: { id: message.id },
      data: {
        status: result.success ? "SENT" : "FAILED",
        providerMsgId: result.providerMsgId || null,
        errorMessage: result.error || null,
      },
    });

    // Emit socket event
    if (req.io) {
      req.io.emit("sms:sent", { messageId: message.id, to: normalizedTo, status: result.success ? "SENT" : "FAILED" });
    }

    if (result.success) {
      res.json({ success: true, messageId: message.id, providerMsgId: result.providerMsgId });
    } else {
      res.status(500).json({ success: false, messageId: message.id, error: result.error });
    }
  } catch (err) {
    console.error("SMS send error:", err);
    res.status(500).json({ error: "Failed to send SMS" });
  }
});

// ─── List SMS Messages ───────────────────────────────────────────────────────
router.get("/messages", verifyToken, async (req, res) => {
  try {
    const { direction, contactId, status, page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};
    if (direction) where.direction = direction;
    if (contactId) where.contactId = parseInt(contactId);
    if (status) where.status = status;

    const [messages, total] = await Promise.all([
      prisma.smsMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { contact: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.smsMessage.count({ where }),
    ]);

    res.json({
      messages,
      pagination: {
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error("SMS list error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ─── List SMS Templates ─────────────────────────────────────────────────────
router.get("/templates", verifyToken, async (req, res) => {
  try {
    const templates = await prisma.smsTemplate.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(templates);
  } catch (err) {
    console.error("SMS templates list error:", err);
    res.status(500).json({ error: "Failed to fetch templates" });
  }
});

// ─── Create SMS Template ─────────────────────────────────────────────────────
router.post("/templates", verifyToken, async (req, res) => {
  try {
    const { name, body, category, dltTemplateId } = req.body;

    if (!name || !body) {
      return res.status(400).json({ error: "name and body are required" });
    }

    const template = await prisma.smsTemplate.create({
      data: {
        name,
        body,
        category: category || "TRANSACTIONAL",
        dltTemplateId: dltTemplateId || null,
      },
    });

    res.status(201).json(template);
  } catch (err) {
    console.error("SMS template create error:", err);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// ─── Update SMS Template ─────────────────────────────────────────────────────
router.put("/templates/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, body, category, dltTemplateId } = req.body;

    const template = await prisma.smsTemplate.update({
      where: { id: parseInt(id) },
      data: {
        ...(name !== undefined && { name }),
        ...(body !== undefined && { body }),
        ...(category !== undefined && { category }),
        ...(dltTemplateId !== undefined && { dltTemplateId }),
      },
    });

    res.json(template);
  } catch (err) {
    console.error("SMS template update error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    res.status(500).json({ error: "Failed to update template" });
  }
});

// ─── Delete SMS Template ─────────────────────────────────────────────────────
router.delete("/templates/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.smsTemplate.delete({ where: { id: parseInt(id) } });
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    console.error("SMS template delete error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ─── Get SMS Config (ADMIN only) ────────────────────────────────────────────
router.get("/config", verifyToken, verifyRole("ADMIN"), async (req, res) => {
  try {
    const configs = await prisma.smsConfig.findMany({
      orderBy: { createdAt: "desc" },
    });

    // Mask sensitive fields
    const masked = configs.map((c) => ({
      ...c,
      apiKey: c.apiKey ? c.apiKey.slice(0, 6) + "****" : null,
      authToken: c.authToken ? c.authToken.slice(0, 6) + "****" : null,
    }));

    res.json(masked);
  } catch (err) {
    console.error("SMS config get error:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ─── Upsert SMS Config (ADMIN only) ─────────────────────────────────────────
router.put("/config/:provider", verifyToken, verifyRole("ADMIN"), async (req, res) => {
  try {
    const { provider } = req.params;
    const { apiKey, authToken, senderId, dltEntityId, isActive, settings } = req.body;

    const config = await prisma.smsConfig.upsert({
      where: { provider },
      create: {
        provider,
        apiKey: apiKey || "",
        authToken: authToken || null,
        senderId: senderId || null,
        dltEntityId: dltEntityId || null,
        isActive: isActive !== undefined ? isActive : true,
        settings: settings || null,
      },
      update: {
        ...(apiKey !== undefined && { apiKey }),
        ...(authToken !== undefined && { authToken }),
        ...(senderId !== undefined && { senderId }),
        ...(dltEntityId !== undefined && { dltEntityId }),
        ...(isActive !== undefined && { isActive }),
        ...(settings !== undefined && { settings }),
      },
    });

    // If marking active, deactivate others
    if (isActive) {
      await prisma.smsConfig.updateMany({
        where: { provider: { not: provider } },
        data: { isActive: false },
      });
    }

    res.json({ success: true, config: { ...config, apiKey: config.apiKey?.slice(0, 6) + "****", authToken: config.authToken ? config.authToken.slice(0, 6) + "****" : null } });
  } catch (err) {
    console.error("SMS config upsert error:", err);
    res.status(500).json({ error: "Failed to update config" });
  }
});

// ─── Webhook (NO AUTH) — Delivery status + inbound SMS ──────────────────────
router.post("/webhook/:provider", async (req, res) => {
  try {
    const { provider } = req.params;

    if (provider === "twilio") {
      // Twilio sends form-encoded data
      const { MessageSid, MessageStatus, From, To, Body, SmsStatus } = req.body;
      const status = MessageStatus || SmsStatus;

      if (Body && From) {
        // Inbound message
        const contact = await prisma.contact.findFirst({ where: { phone: { contains: From.replace("+", "") } } });

        await prisma.smsMessage.create({
          data: {
            to: To ? To.replace("+", "") : "",
            from: From.replace("+", ""),
            body: Body,
            direction: "INBOUND",
            status: "RECEIVED",
            provider: "twilio",
            providerMsgId: MessageSid || null,
            contactId: contact?.id || null,
          },
        });

        if (req.io) {
          req.io.emit("sms:received", { from: From, body: Body, contactId: contact?.id });
        }
      } else if (MessageSid && status) {
        // Status update
        const statusMap = {
          queued: "QUEUED",
          sent: "SENT",
          delivered: "DELIVERED",
          failed: "FAILED",
          undelivered: "FAILED",
        };

        await prisma.smsMessage.updateMany({
          where: { providerMsgId: MessageSid },
          data: { status: statusMap[status] || "SENT" },
        });
      }

      // Twilio expects 200 with TwiML or empty response
      res.status(200).type("text/xml").send("<Response></Response>");
    } else if (provider === "msg91") {
      // MSG91 sends JSON delivery reports
      const data = req.body;

      if (data && data.request_id) {
        const statusMap = {
          1: "DELIVERED",
          2: "FAILED",
          9: "SENT",
          17: "FAILED",
          26: "SENT",
        };

        await prisma.smsMessage.updateMany({
          where: { providerMsgId: data.request_id },
          data: { status: statusMap[data.report_status] || "SENT" },
        });
      }

      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Unknown provider" });
    }
  } catch (err) {
    console.error("SMS webhook error:", err);
    res.status(200).json({ received: true });
  }
});

module.exports = router;
