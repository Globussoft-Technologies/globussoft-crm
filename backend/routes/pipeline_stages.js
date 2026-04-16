const express = require('express');
const { verifyToken } = require('../middleware/auth');
const router = express.Router();
const prisma = require("../lib/prisma");

router.use(verifyToken);

// List all stages ordered by position
router.get('/', async (req, res) => {
  try {
    const stages = await prisma.pipelineStage.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { position: 'asc' } });
    res.json(stages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pipeline stages' });
  }
});

// Create a new stage
router.post('/', async (req, res) => {
  try {
    const { name, color, position } = req.body;
    const stage = await prisma.pipelineStage.create({
      data: { name, color: color || '#3b82f6', position: position ?? 0, tenantId: req.user.tenantId }
    });
    res.status(201).json(stage);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create pipeline stage' });
  }
});

// Reorder stages — must be before /:id to avoid route conflict
router.put('/reorder', async (req, res) => {
  try {
    const { stages } = req.body;
    if (!Array.isArray(stages)) return res.status(400).json({ error: 'stages array required' });

    // Only update stages that belong to this tenant
    const ownedIds = (await prisma.pipelineStage.findMany({
      where: { tenantId: req.user.tenantId, id: { in: stages.map(s => s.id) } },
      select: { id: true }
    })).map(s => s.id);

    await Promise.all(
      stages.filter(s => ownedIds.includes(s.id)).map(s => prisma.pipelineStage.update({
        where: { id: s.id },
        data: { position: s.position }
      }))
    );

    const updated = await prisma.pipelineStage.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { position: 'asc' } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder stages' });
  }
});

// Update a stage
router.put('/:id', async (req, res) => {
  try {
    const { name, color, position } = req.body;
    const existing = await prisma.pipelineStage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Pipeline stage not found' });
    const stage = await prisma.pipelineStage.update({
      where: { id: existing.id },
      data: { name, color, position }
    });
    res.json(stage);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update pipeline stage' });
  }
});

// Delete a stage
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.pipelineStage.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Pipeline stage not found' });
    await prisma.pipelineStage.delete({ where: { id: existing.id } });
    res.json({ message: 'Stage deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete pipeline stage' });
  }
});

module.exports = router;
