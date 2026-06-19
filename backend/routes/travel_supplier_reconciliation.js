// PRD_TRAVEL_SUPPLIER_MASTER G044 + G046 (FR-3.3.c, FR-3.4.a-c) —
// supplier-statement reconciliation + invoice-PDF upload routes.
//
// Sibling to /api/travel/suppliers/:id/* in routes/travel_suppliers.js.
// Lives in its own file because:
//   - G040-G043 is concurrently iterating travel_suppliers.js (status +
//     payment-terms enums + credit-limit guards). Keeping G044+G046 in a
//     separate router avoids merge collisions across parallel agent waves.
//   - Reconciliation surface is ~10 endpoints; invoice uploads add ~4 more.
//     Distinct domain from supplier-credentials (vault), supplier-payables
//     (A/P), and supplier-commissions (commission ledger).
//
// Endpoints (mounted at /api/travel via server.js)
// ------------------------------------------------
// Reconciliation (G044):
//   POST   /suppliers/:id/reconciliation-batches                       — draft batch
//   GET    /suppliers/:id/reconciliation-batches                       — list
//   GET    /suppliers/:id/reconciliation-batches/:batchId              — detail + lines
//   POST   /suppliers/:id/reconciliation-batches/:batchId/lines/bulk   — bulk add lines (JSON array)
//   POST   /suppliers/:id/reconciliation-batches/:batchId/auto-match   — run the matcher
//   POST   /suppliers/:id/reconciliation-batches/:batchId/lines/:lineId/manual-match — operator pick
//   POST   /suppliers/:id/reconciliation-batches/:batchId/review       — draft → reviewed
//   POST   /suppliers/:id/reconciliation-batches/:batchId/reconcile    — reviewed → reconciled
//   POST   /suppliers/:id/reconciliation-batches/:batchId/dispute      — flip to disputed
//
// Invoice uploads (G046):
//   POST   /suppliers/:id/invoice-uploads                              — multer + PDF/CSV/PNG/JPG
//   GET    /suppliers/:id/invoice-uploads                              — list
//   POST   /suppliers/:id/invoice-uploads/:uploadId/match              — link to payable
//   DELETE /suppliers/:id/invoice-uploads/:uploadId                    — ADMIN only
//
// Sub-brand isolation: inherited through the parent TravelSupplier (same
// pattern as travel_supplier_commissions.js). Caller hits 403 SUB_BRAND_DENIED
// when their subBrandAccess set is non-null and doesn't include the
// parent supplier's subBrand.
//
// Audit: writeAudit called on every state transition + every successful
// match decision (auto + manual) + every file upload / match / delete.

const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/requirePermission");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");
const { writeAudit } = require("../lib/audit");
const {
  matchLines,
  sumAmounts,
} = require("../lib/supplierReconciliation");

// ─── Multer setup for supplier-invoice uploads ──────────────────────────
//
// Disk storage under backend/uploads/supplier-invoices/. 10 MB cap;
// PDF / CSV / PNG / JPG only. Extension derived from validated mimetype
// (NOT client-supplied originalname) — same defense-in-depth pattern as
// routes/travel_passport.js. Filename is crypto.randomUUID() + safe ext.
const uploadPath = path.join(
  __dirname,
  "..",
  "uploads",
  "supplier-invoices",
);
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

const INVOICE_MIME_EXT = {
  "application/pdf": ".pdf",
  "text/csv": ".csv",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const safeExt =
      INVOICE_MIME_EXT[(file.mimetype || "").toLowerCase()] || "";
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap per PRD FR-3.3.c
  fileFilter: (req, file, cb) => {
    if (INVOICE_MIME_EXT[(file.mimetype || "").toLowerCase()]) {
      return cb(null, true);
    }
    cb(new Error("UNSUPPORTED_MIME"));
  },
});

// Wrap multer so its rejections become the intended 413/415 here, rather
// than falling through to the global error handler as a 500 (multer calls
// next(err) which skips the handler's catch block).
function uploadHandler(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "file exceeds 10 MB limit",
          code: "FILE_TOO_LARGE",
        });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err && err.message === "UNSUPPORTED_MIME") {
      return res.status(415).json({
        error: "unsupported file type — PDF / CSV / PNG / JPG only",
        code: "UNSUPPORTED_MIME",
      });
    }
    if (err) return next(err);
    next();
  });
}

