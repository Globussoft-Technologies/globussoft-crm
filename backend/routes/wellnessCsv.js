// Issue #816 — CSV import / export endpoints for wellness list pages.
//
// Mounted at /api/wellness/csv/:entity. Endpoints per entity:
//
//   GET  /api/wellness/csv/:entity/template          download CSV template
//   GET  /api/wellness/csv/:entity/export?<filters>  stream filtered CSV
//   POST /api/wellness/csv/:entity/import            multipart upload, sync
//   POST /api/wellness/csv/:entity/import/async      enqueue background job
//   GET  /api/wellness/csv/jobs/:jobId               poll job status
//
// :entity ∈ {services, packages, products, customers, bookings}
//
// The per-entity definitions live in backend/lib/csvEntities.js — this file
// is a thin Express adapter that:
//   - resolves the entity registry entry
//   - applies the right role gate (readGate for export/template, writeGate
//     for import)
//   - parses the uploaded multipart file
//   - runs each row through the entity's parseRow() + persists with
//     a per-row try/catch
//   - returns the canonical `{ inserted, updated, skipped, errors }`
//     envelope
//
// Async path: the job runs in-process via setImmediate. Status is held in
// the per-process `_jobs` map. The frontend polls /jobs/:jobId. When the
// job finishes, an email is sent to req.user.email via the existing
// notification service (best-effort — failure to send doesn't fail the
// import).

"use strict";

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const prisma = require("../lib/prisma");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const { writeAudit } = require("../lib/audit");
const {
  parseCsv,
  toCsv,
  withBom,
  toXlsxBuffer,
  parseXlsxBuffer,
} = require("../lib/csvIO");
const {
  getEntity,
  buildLookupContext,
  ASYNC_THRESHOLD_ROWS,
  ASYNC_THRESHOLD_BYTES,
} = require("../lib/csvEntities");

const router = express.Router();

// 10MB hard ceiling — files larger than this are rejected outright.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── Job store ─────────────────────────────────────────────────────
//
// In-process Map keyed by jobId. Each entry holds the import result envelope
// + tenantId + status ∈ {queued, running, done, failed}. Process restart
// wipes the queue — acceptable for this iteration; promotion to a durable
// queue (Bull/PG) is tracked in TODOS.md as a follow-up.

const _jobs = new Map();
const JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24h
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of _jobs) {
    if (j.finishedAt && j.finishedAt < cutoff) _jobs.delete(id);
  }
}, 60 * 60 * 1000).unref?.();

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

// ── Helpers ───────────────────────────────────────────────────────

function resolveEntity(req, res) {
  const entity = req.params.entity;
  const def = getEntity(entity);
  if (!def) {
    res.status(404).json({ error: `Unknown entity '${entity}'`, code: "UNKNOWN_ENTITY" });
    return null;
  }
  return def;
}

function gateFor(def, mode) {
  // mode: "read" for template/export, "write" for import.
  // The role array (def.readGate / def.writeGate) controls who passes
  // by wellnessRole; def.readPermissions / def.writePermissions opens
  // the SAME endpoint to custom RBAC roles granted the matching
  // module.action permission — so a Radiologist role with
  // `calendar.read` can export bookings without needing a clinical
  // wellnessRole. Falls back to literal-only behaviour when the entity
  // doesn't declare permissions (back-compat).
  const allowed = mode === "write" ? def.writeGate : def.readGate;
  const anyOfPermissions =
    mode === "write" ? def.writePermissions : def.readPermissions;
  const opts = Array.isArray(anyOfPermissions) && anyOfPermissions.length > 0
    ? { anyOfPermissions }
    : {};
  return verifyWellnessRole(allowed, opts);
}

function sendCsv(res, filename, body) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(withBom(body));
}

function sendXlsx(res, filename, buffer) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

// Normalize a `?format=` query param. Anything other than "xlsx" falls back
// to "csv" so existing callers without the param keep working unchanged.
function resolveFormat(req) {
  const raw = String(req.query.format || "csv").toLowerCase();
  return raw === "xlsx" ? "xlsx" : "csv";
}

