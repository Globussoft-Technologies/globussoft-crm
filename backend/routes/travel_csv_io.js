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
const { requirePermission } = require("../middleware/requirePermission");
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
  requirePermission("cost_master", "write"),
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
  requirePermission("diagnostics", "write"),
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

// ── Seasons (TravelSeasonCalendar) ─────────────────────────────────

const SEASON_COLS = [
  { key: "id", header: "id" },
  { key: "subBrand", header: "subBrand" },
  { key: "seasonName", header: "seasonName" },
  {
    key: "startDate",
    header: "startDate",
    render: (r) => (r.startDate ? new Date(r.startDate).toISOString().slice(0, 10) : ""),
  },
  {
    key: "endDate",
    header: "endDate",
    render: (r) => (r.endDate ? new Date(r.endDate).toISOString().slice(0, 10) : ""),
  },
  { key: "multiplier", header: "multiplier" },
];

router.get("/seasons/export.csv", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    const rows = await prisma.travelSeasonCalendar.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { startDate: "asc" }],
      take: 5000,
    });
    const csv = serializeRows(SEASON_COLS, rows);
    setCsvDownloadHeaders(res, "travel-seasons-export.csv");
    res.send(csv);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-csv] seasons export error:", e.message);
    res.status(500).json({ error: "Failed to export seasons" });
  }
});

router.post(
  "/seasons/import.csv",
  verifyToken,
  requirePermission("pricing", "write"),
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
          const seasonName = String(row.seasonName || "").trim();
          const startDateStr = String(row.startDate || "").trim();
          const endDateStr = String(row.endDate || "").trim();

          if (!subBrand || !seasonName || !startDateStr || !endDateStr) {
            errors.push({
              rowNumber,
              reason: "missing subBrand, seasonName, startDate, or endDate",
            });
            continue;
          }
          try { assertValidSubBrand(subBrand); }
          catch (subBrandErr) { errors.push({ rowNumber, reason: subBrandErr.message }); continue; }
          if (!canAccessSubBrand(allowed, subBrand)) {
            errors.push({ rowNumber, reason: `sub-brand access denied: ${subBrand}` });
            continue;
          }
          const startDate = new Date(startDateStr);
          const endDate = new Date(endDateStr);
          if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
            errors.push({ rowNumber, reason: `invalid date(s): ${startDateStr} / ${endDateStr}` });
            continue;
          }
          if (endDate < startDate) {
            errors.push({ rowNumber, reason: "endDate must be on or after startDate" });
            continue;
          }
          let multiplier = null;
          if (row.multiplier !== "" && row.multiplier != null) {
            const m = Number(row.multiplier);
            if (!Number.isFinite(m) || m < 0) {
              errors.push({ rowNumber, reason: `invalid multiplier: ${row.multiplier}` });
              continue;
            }
            multiplier = m;
          }

          const data = { subBrand, seasonName, startDate, endDate, multiplier };
          // Natural key: (tenantId, subBrand, seasonName) — the same season for
          // the same sub-brand should overwrite, not duplicate.
          const existing = await prisma.travelSeasonCalendar.findFirst({
            where: { tenantId: req.travelTenant.id, subBrand, seasonName },
          });
          if (existing) {
            await prisma.travelSeasonCalendar.update({ where: { id: existing.id }, data });
            updated++;
          } else {
            await prisma.travelSeasonCalendar.create({
              data: { ...data, tenantId: req.travelTenant.id },
            });
            imported++;
          }
        } catch (rowErr) {
          errors.push({ rowNumber, reason: rowErr.message });
        }
      }

      await writeImportAudit(req, "TravelSeasonCalendar", {
        rowCount: rows.length,
        imported,
        updated,
        errorCount: errors.length,
      });

      if (req.query.errorReport === "csv" && errors.length > 0) {
        setCsvDownloadHeaders(res, "travel-seasons-errors.csv");
        return res.send(buildErrorReport(errors));
      }
      res.json({ imported, updated, skipped: errors.length, errors });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-csv] seasons import error:", e.message);
      res.status(500).json({ error: "Failed to import seasons" });
    }
  },
);

// ── Markup rules (TravelMarkupRule) ────────────────────────────────

const VALID_SCOPES = ["flight", "hotel", "transport", "package"];

const MARKUP_RULE_COLS = [
  { key: "id", header: "id" },
  { key: "subBrand", header: "subBrand" },
  { key: "scope", header: "scope" },
  { key: "matchKeyJson", header: "matchKeyJson" },
  { key: "markupPct", header: "markupPct" },
  { key: "markupFlat", header: "markupFlat" },
  { key: "minPax", header: "minPax" },
  { key: "priority", header: "priority" },
  { key: "isActive", header: "isActive" },
];

