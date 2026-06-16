// PRD_TRAVEL_SUPPLIER_MASTER G045 (FR-3.1.e, FR-3.5.a, FR-3.5.b) —
// Supplier-side commission ledger CRUD + per-FY statement + CSV export.
//
// Sibling to /api/travel/suppliers/:id/payables (already in travel_suppliers.js).
// Separate file because the surface ships ~7 new endpoints and is conceptually
// distinct from supplier-credentials (vault) and supplier-payables (A/P ledger).
//
// Endpoints (all mounted at /api/travel via server.js):
//   POST   /suppliers/:id/commission-entries                — accrue a new entry
//   GET    /suppliers/:id/commission-entries                — list, ?fiscalYear=FY2025-26 + ?status filter
//   GET    /suppliers/:id/commission-entries/:entryId       — detail
//   POST   /suppliers/:id/commission-entries/:entryId/settle  — flip accrued→settled (ADMIN/MANAGER)
//   POST   /suppliers/:id/commission-entries/:entryId/reverse — flip to reversed with reason (ADMIN)
//   GET    /suppliers/:id/commission-statement?fiscalYear=FY2025-26 — per-FY rollup
//   GET    /suppliers/:id/commission-statement.csv?fiscalYear=FY2025-26 — CSV export
//   GET    /commissions/stats                               — tenant-wide rollup across suppliers
//
// Distinct from /api/travel/commission-profiles (in routes/travel_commission_profiles.js)
// which scopes B2B sub-agent commission shapes (#905). This ledger tracks
// SUPPLIER-SIDE commissions EARNED on confirmed bookings (e.g. IATA inward,
// hotel commission, RFU Umrah kickbacks).
//
// TDS handling: section 194H (commission/brokerage) defaults to 5% per
// PRD DD-5.5. Callers may pass `tdsPercent` (0..100) at accrue time to
// override. Auto-deduct workflow is deferred to a future slice — for now,
// tdsAmount is computed-or-supplied at accrue, stored verbatim.

const express = require("express");
const router = express.Router();
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
  fiscalYearLabelLong,
  isValidFyLongLabel,
} = require("../lib/travelFiscalYear");

const VALID_ENTRY_TYPES = ["accrued", "settled", "reversed", "adjustment"];
const VALID_STATUSES = ["accrued", "settled", "reversed"];
const DEFAULT_TDS_PERCENT = 5; // Section 194H default (DD-5.5)

