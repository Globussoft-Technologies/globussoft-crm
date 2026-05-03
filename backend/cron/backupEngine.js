/**
 * Automated MySQL Backup Engine.
 *
 * Daily 02:00 server-time, runs `mysqldump | gzip` against the DATABASE_URL
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
 * Pipeline implementation (issue #417):
 *   Both modes use `child_process.spawn` (no shell) to run two children
 *   piped together — `mysqldump` (or `docker exec … mysqldump`) and `gzip`
 *   — with the gzip stdout written to the destination file via
 *   `fs.createWriteStream`. This makes BOTH child exit codes observable.
 *   A shell pipeline (`a | b > f`) under POSIX `sh` without `pipefail`
 *   reports only the LAST stage's exit code, so a mysqldump runtime
 *   failure (DB unreachable, bad credentials, schema lock, disk full,
 *   version mismatch, etc.) was previously masked by gzip happily writing
 *   a 0-byte archive and exiting 0 — the engine would return
 *   { success: true } with a useless backup file. The spawn-pipe pattern
 *   below fails fast on any non-zero exit from either child.
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
 *   runBackup(opts)   — async; returns Promise<{ success, file, sizeBytes,
 *                       durationMs, error, code? }> so the manual-trigger
 *                       route can return a structured response.
 *                       opts.filename may override the auto-timestamped
 *                       filename (used by the test spec to tag its
 *                       output for self-clean).
 *                       NOTE: was synchronous prior to #417. Switched to
 *                       Promise return because the spawn-pipe pattern
 *                       cannot be implemented sync without buffering the
 *                       full dump in memory.
 *   listBackups()     — returns array of { file, sizeBytes, mtime }
 *                       sorted newest-first for the
 *                       GET /api/admin/backup/list route.
 *   getBackupDir()    — returns the absolute backup dir path (for the
 *                       file-path sanitizer in the route).
 */
const cron = require('node-cron');
const { spawn } = require('child_process');
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

// Common mysqldump CLI flags. --single-transaction --quick is the standard
// hot-backup combo for InnoDB; --no-tablespaces silences the 8.0
// "PROCESS privilege required" warning on shared hosts.
const MYSQLDUMP_FLAGS = ['--single-transaction', '--quick', '--no-tablespaces'];

/**
 * Build the spawn descriptor for mysqldump. Returns:
 *   { mode: 'path' | 'docker', bin, args }
 *
 * `bin` + `args` are passed straight to `child_process.spawn(bin, args)` with
 * NO shell — every argument is a discrete element so password / database-name
 * shell-metacharacters cannot be interpreted (defence in depth on top of the
 * fact that those values come from DATABASE_URL parse, not user input).
 *
 * The returned descriptor is consumed by runBackup() which wires the
 * mysqldump child's stdout into a `gzip -c` child's stdin via spawn() pipe
 * with both exit codes observable. The previous version of this function
 * returned a single shell pipeline string consumed by execSync(); that path
 * masked mysqldump runtime failures because POSIX `sh` (without `pipefail`)
 * reports only the LAST stage's exit code — and gzip happily exits 0 on
 * empty stdin. See issue #417.
 *
 * The function name is kept for backwards compatibility with the existing
 * test fixtures that import it; callers within this module no longer rely
 * on the legacy shell-string return shape.
 */
