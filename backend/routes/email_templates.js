const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// List all email templates
router.get("/", async (req, res) => {
  try {
    const templates = await prisma.emailTemplate.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { updatedAt: "desc" },
    });
    res.json(templates);
  } catch (err) {
    console.error("[EmailTemplates] List error:", err);
    res.status(500).json({ error: "Failed to fetch email templates" });
  }
});

// Get single template
router.get("/:id", async (req, res) => {
  try {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json(template);
  } catch (err) {
    console.error("[EmailTemplates] Get error:", err);
    res.status(500).json({ error: "Failed to fetch email template" });
  }
});

// Create template
router.post("/", async (req, res) => {
  try {
    const { name, subject, body, category } = req.body;
    if (!name || !subject || !body) {
      return res.status(400).json({ error: "name, subject, and body are required" });
    }
    const template = await prisma.emailTemplate.create({
      data: { name, subject, body, category: category || "General", tenantId: req.user.tenantId },
    });
    res.status(201).json(template);
  } catch (err) {
    console.error("[EmailTemplates] Create error:", err);
    res.status(500).json({ error: "Failed to create email template" });
  }
});

// Update template
router.put("/:id", async (req, res) => {
  try {
    const { name, subject, body, category } = req.body;
    const existing = await prisma.emailTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    const template = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(subject !== undefined && { subject }),
        ...(body !== undefined && { body }),
        ...(category !== undefined && { category }),
      },
    });
    res.json(template);
  } catch (err) {
    console.error("[EmailTemplates] Update error:", err);
    res.status(500).json({ error: "Failed to update email template" });
  }
});

// Delete template
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.emailTemplate.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    await prisma.emailTemplate.delete({
      where: { id: existing.id },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[EmailTemplates] Delete error:", err);
    res.status(500).json({ error: "Failed to delete email template" });
  }
});

module.exports = router;
