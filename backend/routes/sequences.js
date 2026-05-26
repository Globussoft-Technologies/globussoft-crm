const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

// #616: drip-sequence trigger catalog. Generic triggers are always
// available; wellness triggers are surfaced only when the caller's tenant
// is `vertical='wellness'`. The sequence engine itself is timer-based —
// these triggers are emitted on the eventBus and consumed via
// AutomationRule rows (sequence enrolment is one possible action). The
// catalog is the user-facing UI surface that lets a marketer pick a
// wellness event when authoring a drip.
const GENERIC_SEQUENCE_TRIGGERS = [
  { value: "contact.created", label: "Contact Created", description: "Fires when a new contact is added", vertical: "generic" },
  { value: "contact.updated", label: "Contact Updated", description: "Fires when a contact is modified", vertical: "generic" },
  { value: "lead.converted", label: "Lead Converted", description: "Fires when a lead becomes a customer", vertical: "generic" },
  { value: "deal.won", label: "Deal Won", description: "Fires when a deal is marked as won", vertical: "generic" },
  { value: "deal.lost", label: "Deal Lost", description: "Fires when a deal is marked as lost", vertical: "generic" },
];

const WELLNESS_SEQUENCE_TRIGGERS = [
  { value: "visit.scheduled", label: "Visit Scheduled", description: "Fires when a Visit is created (booked appointment) — useful for confirmation drips", vertical: "wellness" },
  { value: "visit.completed", label: "Visit Completed", description: "Fires when a Visit transitions to status='completed' — useful for aftercare drips", vertical: "wellness" },
  { value: "treatment.started", label: "Treatment Plan Started", description: "Fires when a TreatmentPlan is created — useful for plan onboarding drips", vertical: "wellness" },
  { value: "consent.signed", label: "Consent Signed", description: "Fires when a ConsentForm is captured — useful for pre-procedure prep drips", vertical: "wellness" },
];

function listTriggersForVertical(vertical) {
  const list = [...GENERIC_SEQUENCE_TRIGGERS];
  if (vertical === "wellness") list.push(...WELLNESS_SEQUENCE_TRIGGERS);
  return list;
}

// GET /triggers — vertical-aware trigger catalog for the Sequences UI
// (Marketing → Sequences → trigger picker, #616).
router.get("/triggers", verifyToken, (req, res) => {
  const vertical = req.user?.vertical || "generic";
  res.json(listTriggersForVertical(vertical));
});