function buildMysqldumpCommand({ user, pass, host, port, dbName }) {
  // NOTE: signature param `filepath` was removed in #417 — the legacy
  // shell-string return embedded `> "${filepath}"`, but the spawn-pipe
  // implementation in runBackup() owns the file-write side via
  // fs.createWriteStream and no longer needs filepath in the descriptor.
  // Callers that pass filepath continue to work (excess destructured key
  // is silently dropped), but new callers should drop it.
  const bin = process.env.MYSQLDUMP_BIN || 'mysqldump';
  const container = process.env.MYSQLDUMP_DOCKER_CONTAINER;

  // When MYSQLDUMP_BIN is explicitly configured, verify the binary exists
  // before attempting to spawn it. This is the #416 pre-flight: catches
  // the "binary missing entirely" case fast, before the spawn ENOENT path
  // (which IS observable now via the spawn 'error' event in runBackup,
  // but a synchronous throw here gives a cleaner error message and saves
  // a process spawn).
  //
  // We only apply this check when MYSQLDUMP_BIN is explicitly set (not the
  // default 'mysqldump') and not in Docker mode (where the binary lives
  // inside the container, not on the host FS).
  if (process.env.MYSQLDUMP_BIN && !container) {
    let accessible = false;
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      accessible = true;
    } catch (_e) {
      // Not executable or does not exist — fall through to throw below.
    }
    if (!accessible) {
      throw new Error(`MYSQLDUMP_BIN '${bin}' is not executable or does not exist`);
    }
  }

  if (container) {
    // Docker mode — mysqldump runs INSIDE the container, so it talks to
    // the in-container mysqld on its local 127.0.0.1:3306, NOT the
    // forwarded host port. We spawn `docker exec` on the host; its stdout
    // streams the dump out, and runBackup() pipes that into gzip on the
    // host. Each `docker exec` arg is a discrete element — no shell.
    return {
      mode: 'docker',
      bin: 'docker',
      args: [
        'exec',
        container,
        bin,
        '-h', '127.0.0.1',
        '-P', '3306',
        '-u', user,
        // mysqldump only accepts the password glued to -p with NO space.
        // Splitting them would make mysqldump prompt interactively.
        `-p${pass}`,
        ...MYSQLDUMP_FLAGS,
        dbName,
      ],
    };
  }

  // PATH mode
  return {
    mode: 'path',
    bin,
    args: [
      '-h', host,
      '-P', String(port),
      '-u', user,
      `-p${pass}`,
      ...MYSQLDUMP_FLAGS,
      dbName,
    ],
  };
}

// Hard upper bound on how long the whole pipeline may run. Matches the
// previous execSync timeout (300s = 5 min). Beyond this, both children
// are SIGKILL'd and the run returns MYSQLDUMP_TIMEOUT.
const PIPELINE_TIMEOUT_MS = 300000;

// Hard upper bound on captured stderr length per child. Bounded so a
// chatty mysqldump (e.g. table-by-table errors on a 1000-table DB)
// can't blow up memory. The error envelope further truncates to 500.
const STDERR_BUFFER_MAX = 32 * 1024;

/**
 * Cleanup helper: unlink the destination file if it exists. Best-effort —
 * never throws.
 *
 * We unconditionally remove a file we created in this run on failure.
 * Leaving a partial gzip behind would just confuse listBackups()
 * (which doesn't filter by size) and the user. The previous
 * implementation only removed 0-byte files; we widen that to "any
 * file we just wrote and the run failed" because partial gzip
 * archives are unrestorable anyway.
 */
function unlinkEmptyFile(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch (_e) { /* best-effort */ }
}

/**
 * Spawn `mysqldump | gzip > <filepath>` as TWO independent children with
 * observable exit codes. Resolves with { ok, code?, stderr? } where
 *   - ok=true  — both children exited 0 and the output file is readable.
 *   - ok=false — one of the children failed; `code` is one of:
 *       MYSQLDUMP_FAILED  (dump child exited non-zero / failed to spawn)
 *       GZIP_FAILED       (gzip child exited non-zero / failed to spawn)
 *       WRITE_FAILED      (fs.createWriteStream errored, e.g. ENOSPC, EACCES)
 *       MYSQLDUMP_TIMEOUT (pipeline ran past PIPELINE_TIMEOUT_MS)
 *     `stderr` is the combined stderr from whichever child failed,
 *     truncated to STDERR_BUFFER_MAX.
 *
 * The function never throws — failures resolve, not reject — so callers
 * can map the result into the `runBackup` envelope without try/catch.
 */
