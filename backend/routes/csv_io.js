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
//     by their natural key), per-row error report on failure, capped at
//     5,000 rows to prevent DoS via huge uploads.
//
// The import endpoints return a JSON body { imported, updated, skipped,
// errors: [{rowNumber, reason}] } so the frontend can render a per-row
// summary. A separate `?errorReport=csv` query flag returns the error rows
// as a CSV body instead (Content-Disposition: attachment) for re-upload
// after fixes — matches the existing contacts.js import semantics.

const express = require("express");
const multer = require("multer");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { verifyToken, verifyRole } = require("../middleware/auth");
const {
  serializeRows,
  parseCsv,
  buildErrorReport,
  setCsvDownloadHeaders,
} = require("../lib/csvHelpers");

const router = express.Router();

// 5 MB cap; multer holds the file in memory (small CSVs).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const MAX_IMPORT_ROWS = 5000;
const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// Body parser for raw text/csv + text/plain bodies — Express's default
// JSON / urlencoded parsers don't handle these. Without this, posting
// `text/csv` lands req.body as `{}` and readUploadedCsv() returns null,
// triggering NO_CSV instead of EMPTY_CSV. Per /api/csv prefix only so
// other routes aren't affected.
router.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));

// router-level guard so every endpoint inherits auth + RBAC.
router.use(verifyToken, verifyRole(["ADMIN", "MANAGER"]));

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

router.get("/services/export.csv", async (req, res) => {
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

router.post("/services/import.csv", upload.single("file"), async (req, res) => {
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

router.get("/products/export.csv", async (req, res) => {
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

router.post("/products/import.csv", upload.single("file"), async (req, res) => {
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

router.get("/membership-plans/export.csv", async (req, res) => {
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

router.post("/membership-plans/import.csv", upload.single("file"), async (req, res) => {
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

router.get("/bookings/export.csv", async (req, res) => {
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

module.exports = router;
