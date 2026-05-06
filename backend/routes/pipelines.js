const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit, diffFields } = require("../lib/audit");
// #527 (CRIT-02 hardening): admin-config writes are admin-only. GET routes
// stay open to all authenticated tenant members (USERs need to see the
// pipeline list to file deals against it).
const adminOnly = [verifyToken, verifyRole(["ADMIN"])];

// ── GET / ─ list all pipelines for tenant (with deal counts) ─────
router.get("/", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const pipelines = await prisma.pipeline.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });

    // Attach deal counts per pipeline
    const counts = await prisma.deal.groupBy({
      by: ["pipelineId"],
      where: { tenantId, pipelineId: { in: pipelines.map((p) => p.id) } },
      _count: { _all: true },
    });
    const countMap = Object.fromEntries(counts.map((c) => [c.pipelineId, c._count._all]));

    res.json(pipelines.map((p) => ({ ...p, dealCount: countMap[p.id] || 0 })));
  } catch (err) {
    console.error("[pipelines][GET /]", err);
    res.status(500).json({ error: "Failed to fetch pipelines" });
  }
});

// ── POST / ─ create new pipeline ─────────────────────────────────
router.post("/", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { name, description, isDefault } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Pipeline name is required" });
    }

    // Atomic create: if isDefault, unset others first
    const pipeline = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.pipeline.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }
      // If this is the first pipeline for tenant, force it as default
      const count = await tx.pipeline.count({ where: { tenantId } });
      const shouldBeDefault = isDefault === true || count === 0;

      return tx.pipeline.create({
        data: {
          name: name.trim(),
          description: description || null,
          isDefault: shouldBeDefault,
          tenantId,
        },
      });
    });

    // #568: audit Pipeline CREATE — admin-config write must be discoverable
    // via /api/audit for SOC2 / DPDP / HIPAA review. Wrapped in try/catch so
    // an audit failure never breaks the response.
    try {
      await writeAudit('Pipeline', 'CREATE', pipeline.id, req.user.userId, req.user.tenantId, {
        name: pipeline.name,
        isDefault: pipeline.isDefault,
      });
    } catch (auditErr) {
      console.warn('[pipelines][POST /] audit failed:', auditErr.message);
    }

    res.status(201).json(pipeline);
  } catch (err) {
    console.error("[pipelines][POST /]", err);
    res.status(500).json({ error: "Failed to create pipeline" });
  }
});

// ── PUT /:id ─ update name/description ───────────────────────────
router.put("/:id", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid pipeline id" });

    const existing = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Pipeline not found" });

    const { name, description } = req.body || {};
    const data = {};
    if (typeof name === "string" && name.trim()) data.name = name.trim();
    if (description !== undefined) data.description = description || null;

    const updated = await prisma.pipeline.update({ where: { id }, data });

    // #568: audit Pipeline UPDATE — record only the fields that actually
    // changed. Pattern mirrors routes/contacts.js PUT (~line 183).
    try {
      const changes = diffFields(existing, updated, Object.keys(data));
      if (Object.keys(changes).length > 0) {
        await writeAudit('Pipeline', 'UPDATE', updated.id, req.user.userId, req.user.tenantId, {
          changedFields: changes,
        });
      }
    } catch (auditErr) {
      console.warn('[pipelines][PUT /:id] audit failed:', auditErr.message);
    }

    res.json(updated);
  } catch (err) {
    console.error("[pipelines][PUT /:id]", err);
    res.status(500).json({ error: "Failed to update pipeline" });
  }
});

// ── DELETE /:id ─ delete pipeline (no default, no deals) ─────────
router.delete("/:id", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid pipeline id" });

    const existing = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Pipeline not found" });
    if (existing.isDefault) {
      return res.status(400).json({ error: "Cannot delete the default pipeline. Set another pipeline as default first." });
    }

    const dealCount = await prisma.deal.count({ where: { tenantId, pipelineId: id } });
    if (dealCount > 0) {
      return res.status(400).json({ error: `Cannot delete pipeline with ${dealCount} deal(s). Move or remove deals first.` });
    }

    await prisma.pipeline.delete({ where: { id } });

    // #568: audit Pipeline DELETE — hard-delete (Pipeline has no soft-delete
    // column today) so action verb is plain DELETE, mirroring the wellness.js
    // patient DELETE pattern (~line 794). Pipeline name preserved in details
    // since the row is gone after this point.
    try {
      await writeAudit('Pipeline', 'DELETE', id, req.user.userId, req.user.tenantId, {
        name: existing.name,
      });
    } catch (auditErr) {
      console.warn('[pipelines][DELETE /:id] audit failed:', auditErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[pipelines][DELETE /:id]", err);
    res.status(500).json({ error: "Failed to delete pipeline" });
  }
});

// ── POST /:id/set-default ─ atomically swap default ──────────────
router.post("/:id/set-default", ...adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid pipeline id" });

    const existing = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Pipeline not found" });

    const result = await prisma.$transaction(async (tx) => {
      await tx.pipeline.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.pipeline.update({ where: { id }, data: { isDefault: true } });
    });

    res.json(result);
  } catch (err) {
    console.error("[pipelines][POST /:id/set-default]", err);
    res.status(500).json({ error: "Failed to set default pipeline" });
  }
});

// ── GET /:id/deals ─ list deals in this pipeline ─────────────────
router.get("/:id/deals", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid pipeline id" });

    const pipeline = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

    const deals = await prisma.deal.findMany({
      where: { tenantId, pipelineId: id },
      orderBy: { createdAt: "desc" },
      include: {
        contact: { select: { id: true, name: true, email: true, company: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(deals);
  } catch (err) {
    console.error("[pipelines][GET /:id/deals]", err);
    res.status(500).json({ error: "Failed to fetch deals" });
  }
});

// ── GET /:id/stats ─ count deals per stage ───────────────────────
router.get("/:id/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid pipeline id" });

    const pipeline = await prisma.pipeline.findFirst({ where: { id, tenantId } });
    if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

    const grouped = await prisma.deal.groupBy({
      by: ["stage"],
      where: { tenantId, pipelineId: id },
      _count: { _all: true },
      _sum: { amount: true },
    });

    const totalDeals = grouped.reduce((sum, g) => sum + g._count._all, 0);
    const totalValue = grouped.reduce((sum, g) => sum + (g._sum.amount || 0), 0);

    res.json({
      pipelineId: id,
      pipelineName: pipeline.name,
      totalDeals,
      totalValue,
      byStage: grouped.map((g) => ({
        stage: g.stage,
        count: g._count._all,
        value: g._sum.amount || 0,
      })),
    });
  } catch (err) {
    console.error("[pipelines][GET /:id/stats]", err);
    res.status(500).json({ error: "Failed to fetch pipeline stats" });
  }
});

module.exports = router;
