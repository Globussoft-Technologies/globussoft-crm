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

// ─── Enrollment-level controls ──────────────────────────────────────────
// Tenant ownership is enforced via the parent sequence's tenantId (the
// enrollment.tenantId column has a default and is not always trustable on
// its own — joining through the sequence is the canonical check).
const findEnrollmentForTenant = async (id, tenantId) => {
  if (isNaN(id)) return null;
  return prisma.sequenceEnrollment.findFirst({
    where: { id, sequence: { tenantId } },
  });
};

// Pause an active enrollment — engine skips Paused rows because tickSequenceEngine
// only loads status='Active'. Clearing nextRun avoids an immediate fire on resume.
router.patch("/enrollments/:id/pause", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await findEnrollmentForTenant(id, req.user.tenantId);
    if (!existing) return res.status(404).json({ error: "Enrollment not found" });
    const updated = await prisma.sequenceEnrollment.update({
      where: { id: existing.id },
      data: { status: 'Paused', nextRun: null },
    });
    res.json({ success: true, enrollment: updated });
  } catch(err) {
    res.status(500).json({ error: "Failed to pause enrollment." });
  }
});

// Resume a paused enrollment. nextRun=now() so the next cron tick (≤60s)
// picks it up and continues from the stored currentNode cursor.
router.patch("/enrollments/:id/resume", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await findEnrollmentForTenant(id, req.user.tenantId);
    if (!existing) return res.status(404).json({ error: "Enrollment not found" });
    const updated = await prisma.sequenceEnrollment.update({
      where: { id: existing.id },
      data: { status: 'Active', nextRun: new Date() },
    });
    res.json({ success: true, enrollment: updated });
  } catch(err) {
    res.status(500).json({ error: "Failed to resume enrollment." });
  }
});

// Soft-delete (unenroll). We keep the row so audit / analytics can still see
// historical drip activity for this contact; the engine ignores any status
// other than 'Active'.
router.delete("/enrollments/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await findEnrollmentForTenant(id, req.user.tenantId);
    if (!existing) return res.status(404).json({ error: "Enrollment not found" });
    const updated = await prisma.sequenceEnrollment.update({
      where: { id: existing.id },
      data: { status: 'Unenrolled', nextRun: null },
    });
    res.json({ success: true, enrollment: updated });
  } catch(err) {
    res.status(500).json({ error: "Failed to unenroll." });
  }
});

// ─── SequenceStep CRUD (#9 step-list rebuild) ───────────────────────────
// New explicit step-list editor. The engine treats Sequence.steps as the
// canonical drip definition when non-empty; legacy ReactFlow canvas remains
// the fallback for sequences that haven't been migrated.

const ALLOWED_KINDS = ["email", "sms", "wait", "condition"];

// All step routes are admin-only — drips touch real inboxes and are
// inherently destructive if mis-edited.
const stepGuard = [verifyToken, verifyRole(["ADMIN"])];

// Helper: confirm sequence belongs to caller's tenant.
const findSequenceForTenant = async (id, tenantId) => {
  if (isNaN(id)) return null;
  return prisma.sequence.findFirst({ where: { id, tenantId } });
};

// GET /:id/steps — ordered step list for a sequence
router.get("/:id/steps", ...stepGuard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const seq = await findSequenceForTenant(id, req.user.tenantId);
    if (!seq) return res.status(404).json({ error: "Sequence not found" });
    const steps = await prisma.sequenceStep.findMany({
      where: { sequenceId: seq.id },
      include: { emailTemplate: { select: { id: true, name: true, subject: true } } },
      orderBy: { position: "asc" },
    });
    res.json(steps);
  } catch (err) {
    res.status(500).json({ error: "Failed to read steps." });
  }
});