function assertValidEntryType(t) {
  if (t == null) return;
  if (!VALID_ENTRY_TYPES.includes(t)) {
    const err = new Error(
      `entryType must be one of: ${VALID_ENTRY_TYPES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_ENTRY_TYPE";
    throw err;
  }
}

function assertValidStatus(s) {
  if (s == null) return;
  if (!VALID_STATUSES.includes(s)) {
    const err = new Error(
      `status must be one of: ${VALID_STATUSES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_STATUS";
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

function assertValidPercent(v, label, code) {
  if (v == null) return;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    const err = new Error(`${label} must be between 0 and 100`);
    err.status = 400;
    err.code = code;
    throw err;
  }
}

function assertValidFiscalYear(s) {
  if (s == null || s === "") return;
  if (!isValidFyLongLabel(String(s))) {
    const err = new Error(
      "fiscalYear must match FY<startYear>-<endTwo> e.g. FY2025-26",
    );
    err.status = 400;
    err.code = "INVALID_FISCAL_YEAR";
    throw err;
  }
}

// Parent-supplier loader: returns the supplier scoped to the request's
// travel tenant, after verifying sub-brand access. Throws { status, code }
// so the route handler can pass through to the central error mapper.
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

// Decimal math helpers. Prisma Decimal in / out is a string at the route
// boundary; we recompute precisely via JS Number with manual rounding to
// 2 decimal places (commissions are 5,2 / 15,2).
function toMoney(n) {
  if (n == null) return null;
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function sumDecimals(rows, key) {
  let total = 0;
  for (const r of rows) {
    const v = r[key];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return Math.round(total * 100) / 100;
}

// ─── POST /suppliers/:id/commission-entries — accrue ─────────────────

router.post(
  "/suppliers/:id/commission-entries",
  verifyToken,
  requirePermission("commission_profiles", "write"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const {
        baseAmount,
        commissionPercent,
        commissionAmount,
        currency,
        tdsPercent,
        tdsAmount,
        bookingId,
        purchaseOrderId,
        invoiceId,
        fiscalYear,
        entryType,
        notes,
        accruedAt,
      } = req.body || {};

      if (baseAmount == null) {
        return res.status(400).json({
          error: "baseAmount required",
          code: "MISSING_FIELDS",
        });
      }

      assertNonNegativeDecimal(baseAmount, "baseAmount", "INVALID_BASE_AMOUNT");
      assertValidPercent(commissionPercent, "commissionPercent", "INVALID_COMMISSION_PERCENT");
      assertNonNegativeDecimal(commissionAmount, "commissionAmount", "INVALID_COMMISSION_AMOUNT");
      assertValidPercent(tdsPercent, "tdsPercent", "INVALID_TDS_PERCENT");
      assertNonNegativeDecimal(tdsAmount, "tdsAmount", "INVALID_TDS_AMOUNT");
      assertValidEntryType(entryType);
      assertValidFiscalYear(fiscalYear);

      // Resolve commissionPercent: explicit > supplier default.
      const effectivePercent =
        commissionPercent != null
          ? Number(commissionPercent)
          : parent.commissionPercent != null
            ? Number(parent.commissionPercent)
            : null;

      // Resolve commissionAmount: explicit > computed from base + percent.
      const base = Number(baseAmount);
      let commission =
        commissionAmount != null ? Number(commissionAmount) : null;
      if (commission == null) {
        if (effectivePercent == null) {
          return res.status(400).json({
            error:
              "commissionAmount required when neither commissionPercent nor supplier default is set",
            code: "MISSING_COMMISSION_RATE",
          });
        }
        commission = (base * effectivePercent) / 100;
      }
      commission = toMoney(commission);

      // Resolve TDS: explicit amount > explicit percent > default 5% applied
      // to commissionAmount. tdsAmount=0 is preserved (caller explicitly
      // opted out).
      let tds;
      if (tdsAmount != null) {
        tds = toMoney(tdsAmount);
      } else {
        const tdsRate =
          tdsPercent != null ? Number(tdsPercent) : DEFAULT_TDS_PERCENT;
        tds = toMoney((commission * tdsRate) / 100);
      }
      const net = toMoney(commission - (tds || 0));

      // FY: explicit > computed-from-accruedAt-or-now.
      const accruedDate = accruedAt ? new Date(accruedAt) : new Date();
      const fyLabel = fiscalYear || fiscalYearLabelLong(accruedDate);

      const created = await prisma.travelSupplierCommissionEntry.create({
        data: {
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
          bookingId: bookingId != null ? parseInt(bookingId, 10) : null,
          purchaseOrderId:
            purchaseOrderId != null ? parseInt(purchaseOrderId, 10) : null,
          invoiceId: invoiceId != null ? parseInt(invoiceId, 10) : null,
          fiscalYear: fyLabel,
          entryType: entryType || "accrued",
          commissionPercent:
            effectivePercent != null ? String(effectivePercent) : null,
          baseAmount: String(base),
          commissionAmount: String(commission),
          currency: currency ? String(currency) : "INR",
          tdsAmount: tds != null ? String(tds) : null,
          netAmount: net != null ? String(net) : null,
          status: "accrued",
          accruedAt: accruedDate,
          notes: notes ? String(notes) : null,
          createdBy: req.user.userId,
        },
      });

      await writeAudit(
        "TravelSupplierCommissionEntry",
        "CREATE",
        created.id,
        req.user.userId,
        req.travelTenant.id,
        {
          supplierId: parent.id,
          fiscalYear: fyLabel,
          commissionAmount: created.commissionAmount,
        },
      );

      res.status(201).json(created);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] accrue error:", e.message);
      res.status(500).json({ error: "Failed to accrue commission entry" });
    }
  },
);

// ─── GET /suppliers/:id/commission-entries — list ────────────────────

router.get(
  "/suppliers/:id/commission-entries",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const where = {
        tenantId: req.travelTenant.id,
        supplierId: parent.id,
      };
      if (req.query.fiscalYear) {
        assertValidFiscalYear(String(req.query.fiscalYear));
        where.fiscalYear = String(req.query.fiscalYear);
      }
      if (req.query.status) {
        assertValidStatus(String(req.query.status));
        where.status = String(req.query.status);
      }
      const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = parseInt(req.query.offset, 10) || 0;
      const [rows, total] = await Promise.all([
        prisma.travelSupplierCommissionEntry.findMany({
          where,
          orderBy: [{ accruedAt: "desc" }, { id: "desc" }],
          take,
          skip,
        }),
        prisma.travelSupplierCommissionEntry.count({ where }),
      ]);
      res.json({ entries: rows, total });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] list error:", e.message);
      res.status(500).json({ error: "Failed to list commission entries" });
    }
  },
);

// ─── GET /suppliers/:id/commission-entries/:entryId — detail ─────────