// ============================================================================
// GET /api/sequences/stats — tenant-wide drip-sequence rollup
//
// CRM polish — first /stats endpoint for the drip-sequence route. Read-only
// KPI surface for the Marketing → Sequences dashboard. Mirrors the
// /api/travel/suppliers/stats posture: a single aggregate roundtrip that
// replaces the N+1 the frontend would otherwise need ({list + count by
// status + enrollment counts × 3 + last-created}).
//
// Schema reality (verified against prisma/schema.prisma → models Sequence
// + SequenceEnrollment lines 996, 1018):
//   - Sequence has NO `status` column. The active/paused flag is the
//     `isActive` Boolean. So `byStatus` is sourced from isActive — keys
//     'active' (true) and 'inactive' (false). No 'paused' / 'archived'
//     buckets exist in the live schema; both map to inactive.
//   - SequenceEnrollment.status is a free String defaulting to "Active",
//     with documented values "Active" / "Paused" / "Completed" /
//     "Unenrolled" (see schema comment + route handlers at
//     /enrollments/:id/{pause,resume} + /enroll). The handler matches the
//     case used by the writers (capitalised) so historical rows aren't
//     double-counted. activeEnrollments := status === 'Active' (excludes
//     Completed + Cancelled/Unenrolled + Paused).
//
// Query params:
//   - ?from / ?to — optional ISO date bounds on Sequence.createdAt; invalid
//     → 400 INVALID_DATE.
//
// Tenant-scoped via req.user.tenantId. Read-only meta surface — NO audit
// row written.
//
// Response envelope:
//   {
//     total: N,
//     byStatus: { active: N, inactive: M },
//     totalEnrollments: N,
//     activeEnrollments: N,
//     completedEnrollments: N,
//     cancelledEnrollments: N,
//     lastCreatedAt: ISO | null,
//   }
//
// Express route ordering: literal-path /stats MUST be declared BEFORE the
// /:id family (line 142+) or `:id="stats"` would 400 INVALID_ID before
// reaching this handler.
// ============================================================================
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Optional ISO date bounds on Sequence.createdAt
    const sequenceWhere = { tenantId };
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
      sequenceWhere.createdAt = Object.assign(
        sequenceWhere.createdAt || {},
        { gte: d },
      );
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      sequenceWhere.createdAt = Object.assign(
        sequenceWhere.createdAt || {},
        { lte: d },
      );
    }

    // Pull the minimal column set we need for in-process aggregation.
    // For a typical CRM tenant the sequence count is bounded in the low
    // hundreds (one row per drip the team has authored) so no cap needed.
    const sequences = await prisma.sequence.findMany({
      where: sequenceWhere,
      select: {
        id: true,
        isActive: true,
        createdAt: true,
      },
    });

    let activeCount = 0;
    let inactiveCount = 0;
    let lastCreatedAt = null;
    for (const s of sequences) {
      if (s.isActive) activeCount += 1;
      else inactiveCount += 1;
      const ts = s.createdAt instanceof Date ? s.createdAt : new Date(s.createdAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastCreatedAt || ts > lastCreatedAt) lastCreatedAt = ts;
      }
    }

    // Enrollment counts — same date-window narrowing on Sequence.createdAt
    // applies via the parent sequence join.
    const enrollmentBaseWhere = { sequence: sequenceWhere };
    const [totalEnrollments, activeEnrollments, completedEnrollments, cancelledEnrollments] =
      await Promise.all([
        prisma.sequenceEnrollment.count({ where: enrollmentBaseWhere }),
        prisma.sequenceEnrollment.count({
          where: { ...enrollmentBaseWhere, status: "Active" },
        }),
        prisma.sequenceEnrollment.count({
          where: { ...enrollmentBaseWhere, status: "Completed" },
        }),
        prisma.sequenceEnrollment.count({
          where: { ...enrollmentBaseWhere, status: "Unenrolled" },
        }),
      ]);

    return res.json({
      total: sequences.length,
      byStatus: {
        active: activeCount,
        inactive: inactiveCount,
      },
      totalEnrollments,
      activeEnrollments,
      completedEnrollments,
      cancelledEnrollments,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[sequences] stats error:", err.message);
    return res.status(500).json({ error: "Failed to summarise sequences" });
  }
});

// v3.4.11: sanitization helpers moved to backend/lib/sanitizeJson.js so the
// 4 routes identified by the v3.4.10 audit (lead_routing, ab_tests, marketing,
// report_schedules) can adopt the same toolkit. sanitizeText handles
// HTML-stripping with merge-tag preservation; sanitizeJson is shape-preserving
// for object → object handoff (e.g. real JSON-typed Prisma columns);
// sanitizeJsonForStringColumn wraps sanitizeJson + stringifies for
// `String? @db.Text` storage columns like SequenceStep.conditionJson.
const {
  sanitizeText,
  sanitizeJson,
  sanitizeJsonForStringColumn,
} = require("../lib/sanitizeJson");

// Walk an array of ReactFlow nodes and strip any text inside data.label so a
// payload like `{ data: { label: "<img onerror=…>" } }` cannot persist.
// This wrapper is sequence-specific (knows the ReactFlow node shape) so it
// stays local to this route.
const sanitizeNodes = (nodes) => {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((n) => {
    if (n && typeof n === "object" && n.data && typeof n.data === "object") {
      const data = { ...n.data };
      if (typeof data.label === "string") data.label = sanitizeText(data.label);
      if (typeof data.content === "string") data.content = sanitizeText(data.content);
      return { ...n, data };
    }
    return n;
  });
};

