const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// Supported trigger types
const TRIGGER_TYPES = [
  { value: "contact.created", label: "Contact Created", description: "Fires when a new contact is added" },
  { value: "contact.updated", label: "Contact Updated", description: "Fires when a contact is modified" },
  { value: "deal.created", label: "Deal Created", description: "Fires when a new deal is created" },
  { value: "deal.stage_changed", label: "Deal Stage Changed", description: "Fires when a deal moves pipeline stages" },
  { value: "deal.won", label: "Deal Won", description: "Fires when a deal is marked as won" },
  { value: "deal.lost", label: "Deal Lost", description: "Fires when a deal is marked as lost" },
  { value: "ticket.created", label: "Ticket Created", description: "Fires when a support ticket is opened" },
  { value: "ticket.updated", label: "Ticket Updated", description: "Fires when a ticket status changes" },
  { value: "invoice.created", label: "Invoice Created", description: "Fires when an invoice is generated" },
  { value: "invoice.overdue", label: "Invoice Overdue", description: "Fires when an invoice passes its due date" },
  { value: "task.completed", label: "Task Completed", description: "Fires when a task is marked complete" },
  { value: "lead.converted", label: "Lead Converted", description: "Fires when a lead becomes a customer" },
];

// Supported action types
const ACTION_TYPES = [
  { value: "send_email", label: "Send Email", config: ["to", "subject", "body"] },
  { value: "send_sms", label: "Send SMS", config: ["to", "message"] },
  { value: "send_notification", label: "Send Notification", config: ["userId", "title", "message"] },
  { value: "create_task", label: "Create Task", config: ["title", "dueInDays", "assignToId"] },
  { value: "update_field", label: "Update Field", config: ["entity", "entityId", "field", "value"] },
  { value: "assign_agent", label: "Assign Agent", config: ["userId"] },
  { value: "send_webhook", label: "Send Webhook", config: ["url"] },
];

// GET /triggers — list supported trigger types
router.get("/triggers", (req, res) => {
  res.json(TRIGGER_TYPES);
});

// GET /actions — list supported action types
router.get("/actions", (req, res) => {
  res.json(ACTION_TYPES);
});

// GET /history — recent workflow execution logs
router.get("/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        entity: "AutomationRule",
        action: "WORKFLOW",
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    const total = await prisma.auditLog.count({
      where: {
        tenantId: req.user.tenantId,
        entity: "AutomationRule",
        action: "WORKFLOW",
      },
    });

    res.json({ logs, total, limit, offset });
  } catch (error) {
    console.error("[Workflows] History error:", error.message);
    res.status(500).json({ error: "Failed to fetch workflow history" });
  }
});

// GET / — list all automation rules for tenant
router.get("/", async (req, res) => {
  try {
    const rules = await prisma.automationRule.findMany({
      where: { tenantId: req.user.tenantId },
    });
    res.json(rules);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch workflows" });
  }
});

// POST / — create a new automation rule
router.post("/", async (req, res) => {
  try {
    const { name, triggerType, actionType, targetState } = req.body;

    if (!name || !triggerType || !actionType) {
      return res.status(400).json({ error: "name, triggerType, and actionType are required" });
    }

    const newRule = await prisma.automationRule.create({
      data: {
        name,
        triggerType,
        actionType,
        targetState: typeof targetState === "object" ? JSON.stringify(targetState) : targetState || "{}",
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(newRule);
  } catch (error) {
    console.error("[Workflows] Create error:", error.message);
    res.status(500).json({ error: "Failed to save workflow" });
  }
});

// PUT /:id — update an existing rule
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const { name, triggerType, actionType, targetState } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (triggerType !== undefined) data.triggerType = triggerType;
    if (actionType !== undefined) data.actionType = actionType;
    if (targetState !== undefined) {
      data.targetState = typeof targetState === "object" ? JSON.stringify(targetState) : targetState;
    }

    const updated = await prisma.automationRule.update({
      where: { id: existing.id },
      data,
    });
    res.json(updated);
  } catch (error) {
    console.error("[Workflows] Update error:", error.message);
    res.status(500).json({ error: "Failed to update workflow" });
  }
});

// DELETE /:id — delete an automation rule
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    await prisma.automationRule.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete workflow" });
  }
});

// PUT /:id/toggle — toggle isActive
router.put("/:id/toggle", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const rule = await prisma.automationRule.update({
      where: { id: existing.id },
      data: { isActive: !existing.isActive },
    });
    res.json(rule);
  } catch (error) {
    res.status(500).json({ error: "Failed to toggle workflow" });
  }
});

// POST /:id/test — manually fire a rule with a mock payload
router.post("/:id/test", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.automationRule.findFirst({
      where: { id: parseInt(id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Workflow not found" });

    const { emitEvent } = require("../lib/eventBus");

    // Build mock payload from request body or generate defaults
    const mockPayload = req.body.payload || {
      userId: req.user.id,
      tenantId: req.user.tenantId,
      contactId: req.body.contactId || null,
      dealId: req.body.dealId || null,
      email: req.body.email || req.user.email,
      _test: true,
    };

    await emitEvent(existing.triggerType, mockPayload, req.user.tenantId, req.app.get("io"));

    res.json({ success: true, message: `Test fired for rule "${existing.name}" (trigger: ${existing.triggerType})` });
  } catch (error) {
    console.error("[Workflows] Test error:", error.message);
    res.status(500).json({ error: "Failed to test workflow" });
  }
});

module.exports = router;
