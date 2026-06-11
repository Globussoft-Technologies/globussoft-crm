/**
 * Admin tooling endpoints — manual triggers + read APIs for ops actions
 * that mirror cron-engine behaviour.
 *
 * Currently scoped to the backup engine (G-15). Extend here for any
 * future admin-only ops endpoints (cache flush, reindex, etc.) rather
 * than spawning per-tool routers — keeps the surface small + auditable.
 *
 * Mount: app.use("/api/admin", adminRoutes) in server.js.
 *
 * All routes require:
 *   1. verifyToken (router-level)
 *   2. verifyRole(['ADMIN'])
 *
 * Wellness-vertical roles (doctor / professional / telecaller) get 403.
 *
 * Rationale for an `/api/admin` namespace separate from `/api/staff`:
 *   `/api/staff` is for tenant-admin actions on User rows. `/api/admin`
 *   is for SYSTEM-level ops (filesystem-touching, cron-mirror triggers).
 *   The two have very different blast radii so a separate prefix makes
 *   the audit-log + RBAC review easier.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const prisma = require('../lib/prisma');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { runBackup, listBackups, getBackupDir } = require('../cron/backupEngine');
const backfillLastVisitEngine = require('../cron/backfillLastVisitEngine');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

// All admin routes are auth-gated at the router level. Per-route
// verifyRole(['ADMIN']) is layered ON TOP for clarity (defence in depth
// — if someone re-mounts this router under a non-/api/admin path that
// the global auth guard doesn't cover, we still hard-fail without a
// JWT).
router.use(verifyToken);

// ──────────────────────────────────────────────────────────────────
// POST /api/admin/backup/run — manual mysqldump trigger (G-15)
// ──────────────────────────────────────────────────────────────────
//
// Mirrors cron/backupEngine.js's daily 02:00 sweep, but invocable on-
// demand by an ADMIN. Same engine code path as the cron — manual + cron
// produce identical .sql.gz output in BACKUP_DIR.
//
// Pattern parity: routes/billing.js POST /recurring/run and
// routes/gdpr.js POST /retention/run. Unlike retention, this is NOT
// destructive — no `confirmDestructive` guard required. The backup
// process is read-only on the source DB (mysqldump --single-transaction).
//
// Response shape:
//   { success: true,
//     tenantId,                     — requesting admin's tenant (audit)
//     file:        "backup-2026-05-03T13-45-12.sql.gz",   — RELATIVE only
//     sizeBytes:   12345678,
//     durationMs:  4321,
//     errors:      []  }
//
//   { success: false, tenantId, file: null, sizeBytes: 0,
//     durationMs, errors: [<msg>], code: 'MYSQLDUMP_FAILED' | … }
//
// Critical: `file` is the BASENAME ONLY. The absolute server FS path
// (BACKUP_DIR is ../backups/ in dev, /var/backups/ on prod) is NEVER
// exposed in the response — leaking that path gives an attacker a
// known-writable filesystem location to target.
router.post('/backup/run', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // runBackup() is async since #417 — the spawn-pipe pattern can't be
    // implemented sync without buffering the full dump in memory.
    const result = await runBackup();
    if (!result.success) {
      // 500 with structured error code — the spec asserts the route
      // doesn't crash when mysqldump is unreachable; it returns a
      // useful error code instead.
      return res.status(500).json({
        success: false,
        tenantId,
        file: null,
        sizeBytes: 0,
        durationMs: result.durationMs,
        errors: [result.error || 'unknown'],
        code: result.code || 'BACKUP_FAILED',
      });
    }
    return res.json({
      success: true,
      tenantId,
      file: result.file, // basename only — never absolute path
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
      errors: [],
    });
  } catch (err) {
    console.error('[admin/backup/run] error:', err);
    res.status(500).json({
      success: false,
      tenantId: req.user?.tenantId || null,
      errors: [err.message || 'Failed to run backup'],
      code: 'INTERNAL_ERROR',
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/admin/backup/list — list recent backups
// ──────────────────────────────────────────────────────────────────
//
// Returns most-recent N (default 20, max 100) `.sql.gz` files in
// BACKUP_DIR with their size + mtime. Used by the spec to confirm the
// /run output exists on disk without exposing absolute paths.
//
// Each row: { file: <basename>, sizeBytes: <int>, mtime: <unix-ms> }.
router.get('/backup/list', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const files = listBackups({ limit });
    res.json({ success: true, backups: files });
  } catch (err) {
    console.error('[admin/backup/list] error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/admin/backup/file/:name — sanity check + size for one backup
// ──────────────────────────────────────────────────────────────────
//
// Lookup-by-basename, RBAC-gated. Used by the test spec to verify the
// freshly-created backup exists + has size > 1KB without ever needing
// the absolute server path. Returns 404 if not found, 400 on path-
// traversal attempts (any "/" or ".." in the name).
router.get('/backup/file/:name', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const name = req.params.name;
    // Path-traversal guard — basename only, no separators or ".." segments.
    if (
      !name ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('..') ||
      path.basename(name) !== name
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid backup filename',
        code: 'INVALID_NAME',
      });
    }
    const fp = path.join(getBackupDir(), name);
    if (!fs.existsSync(fp)) {
      return res
        .status(404)
        .json({ success: false, exists: false, error: 'Backup file not found' });
    }
    const st = fs.statSync(fp);
    res.json({
      success: true,
      exists: true,
      file: name, // never expose fp itself
      sizeBytes: st.size,
      mtime: st.mtimeMs,
    });
  } catch (err) {
    console.error('[admin/backup/file] error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/admin/llm-spend — LLM cost observability daily summary
// ──────────────────────────────────────────────────────────────────
//
// PRD §9.1 + R7 — surfaces the per-day + per-task + per-model breakdown
// of LLM router activity for the requesting admin's tenant. Backed by
// LlmCallLog rows written fire-and-forget by backend/lib/llmRouter.js's
// routeRequest.
//
// Query params:
//   ?days=N   default 7, max 90 (400 INVALID_RANGE otherwise; non-numeric
//             ?days=abc falls back silently to the default — keeps the
//             happy path forgiving for hand-typed curls)
//
// Response shape (200):
//   {
//     days: 7,
//     from: ISO-string,           // 7-day window starts at midnight UTC
//     to:   ISO-string,
//     totals: {
//       calls, promptTokens, completionTokens, totalTokens,
//       costEstimate, stubCalls, realCalls
//     },
//     byDay:   [{ date: "YYYY-MM-DD", calls, totalTokens, costEstimate }],
//     byTask:  [{ task,  calls, totalTokens, costEstimate }],
//     byModel: [{ model, calls, totalTokens, costEstimate }],
//   }
//
// byTask + byModel sorted descending by costEstimate then by calls.
// byDay sorted ascending by date (chronological).
//
// Costs are Decimal in storage; the response converts them to plain
// JS numbers via Number() so JSON consumers don't need a Decimal lib.
// Stub-mode costs are all 0 today (router is in stub mode); the shape
// is forward-compatible with real-mode wire-in.
router.get('/llm-spend', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // ?days parsing: clamp to [1, 90]; non-numeric → default. >90 →
    // 400 INVALID_RANGE (explicit upper bound is the gate spec's contract).
    const DEFAULT_DAYS = 7;
    const MAX_DAYS = 90;
    let days = DEFAULT_DAYS;
    if (req.query.days !== undefined && req.query.days !== '') {
      const parsed = parseInt(req.query.days, 10);
      if (Number.isFinite(parsed)) {
        if (parsed > MAX_DAYS || parsed < 1) {
          return res.status(400).json({
            error: `days must be between 1 and ${MAX_DAYS}`,
            code: 'INVALID_RANGE',
          });
        }
        days = parsed;
      }
      // NaN / non-numeric → silently fall back to default. The contract
      // is "?days=N filters the window"; garbage in → default behaviour.
    }

    const to = new Date();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const where = {
      tenantId,
      createdAt: { gte: from, lte: to },
    };

    // ── Aggregate queries (parallel; same tenant scope). groupBy + count
    // gives us per-bucket call counts; we lift token + cost sums in the
    // same groupBy via _sum so we don't need a second pass.
    const [allRows, byTaskRaw, byModelRaw, totalCalls, stubCount] =
      await Promise.all([
        // Per-day rollup is built in JS from the full row set because
        // Prisma's groupBy can't bucket by a date-trunc expression
        // portably across MySQL / SQLite. The row count for a 90-day
        // window is bounded by call volume; even at ~10k calls/day this
        // pulls 900k rows max which is fine for an admin endpoint.
        // If volume becomes an issue, swap for a raw SQL DATE() groupBy.
        prisma.llmCallLog.findMany({
          where,
          select: {
            createdAt: true,
            totalTokens: true,
            costEstimate: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.llmCallLog.groupBy({
          by: ['task'],
          where,
          _count: { _all: true },
          _sum: { totalTokens: true, costEstimate: true },
        }),
        prisma.llmCallLog.groupBy({
          by: ['model'],
          where,
          _count: { _all: true },
          _sum: { totalTokens: true, costEstimate: true },
        }),
        prisma.llmCallLog.count({ where }),
        prisma.llmCallLog.count({ where: { ...where, stub: true } }),
      ]);

    // Totals — derived from the same row set so they always match
    // byTask / byModel aggregates (no risk of drift between queries).
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTotalTokens = 0;
    let totalCost = 0;

    // byDay buckets — map ISO date (YYYY-MM-DD UTC) → bucket. We re-pull
    // promptTokens / completionTokens via a separate aggregate for the
    // top-line totals so the byDay row set stays narrow.
    const dayBuckets = new Map();
    for (const row of allRows) {
      const dateKey = row.createdAt.toISOString().slice(0, 10);
      const bucket =
        dayBuckets.get(dateKey) || { calls: 0, totalTokens: 0, costEstimate: 0 };
      bucket.calls += 1;
      bucket.totalTokens += row.totalTokens || 0;
      bucket.costEstimate += Number(row.costEstimate) || 0;
      dayBuckets.set(dateKey, bucket);
    }
    const byDay = Array.from(dayBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => ({
        date,
        calls: b.calls,
        totalTokens: b.totalTokens,
        costEstimate: b.costEstimate,
      }));

    // Separate aggregate for promptTokens + completionTokens — these
    // aren't carried in the allRows select to keep the row payload small.
    const tokensAgg = await prisma.llmCallLog.aggregate({
      where,
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costEstimate: true,
      },
    });
    totalPromptTokens = tokensAgg._sum.promptTokens || 0;
    totalCompletionTokens = tokensAgg._sum.completionTokens || 0;
    totalTotalTokens = tokensAgg._sum.totalTokens || 0;
    totalCost = Number(tokensAgg._sum.costEstimate) || 0;

    const formatGroupRow = (row, keyField) => ({
      [keyField]: row[keyField],
      calls: row._count._all,
      totalTokens: row._sum.totalTokens || 0,
      costEstimate: Number(row._sum.costEstimate) || 0,
    });

    const sortByCostThenCalls = (a, b) => {
      if (b.costEstimate !== a.costEstimate) {
        return b.costEstimate - a.costEstimate;
      }
      return b.calls - a.calls;
    };

    const byTask = byTaskRaw
      .map((r) => formatGroupRow(r, 'task'))
      .sort(sortByCostThenCalls);
    const byModel = byModelRaw
      .map((r) => formatGroupRow(r, 'model'))
      .sort(sortByCostThenCalls);

    res.json({
      days,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        calls: totalCalls,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalTotalTokens,
        costEstimate: totalCost,
        stubCalls: stubCount,
        realCalls: totalCalls - stubCount,
      },
      byDay,
      byTask,
      byModel,
    });
  } catch (err) {
    console.error('[admin/llm-spend] error:', err);
    res.status(500).json({
      error: err.message || 'Failed to fetch LLM spend summary',
      code: 'INTERNAL_ERROR',
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// POST /api/admin/wellness/run-backfill-last-visit — S107 manual trigger
// ──────────────────────────────────────────────────────────────────
//
// Mirrors cron/backfillLastVisitEngine.js's `tick()`, but invocable on-demand
// by an ADMIN. S94 (the engine) is one-shot by design: start() is a no-op log
// because scheduling it as recurring node-cron would waste cycles after the
// historical sweep is done. The intended invocation path is THIS endpoint
// (or a manual CLI on the demo box) — see backfillLastVisitEngine.js header.
//
// Pattern parity: routes/admin.js POST /backup/run and routes/gdpr.js POST
// /retention/run. UNLIKE retention, this is NOT destructive — the engine
// only writes Patient.lastVisitDate when the column is currently null AND a
// most-recent Visit exists. No confirmDestructive guard required.
//
// Tenant scoping caveat:
//   We FORWARD `{ tenantId: req.user.tenantId }` to tick() so when the engine
//   gains per-tenant scoping (follow-up gap row), this endpoint becomes
//   automatically tenant-isolated with zero route changes. As of S94 + S107
//   land time the engine ignores the tenantId option and processes every
//   active tenant in a single sweep. This is intentional for the initial
//   historical-backfill — the demo box has one wellness tenant and the
//   sweep is harmless (idempotent: NULL→date, never reverses) — but the
//   per-tenant-scope follow-up gap row exists so a multi-tenant deploy
//   doesn't accidentally fire a cross-tenant sweep on a single ADMIN's
//   trigger. See gapsDiscovered in the S107 agent report.
//
// Response shape (200):
//   {
//     success: true,
//     tenantId: <requesting admin's tenant — for audit context>,
//     triggeredBy: <userId>,
//     processed: <int — patients examined this tick>,
//     updated:   <int — patients whose lastVisitDate was written>,
//     errors:    <int — per-patient failures (already logged in engine)>
//   }
//
// Response shape (500):
//   {
//     success: false,
//     tenantId,
//     triggeredBy,
//     error: <string>,
//     code: 'BACKFILL_FAILED'
//   }
//
// The engine never throws on per-patient failures (it counts + logs). It
// CAN throw on tenant.findMany failure — that case returns 500 BACKFILL_FAILED
// with the underlying error message.
//
// Audit-log: writes one AuditLog row with entity='System',
// action='admin.backfill.last-visit' and the envelope summary in details.
// This captures who triggered the manual sweep + what it did, for
// operational forensics.
router.post(
  '/wellness/run-backfill-last-visit',
  verifyRole(['ADMIN']),
  async (req, res) => {
    const tenantId = req.user.tenantId;
    const triggeredBy = req.user.userId;
    try {
      // Pass tenantId forward; the engine accepts opts but currently ignores
      // tenantId (sweeps all tenants — documented gap). This call stays
      // forward-compatible: when the engine gains per-tenant scoping the
      // route doesn't need to change.
      const result = await backfillLastVisitEngine.tick({ tenantId });

      // Audit-log the run regardless of engine-success — operator forensics
      // need to know about no-op runs too. Fire-and-forget; auditing is
      // never allowed to block the response.
      writeAudit(
        'System',
        'admin.backfill.last-visit',
        null,
        triggeredBy,
        tenantId,
        {
          success: !!result.success,
          processed: result.processed || 0,
          updated: result.updated || 0,
          errors: result.errors || 0,
        },
      ).catch((auditErr) => {
        console.error('[admin/wellness/run-backfill-last-visit] audit failed:', auditErr.message);
      });

      if (!result.success) {
        return res.status(500).json({
          success: false,
          tenantId,
          triggeredBy,
          processed: result.processed || 0,
          updated: result.updated || 0,
          errors: result.errors || 0,
          error: 'Engine reported failure (tenant list unavailable or worse)',
          code: 'BACKFILL_FAILED',
        });
      }

      return res.json({
        success: true,
        tenantId,
        triggeredBy,
        processed: result.processed,
        updated: result.updated,
        errors: result.errors,
      });
    } catch (err) {
      console.error('[admin/wellness/run-backfill-last-visit] error:', err);
      // Mirror the audit emission even on hard failure so the operator who
      // tried to trigger the run shows up in the audit trail.
      writeAudit(
        'System',
        'admin.backfill.last-visit',
        null,
        triggeredBy,
        tenantId,
        { success: false, error: err.message || 'unknown' },
      ).catch(() => {});

      res.status(500).json({
        success: false,
        tenantId,
        triggeredBy,
        error: err.message || 'Failed to run last-visit backfill',
        code: 'BACKFILL_FAILED',
      });
    }
  },
);

// ──────────────────────────────────────────────────────────────────
// GET /api/admin/tenants/:id/embed-allowlist — read tenant embed allowlist (S128)
// ──────────────────────────────────────────────────────────────────
//
// PRD §3.6 / Travel Security PRD FR-3.6 (iframe-isolation operability) —
// completes the embed-allowlist admin surface chain (S38 mount + S39 column
// + S66 read + S129 ?key= resolution + S128 admin UI).
//
// Why this endpoint exists
// ────────────────────────
// S39 added the `Tenant.embedAllowlistJson` column + S66 wired the embed
// mount to read it per request; S129 added ?key=glbs_… resolution so
// cross-origin partner iframes can populate a synthetic req.user. Without
// THIS surface (S128), operators have no UI/API to set the column. The
// admin page (frontend/src/pages/admin/EmbedAllowlist.jsx) consumes both
// this GET and the sibling PATCH below.
//
// Tenant scoping
// ──────────────
// An ADMIN can ONLY view/modify their OWN tenant. There is no platform-
// admin / super-admin concept in this codebase — req.user.tenantId is
// always the active tenant. We require :id === req.user.tenantId and 403
// otherwise. The :id param is therefore redundant on paper but kept in
// the URL for two reasons: (a) it makes the route shape RESTful + reads
// naturally (PATCH /tenants/:id/embed-allowlist), (b) if a platform-admin
// concept ever lands, the gate becomes "platform-admin OR self-tenant"
// without breaking existing callers.
//
// Response shape (200):
//   { tenantId, origins: ["https://partner1.com", "https://partner2.com"] }
//   origins is [] when the column is null OR an empty array (the "no
//   restriction / wildcard back-compat" state per S66's fallback).
//
// Response shape (403): { error, code: 'CROSS_TENANT_DENIED' }
// Response shape (400): { error, code: 'INVALID_TENANT_ID' }
router.get(
  '/tenants/:id/embed-allowlist',
  verifyRole(['ADMIN']),
  async (req, res) => {
    try {
      const targetTenantId = parseInt(req.params.id, 10);
      if (!Number.isFinite(targetTenantId) || targetTenantId < 1) {
        return res.status(400).json({
          error: 'Invalid tenantId',
          code: 'INVALID_TENANT_ID',
        });
      }
      if (targetTenantId !== req.user.tenantId) {
        return res.status(403).json({
          error: 'Cross-tenant access denied — admins can only view their own tenant',
          code: 'CROSS_TENANT_DENIED',
        });
      }
      const tenant = await prisma.tenant.findUnique({
        where: { id: targetTenantId },
        select: { id: true, embedAllowlistJson: true, updatedAt: true },
      });
      if (!tenant) {
        return res.status(404).json({
          error: 'Tenant not found',
          code: 'TENANT_NOT_FOUND',
        });
      }
      // Parse the stored JSON; if it's malformed return [] (the S66 fallback
      // path also treats malformed JSON as "no allowlist set" — keep parity).
      let origins = [];
      if (tenant.embedAllowlistJson) {
        try {
          const parsed = JSON.parse(tenant.embedAllowlistJson);
          if (Array.isArray(parsed)) {
            origins = parsed.filter((o) => typeof o === 'string');
          }
        } catch (_e) {
          origins = [];
        }
      }
      return res.json({
        tenantId: tenant.id,
        origins,
        updatedAt: tenant.updatedAt,
      });
    } catch (err) {
      console.error('[admin/tenants/embed-allowlist GET] error:', err);
      res.status(500).json({
        error: err.message || 'Failed to read embed allowlist',
        code: 'INTERNAL_ERROR',
      });
    }
  },
);

// ──────────────────────────────────────────────────────────────────
// PATCH /api/admin/tenants/:id/embed-allowlist — set tenant embed allowlist (S128)
// ──────────────────────────────────────────────────────────────────
//
// Body shape: { origins: string[] }
//   - Each entry must match HTTPS_ORIGIN_RE: HTTPS scheme, hostname required,
//     optional port + path. Wildcards in the middle of the hostname
//     (`https://*.foo.com`) are NOT supported in v1 — the CSP frame-ancestors
//     spec accepts them but parsing + validating wildcard origins safely
//     adds surface area for little payoff. Operators can list every concrete
//     partner origin explicitly; if a partner needs N subdomains, add N rows.
//   - HTTP origins are rejected — partners embedding via insecure transport
//     are a CSP-bypass risk. The PRD pins HTTPS-only.
//   - Empty array → embedAllowlistJson = null (the "no restriction" /
//     wildcard back-compat per S66's fallback behavior). This is the way
//     to REMOVE all restrictions: PATCH with { origins: [] }.
//
// Response shape (200):
//   { tenantId, origins, updatedAt, updatedBy }
//
// Audit row written via writeAudit() with entity='Tenant',
// action='admin.embed-allowlist.update', and the before/after values in
// the details blob for forensics.
const HTTPS_ORIGIN_RE = /^https:\/\/[^\s/]+(:\d+)?(\/.*)?$/;

router.patch(
  '/tenants/:id/embed-allowlist',
  verifyRole(['ADMIN']),
  async (req, res) => {
    try {
      const targetTenantId = parseInt(req.params.id, 10);
      const triggeredBy = req.user.userId;
      if (!Number.isFinite(targetTenantId) || targetTenantId < 1) {
        return res.status(400).json({
          error: 'Invalid tenantId',
          code: 'INVALID_TENANT_ID',
        });
      }
      if (targetTenantId !== req.user.tenantId) {
        return res.status(403).json({
          error: 'Cross-tenant access denied — admins can only modify their own tenant',
          code: 'CROSS_TENANT_DENIED',
        });
      }
      const { origins } = req.body || {};
      if (!Array.isArray(origins)) {
        return res.status(400).json({
          error: 'origins must be an array of HTTPS origin strings',
          code: 'INVALID_BODY',
        });
      }
      // Validate every origin. Collect all invalid entries so the UI can
      // surface them in one round-trip instead of one-at-a-time.
      const invalid = [];
      for (const o of origins) {
        if (typeof o !== 'string' || !HTTPS_ORIGIN_RE.test(o.trim())) {
          invalid.push(o);
        }
      }
      if (invalid.length > 0) {
        return res.status(400).json({
          error: 'One or more origins are invalid. Must be HTTPS URLs (e.g. https://partner.com).',
          code: 'INVALID_ORIGIN',
          invalid,
        });
      }
      // Cap the list at 100 entries — a sane upper bound that prevents
      // accidental DoS via a 1MB JSON payload. CSP frame-ancestors values
      // beyond a few dozen origins are operationally pathological anyway.
      if (origins.length > 100) {
        return res.status(400).json({
          error: 'Allowlist exceeds maximum size (100 entries)',
          code: 'ALLOWLIST_TOO_LARGE',
        });
      }
      // Trim + dedupe (preserve first-occurrence order).
      const trimmed = origins.map((o) => o.trim());
      const seen = new Set();
      const deduped = [];
      for (const o of trimmed) {
        if (!seen.has(o)) {
          seen.add(o);
          deduped.push(o);
        }
      }
      // Read the existing row for audit forensics + the 404 case.
      const existing = await prisma.tenant.findUnique({
        where: { id: targetTenantId },
        select: { id: true, embedAllowlistJson: true },
      });
      if (!existing) {
        return res.status(404).json({
          error: 'Tenant not found',
          code: 'TENANT_NOT_FOUND',
        });
      }
      // Empty array → null (matches S66 fallback semantics). Non-empty →
      // JSON.stringify. The column is `String? @db.Text` per S39.
      const nextJson = deduped.length === 0 ? null : JSON.stringify(deduped);
      const updated = await prisma.tenant.update({
        where: { id: targetTenantId },
        data: { embedAllowlistJson: nextJson },
        select: { id: true, embedAllowlistJson: true, updatedAt: true },
      });
      // Audit-log the change with before/after for forensics. Fire-and-forget
      // per the canonical writeAudit pattern; auditing must never block the
      // response.
      writeAudit(
        'Tenant',
        'admin.embed-allowlist.update',
        targetTenantId,
        triggeredBy,
        targetTenantId,
        {
          before: existing.embedAllowlistJson,
          after: nextJson,
          origins: deduped,
        },
      ).catch((auditErr) => {
        console.error('[admin/tenants/embed-allowlist PATCH] audit failed:', auditErr.message);
      });
      return res.json({
        tenantId: updated.id,
        origins: deduped,
        updatedAt: updated.updatedAt,
        updatedBy: triggeredBy,
      });
    } catch (err) {
      console.error('[admin/tenants/embed-allowlist PATCH] error:', err);
      res.status(500).json({
        error: err.message || 'Failed to update embed allowlist',
        code: 'INTERNAL_ERROR',
      });
    }
  },
);

module.exports = router;
