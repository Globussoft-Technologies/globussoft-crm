const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

const VALID_STATUSES = ["Open", "Pending", "Resolved", "Closed"];
const VALID_PRIORITIES = ["Low", "Medium", "High", "Urgent"];

// GET / — list all tickets with assignee info
router.get("/", async (req, res) => {
  try {
    const tickets = await prisma.ticket.findMany({
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

// GET /:id — single ticket with assignee
router.get("/:id", async (req, res) => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: parseInt(req.params.id, 10) },
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
    res.status(201).json(ticket);
  } catch (err) {
    res.status(500).json({ error: "Failed to create ticket." });
  }
});

// PUT /:id — update ticket (status, priority, assigneeId)
router.put("/:id", async (req, res) => {
  try {
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

    const ticket = await prisma.ticket.update({
      where: { id: parseInt(req.params.id, 10) },
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

// DELETE /:id — delete ticket
router.delete("/:id", async (req, res) => {
  try {
    await prisma.ticket.delete({
      where: { id: parseInt(req.params.id, 10) },
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
