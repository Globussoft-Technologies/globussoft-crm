const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { verifyToken, verifyRole } = require("../middleware/auth");
const { sendTemplate, sendText, verifyWebhook } = require("../services/whatsappProvider");

// ─── Send WhatsApp Message ──────────────────────────────────────────────────
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { to, body, templateName, parameters, contactId } = req.body;

    if (!to) {
      return res.status(400).json({ error: "to is required" });
    }
    if (!body && !templateName) {
      return res.status(400).json({ error: "body or templateName is required" });
    }

    // Get active config
    const config = await prisma.whatsAppConfig.findFirst({ where: { isActive: true } });
    if (!config) {
      return res.status(400).json({ error: "No active WhatsApp provider configured" });
    }

    // Create message record
    const message = await prisma.whatsAppMessage.create({
      data: {
        to,
        from: config.phoneNumberId || "",
        body: body || null,
        direction: "OUTBOUND",
        status: "QUEUED",
        templateName: templateName || null,
        contactId: contactId || null,
        userId: req.user.id,
      },
    });

    let result;

    if (templateName) {
      // Look up template for language
      const tpl = await prisma.whatsAppTemplate.findUnique({ where: { name: templateName } });
      result = await sendTemplate({
        to,
        templateName,
        language: tpl?.language || "en_US",
        parameters: parameters || [],
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
      });
    } else {
      result = await sendText({
        to,
        body,
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
      });
    }

    // Update message status
    await prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        status: result.success ? "SENT" : "FAILED",
        providerMsgId: result.providerMsgId || null,
        errorMessage: result.error || null,
      },
    });

    if (req.io) {
      req.io.emit("whatsapp:sent", { messageId: message.id, to, status: result.success ? "SENT" : "FAILED" });
    }

    if (result.success) {
      res.json({ success: true, messageId: message.id, providerMsgId: result.providerMsgId });
    } else {
      res.status(500).json({ success: false, messageId: message.id, error: result.error });
    }
  } catch (err) {
    console.error("WhatsApp send error:", err);
    res.status(500).json({ error: "Failed to send WhatsApp message" });
  }
});

// ─── List WhatsApp Messages ─────────────────────────────────────────────────
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
      prisma.whatsAppMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { contact: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.whatsAppMessage.count({ where }),
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
    console.error("WhatsApp list error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ─── List WhatsApp Templates ────────────────────────────────────────────────
router.get("/templates", verifyToken, async (req, res) => {
  try {
    const templates = await prisma.whatsAppTemplate.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(templates);
  } catch (err) {
    console.error("WhatsApp templates list error:", err);
    res.status(500).json({ error: "Failed to fetch templates" });
  }
});

// ─── Create WhatsApp Template ───────────────────────────────────────────────
router.post("/templates", verifyToken, async (req, res) => {
  try {
    const { name, language, category, body, headerType, headerContent, footer, buttons } = req.body;

    if (!name || !body) {
      return res.status(400).json({ error: "name and body are required" });
    }

    const template = await prisma.whatsAppTemplate.create({
      data: {
        name,
        language: language || "en_US",
        category: category || "MARKETING",
        body,
        headerType: headerType || null,
        headerContent: headerContent || null,
        footer: footer || null,
        buttons: buttons ? JSON.stringify(buttons) : null,
        status: "PENDING",
      },
    });

    res.status(201).json(template);
  } catch (err) {
    console.error("WhatsApp template create error:", err);
    if (err.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    res.status(500).json({ error: "Failed to create template" });
  }
});

// ─── Update WhatsApp Template ───────────────────────────────────────────────
router.put("/templates/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, language, category, body, headerType, headerContent, footer, buttons } = req.body;

    const template = await prisma.whatsAppTemplate.update({
      where: { id: parseInt(id) },
      data: {
        ...(name !== undefined && { name }),
        ...(language !== undefined && { language }),
        ...(category !== undefined && { category }),
        ...(body !== undefined && { body }),
        ...(headerType !== undefined && { headerType }),
        ...(headerContent !== undefined && { headerContent }),
        ...(footer !== undefined && { footer }),
        ...(buttons !== undefined && { buttons: buttons ? JSON.stringify(buttons) : null }),
      },
    });

    res.json(template);
  } catch (err) {
    console.error("WhatsApp template update error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    if (err.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    res.status(500).json({ error: "Failed to update template" });
  }
});

// ─── Delete WhatsApp Template ───────────────────────────────────────────────
router.delete("/templates/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.whatsAppTemplate.delete({ where: { id: parseInt(id) } });
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    console.error("WhatsApp template delete error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ─── Sync Template Status from Meta ─────────────────────────────────────────
router.post("/templates/:id/sync", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const template = await prisma.whatsAppTemplate.findUnique({ where: { id: parseInt(id) } });
    if (!template) return res.status(404).json({ error: "Template not found" });

    const config = await prisma.whatsAppConfig.findFirst({ where: { isActive: true } });
    if (!config) return res.status(400).json({ error: "No active WhatsApp config" });

    // Fetch template status from Meta
    const https = require("https");
    const result = await new Promise((resolve) => {
      const options = {
        hostname: "graph.facebook.com",
        path: `/v18.0/${config.businessAccountId}/message_templates?name=${encodeURIComponent(template.name)}`,
        method: "GET",
        headers: { Authorization: `Bearer ${config.accessToken}` },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ error: { message: data } });
          }
        });
      });
      req.on("error", (err) => resolve({ error: { message: err.message } }));
      req.end();
    });

    if (result.data && result.data.length > 0) {
      const metaTemplate = result.data[0];
      const statusMap = { APPROVED: "APPROVED", REJECTED: "REJECTED", PENDING: "PENDING" };

      const updated = await prisma.whatsAppTemplate.update({
        where: { id: parseInt(id) },
        data: {
          status: statusMap[metaTemplate.status] || "PENDING",
          metaTemplateId: metaTemplate.id || null,
        },
      });

      res.json({ success: true, template: updated });
    } else {
      res.json({ success: false, message: "Template not found on Meta", error: result.error?.message });
    }
  } catch (err) {
    console.error("WhatsApp template sync error:", err);
    res.status(500).json({ error: "Failed to sync template" });
  }
});

