// Wave 7 Agent A — CSV import/export framework (PRD Gap §10 item 3).
//
// Mounted at /api/csv. Endpoints:
//
//   GET    /services/export.csv             - all services for the tenant
//   POST   /services/import.csv             - upsert by name, idempotent
//   GET    /products/export.csv             - all products
//   POST   /products/import.csv             - upsert by sku || name
//   GET    /membership-plans/export.csv     - all membership plans
//   POST   /membership-plans/import.csv     - upsert by name
//   GET    /bookings/export.csv             - read-only export
//
// All endpoints:
//   - tenant-scoped via req.user.tenantId
//   - role gate: ADMIN | MANAGER (RBAC role) — operational + bulk; the
//     wellness-clinical roles (doctor / professional / telecaller) are
//     intentionally NOT trusted with bulk catalogue mutations.
//   - export: RFC4180-escaped, UTF-8 BOM via lib/csvHelpers.js
//   - import: per-row idempotent (re-running on the same CSV updates rows
//     by their natural key), per-row error report on failure. Generic contact
//     imports support up to 1,000,000 rows and 100 MB; catalogue imports keep
//     the smaller operational limit below.
//
// The import endpoints return a JSON body { imported, updated, skipped,
// errors: [{rowNumber, reason}] } so the frontend can render a per-row
// summary. A separate `errorReport=csv` query flag returns the error rows
// as a CSV body instead (Content-Disposition: attachment) for re-upload
// after fixes — matches the existing contacts.js import semantics.

const express = require("express");
const multer = require("multer");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { verifyToken } = require("../middleware/auth");
const { requireAnyPermission } = require("../middleware/requirePermission");
const {
  serializeRows,
  parseCsv,
  buildErrorReport,
  setCsvDownloadHeaders,
} = require("../lib/csvHelpers");
const { parseXlsxBuffer, toXlsxBuffer } = require("../lib/csvIO");
const { normalizePhoneValue, normalizeGenericCrmPhone } = require("../lib/phoneFormatting");
const { hardDeleteContact } = require("../lib/contactHardDelete");
const { KEYS, getSetting } = require("../lib/tenantSettings");

const router = express.Router();

// 5 MB cap; multer holds the file in memory (small CSVs).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const CONTACT_IMPORT_MAX_BYTES = 100 * 1024 * 1024;
const contactUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONTACT_IMPORT_MAX_BYTES },
});

const MAX_IMPORT_ROWS = 5000;
const MAX_CONTACT_IMPORT_ROWS = 1_000_000;
const GENERIC_IMPORT_STATUS_MAP = new Map([
  ["new", "Lead"],
  ["unqualified", "Lead"],
  ["contacted", "Prospect"],
  ["interested", "Prospect"],
  ["qualified", "Prospect"],
  ["won", "Customer"],
  ["lost", "Junk"],
]);
const GENERIC_IMPORT_LIFECYCLE_MAP = new Map([
  ["lead", "new"],
  ["salesqualifiedlead", "qualified"],
  ["customer", "won"],
]);

function contactImportUpload(req, res, next) {
  const handler = req.user?.vertical === "generic" ? contactUpload : upload;
  return handler.single("file")(req, res, next);
}
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// CSV is shared by several pages, so authorization is capability-based rather
// than role-name-based. Leads and contacts intentionally share the contacts
// CSV surface: a custom Leads role must be able to use the same import/history
// endpoints without also needing an unrelated Contacts role.
const CONTACT_READ = requireAnyPermission([
  { module: "leads", action: "read" },
  { module: "contacts", action: "read" },
]);
const CONTACT_EXPORT = requireAnyPermission([
  { module: "leads", action: "export" },
  { module: "contacts", action: "export" },
]);
const CONTACT_WRITE = requireAnyPermission([
  { module: "leads", action: "write" },
  { module: "contacts", action: "write" },
]);
const SERVICES_READ = requireAnyPermission([{ module: "services", action: "read" }]);
const SERVICES_WRITE = requireAnyPermission([{ module: "services", action: "write" }]);
const PRODUCTS_READ = requireAnyPermission([{ module: "products", action: "read" }]);
const PRODUCTS_WRITE = requireAnyPermission([{ module: "products", action: "write" }]);
const BOOKINGS_READ = requireAnyPermission([{ module: "booking_pages", action: "read" }]);

const GENERIC_RESOURCE_PERMISSIONS = {
  contacts: { read: CONTACT_READ },
  services: { read: SERVICES_READ },
  products: { read: PRODUCTS_READ },
  "membership-plans": { read: PRODUCTS_READ },
  bookings: { read: BOOKINGS_READ },
};

function requireGenericResourcePermission(action) {
  return (req, res, next) => {
    const middleware = GENERIC_RESOURCE_PERMISSIONS[req.params.entity]?.[action];
    if (!middleware) {
      return res.status(404).json({
        error: `Unknown CSV resource '${req.params.entity}'`,
        code: "UNKNOWN_CSV_RESOURCE",
      });
    }
    return middleware(req, res, next);
  };
}

