const express = require('express');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();
const prisma = require('../lib/prisma');

router.use(verifyToken);

// Generic CRM uses shared PipelineStage identities plus per-pipeline
// assignments. Wellness and Travel retain the legacy direct pipelineId path.
function isGenericCrm(req) {
  return req.user?.vertical !== 'wellness' && req.user?.vertical !== 'travel';
}

async function ownsPipeline(tenantId, pipelineId) {
  return prisma.pipeline.findFirst({ where: { id: pipelineId, tenantId }, select: { id: true } });
}

async function getGenericPipelineStages(tenantId, pipelineId) {
  const assignments = await prisma.pipelineStageAssignment.findMany({
    where: { pipelineId, pipeline: { tenantId } },
    include: { stage: true },
    orderBy: { position: 'asc' },
  });
  return assignments.map(({ stage, position }) => ({ ...stage, pipelineId, position }));
}

router.get('/', async (req, res) => {
  try {
    const pipelineId = req.query.pipelineId == null ? null : Number(req.query.pipelineId);
    if (pipelineId != null && !(await ownsPipeline(req.user.tenantId, pipelineId))) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    if (isGenericCrm(req)) {
      if (pipelineId != null) return res.json(await getGenericPipelineStages(req.user.tenantId, pipelineId));
      const stages = await prisma.pipelineStage.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { position: 'asc' },
      });
      return res.json(stages);
    }

    const stages = await prisma.pipelineStage.findMany({
      where: { tenantId: req.user.tenantId, ...(pipelineId == null ? {} : { pipelineId }) },
      orderBy: { position: 'asc' },
    });
    return res.json(stages);
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to fetch pipeline stages' });
  }
});

// Create a custom stage, or assign an existing shared Generic CRM stage.
router.post('/', async (req, res) => {
  try {
    const { name, color, position, stageId } = req.body;
    const pipelineId = req.body.pipelineId == null ? null : Number(req.body.pipelineId);

    if (!isGenericCrm(req)) {
      if (!Number.isInteger(pipelineId) || pipelineId < 1 || !(await ownsPipeline(req.user.tenantId, pipelineId))) {
        return res.status(400).json({ error: 'Valid pipelineId required' });
      }
      const stage = await prisma.pipelineStage.create({
        data: { name, color: color || '#3b82f6', position: position ?? 0, tenantId: req.user.tenantId, pipelineId },
      });
      return res.status(201).json(stage);
    }

    if (pipelineId != null && (!Number.isInteger(pipelineId) || pipelineId < 1 || !(await ownsPipeline(req.user.tenantId, pipelineId)))) {
      return res.status(400).json({ error: 'Valid pipelineId required' });
    }

    // Keep the existing tenant-wide stage library used by Settings and older
    // Generic CRM callers. Pipeline creation/editing supplies pipelineId and
    // uses the reusable assignment flow below.
    if (pipelineId == null && stageId == null) {
      const stage = await prisma.pipelineStage.create({
        data: { name, color: color || '#3b82f6', position: position ?? 0, tenantId: req.user.tenantId },
      });
      return res.status(201).json(stage);
    }

    if (stageId != null) {
      const existingStage = await prisma.pipelineStage.findFirst({
        where: { id: Number(stageId), tenantId: req.user.tenantId },
      });
      if (!existingStage) return res.status(404).json({ error: 'Pipeline stage not found' });
      if (pipelineId == null) return res.status(400).json({ error: 'pipelineId required when selecting an existing stage' });
      const assignment = await prisma.pipelineStageAssignment.create({
        data: { pipelineId, stageId: existingStage.id, position: position ?? 0 },
      });
      return res.status(201).json({ ...existingStage, pipelineId, position: assignment.position });
    }

    const trimmedName = String(name || '').trim();
    if (!trimmedName) return res.status(400).json({ error: 'Stage name is required' });
    const duplicate = await prisma.pipelineStage.findFirst({
      where: { tenantId: req.user.tenantId, name: { equals: trimmedName } },
      select: { id: true, name: true },
    });
    if (duplicate) {
      return res.status(409).json({
        error: `Stage "${duplicate.name}" already exists. Select the existing stage instead.`,
        code: 'STAGE_ALREADY_EXISTS',
        stageId: duplicate.id,
      });
    }

    const stage = await prisma.$transaction(async (tx) => {
      const created = await tx.pipelineStage.create({
        data: { name: trimmedName, color: color || '#3b82f6', position: position ?? 0, tenantId: req.user.tenantId },
      });
      if (pipelineId == null) return created;
      await tx.pipelineStageAssignment.create({ data: { pipelineId, stageId: created.id, position: position ?? 0 } });
      return { ...created, pipelineId };
    });
    return res.status(201).json(stage);
  } catch (err) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'Stage is already assigned to this pipeline', code: 'DUPLICATE_STAGE_ASSIGNMENT' });
    return res.status(500).json({ error: 'Failed to create pipeline stage' });
  }
});

router.put('/reorder', async (req, res) => {
  try {
    const { stages } = req.body;
    if (!Array.isArray(stages)) return res.status(400).json({ error: 'stages array required' });
    const pipelineId = Number(req.body.pipelineId);

    if (isGenericCrm(req) && Number.isInteger(pipelineId) && pipelineId > 0) {
      if (!(await ownsPipeline(req.user.tenantId, pipelineId))) return res.status(404).json({ error: 'Pipeline not found' });
      await prisma.$transaction(stages.map((item) => prisma.pipelineStageAssignment.update({
        where: { pipelineId_stageId: { pipelineId, stageId: Number(item.id) } },
        data: { position: item.position },
      })));
      return res.json(await getGenericPipelineStages(req.user.tenantId, pipelineId));
    }

    const ownedIds = (await prisma.pipelineStage.findMany({
      where: { tenantId: req.user.tenantId, ...(Number.isInteger(pipelineId) && pipelineId > 0 ? { pipelineId } : {}), id: { in: stages.map((s) => s.id) } },
      select: { id: true },
    })).map((s) => s.id);
    await Promise.all(stages.filter((s) => ownedIds.includes(s.id)).map((s) => prisma.pipelineStage.update({
      where: { id: s.id },
      data: { position: s.position },
    })));
    const updated = await prisma.pipelineStage.findMany({
      where: { tenantId: req.user.tenantId, ...(Number.isInteger(pipelineId) && pipelineId > 0 ? { pipelineId } : {}) },
      orderBy: { position: 'asc' },
    });
    return res.json(updated);
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to reorder pipeline stages' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await prisma.pipelineStage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Pipeline stage not found' });
    const { name, color, position } = req.body;
    const stage = await prisma.pipelineStage.update({
      where: { id: existing.id },
      data: { name, color, position },
    });
    return res.json(stage);
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to update pipeline stage' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const stageId = parseInt(req.params.id);
    if (isGenericCrm(req) && req.query.pipelineId != null) {
      const pipelineId = Number(req.query.pipelineId);
      if (!(await ownsPipeline(req.user.tenantId, pipelineId))) return res.status(404).json({ error: 'Pipeline not found' });
      await prisma.pipelineStageAssignment.delete({ where: { pipelineId_stageId: { pipelineId, stageId } } });
      return res.status(204).end();
    }

    const existing = await prisma.pipelineStage.findFirst({ where: { id: stageId, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Pipeline stage not found' });
    await prisma.pipelineStage.delete({ where: { id: existing.id } });
    return res.status(204).end();
  } catch (_err) {
    return res.status(500).json({ error: 'Failed to delete pipeline stage' });
  }
});

module.exports = router;
