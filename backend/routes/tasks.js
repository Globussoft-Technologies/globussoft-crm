const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };

// GET /api/tasks — with optional filters
router.get("/", verifyToken, async (req, res) => {
  try {
    const { status, priority, contactId, overdue } = req.query;

    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (contactId) where.contactId = parseInt(contactId);
    if (overdue === "true") {
      where.dueDate = { lt: new Date() };
      where.status = "Pending";
    }

    const tasks = await prisma.task.findMany({
      where,
      include: { contact: true, user: true },
      orderBy: { createdAt: "desc" },
    });

    // Sort by priority in-memory (Critical first)
    tasks.sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
    );

    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Tasks" });
  }
});

// POST /api/tasks
router.post("/", verifyToken, async (req, res) => {
  try {
    const { title, dueDate, contactId, userId, notes, priority } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const task = await prisma.task.create({
      data: {
        title,
        priority: priority || "Medium",
        dueDate: dueDate ? new Date(dueDate) : null,
        contactId: contactId ? parseInt(contactId) : null,
        userId: userId ? parseInt(userId) : null,
        notes: notes || null,
        tenantId: req.user.tenantId,
      },
      include: { contact: true, user: true },
    });
    try { require("../lib/eventBus").emitEvent("task.created", { taskId: task.id, title: task.title, userId: req.user.userId }, req.user.tenantId, req.io); } catch(e) {}
    res.status(201).json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create Task" });
  }
});

// PUT /api/tasks/:id — general update
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });

    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });

    const { title, notes, dueDate, priority, status } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (notes !== undefined) data.notes = notes;
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
    if (priority !== undefined) data.priority = priority;
    if (status !== undefined) data.status = status;

    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
      include: { contact: true, user: true },
    });
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update Task" });
  }
});

// PUT /api/tasks/:id/complete
router.put("/:id/complete", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });

    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });

    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { status: "Completed" },
    });
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to complete Task" });
  }
});

// DELETE /api/tasks/:id
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });
    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });
    await prisma.task.delete({ where: { id: existing.id } });
    res.json({ message: "Task Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete Task" });
  }
});

module.exports = router;