async function writeImportedCustomFields(contactId, tenantId, customFields, definitions, { parallel = false } = {}) {
  const writes = Object.entries(customFields || {});
  const definitionsByKey = new Map(definitions.map((definition) => [definition.fieldKey, definition]));
  const writeOne = async ([fieldKey, raw]) => {
    const def = definitionsByKey.get(fieldKey);
    if (!def) return;
    const value = String(raw ?? "").trim();
    const data = { valueText: value || null, valueNumber: null, valueDate: null, valueBool: null };
    if (def.fieldType === "number" && value !== "") {
      const number = Number(value);
      if (!Number.isNaN(number)) { data.valueText = null; data.valueNumber = number; }
    } else if (def.fieldType === "date" && value !== "") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) { data.valueText = null; data.valueDate = date; }
    } else if (def.fieldType === "checkbox") {
      data.valueText = null;
      data.valueBool = ["true", "1", "yes", "y"].includes(value.toLowerCase());
    }
    await prisma.leadCustomFieldValue.upsert({
      where: { contactId_fieldId: { contactId, fieldId: def.id } },
      create: { contactId, fieldId: def.id, tenantId, ...data },
      update: data,
    });
  };
  if (!parallel) {
    for (const entry of writes) await writeOne(entry);
    return;
  }
  // Generic CRM imports can carry dozens of custom fields per row. Keep a
  // bounded batch so 2,000-row imports do not serialize hundreds of thousands
  // of independent round trips or overwhelm the database with an unbounded
  // Promise.all(). Wellness/Travel continue using the original serial path.
  const batchSize = 25;
  for (let i = 0; i < writes.length; i += batchSize) {
    await Promise.all(writes.slice(i, i + batchSize).map(writeOne));
  }
}

async function findContactByImportedExternalId(tenantId, customFields, definitions) {
  const externalIdKeys = new Set(["id", "external_id", "lead_id", "contact_id"]);
  const matchedContacts = new Map();
  for (const definition of definitions) {
    if (!externalIdKeys.has(definition.fieldKey)) continue;
    const value = String(customFields?.[definition.fieldKey] ?? "").trim();
    if (!value) continue;
    const typedWhere = definition.fieldType === "number" && Number.isFinite(Number(value))
      ? { valueNumber: Number(value) }
      : { valueText: value };
    const matches = await prisma.leadCustomFieldValue.findMany({
      where: {
        tenantId,
        fieldId: definition.id,
        ...typedWhere,
      },
      select: {
        contact: { select: { id: true, deletedAt: true } },
      },
      orderBy: { id: "asc" },
      take: 2,
    });
    for (const match of matches) {
      if (match.contact) matchedContacts.set(match.contact.id, match.contact);
    }
    // Check every populated identifier, not just the first definition. Never
    // choose one lead when different identifiers resolve to different leads.
    if (matchedContacts.size > 1) {
      const error = new Error("ambiguous imported id: multiple contacts match");
      error.code = "AMBIGUOUS_IMPORTED_ID";
      throw error;
    }
  }
  return matchedContacts.values().next().value || null;
}

// Body parser for raw text/csv + text/plain bodies — Express's default
// JSON / urlencoded parsers don't handle these. Without this, posting
// `text/csv` lands req.body as `{}` and readUploadedCsv() returns null,
// triggering NO_CSV instead of EMPTY_CSV. Per /api/csv prefix only so
// other routes aren't affected.
router.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));

// Authentication is shared by every endpoint; authorization is attached to
// each resource/action below so custom roles can receive exactly the grants
// selected for them in the permissions matrix.
router.use(verifyToken);

router.get("/contacts/import-history", CONTACT_READ, async (req, res) => {
  if (req.user.vertical !== "generic") {
    return res.status(404).json({ error: "Import history is not available", code: "IMPORT_HISTORY_NOT_AVAILABLE" });
  }
  try {
    const rows = await prisma.genericImportHistory.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      take: 20,
      select: {
        id: true,
        tenantId: true,
        fileName: true,
        inserted: true,
        updated: true,
        skipped: true,
        errors: true,
        contacts: true,
        errorRows: true,
        completedAt: true,
      },
    });
    res.json(rows.map((row) => ({ ...row, status: row.errors ? "Completed, with errors" : "Completed" })));
  } catch (error) {
    console.error("[csv] import history error:", error.message);
    res.status(503).json({ error: "Import history is temporarily unavailable", code: "IMPORT_HISTORY_UNAVAILABLE" });
  }
});

router.get("/contacts/import-history/:id/report", async (req, res) => {
  if (req.user.vertical !== "generic") {
    return res.status(404).json({ error: "Import reports are not available", code: "IMPORT_REPORT_NOT_AVAILABLE" });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid import history ID", code: "INVALID_IMPORT_HISTORY_ID" });
  }
  try {
    const history = await prisma.genericImportHistory.findFirst({
      where: { id, tenantId: req.user.tenantId },
        select: { fileName: true, errors: true, errorRows: true },
    });
    if (!history) return res.status(404).json({ error: "Import history not found", code: "IMPORT_HISTORY_NOT_FOUND" });
    const storedErrorRows = Array.isArray(history.errorRows) ? history.errorRows : [];
    const reportRows = storedErrorRows.length || !history.errors
      ? storedErrorRows
      : [{
        rowNumber: "—",
        field: "Unavailable",
        action: "rejected",
        reason: `${history.errors} rejected row(s) from this legacy import; the original row and field details were not stored.`,
        data: {},
      }];
    const format = String(req.query.format || "csv").toLowerCase();
    const columns = [];
    for (const row of reportRows) {
      for (const key of Object.keys(row?.data || {})) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    const reportColumns = [
      { key: "rowNumber", header: "rowNumber" },
      { key: "field", header: "field" },
      { key: "action", header: "action" },
      { key: "reason", header: "reason" },
      ...columns.map((key) => ({ key: `data.${key}`, header: key })),
    ];
    const rows = reportRows.map((row) => ({
      rowNumber: row.rowNumber,
      field: row.field || "row",
      action: row.action || "rejected",
      reason: row.reason || "Import failed",
      ...Object.fromEntries(columns.map((key) => [`data.${key}`, row?.data?.[key] ?? ""])),
    }));
    const safeName = String(history.fileName || "import").replace(/\.[^.]+$/, "");
    if (format === "xlsx") {
      const buffer = toXlsxBuffer(reportColumns, rows, "Import errors");
      res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}-import-report.xlsx"`);
      return res.send(buffer);
    }
    setCsvDownloadHeaders(res, `${safeName}-import-report.csv`);
    return res.send(serializeRows(reportColumns, rows));
  } catch (error) {
    console.error("[csv] import report error:", error.message);
    return res.status(503).json({ error: "Import report is temporarily unavailable", code: "IMPORT_REPORT_UNAVAILABLE" });
  }
});

