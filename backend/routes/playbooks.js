const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// ── Helpers ──────────────────────────────────────────────────────

function tenantId(req) {
  return (req.user && req.user.tenantId) || 1;
}

function safeParseSteps(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => ({
    title: String(s && s.title ? s.title : `Step ${i + 1}`),
    description: String(s && s.description ? s.description : ""),
    order: Number.isFinite(s && s.order) ? s.order : i,
  }));
}

function hydratePlaybook(p) {
  if (!p) return p;
  return { ...p, steps: safeParseSteps(p.steps) };
}

function safeParseCompleted(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function hydrateProgress(progress, totalSteps) {
  if (!progress) return null;
  const completedSteps = safeParseCompleted(progress.completedSteps);
  const pctComplete = totalSteps > 0
    ? Math.round((completedSteps.length / totalSteps) * 100)
    : 0;
  return { ...progress, completedSteps, pctComplete };
}

// ── Stats ────────────────────────────────────────────────────────
// GET /api/playbooks/stats — count playbooks, avg completion rate by stage
router.get("/stats", async (req, res) => {
  try {
    const tId = tenantId(req);
    const playbooks = await prisma.playbook.findMany({ where: { tenantId: tId } });
    const total = playbooks.length;
    const active = playbooks.filter((p) => p.isActive).length;

    const byStage = {};
    for (const p of playbooks) {
      const stage = p.stage || "unknown";
      if (!byStage[stage]) byStage[stage] = { stage, count: 0, totalPct: 0, progressCount: 0, avgCompletion: 0 };
      byStage[stage].count += 1;

      const progresses = await prisma.playbookProgress.findMany({
        where: { playbookId: p.id, tenantId: tId },
      });
      const steps = safeParseSteps(p.steps);
      const totalSteps = steps.length || 1;
      for (const pr of progresses) {
        const done = safeParseCompleted(pr.completedSteps).length;
        byStage[stage].totalPct += Math.min(100, Math.round((done / totalSteps) * 100));
        byStage[stage].progressCount += 1;
      }
    }

    const stages = Object.values(byStage).map((s) => ({
      stage: s.stage,
      count: s.count,
      avgCompletion: s.progressCount > 0 ? Math.round(s.totalPct / s.progressCount) : 0,
    }));

    res.json({ total, active, inactive: total - active, stages });
  } catch (err) {
    console.error("playbooks/stats error", err);
    res.status(500).json({ error: "Failed to fetch playbook stats" });
  }
});

// ── List / Filter ────────────────────────────────────────────────
// GET /api/playbooks — list playbooks for tenant (filter by stage)
router.get("/", async (req, res) => {
  try {
    const tId = tenantId(req);
    const { stage, isActive } = req.query;
    const where = { tenantId: tId };
    if (stage) where.stage = stage;
    if (isActive === "true") where.isActive = true;
    if (isActive === "false") where.isActive = false;

    const list = await prisma.playbook.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(list.map(hydratePlaybook));
  } catch (err) {
    console.error("playbooks list error", err);
    res.status(500).json({ error: "Failed to fetch playbooks" });
  }
});

// ── Per-Deal Endpoints ───────────────────────────────────────────
// GET /api/playbooks/deal/:dealId — playbooks matching deal's stage + progress
router.get("/deal/:dealId", async (req, res) => {
  try {
    const tId = tenantId(req);
    const dealId = parseInt(req.params.dealId, 10);
    if (Number.isNaN(dealId)) return res.status(400).json({ error: "Invalid deal ID" });

    const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tId } });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const playbooks = await prisma.playbook.findMany({
      where: { tenantId: tId, stage: deal.stage, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    const result = [];
    for (const pb of playbooks) {
      const hydrated = hydratePlaybook(pb);
      const progress = await prisma.playbookProgress.findFirst({
        where: { dealId, playbookId: pb.id, tenantId: tId },
      });
      result.push({
        playbook: hydrated,
        progress: hydrateProgress(
          progress || { dealId, playbookId: pb.id, completedSteps: "[]", tenantId: tId },
          hydrated.steps.length
        ),
      });
    }
    res.json(result);
  } catch (err) {
    console.error("playbooks/deal error", err);
    res.status(500).json({ error: "Failed to fetch deal playbooks" });
  }
});

// POST /api/playbooks/deal/:dealId/step — toggle step completion
router.post("/deal/:dealId/step", async (req, res) => {
  try {
    const tId = tenantId(req);
    const dealId = parseInt(req.params.dealId, 10);
    if (Number.isNaN(dealId)) return res.status(400).json({ error: "Invalid deal ID" });

    const { playbookId, stepIndex, completed } = req.body || {};
    const pbId = parseInt(playbookId, 10);
    const idx = parseInt(stepIndex, 10);
    if (Number.isNaN(pbId) || Number.isNaN(idx)) {
      return res.status(400).json({ error: "playbookId and stepIndex are required" });
    }

    const playbook = await prisma.playbook.findFirst({ where: { id: pbId, tenantId: tId } });
    if (!playbook) return res.status(404).json({ error: "Playbook not found" });

    const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tId } });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const existing = await prisma.playbookProgress.findFirst({
      where: { dealId, playbookId: pbId, tenantId: tId },
    });
    const current = existing ? safeParseCompleted(existing.completedSteps) : [];
    const set = new Set(current);
    if (completed) set.add(idx);
    else set.delete(idx);
    const next = Array.from(set).sort((a, b) => a - b);

    let saved;
    if (existing) {
      saved = await prisma.playbookProgress.update({
        where: { id: existing.id },
        data: { completedSteps: JSON.stringify(next) },
      });
    } else {
      saved = await prisma.playbookProgress.create({
        data: {
          dealId,
          playbookId: pbId,
          completedSteps: JSON.stringify(next),
          tenantId: tId,
        },
      });
    }

    const totalSteps = safeParseSteps(playbook.steps).length;
    res.json(hydrateProgress(saved, totalSteps));
  } catch (err) {
    console.error("playbooks/deal/step error", err);
    res.status(500).json({ error: "Failed to update step progress" });
  }
});

