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
const { verifyToken, verifyRole } = require('../middleware/auth');
const { runBackup, listBackups, getBackupDir } = require('../cron/backupEngine');

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
    const result = runBackup();
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

module.exports = router;