// ── Utility: parse uploaded CSV body ───────────────────────────────

function readUploadedCsv(req) {
  // Two paths: multipart/form-data (multer.file.buffer) or raw text body.
  if (req.file && req.file.buffer) {
    return req.file.buffer.toString("utf8");
  }
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body.csv === "string") return req.body.csv;
  return null;
}

function writeImportAudit(req, entity, summary) {
  return writeAudit(entity, "CSV_IMPORT", null, req.user.userId, req.user.tenantId, {
    ...summary,
    source: "csv",
  });
}

function getSpreadsheetValue(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const lookup = new Map(Object.entries(row).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const alias of aliases) {
    const value = lookup.get(String(alias).toLowerCase());
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

// Generic CRM Contacts
const CONTACT_EXPORT_COLS = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "email", header: "email" },
  { key: "phone", header: "phone" },
  { key: "company", header: "company" },
  { key: "title", header: "title" },
  { key: "status", header: "status" },
  { key: "source", header: "source" },
  { key: "createdAt", header: "createdAt", render: (r) => r.createdAt ? new Date(r.createdAt).toISOString() : "" },
];

const CONTACT_IMPORT_COLS = [
  { key: "name", header: "name" },
  { key: "email", header: "email" },
  { key: "phone", header: "phone" },
  { key: "company", header: "company" },
  { key: "title", header: "title" },
  { key: "status", header: "status" },
  { key: "source", header: "source" },
];

const CONTACT_TEMPLATE_SAMPLE = {
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "+919876543210",
  company: "Acme Health",
  title: "Owner",
  status: "Lead",
  source: "website",
};

const CONTACT_COLS = CONTACT_EXPORT_COLS;
const ALLOWED_CONTACT_STATUSES = new Set(["Lead", "Prospect", "Customer", "Churned", "Junk"]);
const CONTACT_EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;

function sanitizeCellForExport(v) {
  if (typeof v !== "string" || v.length === 0) return v;
  return FORMULA_INJECTION_RE.test(v) ? `'${v}` : v;
}

function setXlsxDownloadHeaders(res, filename) {
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

function resolveExportFormat(req) {
  return String(req.query.format || "csv").toLowerCase() === "xlsx" ? "xlsx" : "csv";
}

function readUploadedContactRows(req) {
  if (req.file && req.file.buffer) {
    const isXlsx = String(req.file.originalname || "").toLowerCase().endsWith(".xlsx")
      || String(req.file.mimetype || "").toLowerCase() === XLSX_CONTENT_TYPE
      || String(req.file.mimetype || "").toLowerCase() === "application/vnd.ms-excel";
    return isXlsx ? parseXlsxBuffer(req.file.buffer) : parseCsv(req.file.buffer.toString("utf8"));
  }
  const csvText = readUploadedCsv(req);
  if (!csvText) return null;
  return parseCsv(csvText);
}

function normalizeQueryValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeLifecycleValue(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveGenericImportStatus(value) {
  const normalized = normalizeLifecycleValue(value);
  return GENERIC_IMPORT_STATUS_MAP.get(normalized) || value;
}

function normalizeGenericImportTarget(target) {
  const normalized = normalizeLifecycleValue(target);
  if (normalized === "lifecyclestage" || normalized === "lifecyclestagekey") {
    return "lifecycleStageKey";
  }
  return target;
}

async function loadGenericLifecycleOptions(tenantId, mapping) {
  const mapsToLifecycle = Object.values(mapping || {}).some(
    (target) => target === "lifecycleStageKey",
  );
  if (!mapsToLifecycle) return [];

  const raw = await getSetting(
    tenantId,
    KEYS.GENERIC_CONTACT_LIFECYCLE_STAGES,
    { coerce: String },
  );
  let stages;
  try {
    stages = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    const error = new Error("Lifecycle stage configuration is invalid");
    error.code = "INVALID_LIFECYCLE_STAGE_CONFIG";
    throw error;
  }
  if (!Array.isArray(stages)) {
    const error = new Error("Lifecycle stage configuration is invalid");
    error.code = "INVALID_LIFECYCLE_STAGE_CONFIG";
    throw error;
  }
  return stages.flatMap((stage) => (
    Array.isArray(stage?.options) ? stage.options : []
  )).map((option) => ({
    id: String(option?.id || "").trim(),
    label: String(option?.label || option?.id || "").trim(),
  })).filter((option) => option.id && option.label);
}

function resolveGenericLifecycleStage(value, options) {
  const normalized = normalizeLifecycleValue(value);
  if (!normalized) return null;
  const directMatch = options.find((option) => (
    normalizeLifecycleValue(option.id) === normalized ||
    normalizeLifecycleValue(option.label) === normalized
  ))?.id;
  if (directMatch) return directMatch;
  const compatibilityId = GENERIC_IMPORT_LIFECYCLE_MAP.get(normalized);
  return options.find((option) => option.id === compatibilityId)?.id || null;
}

function matchesContactExportFilter(contact, req) {
  const status = normalizeQueryValue(req.query.status);
  if (status && normalizeQueryValue(contact.status) !== status) return false;

  const source = normalizeQueryValue(req.query.source);
  if (source && normalizeQueryValue(contact.source) !== source) return false;

  const assignedToId = String(req.query.assignedToId || "").trim();
  if (assignedToId && String(contact.assignedToId || "") !== assignedToId) return false;
  if (req.query.unassigned === "true" && contact.assignedToId) return false;

  const campaignId = String(req.query.campaignId || "").trim();
  if (campaignId && String(contact.callifiedCampaignId || "") !== campaignId) return false;

  const leadStatus = normalizeQueryValue(req.query.leadStatus);
  if (leadStatus && normalizeQueryValue(contact.callifiedLeadStatus) !== leadStatus) return false;

  const subBrand = normalizeQueryValue(req.query.subBrand);
  if (subBrand && normalizeQueryValue(contact.subBrand) !== subBrand) return false;

  const q = normalizeQueryValue(req.query.q);
  if (q) {
    const haystack = [
      contact.name,
      contact.email,
      contact.phone,
      contact.company,
      contact.title,
      contact.source,
      contact.callifiedLeadStatus,
      contact.assignedTo.name,
      contact.assignedTo.email,
    ].map((v) => String(v || "").toLowerCase()).join(" ");
    if (!haystack.includes(q)) return false;
  }

  return true;
}

router.get("/contacts", CONTACT_READ, async (req, res) => {
  const isGeneric = req.user.vertical === "generic";
  res.json({
    entity: "contacts",
    headers: CONTACT_IMPORT_COLS.map((c) => c.header),
    // Generic CRM accepts arbitrary mapped spreadsheets, so none of the
    // template headers are mandatory. The shared Wellness contact importer
    // retains its email requirement.
    optionalHeaders: CONTACT_IMPORT_COLS.map((c) => c.header).filter((header) => (
      isGeneric || header !== "email"
    )),
    sample: CONTACT_TEMPLATE_SAMPLE,
    thresholds: req.user.vertical === "generic"
      ? { rows: MAX_CONTACT_IMPORT_ROWS, bytes: CONTACT_IMPORT_MAX_BYTES }
      : { rows: MAX_IMPORT_ROWS, bytes: 5 * 1024 * 1024 },
  });
});

router.get("/contacts/export.csv", CONTACT_EXPORT, async (req, res) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: tenantWhere(req, { deletedAt: null }),
      orderBy: { createdAt: "desc" },
      take: 10000,
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
    const filtered = contacts.filter((contact) => matchesContactExportFilter(contact, req));
    const format = resolveExportFormat(req);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "xlsx") {
      const buf = toXlsxBuffer(CONTACT_EXPORT_COLS.map((c) => c.header), filtered, "Contacts Export");
      setXlsxDownloadHeaders(res, `contacts-export-${stamp}.xlsx`);
      return res.send(buf);
    }
    const csv = serializeRows(CONTACT_EXPORT_COLS, filtered);
    setCsvDownloadHeaders(res, `contacts-export-${stamp}.csv`);
    return res.send(csv);
  } catch (e) {
    console.error("[csv] contacts export error:", e.message);
    res.status(500).json({ error: "Failed to export contacts" });
  }
});

