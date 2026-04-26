const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { ensureEnum, ensureDateInRange } = require("../lib/validators");

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
// #163: enums used elsewhere in the app — surfaced as strict checks instead of
// silent coercion to "Pending".
const ALLOWED_TASK_STATUSES = new Set(["Pending", "In Progress", "Completed", "Cancelled"]);
const ALLOWED_TASK_PRIORITIES = new Set(["Low", "Medium", "High", "Critical"]);

function validateTaskInput(body) {
  if (body.priority !== undefined && body.priority !== null && body.priority !== "") {
    const e = ensureEnum(body.priority, ALLOWED_TASK_PRIORITIES, { field: "priority", code: "INVALID_PRIORITY" });
    if (e) return e;
  }
  if (body.status !== undefined && body.status !== null && body.status !== "") {
    const e = ensureEnum(body.status, ALLOWED_TASK_STATUSES, { field: "status", code: "INVALID_STATUS" });
    if (e) return e;
  }
  if (body.dueDate !== undefined && body.dueDate !== null && body.dueDate !== "") {
    // Reject obviously bogus dates (year < 2000 or > 2100). We allow past
    // dueDates because users do legitimately log overdue work, but a 1900 or
    // 2999 timestamp is always wrong and was silently accepted pre-fix.
    const e = ensureDateInRange(body.dueDate, { minYear: 2000, maxYear: 2100, field: "dueDate", code: "INVALID_DUEDATE" });
    if (e) return e;
  }
  return null;
}

// GET /api/tasks — with optional filters
// #167: soft-deleted tasks hidden by default. ?includeDeleted=true opts in.
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
    if (req.query.includeDeleted !== "true") where.deletedAt = null;

    // #172: pagination
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const tasks = await prisma.task.findMany({
      where, take: limit, skip: offset,
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
    // #163: reject invalid status / priority instead of silently coercing.
    const inputErr = validateTaskInput(req.body);
    if (inputErr) return res.status(inputErr.status).json(inputErr);

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

    // #168: same validation on update path.
    const inputErr = validateTaskInput(req.body);
    if (inputErr) return res.status(inputErr.status).json(inputErr);

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

// DELETE /api/tasks/:id — soft-delete (#167). ADMIN only. Idempotent.
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });
    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });
    if (existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, softDeleted: true });
    }
    try {
      await prisma.auditLog.create({
        data: { action: "SOFT_DELETE", entity: "Task", entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ title: existing.title }) }
      });
    } catch (_) { /* audit failures must not block */ }
    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.json({ ...task, message: "Task soft-deleted", softDeleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete Task" });
  }
});

// POST /api/tasks/:id/restore — undo soft-delete (#167)
router.post("/:id/restore", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid task ID" });
    const existing = await prisma.task.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Task not found" });
    if (!existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, restored: false });
    }
    try {
      await prisma.auditLog.create({
        data: { action: "RESTORE", entity: "Task", entityId: existing.id, userId: req.user?.userId || null, tenantId: req.user.tenantId, details: JSON.stringify({ title: existing.title }) }
      });
    } catch (_) { /* non-critical */ }
    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { deletedAt: null },
      include: { contact: true, user: true },
    });
    res.json({ ...task, restored: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to restore Task" });
  }
});

module.exports = router;
