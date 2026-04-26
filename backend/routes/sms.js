const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { normalizePhone, substituteVars, sendSms, resolveProviderConfig } = require("../services/smsProvider");

// ─── Send SMS ────────────────────────────────────────────────────────────────
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { to, body, contactId, templateId } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: "to and body are required" });
    }

    // Get active provider config for this tenant
    const config = await prisma.smsConfig.findFirst({ where: { isActive: true, tenantId: req.user.tenantId } });
    if (!config) {
      return res.status(400).json({ error: "No active SMS provider configured" });
    }

    // If template specified, substitute variables
    let messageBody = body;
    let templateRecord = null;
    if (templateId) {
      templateRecord = await prisma.smsTemplate.findFirst({ where: { id: templateId, tenantId: req.user.tenantId } });
    }
    if (templateRecord && contactId) {
      const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: req.user.tenantId } });
      if (contact) messageBody = substituteVars(templateRecord.body, contact);
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
        dltTemplateId: templateRecord?.dltTemplateId || null,
        contactId: contactId || null,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
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
// #254: redact OTP / verification codes before returning SMS messages to
// staff. Without this, anyone with /inbox access could read other patients'
// portal-login codes within their 10-minute validity window — a horizontal
// account-takeover vector. We scrub the body and leave the rest of the row
// untouched so audit / "did this send?" use cases still work.
function redactOtp(body) {
  if (typeof body !== "string") return body;
  // Common templates: "Your verification code is 4346. Valid for 10 minutes."
  // Cover OTP / verification / passcode prefixes + numeric digit groups (4-8).
  return body.replace(
    /(verification code|otp|passcode|one[-\s]?time\s+code|login\s+code)\s*(?:is|:)?\s*[:#]?\s*\d{3,8}/gi,
    "$1 ****"
  );
}

router.get("/messages", verifyToken, async (req, res) => {
  try {
    const { direction, contactId, status, page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { tenantId: req.user.tenantId };
    if (direction) where.direction = direction;
    if (contactId) where.contactId = parseInt(contactId);
    if (status) where.status = status;

    const [rows, total] = await Promise.all([
      prisma.smsMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { contact: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.smsMessage.count({ where }),
    ]);
    // #254: scrub the digit groups in OTP-template bodies on the way out.
    const messages = rows.map((m) => ({ ...m, body: redactOtp(m.body) }));

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
      where: { tenantId: req.user.tenantId },
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
        tenantId: req.user.tenantId,
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

    const existing = await prisma.smsTemplate.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const template = await prisma.smsTemplate.update({
      where: { id: existing.id },
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
    const existing = await prisma.smsTemplate.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    await prisma.smsTemplate.delete({ where: { id: existing.id } });
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    console.error("SMS template delete error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ─── Get SMS Config (ADMIN only) ────────────────────────────────────────────
router.get("/config", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const configs = await prisma.smsConfig.findMany({
      where: { tenantId: req.user.tenantId },
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
router.put("/config/:provider", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider } = req.params;
    const { apiKey, authToken, senderId, dltEntityId, isActive, settings } = req.body;

    const config = await prisma.smsConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      create: {
        provider,
        apiKey: apiKey || "",
        authToken: authToken || null,
        senderId: senderId || null,
        dltEntityId: dltEntityId || null,
        isActive: isActive !== undefined ? isActive : true,
        settings: settings || null,
        tenantId: req.user.tenantId,
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

    // If marking active, deactivate others in this tenant
    if (isActive) {
      await prisma.smsConfig.updateMany({
        where: { provider: { not: provider }, tenantId: req.user.tenantId },
        data: { isActive: false },
      });
    }

    res.json({ success: true, config: { ...config, apiKey: config.apiKey?.slice(0, 6) + "****", authToken: config.authToken ? config.authToken.slice(0, 6) + "****" : null } });
  } catch (err) {
    console.error("SMS config upsert error:", err);
    res.status(500).json({ error: "Failed to update config" });
  }
});

// ─── Drain QUEUED messages (ADMIN only) ─────────────────────────────────────
// Issue #182: messages queued by cron engines (orchestrator, appointment
// reminders, NPS) sat in QUEUED forever when no provider was configured.
// This endpoint:
//   1. resolves an SMS provider (DB SmsConfig → env-var fallback)
//   2. if no provider → marks every QUEUED row FAILED with a clear reason
//   3. otherwise sends each via the provider, updating SENT/FAILED inline
// Returns { queued, sent, failed, errors[] } — admins can call it from the
// Inbox UI as the manual escape hatch the issue asked for.
router.post("/drain", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const queuedMsgs = await prisma.smsMessage.findMany({
      where: { tenantId, status: "QUEUED", direction: "OUTBOUND" },
      orderBy: { createdAt: "asc" },
    });

    if (queuedMsgs.length === 0) {
      return res.json({ queued: 0, sent: 0, failed: 0, errors: [] });
    }

    const cfg = await resolveProviderConfig(prisma, tenantId);

    // No provider configured: fail-fast every QUEUED row so they stop piling
    // up silently and the operator sees a clear errorMessage in the inbox.
    if (!cfg) {
      const reason = "No SMS provider configured for tenant";
      console.warn(`[sms/drain] tenant ${tenantId}: ${reason} — marking ${queuedMsgs.length} QUEUED messages FAILED`);
      await prisma.smsMessage.updateMany({
        where: { tenantId, status: "QUEUED", direction: "OUTBOUND" },
        data: { status: "FAILED", errorMessage: reason },
      });
      return res.json({
        queued: queuedMsgs.length,
        sent: 0,
        failed: queuedMsgs.length,
        errors: [reason],
      });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const m of queuedMsgs) {
      try {
        const result = await sendSms({
          to: m.to,
          body: m.body,
          provider: cfg.provider,
          apiKey: cfg.apiKey,
          senderId: cfg.senderId,
          authToken: cfg.authToken,
          dltTemplateId: m.dltTemplateId || undefined,
        });
        if (result.success) {
          await prisma.smsMessage.update({
            where: { id: m.id },
            data: {
              status: "SENT",
              provider: cfg.provider,
              providerMsgId: result.providerMsgId || null,
              errorMessage: null,
            },
          });
          sent++;
        } else {
          await prisma.smsMessage.update({
            where: { id: m.id },
            data: {
              status: "FAILED",
              provider: cfg.provider,
              errorMessage: result.error || "send failed",
            },
          });
          failed++;
          if (errors.length < 25) errors.push({ id: m.id, error: result.error || "send failed" });
        }
      } catch (e) {
        await prisma.smsMessage.update({
          where: { id: m.id },
          data: {
            status: "FAILED",
            provider: cfg.provider,
            errorMessage: e.message || "exception during send",
          },
        });
        failed++;
        if (errors.length < 25) errors.push({ id: m.id, error: e.message });
      }
    }

    res.json({
      queued: queuedMsgs.length,
      sent,
      failed,
      errors,
      providerSource: cfg.source,
      provider: cfg.provider,
    });
  } catch (err) {
    console.error("SMS drain error:", err);
    res.status(500).json({ error: "Failed to drain SMS queue", detail: err.message });
  }
});

// ─── Webhook (NO AUTH) — Delivery status + inbound SMS ──────────────────────
// Tenant inferred from existing message or matched contact, defaulting to 1.
router.post("/webhook/:provider", async (req, res) => {
  try {
    const { provider } = req.params;

    if (provider === "twilio") {
      const { MessageSid, MessageStatus, From, To, Body, SmsStatus } = req.body;
      const status = MessageStatus || SmsStatus;

      if (Body && From) {
        // Inbound message — match a contact globally; if multiple, pick first
        const contact = await prisma.contact.findFirst({ where: { phone: { contains: From.replace("+", "") } } });
        const tenantId = contact?.tenantId || 1;

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
            tenantId,
          },
        });

        if (req.io) {
          req.io.emit("sms:received", { from: From, body: Body, contactId: contact?.id });
        }
      } else if (MessageSid && status) {
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

      res.status(200).type("text/xml").send("<Response></Response>");
    } else if (provider === "msg91") {
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