router.get("/contacts/template.csv", CONTACT_READ, async (req, res) => {
  try {
    const format = resolveExportFormat(req);
    if (format === "xlsx") {
      const buf = toXlsxBuffer(CONTACT_IMPORT_COLS.map((c) => c.header), [CONTACT_TEMPLATE_SAMPLE], "Contacts Template");
      setXlsxDownloadHeaders(res, "contacts-template.xlsx");
      return res.send(buf);
    }
    const csv = serializeRows(CONTACT_IMPORT_COLS, [CONTACT_TEMPLATE_SAMPLE]);
    setCsvDownloadHeaders(res, "contacts-template.csv");
    return res.send(csv);
  } catch (e) {
    console.error("[csv] contacts template error:", e.message);
    res.status(500).json({ error: "Failed to build contacts template" });
  }
});

router.post("/contacts/import.csv", CONTACT_WRITE, contactImportUpload, async (req, res) => {
  try {
    const isGeneric = req.user.vertical === "generic";
    const parsed = readUploadedContactRows(req);
    if (!parsed) return res.status(400).json({ error: "No CSV body or file uploaded", code: "NO_CSV" });

    const { rows } = parsed;
    if (rows.length === 0) return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
    const maxRows = isGeneric ? MAX_CONTACT_IMPORT_ROWS : MAX_IMPORT_ROWS;
    if (rows.length > maxRows) {
      return res.status(413).json({ error: `Too many rows. Max ${maxRows}`, code: "TOO_MANY_ROWS" });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];
    const importedContacts = [];
    let mapping = {};
    try { mapping = req.body?.mapping ? JSON.parse(req.body.mapping) : {}; } catch { mapping = {}; }
    if (isGeneric && mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      mapping = Object.fromEntries(
        Object.entries(mapping).map(([source, target]) => [
          source,
          normalizeGenericImportTarget(target),
        ]),
      );
      // Lifecycle stage is an automatic Generic CRM column and may be absent
      // from an older/saved mapping payload. Detect the source header directly
      // so its values still use the configured lifecycle options.
      const lifecycleSource = Object.keys(rows[0] || {}).find((source) => (
        normalizeLifecycleValue(source) === "lifecyclestage" ||
        normalizeLifecycleValue(source) === "lifecyclestagekey"
      ));
      const hasLifecycleTarget = Object.values(mapping).some(
        (target) => target === "lifecycleStageKey",
      );
      if (lifecycleSource && !hasLifecycleTarget) {
        mapping[lifecycleSource] = "lifecycleStageKey";
      }
    }
    const misroutedStatusSource = isGeneric
      ? Object.entries(mapping).find(([source, target]) => (
        target === "lifecycleStageKey" && normalizeLifecycleValue(source) === "status"
      ))?.[0]
      : null;
    let lifecycleOptions = [];
    if (isGeneric) lifecycleOptions = await loadGenericLifecycleOptions(req.user.tenantId, mapping);
    const customDefinitions = Object.keys(mapping).length
      ? await prisma.leadCustomFieldDefinition.findMany({ where: { tenantId: req.user.tenantId } })
      : [];

    for (let i = 0; i < rows.length; i++) {
      const sourceRow = rows[i];
      const mappedRow = Object.keys(mapping).length
        ? Object.fromEntries(Object.entries(mapping).map(([source, target]) => [target, sourceRow[source]]))
        : {};
      // Generic CRM has automatic fields (notably Status) that are hidden
      // from the manual mapping list. Preserve the source columns so a
      // mapping for custom fields cannot accidentally drop Status, Email,
      // or other importer-recognized values. Wellness/Travel retain the
      // legacy mapped-row behavior.
      const row = isGeneric ? { ...sourceRow, ...mappedRow } : (Object.keys(mapping).length ? mappedRow : sourceRow);
      const rowNumber = i + 2;
      try {
        const name = String(getSpreadsheetValue(row, ["name", "Name"])).trim();
        const email = String(getSpreadsheetValue(row, ["email", "Email"])).trim();
        const sourceStatus = String(
          (misroutedStatusSource
            ? sourceRow?.[misroutedStatusSource]
            : getSpreadsheetValue(row, ["status", "Status"])) || "Lead",
        ).trim();
        const rawStatus = isGeneric
          ? resolveGenericImportStatus(sourceStatus)
          : sourceStatus;

        const status = [...ALLOWED_CONTACT_STATUSES].find(
          (allowedStatus) =>
            allowedStatus.toLowerCase() === rawStatus.toLowerCase(),
        );
        if (!isGeneric && !email) {
          errors.push({ rowNumber, field: "email", reason: "missing email" });
          skipped++;
          continue;
        }
        if (email && !CONTACT_EMAIL_RE.test(email)) {
          errors.push({ rowNumber, field: "email", reason: `invalid email (${email})` });
          skipped++;
          continue;
        }
        if (!status) {
          errors.push({ rowNumber, field: "status", reason: `invalid status "${rawStatus}"` });
          skipped++;
          continue;
        }

        const lifecycleStageRaw = getSpreadsheetValue(row, ["lifecycleStageKey"]);
        const lifecycleStageKey = isGeneric && lifecycleStageRaw
          ? resolveGenericLifecycleStage(lifecycleStageRaw, lifecycleOptions)
          : null;
        if (isGeneric && lifecycleStageRaw && !lifecycleStageKey) {
          errors.push({ rowNumber, field: "lifecycleStageKey", reason: `invalid lifecycle stage "${lifecycleStageRaw}"` });
          skipped++;
          continue;
        }

        const importedPhone = normalizePhoneValue(
          getSpreadsheetValue(row, ["phone", "phone_number", "phoneNumber", "mobile", "Mobile", "mobile_number", "mobileNumber", "sms_number", "smsNumber"]),
        );
        const phone = req.user?.vertical === "generic"
          ? normalizeGenericCrmPhone(importedPhone)
          : importedPhone;
        const company = String(getSpreadsheetValue(row, ["company", "Company"])).trim();
        const title = String(getSpreadsheetValue(row, ["title", "Title"])).trim();
        const source = String(getSpreadsheetValue(row, ["source", "Source", "lead_source", "leadSource", "Lead Source"])).trim();
        const firstName = String(getSpreadsheetValue(sourceRow, ["first name", "First name", "First Name", "first_name", "firstName"])).trim();
        const lastName = String(getSpreadsheetValue(sourceRow, ["last name", "Last name", "Last Name", "last_name", "lastName"])).trim();
        const genericFallbackName = [firstName, lastName].filter(Boolean).join(" ")
          || company
          || (email ? email.split("@")[0] : "")
          || (phone ? `Lead ${phone}` : "")
          || `Imported Lead ${i + 1}`;
        const createData = {
          // Contact.name remains required in the database. Generic imports
          // derive a display name instead of rejecting arbitrary spreadsheets
          // that do not contain a literal `name` column.
          name: sanitizeCellForExport(name || (isGeneric ? genericFallbackName : email.split("@")[0])),
          email: email || null,
          phone: phone || null,
          company: sanitizeCellForExport(company),
          title,
          status,
          source: source || null,
        };
        if (lifecycleStageKey) createData.lifecycleStageKey = lifecycleStageKey;
        const customFields = {};
        for (const definition of customDefinitions) {
          const mappedKey = `cf_${definition.fieldKey}`;
          if (Object.prototype.hasOwnProperty.call(row, mappedKey)) {
            customFields[definition.fieldKey] = row[mappedKey];
          } else if (Object.prototype.hasOwnProperty.call(row, definition.fieldKey)) {
            customFields[definition.fieldKey] = row[definition.fieldKey];
          }
        }
        const updateData = {};
        if (email) updateData.email = email;
        if (name) updateData.name = sanitizeCellForExport(name);
        if (phone) updateData.phone = phone;
        if (company) updateData.company = sanitizeCellForExport(company);
        if (title) updateData.title = title;
        if (rawStatus) updateData.status = status;
        if (source) updateData.source = source;
        if (lifecycleStageKey) updateData.lifecycleStageKey = lifecycleStageKey;

        let existing = null;
        if (email) {
          existing = await prisma.contact.findFirst({
            where: { email, tenantId: req.user.tenantId },
            select: { id: true, deletedAt: true },
          });
        }
        // A supplied email is the authoritative identity for Generic CRM.
        // Do not let a stale/custom external ID or phone value redirect a
        // row with a different email onto an unrelated existing contact.
        // Fallback identifiers are only for rows that have no email.
        if (!email && !existing && isGeneric) {
          existing = await findContactByImportedExternalId(
            req.user.tenantId,
            customFields,
            customDefinitions,
          );
        }
        if (!email && !existing && isGeneric && phone) {
          // Email-less imports can still update an existing contact when the
          // row has a phone number. Phone is not unique: reject ambiguous
          // matches before any update or tombstone deletion.
          const matches = await prisma.contact.findMany({
            where: { phone, tenantId: req.user.tenantId },
            select: { id: true, deletedAt: true },
            orderBy: { id: "asc" },
            take: 2,
          });
          if (matches.length > 1) {
            errors.push({ rowNumber, field: "phone", reason: "ambiguous phone: multiple contacts match; supply email" });
            skipped++;
            continue;
          }
          existing = matches[0] || null;
        }
        if (existing?.deletedAt) {
          await hardDeleteContact(prisma, existing.id);
          existing = null;
        }
        const wasExisting = Boolean(existing);
        if (existing) {
          await prisma.contact.update({ where: { id: existing.id }, data: updateData });
        } else {
          existing = await prisma.contact.create({ data: { ...createData, tenantId: req.user.tenantId }, select: { id: true } });
        }
        await writeImportedCustomFields(
          existing.id,
          req.user.tenantId,
          customFields,
          customDefinitions,
          { parallel: isGeneric && rows.length >= 100 },
        );
        // The Generic campaign engine is driven by the existing contact.created
        // event. CSV imports previously persisted a new contact without
        // emitting that event, so configured lead-joined campaigns never saw
        // these leads. Updates deliberately remain silent to preserve the
        // event's create-only semantics and avoid duplicate enrollments.
        if (!wasExisting && req.user.vertical === "generic") {
          try {
            await require("../lib/eventBus").emitEvent(
              "contact.created",
              { contactId: existing.id, userId: req.user.userId },
              req.user.tenantId,
              req.io,
            );
          } catch (eventError) {
            console.error("[csv_io] Generic contact.created event failed:", eventError.message);
          }
        }
        importedContacts.push({
          action: wasExisting ? "updated" : "created",
          reason: wasExisting ? "Existing contact matched and updated" : "New contact created",
          id: existing.id,
          name: createData.name,
          email,
          phone: phone || "",
          company,
          title,
          status,
          source,
        });
        if (wasExisting) updated++;
        else imported++;
      } catch (rowErr) {
        errors.push({ rowNumber, field: "row", reason: rowErr.message });
        skipped++;
      }
    }

    await writeImportAudit(req, "Contact", { rowCount: rows.length, imported, updated, errorCount: errors.length });
    // History is supplemental metadata, not part of the contact mutation.
    // Never turn an already-completed import into a misleading 500 if this
    // best-effort write fails. Wellness uses this shared contact endpoint but
    // must not receive Generic-only history records.
    if (req.user.vertical === "generic") {
      try {
        const errorRows = errors.map((error) => ({
          ...error,
          action: "skipped",
          data: rows[Math.max(0, Number(error.rowNumber || 1) - 2)] || {},
        }));
        await prisma.genericImportHistory.create({
          data: {
            tenantId: req.user.tenantId,
            fileName: req.file?.originalname || "Uploaded contacts file",
            inserted: imported,
            updated,
            skipped,
            errors: errors.length,
            contacts: importedContacts,
            errorRows,
          },
        });
      } catch (historyError) {
        console.error("[csv] failed to persist import history:", historyError.message);
      }
    }
    res.json({ imported, updated, skipped, errors, importedContacts });
  } catch (e) {
    console.error("[csv] contacts import error:", e.message);
    res.status(500).json({ error: "Failed to import contacts" });
  }
});
// ── Services ───────────────────────────────────────────────────────

