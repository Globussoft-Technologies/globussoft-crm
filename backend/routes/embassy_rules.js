/**
 * /api/embassy-rules — EmbassyRule CRUD (Visa Sure Phase 3, PC-3 + PC-7 resolved 2026-05-24).
 *
 * The EmbassyRule model (prisma/schema.prisma:4581, shipped tick #173 commit
 * 6f82e9a7) is the structured backing store for the Visa Sure risk-flag
 * engine. Per PC-3 resolution: Phase 3 ships *structured* rules (not
 * free-text PDF advisories); per PC-7 resolution: the advisor-head + an
 * admin UI maintainer own authorship and curation.
 *
 * Endpoints
 * ---------
 *   GET    /api/embassy-rules                — list, filterable by
 *                                              ?destinationCountry / ?applicationType /
 *                                              ?ruleType / ?severity / ?isActive
 *   GET    /api/embassy-rules/import-meta     — ADMIN-only import headers
 *   GET    /api/embassy-rules/import-template — ADMIN-only CSV/XLSX template
 *   GET    /api/embassy-rules/export          — ADMIN-only CSV/XLSX export
 *   POST   /api/embassy-rules/import          — ADMIN-only bulk import
 *   GET    /api/embassy-rules/:id            — single rule
 *   POST   /api/embassy-rules                — create (ADMIN-only)
 *   PUT    /api/embassy-rules/:id            — update (ADMIN-only)
 *   DELETE /api/embassy-rules/:id            — soft-delete via isActive=false
 *                                              (ADMIN-only; NO hard delete)
 *
 * Validation
 * ----------
 *   - destinationCountry: 2 uppercase A-Z chars (ISO-3166-1 alpha-2)
 *   - severity: info | warning | blocker
 *   - ruleType: non-empty string
 *   - conditionJson: routed through sanitizeJsonForStringColumn per CLAUDE.md
 *
 * Error envelope
 * --------------
 *   400 INVALID_DESTINATION_COUNTRY  — country not 2-char uppercase
 *   400 INVALID_SEVERITY             — severity not in {info, warning, blocker}
 *   400 INVALID_RULE_TYPE            — empty/missing ruleType
 *   400 MISSING_FIELDS               — required field absent on create
 *   400 INVALID_ID                   — non-numeric path id
 *   400 EMPTY_BODY                   — PUT with no updatable fields
 *   403 RBAC_DENIED                  — verifyRole gate
 *   404 EMBASSY_RULE_NOT_FOUND       — id absent or cross-tenant
 *   409 EMBASSY_RULE_DUPLICATE       — @@unique([tenantId, destinationCountry,
 *                                       applicationType, ruleType]) violation
 *
 * Tenant scoping: every read uses `req.user.tenantId`; every write stamps
 * `tenantId` from the same source. The body cannot override (stripDangerous
 * middleware drops req.body.tenantId before this handler sees it, AND the
 * handler never reads it anyway).
 *
 * createdById is stamped from `req.user.userId` on POST and cannot be
 * reassigned via PUT.
 */

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { sanitizeText, sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
const {
  serializeRows,
  parseCsv,
  setCsvDownloadHeaders,
} = require("../lib/csvHelpers");
const { parseXlsxBuffer, toXlsxBuffer } = require("../lib/csvIO");

const VALID_SEVERITIES = ["info", "warning", "blocker"];
const ISO_ALPHA2_RE = /^[A-Z]{2}$/;
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_IMPORT_ROWS = 5000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const EMBASSY_RULE_EXPORT_COLUMNS = [
  { key: "destinationCountry", header: "destinationCountry" },
  { key: "ruleType", header: "ruleType" },
  { key: "applicationType", header: "applicationType" },
  { key: "actionLabel", header: "actionLabel" },
  { key: "severity", header: "severity" },
  { key: "isActive", header: "isActive", render: (r) => (r.isActive ? "true" : "false") },
  { key: "conditionJson", header: "conditionJson" },
];

const EMBASSY_RULE_IMPORT_HEADERS = EMBASSY_RULE_EXPORT_COLUMNS.map((col) => col.header);
const EMBASSY_RULE_TEMPLATE_SAMPLE = {
  destinationCountry: "# DELETE THIS ROW BEFORE IMPORTING",
  ruleType: "# example: document_required",
  applicationType: "# optional: leave blank for all application types",
  actionLabel: "# example: Sponsor income proof required (last 6 months)",
  severity: "# info | warning | blocker",
  isActive: "# true",
  conditionJson: "# optional JSON string",
};

function assertValidDestinationCountry(input) {
  if (typeof input !== "string" || !ISO_ALPHA2_RE.test(input)) {
    const err = new Error(
      "destinationCountry must be a 2-character uppercase ISO-3166-1 alpha-2 code",
    );
    err.status = 400;
    err.code = "INVALID_DESTINATION_COUNTRY";
    throw err;
  }
}

function assertValidSeverity(input) {
  if (!VALID_SEVERITIES.includes(input)) {
    const err = new Error(
      `severity must be one of: ${VALID_SEVERITIES.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_SEVERITY";
    throw err;
  }
}

function assertValidRuleType(input) {
  if (typeof input !== "string" || input.trim() === "") {
    const err = new Error("ruleType must be a non-empty string");
    err.status = 400;
    err.code = "INVALID_RULE_TYPE";
    throw err;
  }
}

// Translate Prisma's P2002 (unique constraint violation) to a 409 with a
// stable code so the SPA / specs can distinguish it from generic 500s.
function isPrismaUniqueViolation(e) {
  return e && (e.code === "P2002" || /Unique constraint/i.test(e.message || ""));
}

function setXlsxDownloadHeaders(res, filename) {
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function resolveDownloadFormat(req) {
  const format = String(req.query.format || "csv").toLowerCase();
  return format === "xlsx" ? "xlsx" : "csv";
}

function buildListWhere(req) {
  const where = { tenantId: req.user.tenantId };
  if (req.query.destinationCountry !== undefined) {
    const dc = String(req.query.destinationCountry).toUpperCase();
    assertValidDestinationCountry(dc);
    where.destinationCountry = dc;
  }
  if (req.query.applicationType !== undefined) {
    where.applicationType = String(req.query.applicationType);
  }
  if (req.query.ruleType !== undefined) {
    where.ruleType = String(req.query.ruleType);
  }
  if (req.query.severity !== undefined) {
    assertValidSeverity(String(req.query.severity));
    where.severity = String(req.query.severity);
  }
  if (req.query.isActive !== undefined) {
    const v = String(req.query.isActive).toLowerCase();
    where.isActive = !(v === "false" || v === "0");
  }
  return where;
}

function isXlsxUpload(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return true;
  const mime = String(file.mimetype || "").toLowerCase();
  return mime === XLSX_CONTENT_TYPE || mime === "application/vnd.ms-excel";
}

function readUploadedRows(req) {
  if (req.file && req.file.buffer && req.file.buffer.length > 0) {
    return isXlsxUpload(req.file)
      ? parseXlsxBuffer(req.file.buffer)
      : parseCsv(req.file.buffer.toString("utf8"));
  }
  if (typeof req.body === "string" && req.body.length > 0) {
    return parseCsv(req.body);
  }
  if (req.body && typeof req.body.csv === "string" && req.body.csv.length > 0) {
    return parseCsv(req.body.csv);
  }
  return null;
}

function normalizeOptionalText(value) {
  const raw = value == null ? "" : String(value).trim();
  return raw ? sanitizeText(raw) : null;
}

function parseBoolLike(value, fallback = true) {
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (raw === "") return fallback;
  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;
  return Boolean(value);
}

// GET /api/embassy-rules — list with optional filters.
router.get("/", verifyToken, async (req, res) => {
  try {
    const where = buildListWhere(req);

    const take = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip = parseInt(req.query.offset, 10) || 0;

    // ?fields=summary — opt-in slim shape for list-card UIs that don't need the
    // heavy actionLabel free-text + conditionJson payload. Mirrors slices 1-39
    // of #920. Drops actionLabel (long advisor warning text) and conditionJson
    // (rule-logic blob); keeps the identifying + filterable + display-chrome
    // fields the SPA's index pages render.
    const isSummary = String(req.query.fields || "").toLowerCase() === "summary";
    const findManyArgs = {
      where,
      orderBy: [{ createdAt: "desc" }],
      take,
      skip,
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        tenantId: true,
        ruleType: true,
        destinationCountry: true,
        applicationType: true,
        severity: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      };
    }

    const [rules, total] = await Promise.all([
      prisma.embassyRule.findMany(findManyArgs),
      prisma.embassyRule.count({ where }),
    ]);
    res.json({ rules, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[embassy-rules] list error:", e.message);
    res.status(500).json({ error: "Failed to list embassy rules" });
  }
});

// ADMIN-only import/export/template helpers (must stay before /:id).
router.get("/import-meta", verifyToken, verifyRole(["ADMIN"]), (req, res) => {
  res.json({
    entity: "embassy-rules",
    headers: EMBASSY_RULE_IMPORT_HEADERS,
    sample: EMBASSY_RULE_TEMPLATE_SAMPLE,
    thresholds: {
      rows: MAX_IMPORT_ROWS,
      bytes: 5 * 1024 * 1024,
    },
  });
});

router.get("/import-template", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const format = resolveDownloadFormat(req);
    if (format === "xlsx") {
      const buf = toXlsxBuffer(
        EMBASSY_RULE_IMPORT_HEADERS,
        [EMBASSY_RULE_TEMPLATE_SAMPLE],
        "Embassy Rules Template",
      );
      setXlsxDownloadHeaders(res, "embassy-rules-template.xlsx");
      return res.send(buf);
    }
    const csv = serializeRows(EMBASSY_RULE_EXPORT_COLUMNS, [EMBASSY_RULE_TEMPLATE_SAMPLE]);
    setCsvDownloadHeaders(res, "embassy-rules-template.csv");
    return res.send(csv);
  } catch (e) {
    console.error("[embassy-rules] template error:", e.message);
    return res.status(500).json({
      error: "Failed to generate embassy rules template",
      code: "EMBASSY_RULE_TEMPLATE_FAILED",
    });
  }
});

router.get("/export", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const where = buildListWhere(req);
    const rules = await prisma.embassyRule.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: 10000,
    });
    const rows = rules.map((rule) => ({
      destinationCountry: rule.destinationCountry,
      ruleType: rule.ruleType,
      applicationType: rule.applicationType || "",
      actionLabel: rule.actionLabel,
      severity: rule.severity,
      isActive: rule.isActive,
      conditionJson: rule.conditionJson || "",
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    const format = resolveDownloadFormat(req);
    if (format === "xlsx") {
      const buf = toXlsxBuffer(EMBASSY_RULE_IMPORT_HEADERS, rows, "Embassy Rules Export");
      setXlsxDownloadHeaders(res, `embassy-rules-export-${stamp}.xlsx`);
      return res.send(buf);
    }
    const csv = serializeRows(EMBASSY_RULE_EXPORT_COLUMNS, rows);
    setCsvDownloadHeaders(res, `embassy-rules-export-${stamp}.csv`);
    return res.send(csv);
  } catch (e) {
    console.error("[embassy-rules] export error:", e.message);
    return res.status(500).json({
      error: "Failed to export embassy rules",
      code: "EMBASSY_RULE_EXPORT_FAILED",
    });
  }
});

router.post("/import", verifyToken, verifyRole(["ADMIN"]), upload.single("file"), async (req, res) => {
  try {
    const parsed = readUploadedRows(req);
    if (!parsed) {
      return res.status(400).json({
        error: "No CSV/Excel body or file uploaded",
        code: "NO_CSV",
      });
    }

    const headers = Array.isArray(parsed.headers) ? parsed.headers : [];
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const missing = EMBASSY_RULE_IMPORT_HEADERS.filter((header) => !headers.includes(header));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `missing required column(s): ${missing.join(", ")}`,
        code: "MISSING_FIELDS",
      });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({
        error: `Too many rows. Max ${MAX_IMPORT_ROWS}`,
        code: "TOO_MANY_ROWS",
      });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const rowNumber = i + 2;
      try {
        const destinationCountryRaw = normalizeOptionalText(row.destinationCountry);
        const ruleTypeRaw = normalizeOptionalText(row.ruleType);
        const actionLabelRaw = normalizeOptionalText(row.actionLabel);
        const severityRaw = normalizeOptionalText(row.severity);
        const applicationTypeRaw = normalizeOptionalText(row.applicationType);
        const conditionJsonRaw = normalizeOptionalText(row.conditionJson);
        const isActiveRaw = normalizeOptionalText(row.isActive);

        if (
          !destinationCountryRaw &&
          !ruleTypeRaw &&
          !actionLabelRaw &&
          !severityRaw &&
          !applicationTypeRaw &&
          !conditionJsonRaw &&
          !isActiveRaw
        ) {
          skipped += 1;
          continue;
        }

        if (
          String(row.destinationCountry || "").trim().startsWith("#") ||
          String(row.ruleType || "").trim().startsWith("#")
        ) {
          skipped += 1;
          continue;
        }

        if (!destinationCountryRaw || !ruleTypeRaw || !actionLabelRaw || !severityRaw) {
          errors.push({
            rowNumber,
            reason: "missing destinationCountry, ruleType, actionLabel, or severity",
          });
          skipped += 1;
          continue;
        }

        const destinationCountry = destinationCountryRaw.toUpperCase();
        assertValidDestinationCountry(destinationCountry);
        const ruleType = ruleTypeRaw;
        assertValidRuleType(ruleType);
        assertValidSeverity(severityRaw);

        const applicationType = applicationTypeRaw;
        const conditionJson = conditionJsonRaw == null
          ? null
          : sanitizeJsonForStringColumn(conditionJsonRaw);
        const isActive = parseBoolLike(isActiveRaw, true);

        const data = {
          tenantId: req.user.tenantId,
          destinationCountry,
          ruleType,
          applicationType,
          conditionJson,
          actionLabel: actionLabelRaw,
          severity: severityRaw,
          isActive,
          createdById: req.user.userId,
        };

        const existing = await prisma.embassyRule.findFirst({
          where: {
            tenantId: req.user.tenantId,
            destinationCountry,
            applicationType,
            ruleType,
          },
        });

        if (existing) {
          await prisma.embassyRule.update({
            where: { id: existing.id },
            data: {
              ruleType: data.ruleType,
              destinationCountry: data.destinationCountry,
              applicationType: data.applicationType,
              conditionJson: data.conditionJson,
              actionLabel: data.actionLabel,
              severity: data.severity,
              isActive: data.isActive,
            },
          });
          updated += 1;
        } else {
          await prisma.embassyRule.create({ data });
          imported += 1;
        }
      } catch (rowErr) {
        errors.push({
          rowNumber,
          reason: rowErr?.message || String(rowErr),
        });
        skipped += 1;
      }
    }

    return res.json({ imported, updated, skipped, errors });
  } catch (e) {
    console.error("[embassy-rules] import error:", e.message);
    return res.status(500).json({
      error: "Failed to import embassy rules",
      code: "EMBASSY_RULE_IMPORT_FAILED",
    });
  }
});

// GET /api/embassy-rules/:id — single rule (tenant-scoped).
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const rule = await prisma.embassyRule.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!rule) {
      return res.status(404).json({
        error: "Embassy rule not found",
        code: "EMBASSY_RULE_NOT_FOUND",
      });
    }
    res.json(rule);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[embassy-rules] get error:", e.message);
    res.status(500).json({ error: "Failed to get embassy rule" });
  }
});

// POST /api/embassy-rules — ADMIN-only. Required: ruleType, destinationCountry,
// severity, actionLabel. Optional: applicationType, conditionJson, isActive.
router.post(
  "/",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const {
        ruleType,
        destinationCountry,
        applicationType,
        conditionJson,
        actionLabel,
        severity,
        isActive,
      } = req.body || {};

      if (!ruleType || !destinationCountry || !severity || !actionLabel) {
        return res.status(400).json({
          error: "ruleType, destinationCountry, severity, actionLabel required",
          code: "MISSING_FIELDS",
        });
      }

      assertValidRuleType(ruleType);
      const dc = String(destinationCountry).toUpperCase();
      assertValidDestinationCountry(dc);
      assertValidSeverity(severity);

      const data = {
        tenantId: req.user.tenantId,
        ruleType: sanitizeText(ruleType),
        destinationCountry: dc,
        applicationType: applicationType == null ? null : sanitizeText(String(applicationType)),
        conditionJson: conditionJson == null ? null : sanitizeJsonForStringColumn(conditionJson),
        actionLabel: sanitizeText(actionLabel),
        severity,
        isActive: isActive === undefined ? true : Boolean(isActive),
        createdById: req.user.userId,
      };

      const created = await prisma.embassyRule.create({ data });
      res.status(201).json(created);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error:
            "An embassy rule with that (destinationCountry, applicationType, ruleType) already exists for this tenant.",
          code: "EMBASSY_RULE_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[embassy-rules] create error:", e.message);
      res.status(500).json({ error: "Failed to create embassy rule" });
    }
  },
);

// PUT /api/embassy-rules/:id — ADMIN-only. Cannot reassign tenantId or
// createdById (both are stripped by the global stripDangerous middleware AND
// not read here).
router.put(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }

      const existing = await prisma.embassyRule.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Embassy rule not found",
          code: "EMBASSY_RULE_NOT_FOUND",
        });
      }

      const {
        ruleType,
        destinationCountry,
        applicationType,
        conditionJson,
        actionLabel,
        severity,
        isActive,
      } = req.body || {};

      const data = {};
      if (ruleType !== undefined) {
        assertValidRuleType(ruleType);
        data.ruleType = sanitizeText(ruleType);
      }
      if (destinationCountry !== undefined) {
        const dc = String(destinationCountry).toUpperCase();
        assertValidDestinationCountry(dc);
        data.destinationCountry = dc;
      }
      if (applicationType !== undefined) {
        data.applicationType = applicationType == null ? null : sanitizeText(String(applicationType));
      }
      if (conditionJson !== undefined) {
        data.conditionJson = conditionJson == null ? null : sanitizeJsonForStringColumn(conditionJson);
      }
      if (actionLabel !== undefined) {
        if (typeof actionLabel !== "string" || actionLabel.trim() === "") {
          return res.status(400).json({
            error: "actionLabel must be a non-empty string",
            code: "MISSING_FIELDS",
          });
        }
        data.actionLabel = sanitizeText(actionLabel);
      }
      if (severity !== undefined) {
        assertValidSeverity(severity);
        data.severity = severity;
      }
      if (isActive !== undefined) {
        data.isActive = Boolean(isActive);
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
      }

      const updated = await prisma.embassyRule.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        return res.status(409).json({
          error:
            "An embassy rule with that (destinationCountry, applicationType, ruleType) already exists for this tenant.",
          code: "EMBASSY_RULE_DUPLICATE",
        });
      }
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[embassy-rules] update error:", e.message);
      res.status(500).json({ error: "Failed to update embassy rule" });
    }
  },
);

// DELETE /api/embassy-rules/:id — ADMIN-only. Soft-delete (sets isActive=false);
// rule rows are referenced indirectly by the risk-flag engine's audit trail
// so we never hard-delete. Returns the updated (now-inactive) row.
router.delete(
  "/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.embassyRule.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing) {
        return res.status(404).json({
          error: "Embassy rule not found",
          code: "EMBASSY_RULE_NOT_FOUND",
        });
      }
      const updated = await prisma.embassyRule.update({
        where: { id },
        data: { isActive: false },
      });
      res.json(updated);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[embassy-rules] delete error:", e.message);
      res.status(500).json({ error: "Failed to deactivate embassy rule" });
    }
  },
);

module.exports = router;
