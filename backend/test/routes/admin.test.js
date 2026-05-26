// @ts-check
/**
 * Unit tests for backend/routes/admin.js — pins the admin-only ops surface
 * (manual backup trigger + backup file lookup + LLM spend summary).
 *
 * Why this file exists
 * ────────────────────
 * routes/admin.js is the "system-level ops" namespace (filesystem-touching,
 * cron-mirror triggers, LLM cost observability). It's separate from
 * /api/staff (which is for tenant-admin actions on User rows) precisely
 * because the blast radius is bigger — every endpoint here is ADMIN-only,
 * tenant-scoped, and either touches the filesystem (backups) or pulls a
 * cross-tenant-shaped Prisma table (LlmCallLog).
 *
 * What this file pins
 * ───────────────────
 *   1. POST /backup/run happy-path: returns { success: true, tenantId, file:
 *      <basename>, sizeBytes, durationMs, errors: [] } — no absolute path
 *      leaks (CRITICAL: `file` is basename only per route JSDoc).
 *   2. POST /backup/run failure-path: backupEngine.runBackup() resolves with
 *      { success: false, code, error } → route returns 500 with structured
 *      envelope including the engine's error code (MYSQLDUMP_FAILED etc).
 *   3. POST /backup/run thrown-error path: engine throws → 500 INTERNAL_ERROR.
 *   4. POST /backup/run is gated by verifyRole(['ADMIN']) — USER → 403
 *      RBAC_DENIED.
 *   5. GET /backup/list happy-path: returns { success: true, backups: [...] }
 *      with the limit query passed through.
 *   6. GET /backup/list ADMIN-only: USER → 403.
 *   7. GET /backup/file/:name happy-path: existing file → { success: true,
 *      exists: true, file, sizeBytes, mtime }.
 *   8. GET /backup/file/:name 404 when file not found.
 *   9. GET /backup/file/:name 400 INVALID_NAME on path-traversal:
 *      slash, backslash, "..", and basename!==name all rejected.
 *  10. GET /backup/file/:name ADMIN-only.
 *  11. GET /llm-spend happy-path: returns { days, from, to, totals, byDay,
 *      byTask, byModel } with the right shape; default days=7 when no query.
 *  12. GET /llm-spend ?days=14 honored within [1, 90] window.
 *  13. GET /llm-spend ?days=99 → 400 INVALID_RANGE (exceeds MAX_DAYS=90).
 *  14. GET /llm-spend ?days=0 → 400 INVALID_RANGE (below min=1).
 *  15. GET /llm-spend ?days=abc → silently falls back to default (7).
 *  16. GET /llm-spend tenant scoping: every Prisma query passed a where with
 *      tenantId=req.user.tenantId (no cross-tenant leak).
 *  17. GET /llm-spend ADMIN-only.
 *  18. GET /llm-spend Prisma error → 500 INTERNAL_ERROR.
 *
 * Pattern mirrors backend/test/routes/staff.test.js (prisma singleton
 * monkey-patch + supertest with fake auth middleware) and
 * backend/test/routes/accounting.test.js (auth-middleware bypass via
 * monkey-patching `authMw.verifyToken` BEFORE the router is required).
 *
 * The backupEngine module is patched the same way — its three exports
 * (runBackup, listBackups, getBackupDir) are swapped for vi.fn()s on the
 * module-exports object BEFORE the router is required, so the router's
 * destructured `const { runBackup, listBackups, getBackupDir } =
 * require(...)` captures the mocks. `fs.existsSync` + `fs.statSync` are
 * stubbed via vi.spyOn for the backup/file/:name happy-path; the
 * path-traversal cases short-circuit before any fs call so they don't
 * need stubs.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch backupEngine module's exports BEFORE the admin router is required
// — the router does `const { runBackup, listBackups, getBackupDir } =
// require('../cron/backupEngine')` at module-load, so the destructured
// references capture whatever the module-exports object points at THE
// MOMENT the route is required.
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const backupEngine = requireCJS('../../cron/backupEngine');
backupEngine.runBackup = vi.fn();
backupEngine.listBackups = vi.fn();
backupEngine.getBackupDir = vi.fn();

// Auth middleware bypass — pass through verifyToken so we exercise the
// route + verifyRole flow without minting JWTs. verifyRole stays REAL so
// the role-gate assertions are end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — replace the lazy $extends-proxy delegate
// for llmCallLog with bare vi.fn() surfaces. The route only touches this
// one delegate via findMany / groupBy / count / aggregate.
prisma.llmCallLog = {
  findMany: vi.fn(),
  groupBy: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import fs from 'node:fs';

const adminRouter = requireCJS('../../routes/admin');

/**
 * Construct a fresh express app with a fake auth-context middleware so the
 * router sees req.user populated. Default role is ADMIN; override to USER
 * to exercise the verifyRole(['ADMIN']) denial path.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => {
  backupEngine.runBackup.mockReset();
  backupEngine.listBackups.mockReset();
  backupEngine.getBackupDir.mockReset();
  prisma.llmCallLog.findMany.mockReset();
  prisma.llmCallLog.groupBy.mockReset();
  prisma.llmCallLog.count.mockReset();
  prisma.llmCallLog.aggregate.mockReset();

  // Default aggregate / groupBy fallbacks so happy-path llm-spend tests
  // don't need to wire every mock if they don't care about the values.
  prisma.llmCallLog.findMany.mockResolvedValue([]);
  prisma.llmCallLog.groupBy.mockResolvedValue([]);
  prisma.llmCallLog.count.mockResolvedValue(0);
  prisma.llmCallLog.aggregate.mockResolvedValue({
    _sum: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costEstimate: 0,
    },
  });
});

// ── POST /backup/run — manual mysqldump trigger (G-15) ────────────────

describe('POST /backup/run', () => {
  test('happy path: returns success envelope with basename file + sizes', async () => {
    backupEngine.runBackup.mockResolvedValue({
      success: true,
      file: 'backup-2026-05-25T10-30-00.sql.gz',
      sizeBytes: 1234567,
      durationMs: 4321,
    });

    const res = await request(makeApp({ tenantId: 42 })).post('/api/admin/backup/run').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      tenantId: 42,
      file: 'backup-2026-05-25T10-30-00.sql.gz',
      sizeBytes: 1234567,
      durationMs: 4321,
      errors: [],
    });
    // CRITICAL — file must never carry directory separators (basename only).
    expect(res.body.file).not.toMatch(/[\\/]/);
    // No absolute server path leak — neither C:\ nor /var/ nor /tmp/.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toMatch(/[A-Z]:\\/);
    expect(bodyStr).not.toMatch(/\/var\//);
  });

  test('engine reports failure → 500 with structured code', async () => {
    backupEngine.runBackup.mockResolvedValue({
      success: false,
      error: 'mysqldump: connection refused',
      code: 'MYSQLDUMP_FAILED',
      durationMs: 250,
    });

    const res = await request(makeApp({ tenantId: 1 })).post('/api/admin/backup/run').send({});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      tenantId: 1,
      file: null,
      sizeBytes: 0,
      durationMs: 250,
      code: 'MYSQLDUMP_FAILED',
    });
    expect(res.body.errors).toContain('mysqldump: connection refused');
  });

  test('engine throws → 500 INTERNAL_ERROR', async () => {
    backupEngine.runBackup.mockRejectedValue(new Error('disk full'));
    const res = await request(makeApp()).post('/api/admin/backup/run').send({});
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.errors).toContain('disk full');
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/admin/backup/run')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(backupEngine.runBackup).not.toHaveBeenCalled();
  });

  test('MANAGER role → 403 RBAC_DENIED (only ADMIN passes)', async () => {
    const res = await request(makeApp({ role: 'MANAGER' }))
      .post('/api/admin/backup/run')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(backupEngine.runBackup).not.toHaveBeenCalled();
  });
});

// ── GET /backup/list — list recent backups ────────────────────────────

describe('GET /backup/list', () => {
  test('returns { success, backups } using engine listBackups()', async () => {
    backupEngine.listBackups.mockReturnValue([
      { file: 'backup-2026-05-24T02-00-00.sql.gz', sizeBytes: 1000000, mtime: 1716508800000 },
      { file: 'backup-2026-05-23T02-00-00.sql.gz', sizeBytes: 900000, mtime: 1716422400000 },
    ]);
    const res = await request(makeApp()).get('/api/admin/backup/list');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.backups).toHaveLength(2);
    expect(res.body.backups[0]).toMatchObject({
      file: 'backup-2026-05-24T02-00-00.sql.gz',
      sizeBytes: 1000000,
    });
  });

  test('?limit=5 forwarded to engine listBackups', async () => {
    backupEngine.listBackups.mockReturnValue([]);
    await request(makeApp()).get('/api/admin/backup/list?limit=5');
    expect(backupEngine.listBackups).toHaveBeenCalledWith({ limit: 5 });
  });

  test('USER role → 403', async () => {
    const res = await request(makeApp({ role: 'USER' })).get('/api/admin/backup/list');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(backupEngine.listBackups).not.toHaveBeenCalled();
  });
});

// ── GET /backup/file/:name — sanity check + size for one backup ───────

describe('GET /backup/file/:name', () => {
  test('happy path: existing file returns { exists: true, sizeBytes, mtime }', async () => {
    backupEngine.getBackupDir.mockReturnValue('/var/backups');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const statSpy = vi.spyOn(fs, 'statSync').mockReturnValue(
      /** @type {any} */ ({ size: 5000000, mtimeMs: 1716508800000 })
    );
    try {
      const res = await request(makeApp()).get(
        '/api/admin/backup/file/backup-2026-05-24T02-00-00.sql.gz'
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        exists: true,
        file: 'backup-2026-05-24T02-00-00.sql.gz',
        sizeBytes: 5000000,
        mtime: 1716508800000,
      });
      // CRITICAL — the response must not contain the absolute backup directory.
      expect(JSON.stringify(res.body)).not.toContain('/var/backups');
    } finally {
      existsSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  test('404 when file does not exist', async () => {
    backupEngine.getBackupDir.mockReturnValue('/var/backups');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      const res = await request(makeApp()).get('/api/admin/backup/file/missing.sql.gz');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.exists).toBe(false);
    } finally {
      existsSpy.mockRestore();
    }
  });

  test('rejects path-traversal with forward slash → 400 INVALID_NAME', async () => {
    // The supertest URL parsing of "/api/admin/backup/file/foo/bar" treats
    // the slash as a route boundary, so the express router returns 404 for
    // a missing handler — to hit the route's own slash-check we URL-encode.
    const res = await request(makeApp()).get(
      '/api/admin/backup/file/' + encodeURIComponent('../../etc/passwd')
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME');
  });

  test('rejects path-traversal with backslash → 400 INVALID_NAME', async () => {
    const res = await request(makeApp()).get(
      '/api/admin/backup/file/' + encodeURIComponent('..\\windows\\sam')
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME');
  });

  test('rejects ".." segment alone → 400 INVALID_NAME', async () => {
    const res = await request(makeApp()).get(
      '/api/admin/backup/file/' + encodeURIComponent('..foo..bar.sql.gz')
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME');
  });

  test('USER role → 403', async () => {
    const res = await request(makeApp({ role: 'USER' })).get(
      '/api/admin/backup/file/x.sql.gz'
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

// ── GET /llm-spend — LLM cost observability daily summary ─────────────

describe('GET /llm-spend', () => {
  test('happy path: returns days/from/to/totals/byDay/byTask/byModel shape', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-05-24T10:00:00Z'),
        totalTokens: 1000,
        costEstimate: 0.01,
      },
      {
        createdAt: new Date('2026-05-24T11:00:00Z'),
        totalTokens: 2000,
        costEstimate: 0.02,
      },
      {
        createdAt: new Date('2026-05-25T09:00:00Z'),
        totalTokens: 1500,
        costEstimate: 0.015,
      },
    ]);
    prisma.llmCallLog.groupBy
      .mockResolvedValueOnce([
        // byTask
        { task: 'summarize', _count: { _all: 2 }, _sum: { totalTokens: 3000, costEstimate: 0.03 } },
        { task: 'classify', _count: { _all: 1 }, _sum: { totalTokens: 1500, costEstimate: 0.015 } },
      ])
      .mockResolvedValueOnce([
        // byModel
        { model: 'gemini-2.5', _count: { _all: 3 }, _sum: { totalTokens: 4500, costEstimate: 0.045 } },
      ]);
    prisma.llmCallLog.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    prisma.llmCallLog.aggregate.mockResolvedValue({
      _sum: {
        promptTokens: 3000,
        completionTokens: 1500,
        totalTokens: 4500,
        costEstimate: 0.045,
      },
    });

    const res = await request(makeApp({ tenantId: 42 })).get('/api/admin/llm-spend');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    expect(typeof res.body.from).toBe('string');
    expect(typeof res.body.to).toBe('string');
    expect(res.body.totals).toMatchObject({
      calls: 3,
      promptTokens: 3000,
      completionTokens: 1500,
      totalTokens: 4500,
      costEstimate: 0.045,
      stubCalls: 2,
      realCalls: 1,
    });
    // byDay: chronological order, two days bucketed.
    expect(res.body.byDay).toHaveLength(2);
    expect(res.body.byDay[0].date).toBe('2026-05-24');
    expect(res.body.byDay[0].calls).toBe(2);
    expect(res.body.byDay[1].date).toBe('2026-05-25');
    // byTask / byModel: descending by cost.
    expect(res.body.byTask[0].task).toBe('summarize');
    expect(res.body.byTask[0].costEstimate).toBe(0.03);
    expect(res.body.byModel[0].model).toBe('gemini-2.5');
  });

  test('?days=14 honored within [1, 90]', async () => {
    const res = await request(makeApp()).get('/api/admin/llm-spend?days=14');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
  });

  test('?days=99 → 400 INVALID_RANGE (exceeds MAX_DAYS=90)', async () => {
    const res = await request(makeApp()).get('/api/admin/llm-spend?days=99');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RANGE');
    expect(res.body.error).toMatch(/between 1 and 90/);
  });

  test('?days=0 → 400 INVALID_RANGE (below min=1)', async () => {
    const res = await request(makeApp()).get('/api/admin/llm-spend?days=0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RANGE');
  });

  test('?days=abc falls back silently to default (7)', async () => {
    const res = await request(makeApp()).get('/api/admin/llm-spend?days=abc');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
  });

  test('tenant scoping: every Prisma query receives where.tenantId from req.user', async () => {
    await request(makeApp({ tenantId: 7 })).get('/api/admin/llm-spend');

    // Every call: findMany + 2× groupBy + 2× count + aggregate.
    const allCalls = [
      ...prisma.llmCallLog.findMany.mock.calls,
      ...prisma.llmCallLog.groupBy.mock.calls,
      ...prisma.llmCallLog.count.mock.calls,
      ...prisma.llmCallLog.aggregate.mock.calls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const [arg] of allCalls) {
      expect(arg.where.tenantId).toBe(7);
    }
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' })).get('/api/admin/llm-spend');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.llmCallLog.findMany).not.toHaveBeenCalled();
  });

  test('Prisma error → 500 INTERNAL_ERROR', async () => {
    prisma.llmCallLog.findMany.mockRejectedValue(new Error('DB unreachable'));
    const res = await request(makeApp()).get('/api/admin/llm-spend');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/DB unreachable/);
  });
});
