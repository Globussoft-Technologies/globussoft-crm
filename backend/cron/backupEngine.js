/**
 * Automated MySQL Backup Engine.
 *
 * Daily 02:00 server-time, shells `mysqldump | gzip` against the DATABASE_URL
 * MySQL instance and writes a timestamped `.sql.gz` to BACKUP_DIR (default
 * `<repo>/backups/`). Cleans up files older than the retention window
 * (default 30 days) on each successful run.
 *
 * Two invocation paths supported (G-15 — needed because CI runners do NOT
 * pre-install mysql-client, and the dev host on Windows doesn't have
 * mysqldump on PATH either, but the local Docker MySQL container does):
 *
 *   1. PATH mode (default) — `mysqldump` is on PATH (Linux dev host, prod
 *      server, GitHub Actions runner with mysql-client installed).
 *   2. Docker mode — set `MYSQLDUMP_DOCKER_CONTAINER=<container-name>`
 *      to invoke `docker exec <container> mysqldump …`. When the engine
 *      runs against the local Docker MySQL on :3307 (cf. CLAUDE.md
 *      candidateDbUrls), the host arg passed to mysqldump is rewritten
 *      to `127.0.0.1` + the container's INTERNAL port `3306` (mysqldump
 *      runs INSIDE the container, so it sees mysql on its localhost,
 *      not the host's :3307 forward). DATABASE_URL parsing still drives
 *      user / password / db.
 *
 * Env vars:
 *   DATABASE_URL                   — REQUIRED; mysql://user:pass@host:port/db
 *   BACKUP_DIR                     — optional; default <repo>/backups/
 *   BACKUP_RETENTION_DAYS          — optional; default 30
 *   MYSQLDUMP_BIN                  — optional; default 'mysqldump'
 *   MYSQLDUMP_DOCKER_CONTAINER     — optional; when set, wraps invocation
 *                                    in `docker exec <container>`
 *
 * Exports:
 *   initBackupCron()  — wires the daily cron schedule (called from server.js)
 *   runBackup(opts)   — synchronous; returns { success, file, sizeBytes,
 *                       durationMs, error } so the manual-trigger route
 *                       can return a structured response.
 *                       opts.filename may override the auto-timestamped
 *                       filename (used by the test spec to tag its
 *                       output for self-clean).
 *   listBackups()     — returns array of { file, sizeBytes, mtime }
 *                       sorted newest-first for the
 *                       GET /api/admin/backup/list route.
 *   getBackupDir()    — returns the absolute backup dir path (for the
 *                       file-path sanitizer in the route).
 */
const cron = require('node-cron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function getBackupDir() {
  return process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.resolve(__dirname, '../../backups');
}

function getRetentionDays() {
  const n = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function parseDbUrl(dbUrl) {
  // mysql://user:pass@host:port/dbname (port + ?query optional)
  const m = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:/]+)(?::(\d+))?\/([^?]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: m[4] || '3306', dbName: m[5] };
}

function buildMysqldumpCommand({ user, pass, host, port, dbName, filepath }) {
  const bin = process.env.MYSQLDUMP_BIN || 'mysqldump';
  const container = process.env.MYSQLDUMP_DOCKER_CONTAINER;
  // Common mysqldump args. --single-transaction --quick is the standard
  // hot-backup combo for InnoDB; --no-tablespaces silences the 8.0
  // "PROCESS privilege required" warning on shared hosts.
  const args = `--single-transaction --quick --no-tablespaces`;
  if (container) {
    // Docker mode — mysqldump runs INSIDE the container, so it talks to
    // the in-container mysqld on its local 127.0.0.1:3306, NOT the
    // forwarded host port. Output is piped from `docker exec` to gzip
    // on the HOST and then redirected to filepath.
    return (
      `docker exec ${container} ${bin} ` +
      `-h 127.0.0.1 -P 3306 ` +
      `-u "${user}" -p"${pass}" ${args} "${dbName}" ` +
      `| gzip > "${filepath}"`
    );
  }
  // PATH mode
  return (
    `${bin} -h "${host}" -P ${port} ` +
    `-u "${user}" -p"${pass}" ${args} "${dbName}" ` +
    `| gzip > "${filepath}"`
  );
}

function runBackup(opts = {}) {
  const start = Date.now();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[Backup] DATABASE_URL not set, skipping');
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: 'DATABASE_URL not set',
      code: 'NO_DB_URL',
    };
  }
  const parsed = parseDbUrl(dbUrl);
  if (!parsed) {
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: 'Could not parse DATABASE_URL',
      code: 'BAD_DB_URL',
    };
  }

  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const filename =
    opts.filename ||
    `backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.sql.gz`;
  const filepath = path.join(backupDir, filename);

  let cmd;
  try {
    cmd = buildMysqldumpCommand({ ...parsed, filepath });
  } catch (err) {
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: err.message,
      code: 'CMD_BUILD_FAILED',
    };
  }

  try {
    console.log(`[Backup] Starting backup to ${filename}…`);
    execSync(cmd, { stdio: 'pipe', timeout: 300000, shell: true });
    const stat = fs.statSync(filepath);
    // Cleanup old backups — only successful runs trigger pruning so a
    // failing run never erases evidence we could need to debug.
    pruneOldBackups(backupDir);
    console.log(
      `[Backup] Complete: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`
    );
    return {
      success: true,
      file: filename, // RELATIVE only — never leak the absolute server FS path
      sizeBytes: stat.size,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    // mysqldump binary unavailable / wrong creds / network unreachable —
    // also clean up an empty/partial file if gzip created one.
    try {
      if (fs.existsSync(filepath) && fs.statSync(filepath).size === 0) {
        fs.unlinkSync(filepath);
      }
    } catch (_e) { /* best-effort */ }
    const msg = (err.stderr && err.stderr.toString()) || err.message || 'unknown';
    console.error('[Backup] Failed:', msg);
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: msg.slice(0, 500),
      code: 'MYSQLDUMP_FAILED',
    };
  }
}

function pruneOldBackups(backupDir) {
  try {
    const cutoff = Date.now() - getRetentionDays() * 24 * 60 * 60 * 1000;
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('backup-') && f.endsWith('.sql.gz'));
    for (const f of files) {
      const fpath = path.join(backupDir, f);
      try {
        if (fs.statSync(fpath).mtimeMs < cutoff) {
          fs.unlinkSync(fpath);
          console.log(`[Backup] Cleaned old backup: ${f}`);
        }
      } catch (_e) { /* best-effort */ }
    }
  } catch (_e) { /* best-effort */ }
}

function listBackups({ limit = 20 } = {}) {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];
  try {
    return fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.sql.gz'))
      .map((f) => {
        const fp = path.join(backupDir, f);
        const st = fs.statSync(fp);
        return { file: f, sizeBytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(0, Math.min(100, limit | 0)));
  } catch (_e) {
    return [];
  }
}

function initBackupCron() {
  // Run daily at 2 AM
  cron.schedule('0 2 * * *', () => {
    runBackup();
  });
  console.log('[Backup] Cron scheduled: daily at 02:00');
}

module.exports = {
  initBackupCron,
  runBackup,
  listBackups,
  getBackupDir,
};