router.get(
  "/suppliers/:id/commission-entries/:entryId",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const entryId = parseInt(req.params.entryId, 10);
      if (!Number.isFinite(entryId)) {
        return res.status(400).json({ error: "entryId must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.travelSupplierCommissionEntry.findFirst({
        where: { id: entryId, tenantId: req.travelTenant.id, supplierId: parent.id },
      });
      if (!row) {
        return res.status(404).json({ error: "Entry not found", code: "ENTRY_NOT_FOUND" });
      }
      res.json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] get error:", e.message);
      res.status(500).json({ error: "Failed to get commission entry" });
    }
  },
);

// ─── POST /suppliers/:id/commission-entries/:entryId/settle ──────────

router.post(
  "/suppliers/:id/commission-entries/:entryId/settle",
  verifyToken,
  requirePermission("commission_profiles", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const entryId = parseInt(req.params.entryId, 10);
      if (!Number.isFinite(entryId)) {
        return res.status(400).json({ error: "entryId must be a number", code: "INVALID_ID" });
      }
      const row = await prisma.travelSupplierCommissionEntry.findFirst({
        where: { id: entryId, tenantId: req.travelTenant.id, supplierId: parent.id },
      });
      if (!row) {
        return res.status(404).json({ error: "Entry not found", code: "ENTRY_NOT_FOUND" });
      }
      if (row.status === "settled") {
        return res.status(409).json({ error: "Entry already settled", code: "ALREADY_SETTLED" });
      }
      if (row.status === "reversed") {
        return res.status(409).json({ error: "Entry is reversed", code: "ALREADY_REVERSED" });
      }
      const updated = await prisma.travelSupplierCommissionEntry.update({
        where: { id: entryId },
        data: {
          status: "settled",
          settledAt: new Date(),
        },
      });
      await writeAudit(
        "TravelSupplierCommissionEntry",
        "SETTLE",
        entryId,
        req.user.userId,
        req.travelTenant.id,
        { supplierId: parent.id, fiscalYear: row.fiscalYear },
      );
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] settle error:", e.message);
      res.status(500).json({ error: "Failed to settle commission entry" });
    }
  },
);

// ─── POST /suppliers/:id/commission-entries/:entryId/reverse ─────────

router.post(
  "/suppliers/:id/commission-entries/:entryId/reverse",
  verifyToken,
  requirePermission("commission_profiles", "update"),
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const entryId = parseInt(req.params.entryId, 10);
      if (!Number.isFinite(entryId)) {
        return res.status(400).json({ error: "entryId must be a number", code: "INVALID_ID" });
      }
      const { reversalReason } = req.body || {};
      if (!reversalReason || !String(reversalReason).trim()) {
        return res.status(400).json({
          error: "reversalReason required",
          code: "MISSING_FIELDS",
        });
      }
      const row = await prisma.travelSupplierCommissionEntry.findFirst({
        where: { id: entryId, tenantId: req.travelTenant.id, supplierId: parent.id },
      });
      if (!row) {
        return res.status(404).json({ error: "Entry not found", code: "ENTRY_NOT_FOUND" });
      }
      if (row.status === "reversed") {
        return res.status(409).json({ error: "Entry already reversed", code: "ALREADY_REVERSED" });
      }
      const updated = await prisma.travelSupplierCommissionEntry.update({
        where: { id: entryId },
        data: {
          status: "reversed",
          reversedAt: new Date(),
          reversalReason: String(reversalReason).trim(),
        },
      });
      await writeAudit(
        "TravelSupplierCommissionEntry",
        "REVERSE",
        entryId,
        req.user.userId,
        req.travelTenant.id,
        {
          supplierId: parent.id,
          fiscalYear: row.fiscalYear,
          reason: String(reversalReason).trim(),
        },
      );
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] reverse error:", e.message);
      res.status(500).json({ error: "Failed to reverse commission entry" });
    }
  },
);

// ─── GET /suppliers/:id/commission-statement?fiscalYear=FY2025-26 ────

router.get(
  "/suppliers/:id/commission-statement",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const fy = req.query.fiscalYear
        ? String(req.query.fiscalYear)
        : fiscalYearLabelLong(new Date());
      assertValidFiscalYear(fy);
      const rows = await prisma.travelSupplierCommissionEntry.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
          fiscalYear: fy,
        },
      });

      const accruedRows = rows.filter((r) => r.status === "accrued");
      const settledRows = rows.filter((r) => r.status === "settled");
      const reversedRows = rows.filter((r) => r.status === "reversed");

      const totalAccruedCommission = sumDecimals(accruedRows, "commissionAmount");
      const totalSettledCommission = sumDecimals(settledRows, "commissionAmount");
      const totalReversedCommission = sumDecimals(reversedRows, "commissionAmount");
      const totalTds = sumDecimals(
        rows.filter((r) => r.status !== "reversed"),
        "tdsAmount",
      );
      const totalNetPayable = sumDecimals(accruedRows, "netAmount");
      const totalNetSettled = sumDecimals(settledRows, "netAmount");

      res.json({
        supplierId: parent.id,
        supplierName: parent.name,
        subBrand: parent.subBrand,
        fiscalYear: fy,
        counts: {
          accrued: accruedRows.length,
          settled: settledRows.length,
          reversed: reversedRows.length,
          total: rows.length,
        },
        totals: {
          accruedCommission: totalAccruedCommission,
          settledCommission: totalSettledCommission,
          reversedCommission: totalReversedCommission,
          tdsDeducted: totalTds,
          netPayable: totalNetPayable,
          netSettled: totalNetSettled,
        },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] statement error:", e.message);
      res.status(500).json({ error: "Failed to build commission statement" });
    }
  },
);