// Fetch all drip sequences
// GET /api/sequences?fields=summary
router.get("/", verifyToken, async (req, res) => {
  try {
    // #920 slice 12: ?fields=summary slim-shape opt-in. Mirrors slice 1
    // (contacts f7790241), slice 2 (deals 6786c2da), slice 3 (tickets
    // badc9cca), slice 4 (tasks eec7d856), slice 5 (projects 257771a0),
    // slice 6 (expenses e81e6cb5), slice 7 (notifications a3487518),
    // slice 8 (surveys e71594d9), slice 9 (email-templates 0d4a63f9),
    // slice 10 (knowledge-base 21ad3290).
    // When the caller passes ?fields=summary we drop the heavy
    // `nodes`/`edges` columns (Sequence.nodes/edges are `String? @db.Text`
    // JSON blobs storing legacy ReactFlow canvas — can be many KB per row)
    // and the `_count` include, returning only the columns the sequence
    // list renderer actually needs. Opt-in additive — existing callers
    // (no ?fields, or any non-exact value) get the full row shape unchanged.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        isActive: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
      };
    } else {
      findManyArgs.include = {
        _count: { select: { enrollments: true } }
      };
    }

    const sequences = await prisma.sequence.findMany(findManyArgs);
    res.json(sequences);
  } catch(_err) {
    res.status(500).json({ error: "Failed to read marketing sequences." });
  }
});