const SERVICE_COLS = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "category", header: "category" },
  { key: "categoryId", header: "categoryId" },
  { key: "ticketTier", header: "ticketTier" },
  { key: "basePrice", header: "basePrice" },
  { key: "durationMin", header: "durationMin" },
  { key: "description", header: "description" },
  { key: "isActive", header: "isActive" },
];

router.get("/services/export.csv", SERVICES_READ, async (req, res) => {
  try {
    const services = await prisma.service.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
    });
    const csv = serializeRows(SERVICE_COLS, services);
    setCsvDownloadHeaders(res, "services-export.csv");
    res.send(csv);
  } catch (e) {
    console.error("[csv] services export error:", e.message);
    res.status(500).json({ error: "Failed to export services" });
  }
});

router.post("/services/import.csv", SERVICES_WRITE, upload.single("file"), async (req, res) => {
  try {
    const csvText = readUploadedCsv(req);
    if (!csvText) return res.status(400).json({ error: "No CSV body or file uploaded", code: "NO_CSV" });

    const { rows } = parseCsv(csvText);
    if (rows.length === 0) return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS}`, code: "TOO_MANY_ROWS" });
    }

    let imported = 0;
    let updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // 1-based + header offset
      try {
        const name = String(row.name || "").trim();
        if (!name) {
          errors.push({ rowNumber, reason: "missing name" });
          continue;
        }
        const data = {
          name,
          category: row.category ? String(row.category).trim() : null,
          ticketTier: row.ticketTier ? String(row.ticketTier).trim() : "medium",
          basePrice: row.basePrice ? parseFloat(row.basePrice) : 0,
          durationMin: row.durationMin ? parseInt(row.durationMin, 10) : 30,
          description: row.description ? String(row.description) : null,
          isActive: row.isActive ? row.isActive !== "false" : true,
        };
        if (row.categoryId && /^\d+$/.test(String(row.categoryId).trim())) {
          data.categoryId = parseInt(String(row.categoryId).trim(), 10);
        }
        const existing = await prisma.service.findFirst({
          where: tenantWhere(req, { name }),
        });
        if (existing) {
          await prisma.service.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await prisma.service.create({ data: { ...data, tenantId: req.user.tenantId } });
          imported++;
        }
      } catch (rowErr) {
        errors.push({ rowNumber, reason: rowErr.message });
      }
    }

    await writeImportAudit(req, "Service", { rowCount: rows.length, imported, updated, errorCount: errors.length });

    if (req.query.errorReport === "csv" && errors.length > 0) {
      setCsvDownloadHeaders(res, "services-errors.csv");
      return res.send(buildErrorReport(errors));
    }
    res.json({ imported, updated, skipped: errors.length, errors });
  } catch (e) {
    console.error("[csv] services import error:", e.message);
    res.status(500).json({ error: "Failed to import services" });
  }
});

// ── Products ───────────────────────────────────────────────────────

const PRODUCT_COLS = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "sku", header: "sku" },
  { key: "description", header: "description" },
  { key: "price", header: "price" },
  { key: "isRecurring", header: "isRecurring" },
  { key: "currentStock", header: "currentStock" },
  { key: "threshold", header: "threshold" },
];

router.get("/products/export.csv", PRODUCTS_READ, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
    });
    const csv = serializeRows(PRODUCT_COLS, products);
    setCsvDownloadHeaders(res, "products-export.csv");
    res.send(csv);
  } catch (e) {
    console.error("[csv] products export error:", e.message);
    res.status(500).json({ error: "Failed to export products" });
  }
});

router.post("/products/import.csv", PRODUCTS_WRITE, upload.single("file"), async (req, res) => {
  try {
    const csvText = readUploadedCsv(req);
    if (!csvText) return res.status(400).json({ error: "No CSV body or file uploaded", code: "NO_CSV" });

    const { rows } = parseCsv(csvText);
    if (rows.length === 0) return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS}`, code: "TOO_MANY_ROWS" });
    }

    let imported = 0;
    let updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2;
      try {
        const name = String(row.name || "").trim();
        if (!name) {
          errors.push({ rowNumber, reason: "missing name" });
          continue;
        }
        const sku = row.sku ? String(row.sku).trim() : null;
        const price = row.price ? parseFloat(row.price) : 0;
        if (Number.isNaN(price)) {
          errors.push({ rowNumber, reason: `invalid price: ${row.price}` });
          continue;
        }
        const data = {
          name,
          sku: sku || null,
          description: row.description || null,
          price,
          isRecurring: row.isRecurring ? row.isRecurring !== "false" : true,
          currentStock: row.currentStock ? parseInt(row.currentStock, 10) || 0 : 0,
          threshold: row.threshold ? parseInt(row.threshold, 10) || 0 : 0,
        };

        // Natural key: sku if present (sku has @unique global), else name (per tenant).
        let existing = null;
        if (sku) {
          existing = await prisma.product.findFirst({ where: { sku } });
          if (existing && existing.tenantId !== req.user.tenantId) {
            errors.push({ rowNumber, reason: `sku ${sku} already exists in another tenant` });
            continue;
          }
        }
        if (!existing) {
          existing = await prisma.product.findFirst({ where: tenantWhere(req, { name }) });
        }

        if (existing) {
          await prisma.product.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await prisma.product.create({ data: { ...data, tenantId: req.user.tenantId } });
          imported++;
        }
      } catch (rowErr) {
        errors.push({ rowNumber, reason: rowErr.message });
      }
    }

    await writeImportAudit(req, "Product", { rowCount: rows.length, imported, updated, errorCount: errors.length });

    if (req.query.errorReport === "csv" && errors.length > 0) {
      setCsvDownloadHeaders(res, "products-errors.csv");
      return res.send(buildErrorReport(errors));
    }
    res.json({ imported, updated, skipped: errors.length, errors });
  } catch (e) {
    console.error("[csv] products import error:", e.message);
    res.status(500).json({ error: "Failed to import products" });
  }
});

