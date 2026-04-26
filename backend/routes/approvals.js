const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

// ─── Helper: audit log ───────────────────────────────────────────────
// Mirrors the pattern in routes/deals.js — non-critical writes (best-effort).
async function audit(action, entityId, userId, tenantId, details) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entity: "ApprovalRequest",
        entityId,
        userId,
        tenantId,
        details: typeof details === "string" ? details : JSON.stringify(details),
      },
    });
  } catch (_) {
    /* non-critical */
  }
}

// Helper: hydrate requester / approver user objects (Prisma model has no
// declared relations, so we fetch users explicitly and graft them on).
async function hydrateUsers(requests, tenantId) {
  if (!Array.isArray(requests) || requests.length === 0) return requests;

  const userIds = new Set();
  for (const r of requests) {
    if (r.requestedBy) userIds.add(r.requestedBy);
    if (r.approvedBy) userIds.add(r.approvedBy);
  }
  if (userIds.size === 0) return requests;

  const users = await prisma.user.findMany({
    where: { id: { in: Array.from(userIds) } },
    select: { id: true, name: true, email: true, role: true },
  });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));

  return requests.map((r) => ({
    ...r,
    requester: byId[r.requestedBy] || null,
    approver: r.approvedBy ? byId[r.approvedBy] || null : null,
  }));
}

// ── GET /api/approvals ─ list approval requests for tenant ───────
router.get("/", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { status, entity } = req.query;

    const where = { tenantId };
    if (status) where.status = status;
    if (entity) where.entity = entity;

    const requests = await prisma.approvalRequest.findMany({
      where,
      orderBy: { requestedAt: "desc" },
    });
    const hydrated = await hydrateUsers(requests, tenantId);
    res.json(hydrated);
  } catch (err) {
    console.error("[approvals][GET /]", err);
    res.status(500).json({ error: "Failed to fetch approval requests" });
  }
});

// ── GET /api/approvals/pending-count ─ badge count ───────────────
// For ADMIN/MANAGER: count of all PENDING in the tenant (their queue).
// For USER: count of their own PENDING requests.
router.get("/pending-count", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const role = req.user.role;
    const where = { tenantId, status: "PENDING" };
    if (role !== "ADMIN" && role !== "MANAGER") {
      where.requestedBy = req.user.userId;
    }
    const count = await prisma.approvalRequest.count({ where });
    res.json({ count });
  } catch (err) {
    console.error("[approvals][GET /pending-count]", err);
    res.status(500).json({ error: "Failed to fetch pending count" });
  }
});

// ── GET /api/approvals/my-requests ─ requests created by me ──────
router.get("/my-requests", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.userId;
    const { status, entity } = req.query;

    const where = { tenantId, requestedBy: userId };
    if (status) where.status = status;
    if (entity) where.entity = entity;

    const requests = await prisma.approvalRequest.findMany({
      where,
      orderBy: { requestedAt: "desc" },
    });
    const hydrated = await hydrateUsers(requests, tenantId);
    res.json(hydrated);
  } catch (err) {
    console.error("[approvals][GET /my-requests]", err);
    res.status(500).json({ error: "Failed to fetch my requests" });
  }
});

// ── GET /api/approvals/to-approve ─ ADMIN/MANAGER queue ──────────
router.get(
  "/to-approve",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      const { entity } = req.query;
      const where = { tenantId, status: "PENDING" };
      if (entity) where.entity = entity;

      const requests = await prisma.approvalRequest.findMany({
        where,
        orderBy: { requestedAt: "asc" },
      });
      const hydrated = await hydrateUsers(requests, tenantId);
      res.json(hydrated);
    } catch (err) {
      console.error("[approvals][GET /to-approve]", err);
      res.status(500).json({ error: "Failed to fetch approval queue" });
    }
  }
);

// ── POST /api/approvals ─ create new request ─────────────────────
router.post("/", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.userId;
    const { entity, entityId, reason } = req.body || {};

    if (!entity || typeof entity !== "string" || !entity.trim()) {
      return res.status(400).json({ error: "entity is required" });
    }
    const entityIdInt = parseInt(entityId, 10);
    if (Number.isNaN(entityIdInt)) {
      return res.status(400).json({ error: "entityId must be an integer" });
    }

    const created = await prisma.approvalRequest.create({
      data: {
        entity: entity.trim(),
        entityId: entityIdInt,
        reason: reason ? String(reason) : null,
        status: "PENDING",
        requestedBy: userId,
        tenantId,
      },
    });
    const [hydrated] = await hydrateUsers([created], tenantId);
    res.status(201).json(hydrated);
  } catch (err) {
    console.error("[approvals][POST /]", err);
    res.status(500).json({ error: "Failed to create approval request" });
  }
});

