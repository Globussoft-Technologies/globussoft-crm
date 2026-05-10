// @ts-check
/**
 * Unit tests for backend/cron/backupEngine.js — Wave 11 Agent A.
 *
 * Why this file exists (regression class):
 *   Pre-Wave-11 the module was 0% covered. The engine runs the daily
 *   `mysqldump | gzip` pipeline at 02:00 server-time. The #417 refactor
 *   moved from a shell-pipeline to a spawn-pipe so BOTH child exit codes
 *   are observable — the old form silently swallowed mysqldump failures
 *   and wrote 0-byte gzip archives that looked successful. We pin
 *   the post-#417 contract:
 *     - DATABASE_URL absent → { success:false, code:'NO_DB_URL' }
 *     - DATABASE_URL un-parseable → { success:false, code:'BAD_DB_URL' }
 *     - MYSQLDUMP_BIN explicitly set + binary missing → { code:'MYSQLDUMP_FAILED' }
 *     - mysqldump exits non-zero → { code:'MYSQLDUMP_FAILED', stderr present }
 *     - gzip exits non-zero → { code:'GZIP_FAILED' }
 *     - happy path with both children exiting 0 → { success:true, file, sizeBytes>0 }
 *     - 0-byte gzip output (the historical bug) → { code:'MYSQLDUMP_FAILED' }
 *     - listBackups returns newest-first
 *     - getBackupDir respects BACKUP_DIR env-var
 *     - initBackupCron is exported (schedule wire-in is trivial, not asserted)
 *
 * Mocking strategy:
 *   - Use createRequire to grab the actual CJS modules (child_process,
 *     node-cron) and monkey-patch their exports. The SUT's
 *     `const { spawn } = require('child_process')` and
 *     `const cron = require('node-cron')` both resolve to the same
 *     cached instance, so writing on the cached exports propagates.
 *     Pattern matches backend/test/lib/sentry.test.js's createRequire
 *     workaround. `vi.mock` does NOT reliably intercept CJS requires
 *     under this repo's vitest config (documented in
 *     backend/test/cron/slaBreachEngine.test.js:702-709).
 *   - Use a real tmp dir for BACKUP_DIR (created per test, removed
 *     after) so fs.createWriteStream + fs.statSync paths actually run.
 *
 * NOT covered (intentional):
 *   - Real mysqldump invocation (would require a live MySQL on the test box).
 *   - The exact cron.schedule registration call. Asserted only that
 *     initBackupCron is exported; the schedule shell is one line.
 */
import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const childProcess = requireCJS('child_process');
const nodeCron = requireCJS('node-cron');

// Capture the originals so we can restore them between tests.
const originalSpawn = childProcess.spawn;
const originalSchedule = nodeCron.schedule;

// Install the spawn + schedule mocks BEFORE requiring the SUT — the SUT
// destructures `const { spawn } = require('child_process')` at module
// load, so the destructured ref is captured against whatever spawn the
// cached child_process module had AT THAT MOMENT. We assign mocks to
// the module exports first, then require the SUT, which gives the
// destructured ref a pointer to the same mock variable.
const spawnMock = vi.fn();
const scheduleMock = vi.fn();
childProcess.spawn = spawnMock;
nodeCron.schedule = scheduleMock;

// Resolve the SUT's path absolutely and clear its cache so the destructure
// re-runs against the patched module exports.
const sutPath = requireCJS.resolve('../../cron/backupEngine.js');
delete requireCJS.cache[sutPath];
const backupEngine = requireCJS('../../cron/backupEngine.js');

/**
 * Build a fake child process. Its stdout / stderr are EventEmitters that
 * also expose .pipe() — the spawn pipeline does
 *   dump.stdout.pipe(gz.stdin)  // we no-op this (drives nothing)
 *   gz.stdout.pipe(fileStream)  // captures the destination on `_fileStream`
 */
function makeFakeProcess({ captureFileStream = false } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.pipe = (dest) => {
    if (captureFileStream) proc._fileStream = dest;
    return dest;
  };
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.end = vi.fn();
  proc.stdin.write = vi.fn();
  proc.kill = vi.fn();
  return proc;
}

/** Configure spawn() to return a sequence of fake processes. */
function setupSpawnSequence(processes) {
  spawnMock.mockReset();
  let i = 0;
  spawnMock.mockImplementation(() => {
    if (i >= processes.length) {
      throw new Error(`spawn called more than ${processes.length} times`);
    }
    return processes[i++];
  });
}

/**
 * Drive a fake-process pair (mysqldump + gzip) toward a successful exit.
 *   - gz._fileStream receives bytes and is end()'d → 'close' fires.
 *   - dump emits exit 0
 *   - gz emits exit 0
 */
function driveSuccess(dump, gz, gzipData = Buffer.from('compressed-bytes')) {
  setImmediate(() => {
    if (gz._fileStream) {
      gz._fileStream.write(gzipData, () => {
        gz._fileStream.end();
      });
    }
    dump.emit('exit', 0, null);
    gz.emit('exit', 0, null);
  });
}

