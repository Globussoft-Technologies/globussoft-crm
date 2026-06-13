// PRD_TRAVEL_BILLING G022 (FR-3.5.e) — supplier-payable batch runs.
//
// A `TravelSupplierPayableBatch` groups N TravelSupplierPayable rows into a
// single bank-transfer run that an operator approves + sends to the bank as
// a CSV file. Mirror-pattern of TravelPurchaseOrder (G035/G036/G037):
//
//   draft → approved → sent_to_bank → settled
//                                       └──→ cancelled (terminal)
//   draft / approved / sent_to_bank ─────→ cancelled
//
// Each transition is gated; invalid transitions return 409
// INVALID_STATUS_TRANSITION with { from, to, allowed }.
//
// Numbering: TPB-YYYY-NNNN per-tenant per-year, race-safe via $transaction.
// Same shape as TPO-… (travel_purchase_orders.js nextPoNumber).
//
// On `settled`, every child payable's status flips → `paid` + `paidAt = now`
// in the same transaction with the batch flip. Cancelling the batch resets
// payable.payableBatchId to NULL (FK SetNull) — children become free again.
//
// CSV export (FR-3.5.e last bullet): GET /:id/payment-csv returns a
// bank-friendly CSV (Excel-style RFC 4180). Columns:
//   batchNumber,paymentMethod,supplierName,supplierGstin,bankAccountMasked,
//   amount,currency,description,poNumber,reference
//
// Sub-brand isolation: a batch is tenant-scoped only (a batch can mix
// suppliers across sub-brands — operator-driven). Adding a payable to the
// batch enforces sub-brand access on the parent supplier.
//
// Endpoints:
//   POST   /api/travel/payable-batches                        ADMIN+MGR — create draft from payable IDs
//   GET    /api/travel/payable-batches                        any — list (?status filter, paging)
//   GET    /api/travel/payable-batches/:id                    any — detail with linked payables
//   PUT    /api/travel/payable-batches/:id                    ADMIN+MGR — update (draft only)
//   POST   /api/travel/payable-batches/:id/add-payable        ADMIN+MGR — attach a payable
//   POST   /api/travel/payable-batches/:id/remove-payable     ADMIN+MGR — detach a payable (draft only)
//   POST   /api/travel/payable-batches/:id/approve            ADMIN — draft → approved
//   POST   /api/travel/payable-batches/:id/send-to-bank       ADMIN — approved → sent_to_bank
//   POST   /api/travel/payable-batches/:id/settle             ADMIN — sent_to_bank → settled (+ child payables paid)
//   POST   /api/travel/payable-batches/:id/cancel             ADMIN — terminal cancel (releases children)
//   GET    /api/travel/payable-batches/:id/payment-csv        ADMIN+MGR — bank-friendly CSV export

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

const VALID_STATUSES = ["draft", "approved", "sent_to_bank", "settled", "cancelled"];
const VALID_PAYMENT_METHODS = ["bank_transfer", "upi", "cheque", "rtgs", "neft", "wire"];

// State-machine transition matrix.
const TRANSITIONS = {
  draft: new Set(["approved", "cancelled"]),
  approved: new Set(["sent_to_bank", "cancelled"]),
  sent_to_bank: new Set(["settled", "cancelled"]),
  settled: new Set(), // terminal
  cancelled: new Set(), // terminal
};

function assertValidStatus(s) {
  if (!VALID_STATUSES.includes(s)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_STATUS";
    throw err;
  }
}

