// Travel CRM — CSV import/export for cost-master + diagnostic banks.
//
// Closes the Phase 1.5 polish-list item: "CSV import for cost-master +
// diagnostic banks. Mirrors the pattern in routes/csv_io.js."
//
// Endpoints (mounted at /api/travel):
//   GET    /cost-master/export.csv          — verifyToken + requireTravelTenant
//   POST   /cost-master/import.csv          — ADMIN | MANAGER (matches POST /cost-master)
//   GET    /diagnostic-banks/export.csv     — verifyToken + requireTravelTenant
//   POST   /diagnostic-banks/import.csv     — ADMIN only (matches POST /diagnostic-banks)
//
// Why a separate file from routes/csv_io.js:
//   csv_io.js gates on plain RBAC (ADMIN | MANAGER) without the travel-vertical
//   or sub-brand checks. Importing travel cost rows for a clinic admin who has
//   no sub-brand access would silently widen their data view. This file keeps
//   the requireTravelTenant + getSubBrandAccessSet middleware chain identical
//   to the existing travel CRUD routes so the audit + scoping invariants hold.
//
// Idempotency keys:
//   - TravelCostMaster: (tenantId, subBrand, category, routeOrSku). Re-running
//     the same CSV updates baseRate / supplier / season / validity instead of
//     duplicating rows. This is the natural key a buyer uses to dedupe a
//     supplier rate card upload (one row per route+SKU).
//   - TravelDiagnosticQuestionBank: (tenantId, subBrand, version). Admin
//     specifies version explicitly so the CSV is reproducible — re-running
//     overwrites the same version row with updated questions/scoring; bumping
//     to v2 means uploading with version=2. This matches the existing POST
//     /diagnostic-banks convention except the CSV path does NOT auto-increment
//     (auto-increment would make re-imports non-deterministic).
//
// Capped at 5,000 rows per upload to match csv_io.js — guards against DoS
// via massive uploads and keeps the row-by-row Prisma loop bounded.

const express = require("express");
const multer = require("multer");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { verifyToken, verifyRole } = require("../middleware/auth");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  narrowWhereBySubBrand,
} = require("../middleware/travelGuards");
const { parseBank } = require("../lib/travelDiagnosticScoring");
const {
  serializeRows,
  parseCsv,
  buildErrorReport,
  setCsvDownloadHeaders,
} = require("../lib/csvHelpers");

const router = express.Router();

// 5 MB cap matches csv_io.js; CSVs holding ~thousands of rate rows comfortably
// fit. Larger uploads usually indicate a misuse (e.g. dumping a full bookings
// table by accident) and the multer error is a better signal than OOM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const MAX_IMPORT_ROWS = 5000;
const VALID_CATEGORIES = ["hotel", "flight", "transport", "visa", "insurance"];

// Accept both multipart/form-data (multer) AND text/csv-as-body. The
// /api/travel router doesn't have a global text-body parser — scope this
// one to the sub-routes here only.
router.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));

function readUploadedCsv(req) {
  if (req.file && req.file.buffer) return req.file.buffer.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body.csv === "string") return req.body.csv;
  return null;
}

function writeImportAudit(req, entity, summary) {
  return writeAudit(entity, "CSV_IMPORT", null, req.user.userId, req.travelTenant.id, {
    ...summary,
    source: "csv",
  });
}

// ── Cost master ────────────────────────────────────────────────────

const COST_MASTER_COLS = [
  { key: "id", header: "id" },
  { key: "subBrand", header: "subBrand" },
  { key: "category", header: "category" },
  { key: "routeOrSku", header: "routeOrSku" },
  { key: "supplierId", header: "supplierId" },
  { key: "baseRate", header: "baseRate" },
  { key: "currency", header: "currency" },
  { key: "seasonId", header: "seasonId" },
  { key: "attributesJson", header: "attributesJson" },
  {
    key: "validFrom",
    header: "validFrom",
    render: (r) => (r.validFrom ? new Date(r.validFrom).toISOString().slice(0, 10) : ""),
  },
  {
    key: "validTo",
    header: "validTo",
    render: (r) => (r.validTo ? new Date(r.validTo).toISOString().slice(0, 10) : ""),
  },
  { key: "isActive", header: "isActive" },
];

