const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { ensureEnum, ensureDateInRange } = require("../lib/validators");
const { writeAudit, diffFields } = require("../lib/audit");

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
// #436: status filter is now case-insensitive AND tolerant of the legacy
// "OPEN"/"PENDING" enum values. The Sidebar badge query is hard-coded to
// `?status=PENDING` (uppercase) and the orchestrator-engine fan-out writes
// new tasks with `status: "OPEN"` (also uppercase). Both fall outside the
// canonical Title-case enum the schema/UI expects (`Pending`/`Completed`),
// so an exact-match `where.status = status` returned zero rows — the
// Owner's "Task Queue" badge counter sat at 0 even when the orchestrator
// had created tasks. Treat OPEN/PENDING (and their casing variants) as
// `Pending` for query purposes; everything else still hits exact match.
function normalizeStatusFilter(raw) {
  if (!raw) return null;
  const upper = String(raw).toUpperCase();
  if (upper === "PENDING" || upper === "OPEN") return "Pending";
  if (upper === "COMPLETED" || upper === "DONE" || upper === "CLOSED") return "Completed";
  if (upper === "IN PROGRESS" || upper === "INPROGRESS") return "In Progress";
  if (upper === "CANCELLED" || upper === "CANCELED") return "Cancelled";
  return raw; // unrecognized — pass through, will exact-match (or return [])
}

// #505: lightweight count endpoint for sidebar polling. Sidebar calls
// GET /api/tasks?status=PENDING every 60s; use cheap count instead of findMany.
router.get("/count", verifyToken, async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = normalizeStatusFilter(status);
    if (req.query.includeDeleted !== "true") where.deletedAt = null;
    const total = await prisma.task.count({ where });
    res.json({ total });
  } catch (_err) {
    res.json({ total: 0 });
  }
});

router.get("/", verifyToken, async (req, res) => {
  try {
    const { status, priority, contactId, overdue, mine } = req.query;

    const where = { tenantId: req.user.tenantId };
    if (status) where.status = normalizeStatusFilter(status);
    if (priority) where.priority = priority;
    if (contactId) where.contactId = parseInt(contactId);
    if (overdue === "true") {
      where.dueDate = { lt: new Date() };
      where.status = "Pending";
    }
    // #436: ?mine=true → show tasks assigned to the caller. Owner persona
    // hits this via the upcoming "My Tasks" tab; we keep the existing
    // tenant-wide list for ?mine!=true so admin/manager oversight is
    // unchanged. ADMIN/MANAGER also see tasks they CREATED but never
    // assigned to a specific user (userId=null) so the Owner's recent
    // self-created queue items are visible — orchestrator-fan-out tasks
    // historically wrote userId=null because `stripDangerous` deleted the
    // assignee field on the create path (see POST handler comment).
    if (mine === "true") {
      const me = req.user.userId;
      const isOrgRole = req.user.role === "ADMIN" || req.user.role === "MANAGER";
      where.OR = isOrgRole
        ? [{ userId: me }, { userId: null }]
        : [{ userId: me }];
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
    // #436: the global `stripDangerous` middleware (server.js:299, applied to
    // every route) deletes `userId` from req.body — that's the right thing
    // for entities where `userId` is the row owner / cross-tenant pivot, but
    // on Task `userId` is the assignee. Stripping it meant POST /api/tasks
    // could never assign a task to a user; every row landed with userId=null,
    // so the Owner's "my tasks" queue read empty and the Sidebar pending-task
    // badge sat at 0. Accept `targetUserId` (renamed surface, never stripped)
    // and fall through to req.strippedFields.userId for back-compat with old
    // clients that still POST `userId`.
    const { title, dueDate, contactId, targetUserId, notes, priority } = req.body;
    const assigneeRaw = (targetUserId !== undefined && targetUserId !== null && targetUserId !== "")
      ? targetUserId
      : (req.strippedFields && req.strippedFields.userId);
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
        userId: assigneeRaw !== undefined && assigneeRaw !== null && assigneeRaw !== ""
          ? parseInt(assigneeRaw)
          : null,
        notes: notes || null,
        tenantId: req.user.tenantId,
      },
      include: { contact: true, user: true },
    });
    try { require("../lib/eventBus").emitEvent("task.created", { taskId: task.id, title: task.title, userId: req.user.userId }, req.user.tenantId, req.io); } catch(_e) {}
    // #179: audit task creation.
    await writeAudit('Task', 'CREATE', task.id, req.user.userId, req.user.tenantId, {
      title: task.title,
      priority: task.priority,
      assignedTo: task.userId,
      contactId: task.contactId,
    });
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

    // gap #17: capture prior status BEFORE the update so task.completed can be
    // gated idempotently — re-saving an already-Completed task must not re-fire.
    const wasCompleted = existing.status === "Completed";

    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
      include: { contact: true, user: true },
    });

    // gap #17: emit task.completed only on the Pending → Completed transition.
    try {
      if (!wasCompleted && task.status === "Completed") {
        require("../lib/eventBus").emitEvent(
          "task.completed",
          {
            taskId: task.id,
            contactId: task.contactId,
            dealId: task.dealId || null,
            assignedToId: task.userId,
            completedAt: new Date(),
          },
          req.user.tenantId,
          req.io
        );
      }
    } catch (_e) {}

    // #179: audit only the keys that actually changed.
    const changes = diffFields(existing, task, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit('Task', 'UPDATE', task.id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }

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

    // gap #17: same idempotency gate as PUT /:id — don't re-fire if already complete.
    const wasCompleted = existing.status === "Completed";

    const task = await prisma.task.update({
      where: { id: existing.id },
      data: { status: "Completed" },
    });

    try {
      if (!wasCompleted) {
        require("../lib/eventBus").emitEvent(
          "task.completed",
          {
            taskId: task.id,
            contactId: task.contactId,
            dealId: task.dealId || null,
            assignedToId: task.userId,
            completedAt: new Date(),
          },
          req.user.tenantId,
          req.io
        );
      }
    } catch (_e) {}

    // #179: audit completion (only on the actual transition — re-saving
    // an already-Completed task is a no-op and should not generate a row).
    if (!wasCompleted) {
      await writeAudit('Task', 'COMPLETE', task.id, req.user.userId, req.user.tenantId, {
        title: existing.title,
      });
    }

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