function assertValidPaymentMethod(s) {
  if (!VALID_PAYMENT_METHODS.includes(s)) {
    const err = new Error(`paymentMethod must be one of: ${VALID_PAYMENT_METHODS.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_PAYMENT_METHOD";
    throw err;
  }
}

// Build a TPB-YYYY-NNNN batch number for the caller's tenant, scoped to the
// current calendar year. Race-safe via $transaction so concurrent creates
// can't collide on the sequence number. Exposed via module.exports for the
// CJS self-spy seam.
async function nextBatchNumber(tenantId) {
  const year = new Date().getUTCFullYear();
  const prefix = `TPB-${year}-`;
  return prisma.$transaction(async (tx) => {
    const count = await tx.travelSupplierPayableBatch.count({
      where: {
        tenantId,
        batchNumber: { startsWith: prefix },
      },
    });
    return `${prefix}${String(count + 1).padStart(4, "0")}`;
  });
}

// Recompute cached batch totals (totalAmount + payableCount) after a
// payable is added / removed. Read inside a tx for serialisation.
async function recomputeBatchTotals(tx, batchId) {
  const agg = await tx.travelSupplierPayable.aggregate({
    where: { payableBatchId: batchId },
    _sum: { amount: true },
    _count: { _all: true },
  });
  await tx.travelSupplierPayableBatch.update({
    where: { id: batchId },
    data: {
      totalAmount: (agg._sum.amount != null ? Number(agg._sum.amount) : 0).toFixed(2),
      payableCount: agg._count._all || 0,
    },
  });
}

// Parent loader. Fetches the batch, gates on tenant. No sub-brand gate at
// the batch level — a batch can mix suppliers across sub-brands. Sub-brand
// access is enforced at /add-payable when looking up the payable's supplier.
async function loadBatch(req, include) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number");
    err.status = 400;
    err.code = "INVALID_ID";
    throw err;
  }
  const batch = await prisma.travelSupplierPayableBatch.findFirst({
    where: { id, tenantId: req.travelTenant.id },
    include: include || undefined,
  });
  if (!batch) {
    const err = new Error("Payable batch not found");
    err.status = 404;
    err.code = "BATCH_NOT_FOUND";
    throw err;
  }
  return batch;
}

// ─── GET /api/travel/payable-batches — list ─────────────────────────

router.get(
  "/payable-batches",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const where = { tenantId: req.travelTenant.id };
      if (req.query.status) {
        assertValidStatus(String(req.query.status));
        where.status = String(req.query.status);
      }

      const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const skip = parseInt(req.query.offset, 10) || 0;

      const [rows, total] = await Promise.all([
        prisma.travelSupplierPayableBatch.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take,
          skip,
        }),
        prisma.travelSupplierPayableBatch.count({ where }),
      ]);

      res.json({ payableBatches: rows, total, limit: take, offset: skip });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] list error:", e.message);
      res.status(500).json({ error: "Failed to list payable batches" });
    }
  },
);

// ─── POST /api/travel/payable-batches — create draft from payable IDs ─

router.post(
  "/payable-batches",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const { payableIds, paymentMethod, bankAccount, scheduledFor, notes } = req.body || {};
      const ids = Array.isArray(payableIds) ? payableIds.map((x) => parseInt(x, 10)).filter(Number.isFinite) : [];
      if (paymentMethod !== undefined && paymentMethod !== null && paymentMethod !== "") {
        assertValidPaymentMethod(String(paymentMethod));
      }

      // Validate that every requested payable belongs to this tenant + the
      // operator can access its supplier's sub-brand. Lock-step: fail the
      // entire batch creation if any payable is denied.
      let payables = [];
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (ids.length > 0) {
        payables = await prisma.travelSupplierPayable.findMany({
          where: { id: { in: ids }, tenantId: req.travelTenant.id },
          include: { supplier: { select: { subBrand: true } } },
        });
        if (payables.length !== ids.length) {
          return res.status(404).json({
            error: "One or more payables not found in tenant",
            code: "PAYABLE_NOT_FOUND",
            missingIds: ids.filter((x) => !payables.find((p) => p.id === x)),
          });
        }
        for (const p of payables) {
          if (!canAccessSubBrand(allowed, p.supplier ? p.supplier.subBrand : null)) {
            return res.status(403).json({
              error: "Sub-brand access denied for payable",
              code: "SUB_BRAND_DENIED",
              payableId: p.id,
            });
          }
          // Already-batched payables can't be picked up again.
          if (p.payableBatchId) {
            return res.status(409).json({
              error: "Payable already attached to a batch",
              code: "PAYABLE_ALREADY_BATCHED",
              payableId: p.id,
              existingBatchId: p.payableBatchId,
            });
          }
          // Only pending / scheduled payables can be batched. Paid / cancelled
          // are excluded — nothing to settle.
          if (!["pending", "scheduled"].includes(p.status)) {
            return res.status(409).json({
              error: `Payable in ${p.status} state cannot be batched`,
              code: "PAYABLE_INVALID_STATE",
              payableId: p.id,
              payableStatus: p.status,
            });
          }
        }
      }

      const batchNumber = await module.exports.nextBatchNumber(req.travelTenant.id);

      const created = await prisma.$transaction(async (tx) => {
        const batch = await tx.travelSupplierPayableBatch.create({
          data: {
            tenantId: req.travelTenant.id,
            batchNumber,
            status: "draft",
            paymentMethod: paymentMethod || null,
            bankAccount: bankAccount || null,
            scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
            notes: notes || null,
            createdBy: req.user.userId,
            totalAmount: "0.00",
            payableCount: 0,
          },
        });
        if (payables.length > 0) {
          await tx.travelSupplierPayable.updateMany({
            where: { id: { in: payables.map((p) => p.id) } },
            data: { payableBatchId: batch.id },
          });
          await recomputeBatchTotals(tx, batch.id);
        }
        return tx.travelSupplierPayableBatch.findUnique({ where: { id: batch.id } });
      });

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "P2002") {
        return res.status(409).json({ error: "batchNumber collision — retry", code: "DUPLICATE_BATCH_NUMBER" });
      }
      console.error("[travel-payable-batches] create error:", e.message);
      res.status(500).json({ error: "Failed to create payable batch" });
    }
  },
);

// ─── GET /api/travel/payable-batches/:id — detail ────────────────────

router.get(
  "/payable-batches/:id",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req, {
        payables: {
          include: {
            supplier: {
              select: { id: true, name: true, subBrand: true, gstin: true, supplierCategory: true },
            },
          },
          orderBy: [{ id: "asc" }],
        },
      });
      res.json(batch);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] detail error:", e.message);
      res.status(500).json({ error: "Failed to load payable batch" });
    }
  },
);

// ─── PUT /api/travel/payable-batches/:id — update (draft only) ───────

router.put(
  "/payable-batches/:id",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req);
      if (batch.status !== "draft") {
        return res.status(409).json({
          error: `Batch can only be edited in draft state (currently ${batch.status})`,
          code: "INVALID_STATUS_TRANSITION",
          from: batch.status,
          to: "draft-edit",
          allowed: ["draft"],
        });
      }
      const data = {};
      const { paymentMethod, bankAccount, scheduledFor, notes } = req.body || {};
      if (paymentMethod !== undefined) {
        if (paymentMethod === null || paymentMethod === "") {
          data.paymentMethod = null;
        } else {
          assertValidPaymentMethod(String(paymentMethod));
          data.paymentMethod = String(paymentMethod);
        }
      }
      if (bankAccount !== undefined) data.bankAccount = bankAccount || null;
      if (scheduledFor !== undefined) {
        data.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
      }
      if (notes !== undefined) data.notes = notes || null;
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields", code: "EMPTY_BODY" });
      }
      const updated = await prisma.travelSupplierPayableBatch.update({
        where: { id: batch.id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] update error:", e.message);
      res.status(500).json({ error: "Failed to update payable batch" });
    }
  },
);

// ─── POST /api/travel/payable-batches/:id/add-payable ────────────────

router.post(
  "/payable-batches/:id/add-payable",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req);
      if (batch.status !== "draft") {
        return res.status(409).json({
          error: `Payables can only be added to draft batches (currently ${batch.status})`,
          code: "INVALID_STATUS_TRANSITION",
          from: batch.status,
          to: "add-payable",
          allowed: ["draft"],
        });
      }
      const { payableId } = req.body || {};
      const pid = parseInt(payableId, 10);
      if (!Number.isFinite(pid)) {
        return res.status(400).json({ error: "payableId required", code: "MISSING_FIELDS" });
      }
      const payable = await prisma.travelSupplierPayable.findFirst({
        where: { id: pid, tenantId: req.travelTenant.id },
        include: { supplier: { select: { subBrand: true } } },
      });
      if (!payable) {
        return res.status(404).json({ error: "Payable not found", code: "PAYABLE_NOT_FOUND" });
      }
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (!canAccessSubBrand(allowed, payable.supplier ? payable.supplier.subBrand : null)) {
        return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
      }
      if (payable.payableBatchId) {
        return res.status(409).json({
          error: "Payable already attached to a batch",
          code: "PAYABLE_ALREADY_BATCHED",
          existingBatchId: payable.payableBatchId,
        });
      }
      if (!["pending", "scheduled"].includes(payable.status)) {
        return res.status(409).json({
          error: `Payable in ${payable.status} state cannot be batched`,
          code: "PAYABLE_INVALID_STATE",
          payableStatus: payable.status,
        });
      }
      const result = await prisma.$transaction(async (tx) => {
        await tx.travelSupplierPayable.update({
          where: { id: pid },
          data: { payableBatchId: batch.id },
        });
        await recomputeBatchTotals(tx, batch.id);
        return tx.travelSupplierPayableBatch.findUnique({ where: { id: batch.id } });
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] add-payable error:", e.message);
      res.status(500).json({ error: "Failed to add payable" });
    }
  },
);

// ─── POST /api/travel/payable-batches/:id/remove-payable ─────────────

router.post(
  "/payable-batches/:id/remove-payable",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req);
      if (batch.status !== "draft") {
        return res.status(409).json({
          error: `Payables can only be removed from draft batches (currently ${batch.status})`,
          code: "INVALID_STATUS_TRANSITION",
          from: batch.status,
          to: "remove-payable",
          allowed: ["draft"],
        });
      }
      const { payableId } = req.body || {};
      const pid = parseInt(payableId, 10);
      if (!Number.isFinite(pid)) {
        return res.status(400).json({ error: "payableId required", code: "MISSING_FIELDS" });
      }
      const payable = await prisma.travelSupplierPayable.findFirst({
        where: { id: pid, tenantId: req.travelTenant.id, payableBatchId: batch.id },
      });
      if (!payable) {
        return res.status(404).json({ error: "Payable not in this batch", code: "PAYABLE_NOT_IN_BATCH" });
      }
      const result = await prisma.$transaction(async (tx) => {
        await tx.travelSupplierPayable.update({
          where: { id: pid },
          data: { payableBatchId: null },
        });
        await recomputeBatchTotals(tx, batch.id);
        return tx.travelSupplierPayableBatch.findUnique({ where: { id: batch.id } });
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] remove-payable error:", e.message);
      res.status(500).json({ error: "Failed to remove payable" });
    }
  },
);

// ─── State machine transitions ───────────────────────────────────────

function buildTransitionHandler(toStatus, timestampField, extras = {}) {
  return async (req, res) => {
    try {
      const batch = await loadBatch(req);
      if (!TRANSITIONS[batch.status] || !TRANSITIONS[batch.status].has(toStatus)) {
        return res.status(409).json({
          error: `Cannot transition from ${batch.status} to ${toStatus}`,
          code: "INVALID_STATUS_TRANSITION",
          from: batch.status,
          to: toStatus,
          allowed: Array.from(TRANSITIONS[batch.status] || []),
        });
      }
      const data = { status: toStatus };
      if (timestampField) data[timestampField] = new Date();
      if (extras.approverField && req.user && req.user.userId) {
        data[extras.approverField] = req.user.userId;
      }
      const updated = await prisma.travelSupplierPayableBatch.update({
        where: { id: batch.id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error(`[travel-payable-batches] transition ${toStatus} error:`, e.message);
      res.status(500).json({ error: `Failed to transition to ${toStatus}` });
    }
  };
}

router.post(
  "/payable-batches/:id/approve",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  buildTransitionHandler("approved", "approvedAt", { approverField: "approvedBy" }),
);

router.post(
  "/payable-batches/:id/send-to-bank",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  buildTransitionHandler("sent_to_bank", "sentAt"),
);

// /settle is special — it flips the batch + every child payable in a
// single transaction. Child payables go pending/scheduled → paid + paidAt.
router.post(
  "/payable-batches/:id/settle",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req);
      if (!TRANSITIONS[batch.status] || !TRANSITIONS[batch.status].has("settled")) {
        return res.status(409).json({
          error: `Cannot transition from ${batch.status} to settled`,
          code: "INVALID_STATUS_TRANSITION",
          from: batch.status,
          to: "settled",
          allowed: Array.from(TRANSITIONS[batch.status] || []),
        });
      }
      const now = new Date();
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.travelSupplierPayableBatch.update({
          where: { id: batch.id },
          data: { status: "settled", settledAt: now },
        });
        const payUpdate = await tx.travelSupplierPayable.updateMany({
          where: { payableBatchId: batch.id, status: { in: ["pending", "scheduled"] } },
          data: { status: "paid", paidAt: now },
        });
        return { batch: updated, payablesSettled: payUpdate.count };
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] settle error:", e.message);
      res.status(500).json({ error: "Failed to settle batch" });
    }
  },
);

router.post(
  "/payable-batches/:id/cancel",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req);
      if (!TRANSITIONS[batch.status] || !TRANSITIONS[batch.status].has("cancelled")) {
        return res.status(409).json({
          error: `Cannot cancel from ${batch.status} state`,
          code: "INVALID_STATUS_TRANSITION",
          from: batch.status,
          to: "cancelled",
          allowed: Array.from(TRANSITIONS[batch.status] || []),
        });
      }
      const { cancelReason } = req.body || {};
      if (!cancelReason || !String(cancelReason).trim()) {
        return res.status(400).json({ error: "cancelReason required", code: "MISSING_FIELDS" });
      }
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.travelSupplierPayableBatch.update({
          where: { id: batch.id },
          data: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelReason: String(cancelReason),
          },
        });
        // Detach children — they go back to free state. FK is SetNull at
        // the schema level, but doing it explicitly inside the tx is
        // clearer + lets us recompute totals to 0.
        await tx.travelSupplierPayable.updateMany({
          where: { payableBatchId: batch.id },
          data: { payableBatchId: null },
        });
        await tx.travelSupplierPayableBatch.update({
          where: { id: batch.id },
          data: { totalAmount: "0.00", payableCount: 0 },
        });
        return updated;
      });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] cancel error:", e.message);
      res.status(500).json({ error: "Failed to cancel batch" });
    }
  },
);

// ─── GET /api/travel/payable-batches/:id/payment-csv — bank export ─

// RFC-4180-style CSV cell quoter. Quotes cells containing comma / newline /
// double-quote; doubles internal quotes.
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

router.get(
  "/payable-batches/:id/payment-csv",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const batch = await loadBatch(req, {
        payables: {
          include: {
            supplier: {
              select: { id: true, name: true, gstin: true },
            },
          },
          orderBy: [{ id: "asc" }],
        },
      });
      const lines = [];
      lines.push(
        [
          "batchNumber",
          "paymentMethod",
          "supplierName",
          "supplierGstin",
          "bankAccountMasked",
          "amount",
          "currency",
          "description",
          "poNumber",
          "reference",
        ]
          .map(csvCell)
          .join(","),
      );
      for (const p of batch.payables || []) {
        lines.push(
          [
            batch.batchNumber,
            batch.paymentMethod || "",
            p.supplier ? p.supplier.name : "",
            p.supplier ? p.supplier.gstin || "" : "",
            batch.bankAccount || "",
            Number(p.amount || 0).toFixed(2),
            p.currency || "INR",
            p.description || "",
            p.poNumber || "",
            `PAYABLE-${p.id}`,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      const csv = lines.join("\r\n") + "\r\n";
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${batch.batchNumber}.csv"`,
      );
      res.send(csv);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-payable-batches] csv error:", e.message);
      res.status(500).json({ error: "Failed to render CSV" });
    }
  },
);

module.exports = router;
// CJS self-spy seam — let vitest vi.spyOn(module.exports, 'nextBatchNumber') to
// intercept the numbering call without touching the prisma client.
module.exports.nextBatchNumber = nextBatchNumber;
module.exports.TRANSITIONS = TRANSITIONS;
module.exports.VALID_STATUSES = VALID_STATUSES;
module.exports.VALID_PAYMENT_METHODS = VALID_PAYMENT_METHODS;
module.exports.csvCell = csvCell;