router.get("/cost-master/export.csv", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.category) {
      if (!VALID_CATEGORIES.includes(String(req.query.category))) {
        return res.status(400).json({
          error: `category must be one of: ${VALID_CATEGORIES.join(", ")}`,
          code: "INVALID_CATEGORY",
        });
      }
      where.category = String(req.query.category);
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    const rows = await prisma.travelCostMaster.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { category: "asc" }, { routeOrSku: "asc" }],
      take: 10000,
    });
    const csv = serializeRows(COST_MASTER_COLS, rows);
    setCsvDownloadHeaders(res, "travel-cost-master-export.csv");
    res.send(csv);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-csv] cost-master export error:", e.message);
    res.status(500).json({ error: "Failed to export cost-master" });
  }
});

router.post(
  "/cost-master/import.csv",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  upload.single("file"),
  async (req, res) => {
    try {
      const csvText = readUploadedCsv(req);
      if (!csvText) {
        return res.status(400).json({ error: "No CSV body or file uploaded", code: "NO_CSV" });
      }
      const { rows } = parseCsv(csvText);
      if (rows.length === 0) {
        return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
      }
      if (rows.length > MAX_IMPORT_ROWS) {
        return res.status(413).json({
          error: `Too many rows. Max ${MAX_IMPORT_ROWS}`,
          code: "TOO_MANY_ROWS",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      let imported = 0;
      let updated = 0;
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2;
        try {
          const subBrand = String(row.subBrand || "").trim();
          const category = String(row.category || "").trim();
          const routeOrSku = String(row.routeOrSku || "").trim();
          if (!subBrand || !category || !routeOrSku) {
            errors.push({ rowNumber, reason: "missing subBrand, category, or routeOrSku" });
            continue;
          }
          try {
            assertValidSubBrand(subBrand);
          } catch (subBrandErr) {
            errors.push({ rowNumber, reason: subBrandErr.message });
            continue;
          }
          if (!canAccessSubBrand(allowed, subBrand)) {
            errors.push({ rowNumber, reason: `sub-brand access denied: ${subBrand}` });
            continue;
          }
          if (!VALID_CATEGORIES.includes(category)) {
            errors.push({ rowNumber, reason: `invalid category: ${category}` });
            continue;
          }
          const baseRate = row.baseRate === "" || row.baseRate == null ? NaN : Number(row.baseRate);
          if (!Number.isFinite(baseRate) || baseRate < 0) {
            errors.push({ rowNumber, reason: `invalid baseRate: ${row.baseRate}` });
            continue;
          }

          const data = {
            subBrand,
            category,
            routeOrSku,
            baseRate,
            supplierId:
              row.supplierId && /^\d+$/.test(String(row.supplierId).trim())
                ? parseInt(String(row.supplierId).trim(), 10)
                : null,
            currency: row.currency ? String(row.currency).trim() : "INR",
            seasonId:
              row.seasonId && /^\d+$/.test(String(row.seasonId).trim())
                ? parseInt(String(row.seasonId).trim(), 10)
                : null,
            attributesJson: row.attributesJson ? String(row.attributesJson) : null,
            validFrom: row.validFrom ? new Date(row.validFrom) : null,
            validTo: row.validTo ? new Date(row.validTo) : null,
            isActive: row.isActive ? row.isActive !== "false" : true,
          };

          const existing = await prisma.travelCostMaster.findFirst({
            where: {
              tenantId: req.travelTenant.id,
              subBrand,
              category,
              routeOrSku,
            },
          });
          if (existing) {
            await prisma.travelCostMaster.update({ where: { id: existing.id }, data });
            updated++;
          } else {
            await prisma.travelCostMaster.create({
              data: { ...data, tenantId: req.travelTenant.id },
            });
            imported++;
          }
        } catch (rowErr) {
          errors.push({ rowNumber, reason: rowErr.message });
        }
      }

      await writeImportAudit(req, "TravelCostMaster", {
        rowCount: rows.length,
        imported,
        updated,
        errorCount: errors.length,
      });

      if (req.query.errorReport === "csv" && errors.length > 0) {
        setCsvDownloadHeaders(res, "travel-cost-master-errors.csv");
        return res.send(buildErrorReport(errors));
      }
      res.json({ imported, updated, skipped: errors.length, errors });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-csv] cost-master import error:", e.message);
      res.status(500).json({ error: "Failed to import cost-master" });
    }
  },
);

// ── Diagnostic banks ───────────────────────────────────────────────

const DIAG_BANK_COLS = [
  { key: "id", header: "id" },
  { key: "subBrand", header: "subBrand" },
  { key: "version", header: "version" },
  { key: "isActive", header: "isActive" },
  { key: "questionsJson", header: "questionsJson" },
  { key: "scoringRulesJson", header: "scoringRulesJson" },
];

router.get("/diagnostic-banks/export.csv", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand)
          ? where.subBrand
          : "__none__"
        : { in: [...allowed] };
    }

    const rows = await prisma.travelDiagnosticQuestionBank.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { version: "asc" }],
      take: 5000,
    });
    const csv = serializeRows(DIAG_BANK_COLS, rows);
    setCsvDownloadHeaders(res, "travel-diagnostic-banks-export.csv");
    res.send(csv);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-csv] diagnostic-banks export error:", e.message);
    res.status(500).json({ error: "Failed to export diagnostic banks" });
  }
});