router.get("/markup-rules/export.csv", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.scope) {
      if (!VALID_SCOPES.includes(String(req.query.scope))) {
        return res.status(400).json({
          error: `scope must be one of: ${VALID_SCOPES.join(", ")}`,
          code: "INVALID_SCOPE",
        });
      }
      where.scope = String(req.query.scope);
    }
    const allowed = await getSubBrandAccessSet(req.user.userId);
    narrowWhereBySubBrand(where, allowed);

    const rows = await prisma.travelMarkupRule.findMany({
      where,
      orderBy: [{ subBrand: "asc" }, { priority: "asc" }],
      take: 5000,
    });
    const csv = serializeRows(MARKUP_RULE_COLS, rows);
    setCsvDownloadHeaders(res, "travel-markup-rules-export.csv");
    res.send(csv);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-csv] markup-rules export error:", e.message);
    res.status(500).json({ error: "Failed to export markup rules" });
  }
});

router.post(
  "/markup-rules/import.csv",
  verifyToken,
  requirePermission("pricing", "write"),
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
          const scope = String(row.scope || "").trim();
          const matchKeyJson = String(row.matchKeyJson || "").trim();
          if (!subBrand || !scope || !matchKeyJson) {
            errors.push({
              rowNumber,
              reason: "missing subBrand, scope, or matchKeyJson",
            });
            continue;
          }
          try { assertValidSubBrand(subBrand); }
          catch (subBrandErr) { errors.push({ rowNumber, reason: subBrandErr.message }); continue; }
          if (!canAccessSubBrand(allowed, subBrand)) {
            errors.push({ rowNumber, reason: `sub-brand access denied: ${subBrand}` });
            continue;
          }
          if (!VALID_SCOPES.includes(scope)) {
            errors.push({ rowNumber, reason: `invalid scope: ${scope}` });
            continue;
          }
          try { JSON.parse(matchKeyJson); }
          catch { errors.push({ rowNumber, reason: "matchKeyJson is not valid JSON" }); continue; }

          // Exactly one of markupPct / markupFlat must be set — mirrors the
          // EXACTLY_ONE_MARKUP_TYPE invariant from routes/travel_pricing.js.
          const hasPct = row.markupPct !== "" && row.markupPct != null;
          const hasFlat = row.markupFlat !== "" && row.markupFlat != null;
          if (hasPct === hasFlat) {
            errors.push({ rowNumber, reason: "exactly one of markupPct / markupFlat must be set" });
            continue;
          }
          let markupPct = null;
          let markupFlat = null;
          if (hasPct) {
            const p = Number(row.markupPct);
            if (!Number.isFinite(p) || p < 0) {
              errors.push({ rowNumber, reason: `invalid markupPct: ${row.markupPct}` });
              continue;
            }
            markupPct = p;
          } else {
            const f = Number(row.markupFlat);
            if (!Number.isFinite(f) || f < 0) {
              errors.push({ rowNumber, reason: `invalid markupFlat: ${row.markupFlat}` });
              continue;
            }
            markupFlat = f;
          }
          const priority = row.priority !== "" && row.priority != null
            ? parseInt(row.priority, 10)
            : 100;
          if (!Number.isFinite(priority)) {
            errors.push({ rowNumber, reason: `invalid priority: ${row.priority}` });
            continue;
          }
          const isActive = row.isActive ? row.isActive !== "false" : true;

          let minPax = null;
          if (row.minPax !== "" && row.minPax != null) {
            const mp = parseInt(row.minPax, 10);
            if (!Number.isFinite(mp) || mp < 1) {
              errors.push({ rowNumber, reason: `invalid minPax: ${row.minPax} — must be a positive integer` });
              continue;
            }
            minPax = mp;
          }

          const data = { subBrand, scope, matchKeyJson, markupPct, markupFlat, minPax, priority, isActive };
          // Natural key: (tenantId, subBrand, scope, matchKeyJson). Same rule
          // expressed twice in a CSV (e.g. re-imports) updates instead of
          // creating a second row. matchKeyJson is normalised via JSON.parse
          // round-trip so whitespace / key-order differences don't fork rows.
          const normalisedMatchKey = JSON.stringify(JSON.parse(matchKeyJson));
          const existing = await prisma.travelMarkupRule.findFirst({
            where: { tenantId: req.travelTenant.id, subBrand, scope, matchKeyJson: normalisedMatchKey },
          });
          data.matchKeyJson = normalisedMatchKey;
          if (existing) {
            await prisma.travelMarkupRule.update({ where: { id: existing.id }, data });
            updated++;
          } else {
            await prisma.travelMarkupRule.create({
              data: { ...data, tenantId: req.travelTenant.id },
            });
            imported++;
          }
        } catch (rowErr) {
          errors.push({ rowNumber, reason: rowErr.message });
        }
      }

      await writeImportAudit(req, "TravelMarkupRule", {
        rowCount: rows.length,
        imported,
        updated,
        errorCount: errors.length,
      });

      if (req.query.errorReport === "csv" && errors.length > 0) {
        setCsvDownloadHeaders(res, "travel-markup-rules-errors.csv");
        return res.send(buildErrorReport(errors));
      }
      res.json({ imported, updated, skipped: errors.length, errors });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-csv] markup-rules import error:", e.message);
      res.status(500).json({ error: "Failed to import markup rules" });
    }
  },
);

module.exports = router;
