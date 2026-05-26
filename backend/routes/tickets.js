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
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch tickets." });
  }
});

// ============================================================================
// GET /api/tickets/stats — tenant-wide ticket KPI rollup (CRM polish — first
// /stats endpoint on the support ticket route).
//
// Mirrors backend/routes/deals.js /stats + backend/routes/travel_suppliers.js
// /suppliers/stats posture. Read-only meta surface that powers the support
// dashboard's header tile strip ("12 open · 4 high-priority · 2 SLA-breached
// · avg resolution 8.5h") without forcing the frontend to fire N+1 list +
// per-status count + per-priority count round-trips.
//
// Behaviour:
//   - Tenant-scoped via req.user.tenantId.
//   - Optional ?from / ?to (ISO date bounds) filter Ticket.createdAt; invalid
//     → 400 INVALID_DATE.
//   - Aggregates over prisma.ticket using findMany + in-process bucketing
//     (mirrors travel_suppliers/stats — keeps mocking simple in tests and
//     yields a single shape regardless of which DB engine is behind Prisma).
//   - byStatus / byPriority cover EXACTLY the schema enums
//     (status: Open/Pending/Resolved/Closed; priority: Low/Medium/High/Urgent).
//   - openCount = count where status NOT IN terminal set (Resolved/Closed).
//   - slaBreachedCount = count where breachedAt IS NOT NULL. (Ticket schema
//     uses `breached` Boolean + `breachedAt` DateTime — sibling /sla
//     surfaces use breachedAt as the canonical "breached at this instant".)
//   - avgResolutionHours = average (resolvedAt - createdAt) / 3_600_000 across
//     tickets where resolvedAt IS NOT NULL; null when no resolved tickets.
//     Half-up to 2dp.
//   - lastCreatedAt = max(createdAt) ISO or null.
//
// No audit row written — read-only meta surface (mirrors travel_suppliers/stats
// + deals/stats).
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family or `:id="stats"` would route into GET /:id and fail with the
// `parseInt(...)` → NaN findFirst lookup.
// ============================================================================
const TERMINAL_TICKET_STATUSES = new Set(["resolved", "closed", "cancelled"]);

router.get("/stats", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Optional ISO date bounds on Ticket.createdAt
    const where = { tenantId };
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    const tickets = await prisma.ticket.findMany({
      where,
      select: {
        status: true,
        priority: true,
        createdAt: true,
        resolvedAt: true,
        breachedAt: true,
      },
    });

    // Empty short-circuit — return zeroed shape with null avg + lastCreatedAt.
    if (tickets.length === 0) {
      return res.json({
        total: 0,
        byStatus: {},
        byPriority: {},
        openCount: 0,
        slaBreachedCount: 0,
        avgResolutionHours: null,
        lastCreatedAt: null,
      });
    }

    const byStatus = {};
    const byPriority = {};
    let openCount = 0;
    let slaBreachedCount = 0;
    let lastCreatedAt = null;
    let resolvedSumMs = 0;
    let resolvedCount = 0;

    for (const t of tickets) {
      const status = t.status || "Open";
      const priority = t.priority || "Low";

      byStatus[status] = (byStatus[status] || 0) + 1;
      byPriority[priority] = (byPriority[priority] || 0) + 1;

      const statusLc = String(status).trim().toLowerCase();
      if (!TERMINAL_TICKET_STATUSES.has(statusLc)) {
        openCount += 1;
      }

      if (t.breachedAt != null) {
        slaBreachedCount += 1;
      }

      const created = t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt);
      if (!Number.isNaN(created.getTime())) {
        if (!lastCreatedAt || created > lastCreatedAt) lastCreatedAt = created;
      }

      if (t.resolvedAt != null) {
        const resolved = t.resolvedAt instanceof Date ? t.resolvedAt : new Date(t.resolvedAt);
        if (!Number.isNaN(resolved.getTime()) && !Number.isNaN(created.getTime())) {
          resolvedSumMs += (resolved.getTime() - created.getTime());
          resolvedCount += 1;
        }
      }
    }

    // Half-up round to 2dp — matches sibling stats endpoints.
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const avgResolutionHours = resolvedCount > 0
      ? round2((resolvedSumMs / resolvedCount) / 3_600_000)
      : null;

    res.json({
      total: tickets.length,
      byStatus,
      byPriority,
      openCount,
      slaBreachedCount,
      avgResolutionHours,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[tickets] stats error:", err.message);
    res.status(500).json({ error: "Failed to compute ticket stats" });
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
  } catch (_err) {
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
    } catch (_e) { /* SLA is non-critical */ }

    try { require("../lib/eventBus").emitEvent("ticket.created", { ticketId: ticket.id, subject: ticket.subject, priority: ticket.priority, contactId: ticket.contactId, status: ticket.status, userId: req.user.userId }, req.user.tenantId, req.io); } catch(_e) {}
    res.status(201).json(ticket);
  } catch (_err) {
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
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Ticket not found." });
    }
    res.status(500).json({ error: "Failed to delete ticket." });
  }
});

module.exports = router;