/** Drive mysqldump to exit non-zero (gz exits 0 cleanly). */
function driveMysqldumpFailure(dump, gz, stderrMsg = 'access denied') {
  setImmediate(() => {
    dump.stderr.emit('data', Buffer.from(stderrMsg));
    if (gz._fileStream) {
      gz._fileStream.end();
    }
    dump.emit('exit', 2, null);
    gz.emit('exit', 0, null);
  });
}

/** Drive gzip to exit non-zero (dump exits 0). */
function driveGzipFailure(dump, gz, stderrMsg = 'gzip: broken pipe') {
  setImmediate(() => {
    gz.stderr.emit('data', Buffer.from(stderrMsg));
    if (gz._fileStream) {
      gz._fileStream.end();
    }
    dump.emit('exit', 0, null);
    gz.emit('exit', 1, null);
  });
}

let tmpDir;
let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  process.env.BACKUP_DIR = tmpDir;

  // Reset call records on the mocks (the mock instances themselves are
  // captured at file-top before SUT require — see comment above).
  spawnMock.mockReset();
  scheduleMock.mockReset();
});

afterEach(() => {
  // Restore env.
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    process.env[k] = v;
  }

  // Clean tmp dir.
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { /* */ }
    }
    fs.rmdirSync(tmpDir);
  } catch (_) { /* best-effort */ }
});

// Final restore of patched module exports (after all tests in this file).
afterAll(() => {
  childProcess.spawn = originalSpawn;
  nodeCron.schedule = originalSchedule;
});

describe('cron/backupEngine — env-var guards', () => {
  test('returns NO_DB_URL when DATABASE_URL is absent', async () => {
    delete process.env.DATABASE_URL;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await backupEngine.runBackup();
    warnSpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.code).toBe('NO_DB_URL');
    expect(result.file).toBeNull();
    expect(result.sizeBytes).toBe(0);
    expect(typeof result.durationMs).toBe('number');
  });

  test('returns BAD_DB_URL when DATABASE_URL cannot be parsed', async () => {
    process.env.DATABASE_URL = 'not-a-valid-mysql-url';
    const result = await backupEngine.runBackup();
    expect(result.success).toBe(false);
    expect(result.code).toBe('BAD_DB_URL');
    expect(result.error).toMatch(/parse/i);
  });

  test('MYSQLDUMP_BIN explicitly set but binary missing → MYSQLDUMP_FAILED', async () => {
    process.env.DATABASE_URL = 'mysql://user:pass@127.0.0.1:3306/gbscrm';
    process.env.MYSQLDUMP_BIN = '/nonexistent/path/to/mysqldump';
    const result = await backupEngine.runBackup();
    expect(result.success).toBe(false);
    expect(result.code).toBe('MYSQLDUMP_FAILED');
    expect(result.error).toMatch(/not executable|does not exist/i);
    // spawn should never have been called — the pre-flight throws first.
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('cron/backupEngine — spawn pipeline (happy path + failures)', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'mysql://gbsuser:gbspass@127.0.0.1:3306/gbscrm';
  });

  test('happy path → both children exit 0 → success:true with sizeBytes>0', async () => {
    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    driveSuccess(dump, gz, Buffer.from('compressed-bytes'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backupEngine.runBackup({ filename: 'happy.sql.gz' });
    logSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.file).toBe('happy.sql.gz');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.error).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'happy.sql.gz'))).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [bin1, args1] = spawnMock.mock.calls[0];
    expect(bin1).toBe('mysqldump');
    expect(args1).toContain('-u');
    expect(args1).toContain('gbsuser');
    expect(args1).toContain('--single-transaction');
    const [bin2, args2] = spawnMock.mock.calls[1];
    expect(bin2).toBe('gzip');
    expect(args2).toEqual(['-c']);
  });

  test('mysqldump exits non-zero → MYSQLDUMP_FAILED with captured stderr', async () => {
    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    driveMysqldumpFailure(dump, gz, 'mysqldump: Got error 1045 Access denied');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backupEngine.runBackup({ filename: 'failmd.sql.gz' });
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.code).toBe('MYSQLDUMP_FAILED');
    expect(result.error).toMatch(/Access denied/);
    expect(fs.existsSync(path.join(tmpDir, 'failmd.sql.gz'))).toBe(false);
  });

  test('gzip exits non-zero → GZIP_FAILED', async () => {
    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    driveGzipFailure(dump, gz, 'gzip: broken pipe');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backupEngine.runBackup({ filename: 'failgz.sql.gz' });
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.code).toBe('GZIP_FAILED');
    expect(result.error).toMatch(/broken pipe/);
    expect(fs.existsSync(path.join(tmpDir, 'failgz.sql.gz'))).toBe(false);
  });

  test('0-byte gzip output (both children exit 0 but no bytes) → MYSQLDUMP_FAILED with "0-byte" error', async () => {
    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    setImmediate(() => {
      if (gz._fileStream) gz._fileStream.end();
      dump.emit('exit', 0, null);
      gz.emit('exit', 0, null);
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backupEngine.runBackup({ filename: 'empty.sql.gz' });
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(result.success).toBe(false);
    expect(result.code).toBe('MYSQLDUMP_FAILED');
    expect(result.error).toMatch(/0-byte|empty/);
    expect(fs.existsSync(path.join(tmpDir, 'empty.sql.gz'))).toBe(false);
  });

  test('Docker mode: MYSQLDUMP_DOCKER_CONTAINER wraps spawn in `docker exec <container> mysqldump`', async () => {
    process.env.MYSQLDUMP_DOCKER_CONTAINER = 'gbs-mysql-dev';
    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    driveSuccess(dump, gz);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backupEngine.runBackup({ filename: 'docker.sql.gz' });
    logSpy.mockRestore();

    expect(result.success).toBe(true);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('gbs-mysql-dev');
    expect(args[2]).toBe('mysqldump');
    // Inside the container, mysqldump uses 127.0.0.1:3306 (NOT host port).
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('3306');
  });
});