// Create new Drip Logic Matrix
router.post("/", verifyToken, async (req, res) => {
  try {
    const { name, nodes, edges } = req.body;

    // #396: reject empty/whitespace-only names (same pattern as #337 /pipelines).
    const cleanName = sanitizeText(name);
    if (!cleanName || cleanName.length < 1) {
      return res.status(400).json({
        error: "Sequence name is required.",
        code: "INVALID_SEQUENCE",
      });
    }

    // #395: validate the canvas shape before we hand it to JSON.stringify +
    // Prisma. nodes must be an array (edges may be empty); anything else
    // would surface as an opaque internal error downstream.
    if (!Array.isArray(nodes)) {
      return res.status(400).json({
        error: "Sequence validation failed",
        code: "INVALID_SEQUENCE",
      });
    }

    // #374: newly-created drips must land as DRAFT (isActive=false) so the
    // engine doesn't begin firing emails the second the owner clicks Save.
    // The owner explicitly toggles Active from the builder once the flow is
    // verified. Honour an explicit { isActive: true } only when the caller
    // sends it (e.g. a future "save & activate" button).
    const { isActive } = req.body;
    const seq = await prisma.sequence.create({
      data: {
        name: cleanName,
        // #398: scrub HTML out of any node labels before persisting.
        nodes: JSON.stringify(sanitizeNodes(nodes)),
        edges: JSON.stringify(Array.isArray(edges) ? edges : []),
        isActive: isActive === true ? true : false,
        tenantId: req.user.tenantId,
      }
    });

    res.status(201).json(seq);
  } catch(err) {
    // #395: do not leak raw err.message ("Compilation of Drip Array failed.")
    // to the client. Log internally; return a sanitized code-tagged response.
    console.error("[sequences] create failed:", err.message);
    res.status(500).json({
      error: "Sequence validation failed",
      code: "INVALID_SEQUENCE",
    });
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
  } catch(_err) {
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
    // #396 + #398: same trim/sanitize rules apply on update so a rename to "  "
    // or "<script>…" doesn't get through the back door.
    let cleanName;
    if (name !== undefined) {
      cleanName = sanitizeText(name);
      if (!cleanName || cleanName.length < 1) {
        return res.status(400).json({
          error: "Sequence name is required.",
          code: "INVALID_SEQUENCE",
        });
      }
    }
    if (nodes !== undefined && !Array.isArray(nodes)) {
      return res.status(400).json({
        error: "Sequence validation failed",
        code: "INVALID_SEQUENCE",
      });
    }

    const updated = await prisma.sequence.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name: cleanName }),
        ...(nodes !== undefined && { nodes: JSON.stringify(sanitizeNodes(nodes)) }),
        ...(edges !== undefined && { edges: JSON.stringify(Array.isArray(edges) ? edges : []) }),
        ...(isActive !== undefined && { isActive }),
      }
    });
    res.json(updated);
  } catch(err) {
    console.error("[sequences] update failed:", err.message);
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
  } catch(_err) {
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
  } catch(_err) {
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
  } catch(_err) {
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
  } catch(_err) {
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
  } catch(_err) {
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
  } catch (_err) {
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

    // #375: reject non-numeric delayMinutes server-side. The frontend already
    // forces type="number", but anyone POSTing directly (curl / partner API)
    // could ship "tomorrow" / "a bit later" and stall the engine on NaN.
    if (delayMinutes !== undefined && delayMinutes !== null && delayMinutes !== "") {
      const dmRaw = String(delayMinutes).trim();
      if (!/^\d+$/.test(dmRaw)) {
        return res.status(400).json({
          error: "delayMinutes must be a non-negative integer",
          code: "INVALID_DELAY",
        });
      }
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

    // v3.4.9 carry-over #1: scrub HTML out of free-text step fields
    // before persisting. smsBody is plain text (merge-tags pass through);
    // conditionJson may be an object or string blob — sanitizeJsonForStringColumn
    // walks every string value recursively AND stringifies an object input
    // because SequenceStep.conditionJson is `String? @db.Text` (Prisma
    // rejects an object here).
    const cleanSmsBody = smsBody != null ? sanitizeText(smsBody) : null;
    const cleanConditionJson = sanitizeJsonForStringColumn(conditionJson);

    const created = await prisma.sequenceStep.create({
      data: {
        sequenceId: seq.id,
        position: target,
        kind,
        emailTemplateId: emailTemplateId != null ? parseInt(emailTemplateId, 10) : null,
        smsBody: cleanSmsBody || null,
        delayMinutes: delayMinutes != null ? parseInt(delayMinutes, 10) : null,
        conditionJson: cleanConditionJson || null,
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

    // #375: same numeric guard on update — must reject "tomorrow" etc.
    if (delayMinutes !== undefined && delayMinutes !== null && delayMinutes !== "") {
      const dmRaw = String(delayMinutes).trim();
      if (!/^\d+$/.test(dmRaw)) {
        return res.status(400).json({
          error: "delayMinutes must be a non-negative integer",
          code: "INVALID_DELAY",
        });
      }
    }

    // v3.4.9 carry-over #1: same step-level sanitization on update.
    const updated = await prisma.sequenceStep.update({
      where: { id: existing.id },
      data: {
        ...(kind !== undefined && { kind }),
        ...(emailTemplateId !== undefined && {
          emailTemplateId: emailTemplateId == null ? null : parseInt(emailTemplateId, 10),
        }),
        ...(smsBody !== undefined && { smsBody: smsBody == null ? null : sanitizeText(smsBody) }),
        ...(delayMinutes !== undefined && {
          delayMinutes: delayMinutes == null ? null : parseInt(delayMinutes, 10),
        }),
        ...(conditionJson !== undefined && { conditionJson: sanitizeJsonForStringColumn(conditionJson) }),
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
  } catch(_err) {
    res.status(500).json({ error: "Tick failed." });
  }
});

// v3.4.9 carry-over #1: expose the sanitization helpers for unit tests
// (backend/test/utils/sanitize-json.test.js). Express routers ignore
// extra properties on the exported function, so this is a no-op for the
// runtime app.mount() path.
module.exports = router;
module.exports.sanitizeText = sanitizeText;
module.exports.sanitizeJson = sanitizeJson;
module.exports.sanitizeNodes = sanitizeNodes;
// #616: expose the trigger catalog + helper for unit tests.
module.exports.GENERIC_SEQUENCE_TRIGGERS = GENERIC_SEQUENCE_TRIGGERS;
module.exports.WELLNESS_SEQUENCE_TRIGGERS = WELLNESS_SEQUENCE_TRIGGERS;
module.exports.listTriggersForVertical = listTriggersForVertical;