// ─── Get WhatsApp Config (ADMIN only) ───────────────────────────────────────
router.get("/config", verifyToken, verifyRole("ADMIN"), async (req, res) => {
  try {
    const configs = await prisma.whatsAppConfig.findMany({
      orderBy: { createdAt: "desc" },
    });

    // Mask sensitive fields
    const masked = configs.map((c) => ({
      ...c,
      accessToken: c.accessToken ? c.accessToken.slice(0, 10) + "****" : null,
    }));

    res.json(masked);
  } catch (err) {
    console.error("WhatsApp config get error:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ─── Upsert WhatsApp Config (ADMIN only) ────────────────────────────────────
router.put("/config/:provider", verifyToken, verifyRole("ADMIN"), async (req, res) => {
  try {
    const { provider } = req.params;
    const { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken, isActive, settings } = req.body;

    const config = await prisma.whatsAppConfig.upsert({
      where: { provider },
      create: {
        provider,
        phoneNumberId: phoneNumberId || "",
        businessAccountId: businessAccountId || null,
        accessToken: accessToken || "",
        webhookVerifyToken: webhookVerifyToken || null,
        isActive: isActive !== undefined ? isActive : true,
        settings: settings || null,
      },
      update: {
        ...(phoneNumberId !== undefined && { phoneNumberId }),
        ...(businessAccountId !== undefined && { businessAccountId }),
        ...(accessToken !== undefined && { accessToken }),
        ...(webhookVerifyToken !== undefined && { webhookVerifyToken }),
        ...(isActive !== undefined && { isActive }),
        ...(settings !== undefined && { settings }),
      },
    });

    // If marking active, deactivate others
    if (isActive) {
      await prisma.whatsAppConfig.updateMany({
        where: { provider: { not: provider } },
        data: { isActive: false },
      });
    }

    res.json({
      success: true,
      config: {
        ...config,
        accessToken: config.accessToken ? config.accessToken.slice(0, 10) + "****" : null,
      },
    });
  } catch (err) {
    console.error("WhatsApp config upsert error:", err);
    res.status(500).json({ error: "Failed to update config" });
  }
});

// ─── Meta Webhook Verification (GET, NO AUTH) ───────────────────────────────
router.get("/webhook", async (req, res) => {
  try {
    // Get verify token from config
    const config = await prisma.whatsAppConfig.findFirst({ where: { isActive: true } });
    const token = config?.webhookVerifyToken || process.env.WHATSAPP_VERIFY_TOKEN || "";

    const result = verifyWebhook(req, token);
    if (result.verified) {
      res.status(200).send(result.challenge);
    } else {
      res.status(403).json({ error: "Verification failed" });
    }
  } catch (err) {
    console.error("WhatsApp webhook verify error:", err);
    res.status(500).json({ error: "Webhook verification failed" });
  }
});

// ─── Meta Webhook (POST, NO AUTH) — Inbound messages + status updates ───────
router.post("/webhook", async (req, res) => {
  try {
    const { object, entry } = req.body;

    // Always respond 200 to Meta quickly
    res.status(200).json({ received: true });

    if (object !== "whatsapp_business_account" || !entry) return;

    for (const entryItem of entry) {
      const changes = entryItem.changes || [];

      for (const change of changes) {
        if (change.field !== "messages") continue;

        const value = change.value || {};
        const messages = value.messages || [];
        const statuses = value.statuses || [];
        const metadata = value.metadata || {};

        // Process inbound messages
        for (const msg of messages) {
          const from = msg.from;
          const body = msg.text?.body || msg.caption || "";
          const mediaUrl = msg.image?.id || msg.video?.id || msg.document?.id || null;
          const mediaType = msg.type !== "text" ? msg.type : null;

          // Find contact by phone
          const contact = await prisma.contact.findFirst({
            where: { phone: { contains: from.slice(-10) } },
          });

          await prisma.whatsAppMessage.create({
            data: {
              to: metadata.display_phone_number || metadata.phone_number_id || "",
              from,
              body,
              mediaUrl: mediaUrl || null,
              mediaType: mediaType || null,
              direction: "INBOUND",
              status: "RECEIVED",
              providerMsgId: msg.id || null,
              contactId: contact?.id || null,
            },
          });

          if (req.io) {
            req.io.emit("whatsapp:received", {
              from,
              body,
              mediaType,
              contactId: contact?.id,
              timestamp: msg.timestamp,
            });
          }
        }

        // Process status updates
        for (const status of statuses) {
          const statusMap = {
            sent: "SENT",
            delivered: "DELIVERED",
            read: "READ",
            failed: "FAILED",
          };

          const newStatus = statusMap[status.status];
          if (newStatus && status.id) {
            await prisma.whatsAppMessage.updateMany({
              where: { providerMsgId: status.id },
              data: {
                status: newStatus,
                ...(newStatus === "READ" && { read: true }),
                ...(newStatus === "FAILED" && { errorMessage: status.errors?.[0]?.title || "Delivery failed" }),
              },
            });

            if (req.io) {
              req.io.emit("whatsapp:status", {
                providerMsgId: status.id,
                status: newStatus,
                recipientId: status.recipient_id,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    // Already sent 200
  }
});

module.exports = router;
