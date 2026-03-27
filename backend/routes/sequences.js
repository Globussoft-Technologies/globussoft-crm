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

module.exports = router;