// ── CRUD ─────────────────────────────────────────────────────────
// POST /api/playbooks — create
router.post("/", async (req, res) => {
  try {
    const tId = tenantId(req);
    const { name, stage, steps, isActive } = req.body || {};
    if (!name || !stage) return res.status(400).json({ error: "name and stage are required" });

    const pb = await prisma.playbook.create({
      data: {
        name: String(name),
        stage: String(stage),
        steps: JSON.stringify(normalizeSteps(steps || [])),
        isActive: isActive === undefined ? true : !!isActive,
        tenantId: tId,
      },
    });
    res.status(201).json(hydratePlaybook(pb));
  } catch (err) {
    console.error("playbooks create error", err);
    res.status(500).json({ error: "Failed to create playbook" });
  }
});

// GET /api/playbooks/:id
router.get("/:id", async (req, res) => {
  try {
    const tId = tenantId(req);
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid playbook ID" });

    const pb = await prisma.playbook.findFirst({ where: { id, tenantId: tId } });
    if (!pb) return res.status(404).json({ error: "Playbook not found" });
    res.json(hydratePlaybook(pb));
  } catch (err) {
    console.error("playbooks get error", err);
    res.status(500).json({ error: "Failed to fetch playbook" });
  }
});

// PUT /api/playbooks/:id
router.put("/:id", async (req, res) => {
  try {
    const tId = tenantId(req);
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid playbook ID" });

    const existing = await prisma.playbook.findFirst({ where: { id, tenantId: tId } });
    if (!existing) return res.status(404).json({ error: "Playbook not found" });

    const { name, stage, steps, isActive } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = String(name);
    if (stage !== undefined) data.stage = String(stage);
    if (steps !== undefined) data.steps = JSON.stringify(normalizeSteps(steps));
    if (isActive !== undefined) data.isActive = !!isActive;

    const pb = await prisma.playbook.update({ where: { id: existing.id }, data });
    res.json(hydratePlaybook(pb));
  } catch (err) {
    console.error("playbooks update error", err);
    res.status(500).json({ error: "Failed to update playbook" });
  }
});

// DELETE /api/playbooks/:id
router.delete("/:id", async (req, res) => {
  try {
    const tId = tenantId(req);
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid playbook ID" });

    const existing = await prisma.playbook.findFirst({ where: { id, tenantId: tId } });
    if (!existing) return res.status(404).json({ error: "Playbook not found" });

    await prisma.playbookProgress.deleteMany({ where: { playbookId: id, tenantId: tId } });
    await prisma.playbook.delete({ where: { id: existing.id } });
    res.json({ message: "Playbook deleted" });
  } catch (err) {
    console.error("playbooks delete error", err);
    res.status(500).json({ error: "Failed to delete playbook" });
  }
});

// POST /api/playbooks/:id/duplicate — clone playbook
router.post("/:id/duplicate", async (req, res) => {
  try {
    const tId = tenantId(req);
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid playbook ID" });

    const existing = await prisma.playbook.findFirst({ where: { id, tenantId: tId } });
    if (!existing) return res.status(404).json({ error: "Playbook not found" });

    const copy = await prisma.playbook.create({
      data: {
        name: `${existing.name} (Copy)`,
        stage: existing.stage,
        steps: existing.steps,
        isActive: existing.isActive,
        tenantId: tId,
      },
    });
    res.status(201).json(hydratePlaybook(copy));
  } catch (err) {
    console.error("playbooks duplicate error", err);
    res.status(500).json({ error: "Failed to duplicate playbook" });
  }
});

module.exports = router;
