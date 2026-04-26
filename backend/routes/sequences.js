const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

// Fetch all drip sequences
router.get("/", verifyToken, async (req, res) => {
  try {
    const sequences = await prisma.sequence.findMany({
      where: { tenantId: req.user.tenantId },
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
        isActive: true,
        tenantId: req.user.tenantId,
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
    const existing = await prisma.sequence.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Sequence not found" });
    await prisma.sequence.update({
      where: { id: existing.id },
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
    const existing = await prisma.sequence.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Sequence not found" });
    const updated = await prisma.sequence.update({
      where: { id: existing.id },
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
    const existing = await prisma.sequence.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Sequence not found" });
    // Delete enrollments first
    await prisma.sequenceEnrollment.deleteMany({ where: { sequenceId: existing.id } });
    await prisma.sequence.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: "Failed to delete sequence." });
  }
});

// Enroll a contact in a sequence
router.post("/:id/enroll", verifyToken, async (req, res) => {
  try {
    const sequenceId = parseInt(req.params.id);
    const { contactId } = req.body;
    if (isNaN(sequenceId) || !contactId) return res.status(400).json({ error: 'Valid sequence ID and contactId required' });

    const sequence = await prisma.sequence.findFirst({ where: { id: sequenceId, tenantId: req.user.tenantId } });
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });

    const contact = await prisma.contact.findFirst({ where: { id: parseInt(contactId), tenantId: req.user.tenantId } });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // Check if already enrolled
    const existing = await prisma.sequenceEnrollment.findFirst({
      where: { sequenceId, contactId: contact.id }
    });

    if (existing) {
      return res.status(400).json({ error: 'Contact is already enrolled in this sequence' });
    }

    const enrollment = await prisma.sequenceEnrollment.create({
      data: {
        sequenceId,
        contactId: contact.id,
        status: 'Active',
        tenantId: req.user.tenantId,
      }
    });

    res.json({ success: true, enrollment });
  } catch(err) {
    res.status(500).json({ error: "Failed to enroll contact." });
  }
});

// Debug endpoint to manually trigger a cron tick. Already implicitly gated
// by the global /api/* auth guard (any unauthenticated caller gets 403);
// tightened here to ADMIN-only since this drives the engine for every tenant.
router.post("/debug/tick", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { tickSequenceEngine } = require('../cron/sequenceEngine');
    await tickSequenceEngine();
    res.json({ success: true, message: 'Cron tick fired' });
  } catch(err) {
    res.status(500).json({ error: "Tick failed." });
  }
});

module.exports = router;