// POST /:id/steps — append a new step (or insert at body.position with
// subsequent rows shifted +1).
router.post("/:id/steps", ...stepGuard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const seq = await findSequenceForTenant(id, req.user.tenantId);
    if (!seq) return res.status(404).json({ error: "Sequence not found" });

    const {
      kind, emailTemplateId, smsBody, delayMinutes,
      conditionJson, trueNextPosition, falseNextPosition,
      pauseOnReply, position,
    } = req.body || {};

    if (!ALLOWED_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${ALLOWED_KINDS.join(", ")}` });
    }

    // Determine target position.
    const last = await prisma.sequenceStep.findFirst({
      where: { sequenceId: seq.id },
      orderBy: { position: "desc" },
    });
    const append = last ? last.position + 1 : 0;
    const target = (position == null || isNaN(parseInt(position, 10))) ? append : parseInt(position, 10);

    // If inserting BEFORE the end, shift everything at >= target up by 1
    // BEFORE we create the new row, so the @@unique([sequenceId, position])
    // constraint isn't violated. We do the shift in descending order to
    // avoid a transient duplicate.
    if (target <= append - 1) {
      const toShift = await prisma.sequenceStep.findMany({
        where: { sequenceId: seq.id, position: { gte: target } },
        orderBy: { position: "desc" },
      });
      for (const s of toShift) {
        await prisma.sequenceStep.update({
          where: { id: s.id },
          data: { position: s.position + 1 },
        });
      }
    }

    const created = await prisma.sequenceStep.create({
      data: {
        sequenceId: seq.id,
        position: target,
        kind,
        emailTemplateId: emailTemplateId != null ? parseInt(emailTemplateId, 10) : null,
        smsBody: smsBody || null,
        delayMinutes: delayMinutes != null ? parseInt(delayMinutes, 10) : null,
        conditionJson: conditionJson || null,
        trueNextPosition: trueNextPosition != null ? parseInt(trueNextPosition, 10) : null,
        falseNextPosition: falseNextPosition != null ? parseInt(falseNextPosition, 10) : null,
        pauseOnReply: pauseOnReply == null ? true : !!pauseOnReply,
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error("[sequences] create step failed:", err.message);
    res.status(500).json({ error: "Failed to create step." });
  }
});

// PUT /steps/:id — update one step (tenant scoped via parent sequence)
router.put("/steps/:id", ...stepGuard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid step ID" });
    const existing = await prisma.sequenceStep.findFirst({
      where: { id, sequence: { tenantId: req.user.tenantId } },
    });
    if (!existing) return res.status(404).json({ error: "Step not found" });

    const {
      kind, emailTemplateId, smsBody, delayMinutes,
      conditionJson, trueNextPosition, falseNextPosition,
      pauseOnReply,
    } = req.body || {};

    if (kind != null && !ALLOWED_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${ALLOWED_KINDS.join(", ")}` });
    }

    const updated = await prisma.sequenceStep.update({
      where: { id: existing.id },
      data: {
        ...(kind !== undefined && { kind }),
        ...(emailTemplateId !== undefined && {
          emailTemplateId: emailTemplateId == null ? null : parseInt(emailTemplateId, 10),
        }),
        ...(smsBody !== undefined && { smsBody }),
        ...(delayMinutes !== undefined && {
          delayMinutes: delayMinutes == null ? null : parseInt(delayMinutes, 10),
        }),
        ...(conditionJson !== undefined && { conditionJson }),
        ...(trueNextPosition !== undefined && {
          trueNextPosition: trueNextPosition == null ? null : parseInt(trueNextPosition, 10),
        }),
        ...(falseNextPosition !== undefined && {
          falseNextPosition: falseNextPosition == null ? null : parseInt(falseNextPosition, 10),
        }),
        ...(pauseOnReply !== undefined && { pauseOnReply: !!pauseOnReply }),
      },
    });
    res.json(updated);
  } catch (err) {
    console.error("[sequences] update step failed:", err.message);
    res.status(500).json({ error: "Failed to update step." });
  }
});

// DELETE /steps/:id — remove + auto-renumber subsequent positions so we
// never leave a hole that the engine would interpret as "completed".
router.delete("/steps/:id", ...stepGuard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid step ID" });
    const existing = await prisma.sequenceStep.findFirst({
      where: { id, sequence: { tenantId: req.user.tenantId } },
    });
    if (!existing) return res.status(404).json({ error: "Step not found" });

    const { sequenceId, position } = existing;
    await prisma.sequenceStep.delete({ where: { id: existing.id } });

    // Compact: shift later rows down by 1 (ascending so we don't break the
    // unique constraint mid-loop).
    const tail = await prisma.sequenceStep.findMany({
      where: { sequenceId, position: { gt: position } },
      orderBy: { position: "asc" },
    });
    for (const s of tail) {
      await prisma.sequenceStep.update({
        where: { id: s.id },
        data: { position: s.position - 1 },
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[sequences] delete step failed:", err.message);
    res.status(500).json({ error: "Failed to delete step." });
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