function spawnPipeline(dumpDescriptor, filepath) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Bounded stderr capture for both children. We wrap each in a small
    // object holding the chunks + a running byte count so the capture
    // helper can stop appending once we hit STDERR_BUFFER_MAX (a chatty
    // mysqldump on a 1000-table DB could otherwise blow up memory). The
    // error envelope further truncates to 500 chars at the route layer.
    const dumpStderr = { chunks: [], size: 0 };
    const gzStderr = { chunks: [], size: 0 };
    const captureStderr = (chunk, sink) => {
      const remaining = STDERR_BUFFER_MAX - sink.size;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      sink.chunks.push(slice);
      sink.size += slice.length;
    };

    let dumpExit = null; // null until exit fires
    let gzExit = null;
    let writeError = null;
    let timedOut = false;
    let fileStreamClosed = false;

    // Spawn mysqldump (or `docker exec mysqldump`).
    let dump;
    try {
      dump = spawn(dumpDescriptor.bin, dumpDescriptor.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      settle({ ok: false, code: 'MYSQLDUMP_FAILED', stderr: e && e.message ? e.message : String(e) });
      return;
    }

    // Spawn gzip. `-c` writes compressed output to stdout (not in-place).
    let gz;
    try {
      gz = spawn('gzip', ['-c'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      try { dump.kill('SIGTERM'); } catch (_e) { /* best-effort */ }
      settle({ ok: false, code: 'GZIP_FAILED', stderr: e && e.message ? e.message : String(e) });
      return;
    }

    // Wire dump.stdout → gz.stdin. `{ end: true }` is the default so when
    // dump closes its stdout, gz sees EOF on its stdin and starts exiting.
    // If gz.stdin emits 'error' (gzip died early — e.g. SIGPIPE), we
    // swallow it on the dump side: gzip's own 'exit' event will surface
    // the failure code. Without this guard, an unhandled 'error' on
    // dump.stdout's pipe would crash the process.
    dump.stdout.pipe(gz.stdin);
    gz.stdin.on('error', (_e) => { /* surfaced via gz exit code */ });
    dump.stdout.on('error', (_e) => { /* surfaced via dump exit code */ });

    // Wire gz.stdout → file. fs.createWriteStream can fail on ENOSPC,
    // EACCES, etc. — we capture the first error.
    const fileStream = fs.createWriteStream(filepath);
    fileStream.on('error', (e) => {
      writeError = e;
      try { dump.kill('SIGTERM'); } catch (_e) { /* best-effort */ }
      try { gz.kill('SIGTERM'); } catch (_e) { /* best-effort */ }
    });
    gz.stdout.pipe(fileStream);
    gz.stdout.on('error', (_e) => { /* surfaced via fileStream */ });

    // Capture stderr from both children for diagnostic surfacing.
    dump.stderr.on('data', (chunk) => captureStderr(chunk, dumpStderr));
    gz.stderr.on('data', (chunk) => captureStderr(chunk, gzStderr));
    dump.stderr.on('error', (_e) => { /* best-effort */ });
    gz.stderr.on('error', (_e) => { /* best-effort */ });

    // Spawn 'error' fires when the child cannot start (ENOENT on bin,
    // EACCES on bin, etc.). Distinct from a non-zero exit AFTER it ran.
    dump.on('error', (e) => {
      // Synthesise an exit so the join logic below settles.
      dumpExit = -1;
      const msg = e && e.message ? e.message : String(e);
      captureStderr(Buffer.from(msg), dumpStderr);
      try { gz.kill('SIGTERM'); } catch (_e) { /* best-effort */ }
    });
    gz.on('error', (e) => {
      gzExit = -1;
      const msg = e && e.message ? e.message : String(e);
      captureStderr(Buffer.from(msg), gzStderr);
      try { dump.kill('SIGTERM'); } catch (_e) { /* best-effort */ }
    });

    // Watchdog timeout — both children get SIGKILL'd. We use 'kill' (not
    // 'close') so any data already in flight from gz to fileStream is
    // flushed; the WRITE_FAILED case is preferred over a corrupt success.
    const timer = setTimeout(() => {
      timedOut = true;
      try { dump.kill('SIGKILL'); } catch (_e) { /* best-effort */ }
      try { gz.kill('SIGKILL'); } catch (_e) { /* best-effort */ }
    }, PIPELINE_TIMEOUT_MS);

    const tryFinalise = () => {
      // Wait for: both children's exit code AND fileStream to finish
      // (or to have errored). 'close' on fileStream fires after all
      // pending writes have flushed.
      if (dumpExit === null || gzExit === null) return;
      // Sequence: dump.exit → gz.stdin EOF → gz.exit → fileStream 'close'.
      // We listen for 'close' on fileStream below; tryFinalise gets called
      // again from there with the file fully flushed.
      if (!fileStreamClosed && writeError === null) return;
      clearTimeout(timer);

      if (timedOut) {
        unlinkEmptyFile(filepath);
        settle({
          ok: false,
          code: 'MYSQLDUMP_TIMEOUT',
          stderr: `pipeline exceeded ${PIPELINE_TIMEOUT_MS}ms`,
        });
        return;
      }
      if (writeError) {
        unlinkEmptyFile(filepath);
        settle({
          ok: false,
          code: 'WRITE_FAILED',
          stderr: writeError.message || String(writeError),
        });
        return;
      }
      if (dumpExit !== 0) {
        // Dump failed — gzip very likely also "failed" (EPIPE from dump
        // closing its stdout early), but the meaningful failure is the
        // dump. Report it.
        unlinkEmptyFile(filepath);
        const stderr = Buffer.concat(dumpStderr.chunks).toString('utf8') || `mysqldump exited with code ${dumpExit}`;
        settle({ ok: false, code: 'MYSQLDUMP_FAILED', stderr });
        return;
      }
      if (gzExit !== 0) {
        unlinkEmptyFile(filepath);
        const stderr = Buffer.concat(gzStderr.chunks).toString('utf8') || `gzip exited with code ${gzExit}`;
        settle({ ok: false, code: 'GZIP_FAILED', stderr });
        return;
      }
      // Both children exited 0 and the file flushed cleanly.
      settle({ ok: true });
    };

    fileStream.on('close', () => { fileStreamClosed = true; tryFinalise(); });

    dump.on('exit', (code, signal) => {
      // 'exit' fires when the process ends; 'close' fires when stdio is
      // also closed. We track 'exit' here because 'close' on the dump
      // child is a function of when its stdout pipe is drained — which
      // is by definition after gz reads it all. Either signature works.
      dumpExit = code === null && signal ? -1 : (code === null ? -1 : code);
      tryFinalise();
    });
    gz.on('exit', (code, signal) => {
      gzExit = code === null && signal ? -1 : (code === null ? -1 : code);
      tryFinalise();
    });
  });
}