// ─── GET /suppliers/:id/commission-statement.csv ─────────────────────

router.get(
  "/suppliers/:id/commission-statement.csv",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const parent = await loadParentSupplier(req);
      const fy = req.query.fiscalYear
        ? String(req.query.fiscalYear)
        : fiscalYearLabelLong(new Date());
      assertValidFiscalYear(fy);
      const rows = await prisma.travelSupplierCommissionEntry.findMany({
        where: {
          tenantId: req.travelTenant.id,
          supplierId: parent.id,
          fiscalYear: fy,
        },
        orderBy: [{ accruedAt: "asc" }, { id: "asc" }],
      });

      const header = [
        "id",
        "fiscalYear",
        "status",
        "entryType",
        "accruedAt",
        "settledAt",
        "baseAmount",
        "commissionPercent",
        "commissionAmount",
        "tdsAmount",
        "netAmount",
        "currency",
        "bookingId",
        "invoiceId",
        "notes",
      ];

      const lines = [header.join(",")];
      for (const r of rows) {
        lines.push(
          [
            r.id,
            r.fiscalYear,
            r.status,
            r.entryType,
            r.accruedAt ? r.accruedAt.toISOString() : "",
            r.settledAt ? r.settledAt.toISOString() : "",
            r.baseAmount || "",
            r.commissionPercent || "",
            r.commissionAmount || "",
            r.tdsAmount || "",
            r.netAmount || "",
            r.currency || "",
            r.bookingId || "",
            r.invoiceId || "",
            JSON.stringify(r.notes || ""),
          ].join(","),
        );
      }
      const csv = lines.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="commission-statement-${parent.id}-${fy}.csv"`,
      );
      res.send(csv);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] csv error:", e.message);
      res.status(500).json({ error: "Failed to export CSV" });
    }
  },
);

// ─── GET /commissions/stats — tenant-wide rollup (FR-3.5.b) ───────────
//
// Tenant-wide commission rollup across ALL suppliers (no parent-supplier
// scope). Filters: ?fiscalYear=FY2025-26 (defaults to current FY).
// Sub-brand isolation: where caller is restricted to a subset of
// sub-brands, the rollup filters via the parent supplier's subBrand.

router.get(
  "/commissions/stats",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const fy = req.query.fiscalYear
        ? String(req.query.fiscalYear)
        : fiscalYearLabelLong(new Date());
      assertValidFiscalYear(fy);

      const where = {
        tenantId: req.travelTenant.id,
        fiscalYear: fy,
      };

      // Sub-brand filter via parent supplier when caller scope is narrowed.
      const allowed = await getSubBrandAccessSet(req.user.userId);
      if (allowed) {
        where.supplier = { subBrand: { in: [...allowed] } };
      }

      const rows = await prisma.travelSupplierCommissionEntry.findMany({
        where,
        select: {
          id: true,
          supplierId: true,
          status: true,
          commissionAmount: true,
          tdsAmount: true,
          netAmount: true,
          currency: true,
        },
      });

      const accruedRows = rows.filter((r) => r.status === "accrued");
      const settledRows = rows.filter((r) => r.status === "settled");
      const reversedRows = rows.filter((r) => r.status === "reversed");

      const distinctSuppliers = new Set(rows.map((r) => r.supplierId)).size;

      res.json({
        fiscalYear: fy,
        distinctSuppliers,
        counts: {
          accrued: accruedRows.length,
          settled: settledRows.length,
          reversed: reversedRows.length,
          total: rows.length,
        },
        totals: {
          accruedCommission: sumDecimals(accruedRows, "commissionAmount"),
          settledCommission: sumDecimals(settledRows, "commissionAmount"),
          reversedCommission: sumDecimals(reversedRows, "commissionAmount"),
          tdsDeducted: sumDecimals(
            rows.filter((r) => r.status !== "reversed"),
            "tdsAmount",
          ),
          netPayable: sumDecimals(accruedRows, "netAmount"),
          netSettled: sumDecimals(settledRows, "netAmount"),
        },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-sup-comm] stats error:", e.message);
      res.status(500).json({ error: "Failed to compute commission stats" });
    }
  },
);

module.exports = router;