// Best-effort cleanup of an uploaded file on any non-success branch.
function unlinkUploadedFile(req) {
  if (req.file && req.file.filename) {
    fs.unlink(path.join(uploadPath, req.file.filename), () => {});
  }
}

// ─── Validation helpers ──────────────────────────────────────────────────

const VALID_BATCH_STATUSES = ["draft", "reviewed", "reconciled", "disputed"];
// YYYY-MM (e.g. "2026-05"). Year 2000-2099 / month 01-12.
const STATEMENT_MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;

function assertValidStatementMonth(s) {
  if (!s || !STATEMENT_MONTH_RE.test(String(s))) {
    const err = new Error("statementMonth must be YYYY-MM (e.g. 2026-05)");
    err.status = 400;
    err.code = "INVALID_STATEMENT_MONTH";
    throw err;
  }
}

function assertNonNegativeDecimal(v, label, code) {
  if (v == null) return;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${label} must be a non-negative number`);
    err.status = 400;
    err.code = code;
    throw err;
  }
}

function assertValidTolerance(v) {
  if (v == null) return;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    const err = new Error("tolerancePct must be between 0 and 100");
    err.status = 400;
    err.code = "INVALID_TOLERANCE";
    throw err;
  }
}

// Parent-supplier loader: returns the supplier scoped to the request's
// travel tenant, after verifying sub-brand access. Throws { status, code }
// so the route handler passes it through to the central error mapper.
async function loadParentSupplier(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number");
    err.status = 400;
    err.code = "INVALID_ID";
    throw err;
  }
  const supplier = await prisma.travelSupplier.findFirst({
    where: { id, tenantId: req.travelTenant.id },
  });
  if (!supplier) {
    const err = new Error("Supplier not found");
    err.status = 404;
    err.code = "SUPPLIER_NOT_FOUND";
    throw err;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, supplier.subBrand)) {
    const err = new Error("Sub-brand access denied");
    err.status = 403;
    err.code = "SUB_BRAND_DENIED";
    throw err;
  }
  return supplier;
}

async function loadBatch(req, parentSupplierId) {
  const batchId = parseInt(req.params.batchId, 10);
  if (!Number.isFinite(batchId)) {
    const err = new Error("batchId must be a number");
    err.status = 400;
    err.code = "INVALID_BATCH_ID";
    throw err;
  }
  const batch = await prisma.travelSupplierReconciliationBatch.findFirst({
    where: {
      id: batchId,
      tenantId: req.travelTenant.id,
      supplierId: parentSupplierId,
    },
  });
  if (!batch) {
    const err = new Error("Batch not found");
    err.status = 404;
    err.code = "BATCH_NOT_FOUND";
    throw err;
  }
  return batch;
}

function mapError(res, e, fallbackMsg) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
  console.error(`[travel-supp-recon] ${fallbackMsg}:`, e && e.message);
  res.status(500).json({ error: fallbackMsg });
}

// ─── POST /suppliers/:id/reconciliation-batches — create draft ───────────

router.post(
  "/suppliers/:id/reconciliation-batches",
  verifyToken,
  requirePermission("suppliers", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const {
        statementMonth,
        statementUrl,
        tolerancePct,
        notes,
      } = req.body || {};
      if (!statementMonth) {
        return res.status(400).json({
          error: "statementMonth required (YYYY-MM)",
          code: "MISSING_FIELDS",
        });
      }
      assertValidStatementMonth(statementMonth);
      assertValidTolerance(tolerancePct);
      const created = await prisma.travelSupplierReconciliationBatch.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
          statementMonth: String(statementMonth),
          statementUrl: statementUrl ? String(statementUrl) : null,
          tolerancePct:
            tolerancePct != null ? String(Number(tolerancePct)) : undefined,
          // totals seed at 0; populated after bulk-add-lines.
          totalSupplierAmount: "0",
          totalOursAmount: "0",
          status: "draft",
          notes: notes ? String(notes) : null,
          createdBy: req.user.userId,
        },
      });
      await writeAudit(
        "TravelSupplierReconciliationBatch",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          supplierId: parent.id,
          statementMonth: created.statementMonth,
        },
      );
      res.status(201).json(created);
    } catch (e) {
      mapError(res, e, "Failed to create reconciliation batch");
    }
  },
);

// ─── GET /suppliers/:id/reconciliation-batches — list ────────────────────

router.get(
  "/suppliers/:id/reconciliation-batches",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const where = {
        tenantId: req.travelTenant.id,
        supplierId: parent.id,
      };
      if (req.query.statementMonth) {
        where.statementMonth = String(req.query.statementMonth);
      }
      if (req.query.status) {
        if (!VALID_BATCH_STATUSES.includes(String(req.query.status))) {
          return res.status(400).json({
            error: `status must be one of: ${VALID_BATCH_STATUSES.join(", ")}`,
            code: "INVALID_STATUS",
          });
        }
        where.status = String(req.query.status);
      }
      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;
      const [rows, total] = await Promise.all([
        prisma.travelSupplierReconciliationBatch.findMany({
          where,
          orderBy: [{ statementMonth: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.travelSupplierReconciliationBatch.count({ where }),
      ]);
      res.json({ batches: rows, total });
    } catch (e) {
      mapError(res, e, "Failed to list reconciliation batches");
    }
  },
);

// ─── GET /suppliers/:id/reconciliation-batches/:batchId — detail + lines ─

router.get(
  "/suppliers/:id/reconciliation-batches/:batchId",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const batch = await loadBatch(req, parent.id);
      const lines = await prisma.travelSupplierReconciliationLine.findMany({
        where: { tenantId: req.travelTenant.id, batchId: batch.id },
        orderBy: [{ id: "asc" }],
      });
      res.json({ batch, lines });
    } catch (e) {
      mapError(res, e, "Failed to get reconciliation batch");
    }
  },
);

// ─── POST /suppliers/:id/reconciliation-batches/:batchId/lines/bulk ──────
//
// Bulk-add lines from a JSON body. The CSV-upload path is delegated to the
// operator's client-side parser (see frontend SupplierReconciliation.jsx)
// — keeping CSV parsing in the browser avoids us needing to ship a
// dependency for what is essentially a 2-column CSV.
//
// Body: { lines: [{ pnr?, bookingRef?, supplierAmount, notes? }, ...] }
// Caps at 5000 lines per request to keep transactions bounded.

router.post(
  "/suppliers/:id/reconciliation-batches/:batchId/lines/bulk",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const batch = await loadBatch(req, parent.id);
      if (batch.status === "reconciled") {
        return res.status(409).json({
          error: "Batch is reconciled; cannot add more lines",
          code: "BATCH_FINAL",
        });
      }
      const body = req.body || {};
      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (lines.length === 0) {
        return res.status(400).json({
          error: "lines[] required and must be non-empty",
          code: "MISSING_FIELDS",
        });
      }
      if (lines.length > 5000) {
        return res.status(413).json({
          error: "max 5000 lines per request",
          code: "TOO_MANY_LINES",
        });
      }
      const sanitised = [];
      for (let i = 0; i < lines.length; i++) {
        const r = lines[i] || {};
        if (r.supplierAmount == null) {
          return res.status(400).json({
            error: `lines[${i}].supplierAmount required`,
            code: "MISSING_FIELDS",
          });
        }
        try {
          assertNonNegativeDecimal(
            r.supplierAmount,
            `lines[${i}].supplierAmount`,
            "INVALID_AMOUNT",
          );
        } catch (e) {
          return res.status(e.status).json({ error: e.message, code: e.code });
        }
        sanitised.push({
          tenantId: req.travelTenant.id,
          batchId: batch.id,
          pnr: r.pnr ? String(r.pnr).trim() : null,
          bookingRef: r.bookingRef ? String(r.bookingRef).trim() : null,
          supplierAmount: String(Number(r.supplierAmount)),
          notes: r.notes ? String(r.notes) : null,
        });
      }
      // createMany for speed; we also need to update batch totals afterwards.
      await prisma.travelSupplierReconciliationLine.createMany({
        data: sanitised,
      });
      const newSupplierTotal = sumAmounts(sanitised, "supplierAmount");
      const updated = await prisma.travelSupplierReconciliationBatch.update({
        where: { id: batch.id },
        data: {
          totalSupplierAmount: String(
            Number(batch.totalSupplierAmount) + Number(newSupplierTotal),
          ),
        },
      });
      await writeAudit(
        "TravelSupplierReconciliationBatch",
        "BULK_ADD_LINES",
        batch.id,
        req.user.userId,
        req.travelTenant.id,
        { count: sanitised.length },
      );
      res.status(201).json({
        added: sanitised.length,
        totalSupplierAmount: updated.totalSupplierAmount,
      });
    } catch (e) {
      mapError(res, e, "Failed to add lines");
    }
  },
);

// ─── POST /suppliers/:id/reconciliation-batches/:batchId/auto-match ──────
//
// Runs the matcher (lib/supplierReconciliation.matchLines) against every
// `unmatched` line in the batch. For each line with a matching PoLine
// within tolerancePct, flip to `auto_matched` and record matchedPoLineId
// + varianceAmount. Returns counts.

router.post(
  "/suppliers/:id/reconciliation-batches/:batchId/auto-match",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const batch = await loadBatch(req, parent.id);
      if (batch.status === "reconciled") {
        return res.status(409).json({
          error: "Batch is reconciled; cannot re-match",
          code: "BATCH_FINAL",
        });
      }
      const unmatched = await prisma.travelSupplierReconciliationLine.findMany(
        {
          where: {
            tenantId: req.travelTenant.id,
            batchId: batch.id,
            matchStatus: "unmatched",
          },
        },
      );
      if (unmatched.length === 0) {
        return res.json({
          attempted: 0,
          autoMatched: 0,
          unmatched: 0,
        });
      }
      // Candidate PoLines: any PO-line owned by THIS supplier (via parent PO).
      const poLines = await prisma.travelPurchaseOrderLine.findMany({
        where: {
          tenantId: req.travelTenant.id,
          purchaseOrder: {
            tenantId: req.travelTenant.id,
            supplierId: parent.id,
          },
        },
        select: {
          id: true,
          pnr: true,
          bookingRef: true,
          lineTotal: true,
        },
      });
      const decisions = matchLines(
        unmatched,
        poLines,
        Number(batch.tolerancePct),
      );

      // Apply decisions transactionally.
      let autoMatched = 0;
      await prisma.$transaction(
        decisions.map((d) => {
          if (d.decision === "auto_matched") {
            autoMatched += 1;
            return prisma.travelSupplierReconciliationLine.update({
              where: { id: d.reconLineId },
              data: {
                matchStatus: "auto_matched",
                matchedPoLineId: d.matchedPoLineId,
                varianceAmount:
                  d.varianceAmount != null ? String(d.varianceAmount) : null,
              },
            });
          }
          // No-op for unmatched; we keep the row as-is.
          return prisma.travelSupplierReconciliationLine.update({
            where: { id: d.reconLineId },
            data: { matchStatus: "unmatched" },
          });
        }),
      );

      // Recompute totalOursAmount from matched PoLine totals (cheap; one
      // query). Lets the operator see "this batch matches Rs X of our
      // ledger" without joining client-side.
      const matchedLines =
        await prisma.travelSupplierReconciliationLine.findMany({
          where: {
            tenantId: req.travelTenant.id,
            batchId: batch.id,
            matchedPoLineId: { not: null },
          },
          select: { matchedPoLineId: true },
        });
      const matchedPoLineIds = matchedLines
        .map((m) => m.matchedPoLineId)
        .filter(Boolean);
      let totalOurs = 0;
      if (matchedPoLineIds.length > 0) {
        const polines = await prisma.travelPurchaseOrderLine.findMany({
          where: {
            tenantId: req.travelTenant.id,
            id: { in: matchedPoLineIds },
          },
          select: { lineTotal: true },
        });
        totalOurs = sumAmounts(polines, "lineTotal");
      }
      await prisma.travelSupplierReconciliationBatch.update({
        where: { id: batch.id },
        data: { totalOursAmount: String(totalOurs) },
      });

      await writeAudit(
        "TravelSupplierReconciliationBatch",
        "AUTO_MATCH",
        batch.id,
        req.user.userId,
        req.travelTenant.id,
        {
          attempted: decisions.length,
          autoMatched,
          tolerance: Number(batch.tolerancePct),
        },
      );

      res.json({
        attempted: decisions.length,
        autoMatched,
        unmatched: decisions.length - autoMatched,
        decisions,
      });
    } catch (e) {
      mapError(res, e, "Failed to auto-match");
    }
  },
);

// ─── POST .../lines/:lineId/manual-match ─────────────────────────────────

router.post(
  "/suppliers/:id/reconciliation-batches/:batchId/lines/:lineId/manual-match",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const batch = await loadBatch(req, parent.id);
      if (batch.status === "reconciled") {
        return res.status(409).json({
          error: "Batch is reconciled; cannot re-match",
          code: "BATCH_FINAL",
        });
      }
      const lineId = parseInt(req.params.lineId, 10);
      if (!Number.isFinite(lineId)) {
        return res
          .status(400)
          .json({ error: "lineId must be a number", code: "INVALID_ID" });
      }
      const { poLineId, payableId } = req.body || {};
      if (poLineId == null && payableId == null) {
        return res.status(400).json({
          error: "poLineId or payableId required",
          code: "MISSING_FIELDS",
        });
      }
      const line = await prisma.travelSupplierReconciliationLine.findFirst({
        where: {
          id: lineId,
          tenantId: req.travelTenant.id,
          batchId: batch.id,
        },
      });
      if (!line) {
        return res
          .status(404)
          .json({ error: "Line not found", code: "LINE_NOT_FOUND" });
      }

      // Validate poLineId if supplied: belongs to a PO for THIS supplier.
      let varianceAmount = null;
      let matchedPoLineId = line.matchedPoLineId || null;
      if (poLineId != null) {
        const poLine = await prisma.travelPurchaseOrderLine.findFirst({
          where: {
            id: parseInt(poLineId, 10),
            tenantId: req.travelTenant.id,
            purchaseOrder: {
              tenantId: req.travelTenant.id,
              supplierId: parent.id,
            },
          },
          select: { id: true, lineTotal: true },
        });
        if (!poLine) {
          return res.status(404).json({
            error: "PoLine not found for this supplier",
            code: "POLINE_NOT_FOUND",
          });
        }
        matchedPoLineId = poLine.id;
        const v = Number(line.supplierAmount) - Number(poLine.lineTotal);
        varianceAmount = Math.round(v * 100) / 100;
      }

      // Validate payableId if supplied: belongs to THIS supplier.
      let matchedPayableId = line.matchedPayableId || null;
      if (payableId != null) {
        const payable = await prisma.travelSupplierPayable.findFirst({
          where: {
            id: parseInt(payableId, 10),
            tenantId: req.travelTenant.id,
            supplierId: parent.id,
          },
          select: { id: true },
        });
        if (!payable) {
          return res.status(404).json({
            error: "Payable not found for this supplier",
            code: "PAYABLE_NOT_FOUND",
          });
        }
        matchedPayableId = payable.id;
      }

      const updated = await prisma.travelSupplierReconciliationLine.update({
        where: { id: lineId },
        data: {
          matchStatus: "manual_matched",
          matchedPoLineId,
          matchedPayableId,
          varianceAmount:
            varianceAmount != null ? String(varianceAmount) : line.varianceAmount,
        },
      });
      await writeAudit(
        "TravelSupplierReconciliationLine",
        "MANUAL_MATCH",
        lineId,
        req.user.userId,
        req.travelTenant.id,
        { batchId: batch.id, matchedPoLineId, matchedPayableId },
      );
      res.json(updated);
    } catch (e) {
      mapError(res, e, "Failed to manual-match");
    }
  },
);

// ─── State transitions: review / reconcile / dispute ─────────────────────

function makeTransitionHandler({ from, to, action }) {
  return async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const batch = await loadBatch(req, parent.id);
      if (!from.includes(batch.status)) {
        return res.status(409).json({
          error: `Cannot ${action.toLowerCase()} a batch with status=${batch.status}`,
          code: "INVALID_STATUS_TRANSITION",
        });
      }
      const data = { status: to };
      if (to === "reviewed") {
        data.reviewedBy = req.user.userId;
        data.reviewedAt = new Date();
      } else if (to === "reconciled") {
        data.reconciledBy = req.user.userId;
        data.reconciledAt = new Date();
      }
      const updated = await prisma.travelSupplierReconciliationBatch.update({
        where: { id: batch.id },
        data,
      });
      await writeAudit(
        "TravelSupplierReconciliationBatch",
        action,
        batch.id,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: parent.id, from: batch.status, to },
      );
      res.json(updated);
    } catch (e) {
      mapError(res, e, `Failed to ${action.toLowerCase()} batch`);
    }
  };
}

router.post(
  "/suppliers/:id/reconciliation-batches/:batchId/review",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  makeTransitionHandler({
    from: ["draft"],
    to: "reviewed",
    action: "REVIEW",
  }),
);

router.post(
  "/suppliers/:id/reconciliation-batches/:batchId/reconcile",
  verifyToken,
  requirePermission("suppliers", "manage"),
  requireTravelTenant,
  makeTransitionHandler({
    from: ["reviewed"],
    to: "reconciled",
    action: "RECONCILE",
  }),
);

router.post(
  "/suppliers/:id/reconciliation-batches/:batchId/dispute",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  makeTransitionHandler({
    from: ["draft", "reviewed"],
    to: "disputed",
    action: "DISPUTE",
  }),
);

// ─── G046 — Supplier invoice uploads ─────────────────────────────────────

// POST /suppliers/:id/invoice-uploads
//
// multipart/form-data with `file` part. Optional metadata fields can be
// sent as form fields alongside the file: supplierInvoiceNumber,
// invoiceDate (ISO), invoiceAmount, currency, notes.

router.post(
  "/suppliers/:id/invoice-uploads",
  verifyToken,
  requirePermission("suppliers", "write"),
  requireTravelTenant,
  uploadHandler,
  async (req, res) => {
    let parent;
    try {
      parent = await loadParentSupplier(req);
    } catch (e) {
      // loadParentSupplier runs AFTER multer wrote the file — clean up.
      unlinkUploadedFile(req);
      return mapError(res, e, "Failed to upload invoice");
    }
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "file required", code: "MISSING_FILE" });
    }
    try {
      const {
        supplierInvoiceNumber,
        invoiceDate,
        invoiceAmount,
        currency,
        notes,
      } = req.body || {};
      if (invoiceAmount != null) {
        try {
          assertNonNegativeDecimal(
            invoiceAmount,
            "invoiceAmount",
            "INVALID_AMOUNT",
          );
        } catch (e) {
          unlinkUploadedFile(req);
          return mapError(res, e, "Failed to upload invoice");
        }
      }
      let parsedDate = null;
      if (invoiceDate) {
        const d = new Date(invoiceDate);
        if (Number.isNaN(d.getTime())) {
          unlinkUploadedFile(req);
          return res.status(400).json({
            error: "invoiceDate must be a valid ISO date",
            code: "INVALID_DATE",
          });
        }
        parsedDate = d;
      }

      const created = await prisma.travelSupplierInvoiceUpload.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
          filename: req.file.originalname || req.file.filename,
          fileUrl: `/uploads/supplier-invoices/${req.file.filename}`,
          fileMimeType: req.file.mimetype,
          fileSize: req.file.size,
          supplierInvoiceNumber: supplierInvoiceNumber
            ? String(supplierInvoiceNumber)
            : null,
          invoiceDate: parsedDate,
          invoiceAmount:
            invoiceAmount != null ? String(Number(invoiceAmount)) : null,
          currency: currency ? String(currency) : "INR",
          matchStatus: "unmatched",
          uploadedBy: req.user.userId,
          notes: notes ? String(notes) : null,
        },
      });
      await writeAudit(
        "TravelSupplierInvoiceUpload",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: parent.id, mimeType: req.file.mimetype },
      );
      res.status(201).json(created);
    } catch (e) {
      unlinkUploadedFile(req);
      mapError(res, e, "Failed to upload invoice");
    }
  },
);

// GET /suppliers/:id/invoice-uploads

router.get(
  "/suppliers/:id/invoice-uploads",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const where = {
        tenantId: req.travelTenant.id,
        supplierId: parent.id,
      };
      if (req.query.matchStatus) {
        where.matchStatus = String(req.query.matchStatus);
      }
      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;
      const [rows, total] = await Promise.all([
        prisma.travelSupplierInvoiceUpload.findMany({
          where,
          orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.travelSupplierInvoiceUpload.count({ where }),
      ]);
      res.json({ uploads: rows, total });
    } catch (e) {
      mapError(res, e, "Failed to list invoice uploads");
    }
  },
);

// POST /suppliers/:id/invoice-uploads/:uploadId/match — link to payable

router.post(
  "/suppliers/:id/invoice-uploads/:uploadId/match",
  verifyToken,
  requirePermission("suppliers", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const uploadId = parseInt(req.params.uploadId, 10);
      if (!Number.isFinite(uploadId)) {
        return res
          .status(400)
          .json({ error: "uploadId must be a number", code: "INVALID_ID" });
      }
      const { payableId } = req.body || {};
      if (payableId == null) {
        return res.status(400).json({
          error: "payableId required",
          code: "MISSING_FIELDS",
        });
      }
      const upload = await prisma.travelSupplierInvoiceUpload.findFirst({
        where: {
          id: uploadId,
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
        },
      });
      if (!upload) {
        return res
          .status(404)
          .json({ error: "Upload not found", code: "UPLOAD_NOT_FOUND" });
      }
      // Cross-tenant probe: validate the payable belongs to THIS supplier.
      const payable = await prisma.travelSupplierPayable.findFirst({
        where: {
          id: parseInt(payableId, 10),
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
        },
        select: { id: true },
      });
      if (!payable) {
        return res.status(404).json({
          error: "Payable not found for this supplier",
          code: "PAYABLE_NOT_FOUND",
        });
      }
      const updated = await prisma.travelSupplierInvoiceUpload.update({
        where: { id: uploadId },
        data: {
          payableId: payable.id,
          matchStatus: "matched",
          matchedBy: req.user.userId,
          matchedAt: new Date(),
        },
      });
      await writeAudit(
        "TravelSupplierInvoiceUpload",
        "MATCH",
        uploadId,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: parent.id, payableId: payable.id },
      );
      res.json(updated);
    } catch (e) {
      mapError(res, e, "Failed to match invoice upload");
    }
  },
);

// DELETE /suppliers/:id/invoice-uploads/:uploadId — ADMIN only

router.delete(
  "/suppliers/:id/invoice-uploads/:uploadId",
  verifyToken,
  requirePermission("suppliers", "delete"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const uploadId = parseInt(req.params.uploadId, 10);
      if (!Number.isFinite(uploadId)) {
        return res
          .status(400)
          .json({ error: "uploadId must be a number", code: "INVALID_ID" });
      }
      const upload = await prisma.travelSupplierInvoiceUpload.findFirst({
        where: {
          id: uploadId,
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
        },
      });
      if (!upload) {
        return res
          .status(404)
          .json({ error: "Upload not found", code: "UPLOAD_NOT_FOUND" });
      }
      await prisma.travelSupplierInvoiceUpload.delete({
        where: { id: uploadId },
      });
      // Best-effort disk cleanup. File path may not exist if uploaded to
      // remote storage; failure is non-fatal (audit trail is on the row).
      if (upload.fileUrl && upload.fileUrl.startsWith("/uploads/")) {
        const relativePath = upload.fileUrl.replace(/^\/uploads\//, "");
        fs.unlink(path.join(__dirname, "..", "uploads", relativePath), () => {});
      }
      await writeAudit(
        "TravelSupplierInvoiceUpload",
        "DELETE",
        uploadId,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: parent.id, filename: upload.filename },
      );
      res.json({ ok: true });
    } catch (e) {
      mapError(res, e, "Failed to delete invoice upload");
    }
  },
);

module.exports = router;