// True when the uploaded file looks like an XLSX (extension OR mimetype).
// Multer sets req.file.mimetype from the browser; both Chrome/Firefox emit
// the canonical "application/vnd.openxmlformats-officedocument..." form.
function isXlsxUpload(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  if (name.endsWith(".xlsx")) return true;
  const mt = String(file.mimetype || "").toLowerCase();
  return (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel"
  );
}

function rowKey(def, data) {
  try {
    const k = def.naturalKey(data);
    return typeof k === "string" ? k : null;
  } catch { return null; }
}

// Core import loop — exported so the async runner can reuse it.
// `format` ∈ {"csv","xlsx"} picks the parser; defaults to csv for back-compat
// with existing callers (vitest suite, internal one-off jobs) that don't
// pass it.
async function runImport(def, fileBuffer, tenantId, ctx, format = "csv") {
  const { headers, rows } =
    format === "xlsx" ? parseXlsxBuffer(fileBuffer) : parseCsv(fileBuffer.toString("utf8"));

  // Header check.
  // S103 — `def.optionalHeaders` (array, possibly undefined) lists columns
  // that are accepted but NOT required. Lets entities carry additive
  // columns (e.g. customers' firstName + lastName) without breaking
  // legacy CSVs that pre-date the column. Defaults to [] so existing
  // entities behave identically.
  const optionalHeaders = new Set(def.optionalHeaders || []);
  const missing = def.headers.filter((h) => !headers.includes(h) && !optionalHeaders.has(h));
  // We tolerate EXTRA columns silently — only flag MISSING required headers.
  if (missing.length) {
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [{ row: 1, column: "headers", value: headers.join(","), message: `missing required column(s): ${missing.join(", ")}` }],
      total: rows.length,
    };
  }

  const result = { inserted: 0, updated: 0, skipped: 0, errors: [], total: rows.length };
  const seenKeys = new Map(); // naturalKey → first row number that hit it

  for (const raw of rows) {
    const rowNum = raw.__row;
    try {
      const { data, errors } = await def.parseRow(raw, ctx);
      if (errors && errors.length) {
        for (const e of errors) result.errors.push({ row: rowNum, ...e });
        result.skipped += 1;
        continue;
      }

      // Cross-row duplicate check (same natural key twice in the SAME file).
      const k = rowKey(def, data);
      if (k) {
        if (seenKeys.has(k)) {
          result.errors.push({
            row: rowNum,
            column: "(row)",
            value: k,
            message: `duplicate of row ${seenKeys.get(k)} (same natural key)`,
          });
          result.skipped += 1;
          continue;
        }
        seenKeys.set(k, rowNum);
      }

      // Existing record lookup.
      let existing = null;
      try {
        existing = k ? await def.naturalKeyMatch(prisma, tenantId, data) : null;
      } catch (e) {
        result.errors.push({ row: rowNum, column: "(lookup)", value: "", message: `lookup failed: ${e.message}` });
        result.skipped += 1;
        continue;
      }

      const { action } = await def.persist(prisma, tenantId, data, existing);
      if (action === "inserted") result.inserted += 1;
      else if (action === "updated") result.updated += 1;
      else result.skipped += 1;
    } catch (e) {
      result.errors.push({
        row: rowNum,
        column: "(row)",
        value: "",
        message: e?.message || String(e),
      });
      result.skipped += 1;
    }
  }

  return result;
}

// ── Endpoints ─────────────────────────────────────────────────────

// Per-route gating: each handler resolves the entity first to know which
// gate to apply. We use `router.use(...)` for the multer + per-entity gate
// resolution rather than a single global middleware so each method picks
// the right gate.

// GET /:entity/template?format=csv|xlsx — download template
router.get("/:entity/template", (req, res) => {
  const def = resolveEntity(req, res);
  if (!def) return;
  return gateFor(def, "read")(req, res, () => {
    const format = resolveFormat(req);
    if (format === "xlsx") {
      const buf = toXlsxBuffer(def.headers, [def.sample], "Template");
      return sendXlsx(res, `${req.params.entity}-template.xlsx`, buf);
    }
    const body = toCsv(def.headers, [def.sample]);
    return sendCsv(res, `${req.params.entity}-template.csv`, body);
  });
});

