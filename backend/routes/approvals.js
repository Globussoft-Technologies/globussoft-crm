const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

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
      if (existing.status !== "PENDING") {
        return res
          .status(400)
          .json({ error: `Request already ${existing.status.toLowerCase()}` });
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
      if (existing.status !== "PENDING") {
        return res
          .status(400)
          .json({ error: `Request already ${existing.status.toLowerCase()}` });
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

      const [hydrated] = await hydrateUsers([updated], tenantId);
      res.json(hydrated);
    } catch (err) {
      console.error("[approvals][POST /:id/reject]", err);
      res.status(500).json({ error: "Failed to reject request" });
    }
  }
);

module.exports = router;
