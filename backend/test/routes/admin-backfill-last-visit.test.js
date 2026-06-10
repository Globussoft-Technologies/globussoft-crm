// @ts-check
/**
 * Unit tests for POST /api/admin/wellness/run-backfill-last-visit (S107)
 *
 * Why this file exists
 * ────────────────────
 * S107 adds an ADMIN-gated trigger for cron/backfillLastVisitEngine.tick()
 * (the S94 one-shot backfill that populates Patient.lastVisitDate). Without
 * a unit-test pin, future refactors of the route handler (envelope reshape,
 * RBAC flip, audit-log dropping, etc.) would silently regress the contract.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /wellness/run-backfill-last-visit happy-path: returns
 *      { success: true, tenantId, triggeredBy, processed, updated, errors }
 *      with the engine's envelope passed through verbatim.
 *   2. Tenant scoping forward: the route MUST call tick({ tenantId }) so
 *      future engine-side scoping work auto-activates. We assert tick() was
 *      called exactly once with the requesting admin's tenantId.
 *   3. triggeredBy carries req.user.userId — for operator audit forensics.
 *   4. Engine reports { success: false } → 500 BACKFILL_FAILED with the
 *      envelope shape preserved (processed/updated/errors carried through).
 *   5. Engine throws → 500 BACKFILL_FAILED with the thrown error message
 *      surfaced as `error`.
 *   6. Audit-log emitted on success — entity='System',
 *      action='admin.backfill.last-visit', userId=triggeredBy, tenantId
 *      forwarded; details carries the envelope summary.
 *   7. Audit-log emitted on hard failure too — operator forensics must
 *      capture WHO tried to trigger the run, regardless of outcome.
 *   8. RBAC: USER → 403 RBAC_DENIED, tick() never called.
 *   9. RBAC: MANAGER → 403 RBAC_DENIED, tick() never called.
 *  10. Idempotency: calling twice → second tick() invocation gets called
 *      with the same tenantId (the route is stateless; the engine itself
 *      handles "everything already populated → updated=0" semantics).
 *  11. ADMIN happy path round-trip with mocked verifyToken bypass.
 *
 * Pattern mirrors backend/test/routes/admin.test.js — same monkey-patch
 * approach for the backupEngine module, applied to backfillLastVisitEngine
 * + the audit module. We patch BEFORE the router is required so the
 * router's destructured `require('../cron/backfillLastVisitEngine')` and
 * `require('../lib/audit')` capture the mock surfaces.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch backfillLastVisitEngine BEFORE the admin router is required.
// The router does `const backfillLastVisitEngine = require('../cron/backfillLastVisitEngine')`
// at module-load — replacing tick() on the module-exports object means the
// router's captured reference points at our spy.
const backfillEngine = requireCJS('../../cron/backfillLastVisitEngine');
backfillEngine.tick = vi.fn();

// Patch audit module too — writeAudit is invoked fire-and-forget but we
// want to assert it ran with the right arguments.
const auditMod = requireCJS('../../lib/audit');
auditMod.writeAudit = vi.fn().mockResolvedValue(undefined);

// Auth middleware bypass — verifyToken passes through; verifyRole stays
// REAL so the RBAC assertion is end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Patch backupEngine too so the existing routes don't crash on require —
// not exercised by these tests but the admin router pulls them in eagerly.
const backupEngine = requireCJS('../../cron/backupEngine');
backupEngine.runBackup = backupEngine.runBackup || vi.fn();
backupEngine.listBackups = backupEngine.listBackups || vi.fn();
backupEngine.getBackupDir = backupEngine.getBackupDir || vi.fn();

import express from 'express';
import request from 'supertest';

const adminRouter = requireCJS('../../routes/admin');

/**
 * Build a fresh express app with a fake auth-context middleware so the
 * router sees req.user populated. Default role is ADMIN; override to
 * USER / MANAGER to exercise the verifyRole(['ADMIN']) denial path.
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
  backfillEngine.tick.mockReset();
  auditMod.writeAudit.mockReset();
  auditMod.writeAudit.mockResolvedValue(undefined);
});

describe('POST /api/admin/wellness/run-backfill-last-visit (S107)', () => {
  test('1. happy path: returns success envelope with engine fields + triggeredBy', async () => {
    backfillEngine.tick.mockResolvedValue({
      success: true,
      processed: 42,
      updated: 17,
      errors: 0,
    });

    const res = await request(makeApp({ tenantId: 99, userId: 5 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      tenantId: 99,
      triggeredBy: 5,
      processed: 42,
      updated: 17,
      errors: 0,
    });
  });

  test('2. tenant scoping: tick() called with { tenantId } from req.user', async () => {
    backfillEngine.tick.mockResolvedValue({
      success: true,
      processed: 0,
      updated: 0,
      errors: 0,
    });

    await request(makeApp({ tenantId: 42, userId: 11 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(backfillEngine.tick).toHaveBeenCalledTimes(1);
    expect(backfillEngine.tick).toHaveBeenCalledWith({ tenantId: 42 });
  });

  test('3. triggeredBy carries req.user.userId verbatim', async () => {
    backfillEngine.tick.mockResolvedValue({
      success: true,
      processed: 3,
      updated: 2,
      errors: 0,
    });

    const res = await request(makeApp({ tenantId: 1, userId: 1234 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.triggeredBy).toBe(1234);
  });

  test('4. engine reports success=false → 500 BACKFILL_FAILED with envelope preserved', async () => {
    backfillEngine.tick.mockResolvedValue({
      success: false,
      processed: 0,
      updated: 0,
      errors: 1,
    });

    const res = await request(makeApp({ tenantId: 7, userId: 8 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      tenantId: 7,
      triggeredBy: 8,
      processed: 0,
      updated: 0,
      errors: 1,
      code: 'BACKFILL_FAILED',
    });
  });

  test('5. engine throws → 500 BACKFILL_FAILED with the thrown message surfaced', async () => {
    backfillEngine.tick.mockRejectedValue(new Error('connection lost'));

    const res = await request(makeApp({ tenantId: 1, userId: 1 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('BACKFILL_FAILED');
    expect(res.body.error).toMatch(/connection lost/);
  });

  test('6. audit-log emitted on success with envelope summary in details', async () => {
    backfillEngine.tick.mockResolvedValue({
      success: true,
      processed: 5,
      updated: 3,
      errors: 0,
    });

    await request(makeApp({ tenantId: 42, userId: 99 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    // Audit fires fire-and-forget; give it a microtask to settle even
    // though the .catch path is synchronous in the mock.
    await new Promise((r) => setImmediate(r));

    expect(auditMod.writeAudit).toHaveBeenCalledTimes(1);
    const args = auditMod.writeAudit.mock.calls[0];
    expect(args[0]).toBe('System');
    expect(args[1]).toBe('admin.backfill.last-visit');
    expect(args[2]).toBe(null); // entityId — system-level, no row id
    expect(args[3]).toBe(99); // userId / triggeredBy
    expect(args[4]).toBe(42); // tenantId
    expect(args[5]).toMatchObject({
      success: true,
      processed: 5,
      updated: 3,
      errors: 0,
    });
  });

  test('7. audit-log emitted on hard failure too (operator forensics)', async () => {
    backfillEngine.tick.mockRejectedValue(new Error('catastrophic'));

    await request(makeApp({ tenantId: 1, userId: 22 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    await new Promise((r) => setImmediate(r));

    expect(auditMod.writeAudit).toHaveBeenCalledTimes(1);
    const args = auditMod.writeAudit.mock.calls[0];
    expect(args[0]).toBe('System');
    expect(args[1]).toBe('admin.backfill.last-visit');
    expect(args[3]).toBe(22);
    expect(args[4]).toBe(1);
    expect(args[5]).toMatchObject({ success: false });
    expect(args[5].error).toMatch(/catastrophic/);
  });

  test('8. USER role → 403 RBAC_DENIED, tick() never called', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(backfillEngine.tick).not.toHaveBeenCalled();
  });

  test('9. MANAGER role → 403 RBAC_DENIED, tick() never called', async () => {
    const res = await request(makeApp({ role: 'MANAGER' }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(backfillEngine.tick).not.toHaveBeenCalled();
  });

  test('10. idempotency: second call invokes tick() with same tenantId', async () => {
    // First call: simulate a productive run.
    backfillEngine.tick.mockResolvedValueOnce({
      success: true,
      processed: 100,
      updated: 100,
      errors: 0,
    });
    // Second call: simulate "everything already populated" — engine returns
    // processed=0 because no patients have lastVisitDate=null anymore.
    backfillEngine.tick.mockResolvedValueOnce({
      success: true,
      processed: 0,
      updated: 0,
      errors: 0,
    });

    const r1 = await request(makeApp({ tenantId: 55 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});
    const r2 = await request(makeApp({ tenantId: 55 }))
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});

    expect(r1.status).toBe(200);
    expect(r1.body.updated).toBe(100);
    expect(r2.status).toBe(200);
    expect(r2.body.updated).toBe(0);
    expect(backfillEngine.tick).toHaveBeenCalledTimes(2);
    expect(backfillEngine.tick).toHaveBeenNthCalledWith(1, { tenantId: 55 });
    expect(backfillEngine.tick).toHaveBeenNthCalledWith(2, { tenantId: 55 });
  });

  test('11. ADMIN happy path with verifyToken bypass reaches tick()', async () => {
    // verifyToken is bypassed in this suite; this case asserts that with
    // an ADMIN role + valid auth-context, the endpoint reaches tick(). The
    // genuine 401 case is covered by the playwright spec against a live
    // backend (auth-middleware enforces JWT presence).
    backfillEngine.tick.mockResolvedValue({
      success: true,
      processed: 0,
      updated: 0,
      errors: 0,
    });
    const res = await request(makeApp())
      .post('/api/admin/wellness/run-backfill-last-visit')
      .send({});
    expect(res.status).toBe(200);
    expect(backfillEngine.tick).toHaveBeenCalled();
  });
});