/**
 * Run a single backup. Async — see file-header for the rationale.
 *
 * Returns { success, file, sizeBytes, durationMs, error, code? } — same
 * envelope shape the route handler has always relied on.
 */
async function runBackup(opts = {}) {
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

  let descriptor;
  try {
    descriptor = buildMysqldumpCommand({ ...parsed, filepath });
  } catch (err) {
    // buildMysqldumpCommand throws when the explicitly-configured
    // MYSQLDUMP_BIN is not executable — treat this the same as a
    // runtime binary-unavailable failure so the contract matches.
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: err.message,
      code: 'MYSQLDUMP_FAILED',
    };
  }

  console.log(`[Backup] Starting backup to ${filename}…`);
  const result = await spawnPipeline(descriptor, filepath);

  if (!result.ok) {
    // Belt-and-braces: spawnPipeline already unlinks on every failure
    // path, but we re-check here so a future refactor can't silently
    // leave a partial file behind.
    unlinkEmptyFile(filepath);
    const msg = (result.stderr || 'unknown').toString();
    console.error('[Backup] Failed:', msg);
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: msg.slice(0, 500),
      code: result.code || 'MYSQLDUMP_FAILED',
    };
  }

  // Validate the produced file. A 0-byte gzip is the historical bug
  // mode this whole refactor is preventing — guard against it
  // explicitly so no future change to spawnPipeline silently regresses.
  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch (e) {
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: e.message,
      code: 'WRITE_FAILED',
    };
  }
  if (stat.size === 0) {
    unlinkEmptyFile(filepath);
    return {
      success: false,
      file: null,
      sizeBytes: 0,
      durationMs: Date.now() - start,
      error: 'mysqldump produced empty output (0-byte gzip)',
      code: 'MYSQLDUMP_FAILED',
    };
  }

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
  // Run daily at 2 AM. runBackup() became async with #417 — we attach a
  // .catch so an unexpected internal rejection (none should escape; the
  // implementation always resolves) doesn't surface as an unhandled
  // promise rejection on the process.
  cron.schedule('0 2 * * *', () => {
    runBackup().catch((err) => {
      console.error('[Backup] cron tick crashed:', err && err.message ? err.message : err);
    });
  });
  console.log('[Backup] Cron scheduled: daily at 02:00');
}

module.exports = {
  initBackupCron,
  runBackup,
  listBackups,
  getBackupDir,
};
