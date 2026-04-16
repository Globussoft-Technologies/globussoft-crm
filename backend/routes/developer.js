const express = require("express");
const crypto = require("crypto");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

// Generate a new secure API Key for the user
router.post("/apikeys", verifyToken, async (req, res) => {
  try {
    const rawKey = `glbs_${crypto.randomBytes(24).toString('hex')}`;

    // In production, we would hash the key secret before storing it.
    // However, for this dashboard demo context, we'll store it raw.
    const key = await prisma.apiKey.create({
      data: {
        name: req.body.name || "Default Ext-Integration Key",
        keySecret: rawKey,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      }
    });

    res.status(201).json({ key, rawKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to cryptographically construct API Key." });
  }
});

// Fetch user's active API keys
router.get("/apikeys", verifyToken, async (req, res) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(keys);
  } catch(err) {
    res.status(500).json({ error: "Failed to locate key registers." });
  }
});

// Revoke API Key
router.delete("/apikeys/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.apiKey.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "API key not found" });
    await prisma.apiKey.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: "Failed to revoke key." });
  }
});

// Register Webhook Trigger
router.post("/webhooks", verifyToken, async (req, res) => {
  try {
    const webhook = await prisma.webhook.create({
      data: {
        event: req.body.event,
        targetUrl: req.body.targetUrl,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      }
    });
    res.status(201).json(webhook);
  } catch (err) {
    res.status(500).json({ error: "Failed to register webhook trigger link." });
  }
});

// Fetch user's registered webhooks
router.get("/webhooks", verifyToken, async (req, res) => {
  try {
    const hooks = await prisma.webhook.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(hooks);
  } catch(err) {
    res.status(500).json({ error: "Failed to retrieve webhook nodes." });
  }
});

// Delete Webhook Trigger
router.delete("/webhooks/:id", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.webhook.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Webhook not found" });
    await prisma.webhook.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: "Failed to deregister webhook target." });
  }
});

module.exports = router;