// ── POST /api/approvals/:id/approve ─ ADMIN/MANAGER only ─────────
router.post(
  "/:id/approve",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid approval id" });
      }
      const { comment } = req.body || {};

      const existing = await prisma.approvalRequest.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "Approval request not found" });
      }

      // State-machine guards (mirrors wellness.js /recommendations/:id/approve):
      //  - Re-approve an APPROVED row → 200 idempotent (no-op, no double audit).
      //  - Approve a REJECTED row     → 422 INVALID_APPROVAL_TRANSITION.
      if (existing.status === "APPROVED") {
        const [hydrated] = await hydrateUsers([existing], tenantId);
        return res.json({ ...hydrated, idempotent: true });
      }
      if (existing.status === "REJECTED") {
        return res.status(422).json({
          error: "Cannot approve a rejected request",
          code: "INVALID_APPROVAL_TRANSITION",
          currentStatus: existing.status,
        });
      }
      if (existing.status !== "PENDING") {
        return res.status(422).json({
          error: `Cannot approve from status '${existing.status}'`,
          code: "INVALID_APPROVAL_TRANSITION",
          currentStatus: existing.status,
        });
      }

      const updated = await prisma.approvalRequest.update({
        where: { id },
        data: {
          status: "APPROVED",
          approvedBy: req.user.userId,
          approvedAt: new Date(),
          comment: comment ? String(comment) : existing.comment,
        },
      });

      // Discount-on-Deal note: we deliberately do NOT mutate the deal here.
      // The original requester is responsible for applying the discount once
      // approval is granted; this endpoint just records the decision.
      if (
        updated.entity === "Deal" &&
        (updated.reason || "").toLowerCase().includes("discount")
      ) {
        console.log(
          `[approvals] Deal #${updated.entityId} discount approved by user ${req.user.userId}; requester must apply.`
        );
      }

      await audit("APPROVE", updated.id, req.user.userId, tenantId, {
        from: existing.status,
        to: updated.status,
        entity: updated.entity,
        entityId: updated.entityId,
      });

      const [hydrated] = await hydrateUsers([updated], tenantId);
      res.json(hydrated);
    } catch (err) {
      console.error("[approvals][POST /:id/approve]", err);
      res.status(500).json({ error: "Failed to approve request" });
    }
  }
);

// ── POST /api/approvals/:id/reject ─ ADMIN/MANAGER only ──────────
router.post(
  "/:id/reject",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid approval id" });
      }
      const { comment } = req.body || {};
      if (!comment || !String(comment).trim()) {
        return res
          .status(400)
          .json({ error: "comment is required when rejecting" });
      }

      const existing = await prisma.approvalRequest.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "Approval request not found" });
      }

      // State-machine guards (mirrors wellness.js /recommendations/:id/reject):
      //  - Re-reject a REJECTED row → 200 idempotent.
      //  - Reject an APPROVED row   → 422 INVALID_APPROVAL_TRANSITION.
      if (existing.status === "REJECTED") {
        const [hydrated] = await hydrateUsers([existing], tenantId);
        return res.json({ ...hydrated, idempotent: true });
      }
      if (existing.status === "APPROVED") {
        return res.status(422).json({
          error: "Cannot reject an already-approved request",
          code: "INVALID_APPROVAL_TRANSITION",
          currentStatus: existing.status,
        });
      }
      if (existing.status !== "PENDING") {
        return res.status(422).json({
          error: `Cannot reject from status '${existing.status}'`,
          code: "INVALID_APPROVAL_TRANSITION",
          currentStatus: existing.status,
        });
      }

      const updated = await prisma.approvalRequest.update({
        where: { id },
        data: {
          status: "REJECTED",
          approvedBy: req.user.userId,
          approvedAt: new Date(),
          comment: String(comment),
        },
      });

      await audit("REJECT", updated.id, req.user.userId, tenantId, {
        from: existing.status,
        to: updated.status,
        entity: updated.entity,
        entityId: updated.entityId,
        comment: updated.comment,
      });

      const [hydrated] = await hydrateUsers([updated], tenantId);
      res.json(hydrated);
    } catch (err) {
      console.error("[approvals][POST /:id/reject]", err);
      res.status(500).json({ error: "Failed to reject request" });
    }
  }
);

// ── DELETE /api/approvals/:id ─ ADMIN-only hard delete ───────────
// Schema has no soft-delete column (no deletedAt; status is a free String but
// docstring restricts to PENDING/APPROVED/REJECTED — adding a "DELETED" value
// would silently bypass tenant filters that key on those three). We hard-delete
// after writing the audit row so the trail survives.
router.delete(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid approval id" });
      }

      const existing = await prisma.approvalRequest.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        return res.status(404).json({ error: "Approval request not found" });
      }

      // Audit BEFORE delete so the trail isn't lost if the delete races.
      await audit("DELETE", existing.id, req.user.userId, tenantId, {
        entity: existing.entity,
        entityId: existing.entityId,
        status: existing.status,
        requestedBy: existing.requestedBy,
        approvedBy: existing.approvedBy,
        reason: existing.reason,
      });

      await prisma.approvalRequest.delete({ where: { id } });

      res.json({ success: true, id });
    } catch (err) {
      console.error("[approvals][DELETE /:id]", err);
      res.status(500).json({ error: "Failed to delete approval request" });
    }
  }
);

module.exports = router;
