const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Fetch all drip sequences
router.get("/", verifyToken, async (req, res) => {
  try {
    const sequences = await prisma.sequence.findMany({
      include: {
        _count: { select: { enrollments: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(sequences);
  } catch(err) {
    res.status(500).json({ error: "Failed to read marketing sequences." });
  }
});

// Create new Drip Logic Matrix
router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, nodes, edges } = req.body;
    
    const seq = await prisma.sequence.create({
      data: {
        name,
        nodes: JSON.stringify(nodes),
        edges: JSON.stringify(edges),
        isActive: true
      }
    });

    res.status(201).json(seq);
  } catch(err) {
    res.status(500).json({ error: "Compilation of Drip Array failed." });
  }
});

// Toggle Master Sequence State
router.patch("/:id/toggle", verifyToken, async (req, res) => {
  try {
    const { isActive } = req.body;
    await prisma.sequence.update({
      where: { id: parseInt(req.params.id) },
      data: { isActive }
    });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: "Failed to toggle sequence." });
  }
});

// Update sequence (save over existing)
router.patch("/:id", verifyToken, async (req, res) => {
  try {
    const { name, nodes, edges, isActive } = req.body;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sequence ID' });
    const updated = await prisma.sequence.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(nodes !== undefined && { nodes: JSON.stringify(nodes) }),
        ...(edges !== undefined && { edges: JSON.stringify(edges) }),
        ...(isActive !== undefined && { isActive }),
      }
    });
    res.json(updated);
  } catch(err) {
    res.status(500).json({ error: "Failed to update sequence." });
  }
});

// Delete sequence
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid sequence ID' });
    // Delete enrollments first
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: id } });
    await prisma.sequence.delete({ where: { id } });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: "Failed to delete sequence." });
  }
});

module.exports = router;
