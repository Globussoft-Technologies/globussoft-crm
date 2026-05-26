const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/projects — list with optional status filter
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;

    const projects = await prisma.project.findMany({
      where,
      include: { owner: true, contact: true, deal: true, tasks: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// ============================================================================
// GET /api/projects/stats — tenant-wide project rollup (CRM polish).
//
// Mirrors deals/stats + travel-suppliers/stats posture: a read-only KPI
// surface for the project-management dashboard so the frontend doesn't have
// to fire {list, count by status×5, sum budget} round-trips for a single
// header tile strip.
//
// Aggregates (over prisma.project where tenantId = req.user.tenantId):
//   - total          — count
//   - byStatus       — { Planning: N, Active: M, "On Hold": K, Completed: J, Cancelled: L }
//                      (groupBy status; bucket keys mirror Project.status enum
//                      values seeded in the schema: Planning / Active / On Hold /
//                      Completed / Cancelled. Empty buckets omitted.)
//   - activeCount    — count where status NOT IN (Completed, Cancelled). Open
//                      work the user still owns; Completed + Cancelled are the
//                      terminal "closed" states per the schema enum comment.
//   - totalBudget    — sum of budget (half-up to 2dp). Defensive null→0.
//   - overdueCount   — count where endDate < now AND status NOT IN
//                      (Completed, Cancelled). A project past its endDate but
//                      still open is the canonical "needs attention" tile.
//   - lastCreatedAt  — max(createdAt) ISO string, or null on empty tenant.
//
// Query params (optional):
//   - ?from / ?to    — ISO date bounds on createdAt. Bad input → 400
//                      INVALID_DATE. Bounds applied BEFORE aggregation.
//
// Read-only meta surface: no audit row written, no events emitted. Tenant-
// scoped (no cross-tenant bleed). Express route ordering: literal-path /stats
// MUST be declared BEFORE the /:id family or `:id="stats"` would 400 on the
// parseInt check before reaching this handler.
// ============================================================================
router.get("/stats", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const where = { tenantId };

    // Optional ISO date bounds on createdAt.
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

    const projects = await prisma.project.findMany({ where });

    const total = projects.length;

    // Closed/terminal states per schema enum comment on Project.status.
    const CLOSED = new Set(["Completed", "Cancelled"]);

    // byStatus rollup — bucket key = exact enum value; empty buckets omitted.
    const byStatus = {};
    for (const p of projects) {
      const s = p.status || "Planning";
      byStatus[s] = (byStatus[s] || 0) + 1;
    }

    // activeCount = NOT terminal.
    const activeCount = projects.reduce(
      (n, p) => n + (CLOSED.has(p.status) ? 0 : 1),
      0,
    );

    // totalBudget — defensive null→0, half-up 2dp.
    const rawBudget = projects.reduce((s, p) => s + (p.budget || 0), 0);
    const totalBudget =
      Math.round((rawBudget + Number.EPSILON) * 100) / 100;

    // overdueCount — endDate < now AND not terminal.
    const now = Date.now();
    const overdueCount = projects.reduce((n, p) => {
      if (!p.endDate) return n;
      if (CLOSED.has(p.status)) return n;
      const t = p.endDate instanceof Date ? p.endDate.getTime() : new Date(p.endDate).getTime();
      return Number.isFinite(t) && t < now ? n + 1 : n;
    }, 0);

    // lastCreatedAt — max(createdAt) ISO, or null on empty.
    let lastCreatedAt = null;
    for (const p of projects) {
      if (!p.createdAt) continue;
      const t = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
      if (Number.isNaN(t.getTime())) continue;
      if (lastCreatedAt === null || t.getTime() > lastCreatedAt.getTime()) {
        lastCreatedAt = t;
      }
    }

    res.json({
      total,
      byStatus,
      activeCount,
      totalBudget,
      overdueCount,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[projects] stats error:", err && err.message);
    res.status(500).json({ error: "Failed to compute project stats" });
  }
});

// GET /api/projects/:id — single project
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid project ID" });

    const project = await prisma.project.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { owner: true, contact: true, deal: true, tasks: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// POST /api/projects — create project
router.post("/", async (req, res) => {
  try {
    const { name, description, priority, startDate, endDate, budget, contactId, dealId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const project = await prisma.project.create({
      data: {
        name,
        description: description || null,
        priority: priority || "Medium",
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        budget: budget ? parseFloat(budget) : 0,
        ownerId: req.user.userId,
        contactId: contactId ? parseInt(contactId) : null,
        dealId: dealId ? parseInt(dealId) : null,
        tenantId: req.user.tenantId,
      },
      include: { owner: true, contact: true, deal: true, tasks: true },
    });
    res.status(201).json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// PUT /api/projects/:id — update project
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid project ID" });

    const existing = await prisma.project.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Project not found" });

    const { name, description, status, priority, startDate, endDate, budget, contactId, dealId } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
    if (budget !== undefined) data.budget = parseFloat(budget);
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const project = await prisma.project.update({
      where: { id: existing.id },
      data,
      include: { owner: true, contact: true, deal: true, tasks: true },
    });
    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

// DELETE /api/projects/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid project ID" });
    const existing = await prisma.project.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    await prisma.project.delete({ where: { id: existing.id } });
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

module.exports = router;