// GET /:entity/export — stream filtered CSV
router.get("/:entity/export", async (req, res) => {
  const def = resolveEntity(req, res);
  if (!def) return;
  return gateFor(def, "read")(req, res, async () => {
    try {
      const where = def.buildWhere(req);
      const findArgs = {
        where,
        orderBy: def.orderBy,
        take: 10000, // hard cap on exports — large datasets MUST use the async path
      };
      if (def.exportInclude) findArgs.include = def.exportInclude;
      const rows = await prisma[def.model].findMany(findArgs);

      // Some serialize() implementations may need a lookup ctx (packages
      // resolves first entitlement.serviceId → service.name for display).
      let ctx = null;
      if (def.model === "membershipPlan") {
        const services = await prisma.service.findMany({
          where: { tenantId: req.user.tenantId },
          select: { id: true, name: true },
        });
        const serviceIdToName = new Map(services.map((s) => [s.id, s.name]));
        ctx = { serviceIdToName };
      }

      const outRows = [];
      for (const row of rows) {
        const cells = await def.serialize(row, ctx);
        outRows.push(cells);
      }

      // Audit: capture row count + filter params (NOT row contents).
      writeAudit(
        "CsvExport",
        "EXPORT",
        null,
        req.user.userId,
        req.user.tenantId,
        { entity: req.params.entity, count: rows.length, filters: req.query, format: resolveFormat(req) },
      ).catch((auditErr) => {
        console.warn("[wellness-csv] audit EXPORT failed:", auditErr.message);
      });

      const stamp = new Date().toISOString().slice(0, 10);
      const format = resolveFormat(req);
      if (format === "xlsx") {
        const buf = toXlsxBuffer(def.headers, outRows, "Export");
        return sendXlsx(res, `${req.params.entity}-${stamp}.xlsx`, buf);
      }
      const body = toCsv(def.headers, outRows);
      return sendCsv(res, `${req.params.entity}-${stamp}.csv`, body);
    } catch (e) {
      console.error(`[wellness-csv] export ${req.params.entity} error:`, e.message);
      res.status(500).json({ error: "Failed to export", code: "EXPORT_FAILED" });
    }
  });
});

// POST /:entity/import — multipart upload, synchronous
router.post("/:entity/import", (req, res) => {
  const def = resolveEntity(req, res);
  if (!def) return;
  return gateFor(def, "write")(req, res, () => {
    upload.single("file")(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File exceeds 10MB. Use /import/async.", code: "FILE_TOO_LARGE" });
        }
        return res.status(400).json({ error: uploadErr.message, code: "UPLOAD_FAILED" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "file field required (multipart)", code: "FILE_REQUIRED" });
      }
      if (req.file.size > ASYNC_THRESHOLD_BYTES) {
        return res.status(413).json({
          error: `File exceeds ${ASYNC_THRESHOLD_BYTES} bytes; use /import/async`,
          code: "FILE_TOO_LARGE_SYNC",
        });
      }

      try {
        const isXlsx = isXlsxUpload(req.file);
        if (!isXlsx) {
          const text = req.file.buffer.toString("utf8");
          // Cheap row-count probe before doing the heavy work (CSV only —
          // XLSX is binary so newline count is meaningless; the run-time
          // row cap below catches oversized sheets).
          const newlines = (text.match(/\n/g) || []).length;
          if (newlines > ASYNC_THRESHOLD_ROWS + 1) {
            return res.status(413).json({
              error: `File has > ${ASYNC_THRESHOLD_ROWS} rows; use /import/async`,
              code: "TOO_MANY_ROWS_SYNC",
            });
          }
        }

        const lookups = await buildLookupContext(prisma, req.user.tenantId);
        const format = isXlsx ? "xlsx" : "csv";
        const result = await runImport(def, req.file.buffer, req.user.tenantId, { lookups, req }, format);

        // Belt-and-braces row cap after parsing — protects the xlsx path
        // (which skips the newline pre-probe) without blowing memory.
        if (result.total > ASYNC_THRESHOLD_ROWS) {
          return res.status(413).json({
            error: `File has > ${ASYNC_THRESHOLD_ROWS} rows; use /import/async`,
            code: "TOO_MANY_ROWS_SYNC",
          });
        }

        writeAudit(
          "CsvImport",
          "IMPORT",
          null,
          req.user.userId,
          req.user.tenantId,
          {
            entity: req.params.entity,
            inserted: result.inserted,
            updated: result.updated,
            skipped: result.skipped,
            errorCount: result.errors.length,
            mode: "sync",
          },
        ).catch((auditErr) => {
          console.warn("[wellness-csv] audit IMPORT failed:", auditErr.message);
        });

        res.json(result);
      } catch (e) {
        console.error(`[wellness-csv] import ${req.params.entity} error:`, e.message);
        res.status(500).json({ error: "Failed to import", code: "IMPORT_FAILED", message: e.message });
      }
    });
  });
});