router.post(
  "/diagnostic-banks/import.csv",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  upload.single("file"),
  async (req, res) => {
    try {
      const csvText = readUploadedCsv(req);
      if (!csvText) {
        return res.status(400).json({ error: "No CSV body or file uploaded", code: "NO_CSV" });
      }
      const { rows } = parseCsv(csvText);
      if (rows.length === 0) {
        return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
      }
      if (rows.length > MAX_IMPORT_ROWS) {
        return res.status(413).json({
          error: `Too many rows. Max ${MAX_IMPORT_ROWS}`,
          code: "TOO_MANY_ROWS",
        });
      }

      const allowed = await getSubBrandAccessSet(req.user.userId);
      let imported = 0;
      let updated = 0;
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2;
        try {
          const subBrand = String(row.subBrand || "").trim();
          const versionStr = String(row.version || "").trim();
          const questionsJson = String(row.questionsJson || "");
          const scoringRulesJson = String(row.scoringRulesJson || "");

          if (!subBrand || !versionStr || !questionsJson || !scoringRulesJson) {
            errors.push({
              rowNumber,
              reason: "missing subBrand, version, questionsJson, or scoringRulesJson",
            });
            continue;
          }
          try {
            assertValidSubBrand(subBrand);
          } catch (subBrandErr) {
            errors.push({ rowNumber, reason: subBrandErr.message });
            continue;
          }
          if (!canAccessSubBrand(allowed, subBrand)) {
            errors.push({ rowNumber, reason: `sub-brand access denied: ${subBrand}` });
            continue;
          }
          const version = parseInt(versionStr, 10);
          if (!Number.isFinite(version) || version <= 0) {
            errors.push({ rowNumber, reason: `invalid version: ${versionStr}` });
            continue;
          }

          // Re-use the same JSON validator the POST /diagnostic-banks endpoint
          // uses — a non-parseable bank can't be scored against, refuse it.
          const { bank: parsed } = parseBank(questionsJson, scoringRulesJson);
          if (!parsed) {
            errors.push({ rowNumber, reason: "questionsJson or scoringRulesJson is not valid JSON" });
            continue;
          }
          if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
            errors.push({ rowNumber, reason: "questionsJson must define at least one question" });
            continue;
          }
          if (!Array.isArray(parsed.bands) || parsed.bands.length === 0) {
            errors.push({ rowNumber, reason: "scoringRulesJson must define at least one band" });
            continue;
          }

          const data = {
            subBrand,
            version,
            questionsJson,
            scoringRulesJson,
            isActive: row.isActive ? row.isActive !== "false" : true,
          };

          const existing = await prisma.travelDiagnosticQuestionBank.findFirst({
            where: { tenantId: req.travelTenant.id, subBrand, version },
          });
          if (existing) {
            await prisma.travelDiagnosticQuestionBank.update({
              where: { id: existing.id },
              data,
            });
            updated++;
          } else {
            await prisma.travelDiagnosticQuestionBank.create({
              data: { ...data, tenantId: req.travelTenant.id },
            });
            imported++;
          }
        } catch (rowErr) {
          errors.push({ rowNumber, reason: rowErr.message });
        }
      }

      await writeImportAudit(req, "TravelDiagnosticQuestionBank", {
        rowCount: rows.length,
        imported,
        updated,
        errorCount: errors.length,
      });

      if (req.query.errorReport === "csv" && errors.length > 0) {
        setCsvDownloadHeaders(res, "travel-diagnostic-banks-errors.csv");
        return res.send(buildErrorReport(errors));
      }
      res.json({ imported, updated, skipped: errors.length, errors });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-csv] diagnostic-banks import error:", e.message);
      res.status(500).json({ error: "Failed to import diagnostic banks" });
    }
  },
);

module.exports = router;
