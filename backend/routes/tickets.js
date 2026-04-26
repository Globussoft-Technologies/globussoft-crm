const express = require("express");

const router = express.Router();
const prisma = require("../lib/prisma");

const VALID_STATUSES = ["Open", "Pending", "Resolved", "Closed"];
const VALID_PRIORITIES = ["Low", "Medium", "High", "Urgent"];

// Mirror of support.js — statuses that constitute an actual agent response.
// Terminal statuses (Resolved / Closed / Cancelled) are NOT a first response.
// Match is case-insensitive.
const RESPONSIVE_STATUSES = ["in progress", "pending", "replied"];
const TERMINAL_STATUSES = ["resolved", "closed", "cancelled"];

// GET / — list all tickets in current tenant
router.get("/", async (req, res) => {
  try {
    const tickets = await prisma.ticket.findMany({
      where: { tenantId: req.user.tenantId },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tickets." });
  }
});

// GET /:id — single ticket
router.get("/:id", async (req, res) => {
  try {
    const ticket = await prisma.ticket.findFirst({
      where: { id: parseInt(req.params.id, 10), tenantId: req.user.tenantId },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
      },
    });
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found." });
    }
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch ticket." });
  }
});

// POST / — create ticket
router.post("/", async (req, res) => {
  try {
    const { subject, description, priority, assigneeId } = req.body;

    if (!subject || typeof subject !== "string" || subject.trim().length === 0) {
      return res.status(400).json({ error: "Subject is required." });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` });
    }

    const data = {
      subject: subject.trim(),
      description: description || null,
      priority: priority || "Low",
      status: "Open",
      tenantId: req.user.tenantId,
    };

    if (assigneeId) {
      data.assigneeId = parseInt(assigneeId, 10);
    }

    const ticket = await prisma.ticket.create({
      data,
      include: {
        assignee: { select: { id: true, name: true, email: true } },
      },
    });

    // Auto-apply SLA if policy exists for this priority (mirrors support.js).
    try {
      const sla = await prisma.slaPolicy.findFirst({
        where: { tenantId: req.user.tenantId, priority: ticket.priority, isActive: true },
      });
      if (sla) {
        const now = new Date(ticket.createdAt);
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            slaResponseDue: new Date(now.getTime() + sla.responseMinutes * 60000),
            slaResolveDue: new Date(now.getTime() + sla.resolveMinutes * 60000),
          },
        });
      }
    } catch (e) { /* SLA is non-critical */ }

    try { require("../lib/eventBus").emitEvent("ticket.created", { ticketId: ticket.id, subject: ticket.subject, priority: ticket.priority, contactId: ticket.contactId, status: ticket.status, userId: req.user.userId }, req.user.tenantId, req.io); } catch(e) {}
    res.status(201).json(ticket);
  } catch (err) {
    res.status(500).json({ error: "Failed to create ticket." });
  }
});

// PUT /:id — update ticket
router.put("/:id", async (req, res) => {
  try {
    const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id, 10), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Ticket not found." });

    const { status, priority, assigneeId } = req.body;
    const updateData = {};

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
      }
      updateData.status = status;
    }
    if (priority) {
      if (!VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` });
      }
      updateData.priority = priority;
    }
    if (assigneeId !== undefined) {
      updateData.assigneeId = assigneeId ? parseInt(assigneeId, 10) : null;
    }

    // Stamp resolvedAt on first transition to Resolved (mirrors support.js).
    const incomingStatus = typeof status === "string" ? status.trim().toLowerCase() : null;
    const existingStatus = typeof existing.status === "string" ? existing.status.trim().toLowerCase() : null;

    if (incomingStatus === "resolved" && !existing.resolvedAt) {
      updateData.resolvedAt = new Date();
    }

    // Stamp firstResponseAt only on Open → (In Progress | Pending | Replied).
    // Skip terminal transitions; they are not a "response". (Mirrors support.js.)
    if (
      !existing.firstResponseAt &&
      existingStatus === "open" &&
      incomingStatus &&
      RESPONSIVE_STATUSES.includes(incomingStatus) &&
      !TERMINAL_STATUSES.includes(incomingStatus)
    ) {
      updateData.firstResponseAt = new Date();
    }

    const ticket = await prisma.ticket.update({
      where: { id: existing.id },
      data: updateData,
      include: {
        assignee: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(ticket);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Ticket not found." });
    }
    res.status(500).json({ error: "Failed to update ticket." });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.ticket.findFirst({ where: { id: parseInt(req.params.id, 10), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Ticket not found." });
    await prisma.ticket.delete({
      where: { id: existing.id },
    });
    res.json({ message: "Ticket deleted." });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Ticket not found." });
    }
    res.status(500).json({ error: "Failed to delete ticket." });
  }
});

module.exports = router;