// POST /:entity/import/async — enqueue background job
router.post("/:entity/import/async", (req, res) => {
  const def = resolveEntity(req, res);
  if (!def) return;
  return gateFor(def, "write")(req, res, () => {
    upload.single("file")(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File exceeds 10MB.", code: "FILE_TOO_LARGE" });
        }
        return res.status(400).json({ error: uploadErr.message, code: "UPLOAD_FAILED" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "file field required (multipart)", code: "FILE_REQUIRED" });
      }

      const jobId = newJobId();
      const format = isXlsxUpload(req.file) ? "xlsx" : "csv";
      const job = {
        id: jobId,
        entity: req.params.entity,
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        userEmail: req.user.email || null,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        format,
      };
      _jobs.set(jobId, job);

      // Fire-and-forget. setImmediate yields control back to Express so the
      // ack happens before the runner starts.
      setImmediate(async () => {
        job.status = "running";
        job.startedAt = Date.now();
        try {
          const lookups = await buildLookupContext(prisma, job.tenantId);
          const result = await runImport(def, req.file.buffer, job.tenantId, { lookups }, job.format);
          job.result = result;
          job.status = "done";
          job.finishedAt = Date.now();

          // Best-effort email — use the notification service. Failure to
          // send must not affect job status.
          try {
            const { notify } = require("../lib/notificationService");
            const subj = `CSV import ${result.errors.length === 0 ? "complete" : "complete with errors"}: ${job.entity}`;
            const body = `Inserted ${result.inserted}, updated ${result.updated}, skipped ${result.skipped}, errors ${result.errors.length}. Open the import dialog to download the row-level error report.`;
            await notify({
              userId: job.userId,
              tenantId: job.tenantId,
              type: "csv_import_complete",
              title: subj,
              message: body,
              channels: ["db", "email"],
            });
          } catch (_e) { /* notification optional */ }

          writeAudit(
            "CsvImport",
            "IMPORT",
            null,
            job.userId,
            job.tenantId,
            {
              entity: job.entity,
              inserted: result.inserted,
              updated: result.updated,
              skipped: result.skipped,
              errorCount: result.errors.length,
              mode: "async",
              jobId,
            },
          ).catch(() => {});
        } catch (e) {
          job.error = e.message || String(e);
          job.status = "failed";
          job.finishedAt = Date.now();
        }
      });

      res.status(202).json({ jobId, status: "queued" });
    });
  });
});

// GET /jobs/:jobId — poll job status
router.get("/jobs/:jobId", (req, res) => {
  const job = _jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found", code: "JOB_NOT_FOUND" });
  // Tenant scope — never reveal another tenant's job.
  if (job.tenantId !== req.user.tenantId) {
    return res.status(404).json({ error: "Job not found", code: "JOB_NOT_FOUND" });
  }
  res.json({
    id: job.id,
    entity: job.entity,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
  });
});

// GET /:entity — convenience meta endpoint (frontend uses it to render the
// template-download link label + the column list for the preview header
// before the user even uploads a file).
router.get("/:entity", (req, res) => {
  const def = resolveEntity(req, res);
  if (!def) return;
  return gateFor(def, "read")(req, res, () => {
    res.json({
      entity: req.params.entity,
      headers: def.headers,
      sample: def.sample,
      thresholds: {
        rows: ASYNC_THRESHOLD_ROWS,
        bytes: ASYNC_THRESHOLD_BYTES,
      },
    });
  });
});

module.exports = router;
// Exported for unit tests that don't want to spin up an Express app.
module.exports.runImport = runImport;
