const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken, verifyRole } = require("../middleware/auth");
const pushService = require("../services/pushService");

const router = express.Router();
const prisma = new PrismaClient();

// Subscribe CRM user for push notifications
router.post("/subscribe", verifyToken, async (req, res) => {
  try {
    const { endpoint, p256dh, auth } = req.body;
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: "Missing subscription fields" });

    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { p256dh, auth, isActive: true, userId: req.user.userId, type: "CRM_USER", tenantId: req.user.tenantId },
      create: { endpoint, p256dh, auth, type: "CRM_USER", userId: req.user.userId, tenantId: req.user.tenantId, userAgent: req.headers["user-agent"] || null },
    });
    res.json({ success: true, id: sub.id });
  } catch (err) {
    console.error("[Push] Subscribe error:", err);
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

// Subscribe website visitor (public, no auth) — defaults to Default Org tenant
router.post("/subscribe/visitor", async (req, res) => {
  try {
    const { endpoint, p256dh, auth, contactId } = req.body;
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: "Missing subscription fields" });

    let resolvedTenantId = 1;
    if (contactId) {
      const c = await prisma.contact.findUnique({ where: { id: parseInt(contactId) } });
      if (c) resolvedTenantId = c.tenantId || 1;
    }

    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { p256dh, auth, isActive: true },
      create: { endpoint, p256dh, auth, type: "WEBSITE_VISITOR", contactId: contactId ? parseInt(contactId) : null, tenantId: resolvedTenantId, userAgent: req.headers["user-agent"] || null },
    });
    res.json({ success: true, id: sub.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

// Unsubscribe (scoped to current tenant)
router.delete("/unsubscribe", verifyToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await prisma.pushSubscription.updateMany({ where: { endpoint, tenantId: req.user.tenantId }, data: { isActive: false } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
});

// Send push to specific users (ADMIN/MANAGER)
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { userIds, title, body, url, icon } = req.body;
    if (!title || !body) return res.status(400).json({ error: "Title and body required" });

    const notification = await prisma.pushNotification.create({
      data: { title, body, url, icon, type: "INTERNAL", tenantId: req.user.tenantId },
    });

    let sent = 0, failed = 0;
    const targets = Array.isArray(userIds) ? userIds : [];
    for (const uid of targets) {
      // Restrict push targets to users in same tenant
      const user = await prisma.user.findFirst({ where: { id: parseInt(uid), tenantId: req.user.tenantId } });
      if (!user) continue;
      const result = await pushService.sendToUser(user.id, { title, body, url, icon }, prisma);
      sent += result.sent;
      failed += result.failed;
    }

    await prisma.pushNotification.update({
      where: { id: notification.id },
      data: { sentCount: sent, failedCount: failed, status: "SENT" },
    });

    res.json({ success: true, sent, failed });
  } catch (err) {
    console.error("[Push] Send error:", err);
    res.status(500).json({ error: "Failed to send push" });
  }
});

// Send marketing push to all visitor subscriptions in this tenant
router.post("/send-campaign", verifyToken, async (req, res) => {
  try {
    const { title, body, url, icon } = req.body;
    if (!title || !body) return res.status(400).json({ error: "Title and body required" });

    const notification = await prisma.pushNotification.create({
      data: { title, body, url, icon, type: "MARKETING", tenantId: req.user.tenantId },
    });

    const subs = await prisma.pushSubscription.findMany({ where: { type: "WEBSITE_VISITOR", isActive: true, tenantId: req.user.tenantId } });
    let sent = 0, failed = 0;
    for (const sub of subs) {
      const result = await pushService.sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, { title, body, url, icon });
      if (result.success) sent++; else failed++;
    }

    await prisma.pushNotification.update({
      where: { id: notification.id },
      data: { sentCount: sent, failedCount: failed, status: "SENT" },
    });

    res.json({ success: true, sent, failed });
  } catch (err) {
    res.status(500).json({ error: "Failed to send campaign" });
  }
});

// Templates CRUD
router.get("/templates", verifyToken, async (req, res) => {
  try {
    res.json(await prisma.pushTemplate.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: "desc" } }));
  } catch (err) { res.status(500).json({ error: "Failed to fetch templates" }); }
});

router.post("/templates", verifyToken, async (req, res) => {
  try {
    const { name, title, body, icon, url, category } = req.body;
    res.status(201).json(await prisma.pushTemplate.create({ data: { name, title, body, icon, url, category, tenantId: req.user.tenantId } }));
  } catch (err) { res.status(500).json({ error: "Failed to create template" }); }
});

router.put("/templates/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.pushTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    res.json(await prisma.pushTemplate.update({ where: { id: existing.id }, data: req.body }));
  } catch (err) { res.status(500).json({ error: "Failed to update template" }); }
});

router.delete("/templates/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.pushTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    await prisma.pushTemplate.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to delete template" }); }
});

// Get VAPID public key (public)
router.get("/vapid-key", (req, res) => {
  const keys = pushService.getVapidKeys();
  res.json({ publicKey: keys.publicKey || null });
});

// Stats — scoped to tenant
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const [notifications, subscribers] = await Promise.all([
      prisma.pushNotification.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.pushSubscription.count({ where: { isActive: true, tenantId: req.user.tenantId } }),
    ]);
    res.json({ notifications, subscribers });
  } catch (err) { res.status(500).json({ error: "Failed to fetch stats" }); }
});

module.exports = router;