describe('cron/backupEngine — listBackups + getBackupDir', () => {
  test('getBackupDir respects BACKUP_DIR env-var (absolute path)', () => {
    expect(backupEngine.getBackupDir()).toBe(path.resolve(tmpDir));
  });

  test('listBackups returns [] when backup dir is empty', () => {
    expect(backupEngine.listBackups()).toEqual([]);
  });

  test('listBackups returns entries sorted newest-first', () => {
    const f1 = path.join(tmpDir, 'backup-2026-01-01.sql.gz');
    const f2 = path.join(tmpDir, 'backup-2026-02-01.sql.gz');
    fs.writeFileSync(f1, 'older');
    fs.writeFileSync(f2, 'newer');
    fs.utimesSync(f1, new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(f2, new Date('2026-02-01'), new Date('2026-02-01'));

    const list = backupEngine.listBackups();
    expect(list).toHaveLength(2);
    expect(list[0].file).toBe('backup-2026-02-01.sql.gz');
    expect(list[1].file).toBe('backup-2026-01-01.sql.gz');
    expect(list[0].sizeBytes).toBeGreaterThan(0);
    expect(typeof list[0].mtime).toBe('number');
  });

  test('listBackups limits results per the limit option', () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `backup-${i}.sql.gz`), 'x');
    }
    const list = backupEngine.listBackups({ limit: 3 });
    expect(list).toHaveLength(3);
  });

  test('listBackups filters non-.sql.gz files', () => {
    fs.writeFileSync(path.join(tmpDir, 'backup-x.sql.gz'), 'yes');
    fs.writeFileSync(path.join(tmpDir, 'README.txt'), 'no');
    fs.writeFileSync(path.join(tmpDir, 'something.tar'), 'no');
    const list = backupEngine.listBackups();
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe('backup-x.sql.gz');
  });
});

describe('cron/backupEngine — initBackupCron registration', () => {
  test('initBackupCron registers a daily schedule at 02:00', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    backupEngine.initBackupCron();
    logSpy.mockRestore();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock.mock.calls[0][0]).toBe('0 2 * * *');
    expect(typeof scheduleMock.mock.calls[0][1]).toBe('function');
  });

  test('cron tick callback attaches .catch — does not surface unhandled rejection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    backupEngine.initBackupCron();
    delete process.env.DATABASE_URL;
    const tick = scheduleMock.mock.calls[0][1];
    let synchronousThrow = false;
    try {
      const ret = tick();
      if (ret && typeof ret.then === 'function') {
        await ret;
      } else {
        await new Promise((r) => setImmediate(r));
      }
    } catch (_e) {
      synchronousThrow = true;
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    expect(synchronousThrow).toBe(false);
  });
});

describe('cron/backupEngine — retention pruning', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'mysql://gbsuser:gbspass@127.0.0.1:3306/gbscrm';
    process.env.BACKUP_RETENTION_DAYS = '7';
  });

  test('successful run prunes files older than BACKUP_RETENTION_DAYS', async () => {
    const oldPath = path.join(tmpDir, 'backup-old.sql.gz');
    fs.writeFileSync(oldPath, 'old');
    fs.utimesSync(oldPath, new Date('2020-01-01'), new Date('2020-01-01'));
    const recentPath = path.join(tmpDir, 'backup-recent.sql.gz');
    fs.writeFileSync(recentPath, 'recent');

    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    driveSuccess(dump, gz);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backupEngine.runBackup({ filename: 'fresh.sql.gz' });
    logSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(recentPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'fresh.sql.gz'))).toBe(true);
  });

  test('FAILED run does NOT prune (preserves evidence for debugging)', async () => {
    const oldPath = path.join(tmpDir, 'backup-old.sql.gz');
    fs.writeFileSync(oldPath, 'old');
    fs.utimesSync(oldPath, new Date('2020-01-01'), new Date('2020-01-01'));

    const dump = makeFakeProcess();
    const gz = makeFakeProcess({ captureFileStream: true });
    setupSpawnSequence([dump, gz]);
    driveMysqldumpFailure(dump, gz);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backupEngine.runBackup({ filename: 'failed.sql.gz' });
    errSpy.mockRestore();
    logSpy.mockRestore();

    expect(fs.existsSync(oldPath)).toBe(true);
  });
});
