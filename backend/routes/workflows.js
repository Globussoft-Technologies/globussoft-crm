const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// GET all rules
router.get("/", async (req, res) => {
  try {
    const rules = await prisma.automationRule.findMany({ where: { tenantId: req.user.tenantId } });
    res.json(rules);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch workflows" });
  }
});

// POST new rule
router.post("/", async (req, res) => {
  try {
    const { name, triggerType, actionType, targetState } = req.body;
    const newRule = await prisma.automationRule.create({
      data: { name, triggerType, actionType, targetState, tenantId: req.user.tenantId }
    });
    res.status(201).json(newRule);
  } catch (error) {
    res.status(500).json({ error: "Failed to save workflow" });
  }
});

// DELETE rule
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });
    await prisma.automationRule.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete workflow" });
  }
});

// TOGGLE rule status
router.put("/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const existing = await prisma.automationRule.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });
    const rule = await prisma.automationRule.update({
      where: { id: existing.id },
      data: { isActive }
    });
    res.json(rule);
  } catch (error) {
    res.status(500).json({ error: "Failed to toggle workflow" });
  }
});

module.exports = router;