// ── Membership plans ───────────────────────────────────────────────

const MEMBERSHIP_PLAN_COLS = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "description", header: "description" },
  { key: "durationDays", header: "durationDays" },
  { key: "price", header: "price" },
  { key: "currency", header: "currency" },
  { key: "entitlements", header: "entitlements" },
  { key: "isActive", header: "isActive" },
];

router.get("/membership-plans/export.csv", PRODUCTS_READ, async (req, res) => {
  try {
    const plans = await prisma.membershipPlan.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
    });
    const csv = serializeRows(MEMBERSHIP_PLAN_COLS, plans);
    setCsvDownloadHeaders(res, "membership-plans-export.csv");
    res.send(csv);
  } catch (e) {
    console.error("[csv] membership plans export error:", e.message);
    res.status(500).json({ error: "Failed to export membership plans" });
  }
});

router.post("/membership-plans/import.csv", PRODUCTS_WRITE, upload.single("file"), async (req, res) => {
  try {
    const csvText = readUploadedCsv(req);
    if (!csvText) return res.status(400).json({ error: "No CSV body or file uploaded", code: "NO_CSV" });

    const { rows } = parseCsv(csvText);
    if (rows.length === 0) return res.status(400).json({ error: "CSV is empty", code: "EMPTY_CSV" });
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS}`, code: "TOO_MANY_ROWS" });
    }

    let imported = 0;
    let updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2;
      try {
        const name = String(row.name || "").trim();
        if (!name) {
          errors.push({ rowNumber, reason: "missing name" });
          continue;
        }
        const durationDays = row.durationDays ? parseInt(row.durationDays, 10) : NaN;
        if (Number.isNaN(durationDays) || durationDays <= 0) {
          errors.push({ rowNumber, reason: `invalid durationDays: ${row.durationDays}` });
          continue;
        }
        const price = row.price ? parseFloat(row.price) : NaN;
        if (Number.isNaN(price) || price < 0) {
          errors.push({ rowNumber, reason: `invalid price: ${row.price}` });
          continue;
        }
        // entitlements is a JSON string column. Validate parses.
        let entitlements = "[]";
        if (row.entitlements && String(row.entitlements).trim()) {
          try {
            const parsed = JSON.parse(row.entitlements);
            if (!Array.isArray(parsed)) throw new Error("entitlements must be a JSON array");
            entitlements = JSON.stringify(parsed);
          } catch (jsonErr) {
            errors.push({ rowNumber, reason: `invalid entitlements JSON: ${jsonErr.message}` });
            continue;
          }
        }
        const data = {
          name,
          description: row.description || null,
          durationDays,
          price,
          currency: row.currency ? String(row.currency).trim() : "INR",
          entitlements,
          isActive: row.isActive ? row.isActive !== "false" : true,
        };
        const existing = await prisma.membershipPlan.findFirst({ where: tenantWhere(req, { name }) });
        if (existing) {
          await prisma.membershipPlan.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          await prisma.membershipPlan.create({ data: { ...data, tenantId: req.user.tenantId } });
          imported++;
        }
      } catch (rowErr) {
        errors.push({ rowNumber, reason: rowErr.message });
      }
    }

    await writeImportAudit(req, "MembershipPlan", { rowCount: rows.length, imported, updated, errorCount: errors.length });

    if (req.query.errorReport === "csv" && errors.length > 0) {
      setCsvDownloadHeaders(res, "membership-plans-errors.csv");
      return res.send(buildErrorReport(errors));
    }
    res.json({ imported, updated, skipped: errors.length, errors });
  } catch (e) {
    console.error("[csv] membership plans import error:", e.message);
    res.status(500).json({ error: "Failed to import membership plans" });
  }
});

// ── Bookings (export only) ─────────────────────────────────────────

const BOOKING_COLS = [
  { key: "id", header: "id" },
  { key: "bookingPageId", header: "bookingPageId" },
  { key: "contactName", header: "contactName" },
  { key: "contactEmail", header: "contactEmail" },
  { key: "contactPhone", header: "contactPhone" },
  { key: "scheduledAt", header: "scheduledAt", render: (r) => r.scheduledAt ? new Date(r.scheduledAt).toISOString() : "" },
  { key: "durationMins", header: "durationMins" },
  { key: "meetingUrl", header: "meetingUrl" },
  { key: "notes", header: "notes" },
  { key: "status", header: "status" },
  { key: "createdAt", header: "createdAt", render: (r) => r.createdAt ? new Date(r.createdAt).toISOString() : "" },
];

router.get("/bookings/export.csv", BOOKINGS_READ, async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: tenantWhere(req),
      orderBy: { scheduledAt: "desc" },
      take: 10000,
    });
    const csv = serializeRows(BOOKING_COLS, bookings);
    setCsvDownloadHeaders(res, "bookings-export.csv");
    res.send(csv);
  } catch (e) {
    console.error("[csv] bookings export error:", e.message);
    res.status(500).json({ error: "Failed to export bookings" });
  }
});


const GENERIC_CSV_RESOURCES = {
  contacts: {
    columns: CONTACT_COLS,
    sample: {
      id: "",
      name: "Asha Mehra",
      email: "asha@example.com",
      phone: "+919876543210",
      company: "Acme Ltd",
      title: "Founder",
      status: "Lead",
      source: "website",
      createdAt: "",
    },
  },
  services: {
    columns: SERVICE_COLS,
    sample: {
      id: "",
      name: "Consultation",
      category: "General",
      categoryId: "",
      ticketTier: "medium",
      basePrice: "500",
      durationMin: "30",
      description: "Introductory service",
      isActive: "true",
    },
  },
  products: {
    columns: PRODUCT_COLS,
    sample: {
      id: "",
      name: "Starter Plan",
      sku: "STARTER-001",
      description: "Entry product",
      price: "999",
      isRecurring: "false",
      currentStock: "0",
      threshold: "0",
    },
  },
  "membership-plans": {
    columns: MEMBERSHIP_PLAN_COLS,
    sample: {
      id: "",
      name: "Gold",
      description: "Premium plan",
      durationDays: "365",
      price: "9999",
      currency: "INR",
      entitlements: "[]",
      isActive: "true",
    },
  },
  bookings: {
    columns: BOOKING_COLS,
    sample: {
      id: "",
      bookingPageId: "",
      contactName: "Asha Mehra",
      contactEmail: "asha@example.com",
      contactPhone: "+919876543210",
      scheduledAt: "2026-07-23T10:30:00.000Z",
      durationMins: "30",
      meetingUrl: "https://meet.example/abc",
      notes: "follow-up",
      status: "BOOKED",
      createdAt: "",
    },
  },
};

function genericResource(req, res) {
  const def = GENERIC_CSV_RESOURCES[req.params.entity];
  if (!def) {
    res.status(404).json({ error: `Unknown CSV resource '${req.params.entity}'`, code: "UNKNOWN_CSV_RESOURCE" });
    return null;
  }
  return def;
}

router.get("/:entity/template.csv", requireGenericResourcePermission("read"), (req, res) => {
  const def = genericResource(req, res);
  if (!def) return;
  const csv = serializeRows(def.columns, [def.sample]);
  setCsvDownloadHeaders(res, `${req.params.entity}-template.csv`);
  res.send(csv);
});

router.get("/:entity", requireGenericResourcePermission("read"), (req, res) => {
  const def = genericResource(req, res);
  if (!def) return;
  res.json({
    entity: req.params.entity,
    headers: def.columns.map((c) => c.header),
    sample: def.sample,
    thresholds: { rows: MAX_IMPORT_ROWS, bytes: 5 * 1024 * 1024 },
  });
});
module.exports = router;
