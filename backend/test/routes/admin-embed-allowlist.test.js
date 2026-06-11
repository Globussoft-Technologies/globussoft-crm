// @ts-check
/**
 * Unit tests for /api/admin/tenants/:id/embed-allowlist (S128)
 *
 * Why this file exists
 * ────────────────────
 * S128 adds the admin GET + PATCH surface for `Tenant.embedAllowlistJson`
 * — the operator UI/API for setting which partner origins can iframe-embed
 * a tenant's CRM-served widgets. S39 added the column + S66/S129 wired the
 * read path; S128 closes the chain with a writable surface. Without unit
 * pins, future refactors of the route handler (validation reshape, RBAC
 * flip, audit drop, dedupe/trim change) would silently regress the
 * contract.
 *
 * What this file pins
 * ───────────────────
 *   1. GET happy path: returns { tenantId, origins, updatedAt } with the
 *      stored JSON parsed.
 *   2. GET with null column returns origins=[].
 *   3. GET with malformed JSON returns origins=[] (parity with S66
 *      fallback semantics — never throws).
 *   4. GET cross-tenant → 403 CROSS_TENANT_DENIED.
 *   5. GET non-existent tenant → 404 TENANT_NOT_FOUND.
 *   6. GET invalid tenantId (non-numeric) → 400 INVALID_TENANT_ID.
 *   7. PATCH happy path: writes JSON.stringify(origins) to the column,
 *      returns the envelope { tenantId, origins, updatedAt, updatedBy }.
 *   8. PATCH empty array → embedAllowlistJson = null (the "no
 *      restriction / wildcard back-compat" semantics).
 *   9. PATCH rejects HTTP origin → 400 INVALID_ORIGIN.
 *  10. PATCH rejects malformed string → 400 INVALID_ORIGIN.
 *  11. PATCH rejects non-array body → 400 INVALID_BODY.
 *  12. PATCH dedupe + trim: duplicate / whitespace-padded entries are
 *      normalised before persistence.
 *  13. PATCH 100-entry cap: 101 entries → 400 ALLOWLIST_TOO_LARGE.
 *  14. PATCH cross-tenant → 403 CROSS_TENANT_DENIED, prisma.update never
 *      called.
 *  15. PATCH non-existent tenant → 404 TENANT_NOT_FOUND.
 *  16. PATCH writes audit row with before/after envelope.
 *  17. RBAC: USER → 403 RBAC_DENIED, prisma never touched.
 *  18. RBAC: MANAGER → 403 RBAC_DENIED.
 *
 * Pattern mirrors backend/test/routes/admin-backfill-last-visit.test.js —
 * same monkey-patch approach. We patch prisma + audit BEFORE requiring the
 * router so its destructured references capture the mock surfaces.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch prisma surface BEFORE the admin router is required. The router does
// `const prisma = require('../lib/prisma')` at module-load — replacing the
// methods on the module-exports object means the router's captured reference
// points at our spies.
const prismaMod = requireCJS('../../lib/prisma');
prismaMod.tenant = prismaMod.tenant || {};
prismaMod.tenant.findUnique = vi.fn();
prismaMod.tenant.update = vi.fn();

// Patch audit module too — writeAudit is invoked fire-and-forget but we
// want to assert it ran with the right arguments.
const auditMod = requireCJS('../../lib/audit');
auditMod.writeAudit = vi.fn().mockResolvedValue(undefined);

// Auth middleware bypass — verifyToken passes through; verifyRole stays
// REAL so the RBAC assertion is end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Patch backupEngine + backfillLastVisitEngine so the existing routes don't
// crash on require — not exercised by these tests but the admin router pulls
// them in eagerly.
const backupEngine = requireCJS('../../cron/backupEngine');
backupEngine.runBackup = backupEngine.runBackup || vi.fn();
backupEngine.listBackups = backupEngine.listBackups || vi.fn();
backupEngine.getBackupDir = backupEngine.getBackupDir || vi.fn();
const backfillEngine = requireCJS('../../cron/backfillLastVisitEngine');
backfillEngine.tick = backfillEngine.tick || vi.fn();

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
  prismaMod.tenant.findUnique.mockReset();
  prismaMod.tenant.update.mockReset();
  auditMod.writeAudit.mockReset();
  auditMod.writeAudit.mockResolvedValue(undefined);
});

describe('GET /api/admin/tenants/:id/embed-allowlist (S128)', () => {
  test('1. happy path: returns parsed origins from stored JSON', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 42,
      embedAllowlistJson: JSON.stringify(['https://partner1.com', 'https://partner2.com']),
      updatedAt: new Date('2026-06-11T00:00:00Z'),
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/admin/tenants/42/embed-allowlist');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 42,
      origins: ['https://partner1.com', 'https://partner2.com'],
    });
    expect(res.body.updatedAt).toBeTruthy();
  });

  test('2. null column → origins=[]', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 5,
      embedAllowlistJson: null,
      updatedAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 5 }))
      .get('/api/admin/tenants/5/embed-allowlist');

    expect(res.status).toBe(200);
    expect(res.body.origins).toEqual([]);
  });

  test('3. malformed JSON → origins=[] (parity with S66 fallback semantics)', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 9,
      embedAllowlistJson: '{not valid json',
      updatedAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 9 }))
      .get('/api/admin/tenants/9/embed-allowlist');

    expect(res.status).toBe(200);
    expect(res.body.origins).toEqual([]);
  });

  test('4. cross-tenant → 403 CROSS_TENANT_DENIED, prisma never touched', async () => {
    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/admin/tenants/999/embed-allowlist');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_DENIED');
    expect(prismaMod.tenant.findUnique).not.toHaveBeenCalled();
  });

  test('5. non-existent tenant → 404 TENANT_NOT_FOUND', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 77 }))
      .get('/api/admin/tenants/77/embed-allowlist');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  test('6. invalid tenantId (non-numeric) → 400 INVALID_TENANT_ID', async () => {
    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/admin/tenants/abc/embed-allowlist');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TENANT_ID');
    expect(prismaMod.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/tenants/:id/embed-allowlist (S128)', () => {
  test('7. happy path: writes JSON.stringify(origins) + returns envelope', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 42,
      embedAllowlistJson: null,
    });
    prismaMod.tenant.update.mockResolvedValue({
      id: 42,
      embedAllowlistJson: JSON.stringify(['https://partner1.com']),
      updatedAt: new Date('2026-06-11T00:00:00Z'),
    });

    const res = await request(makeApp({ tenantId: 42, userId: 99 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins: ['https://partner1.com'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 42,
      origins: ['https://partner1.com'],
      updatedBy: 99,
    });
    expect(prismaMod.tenant.update).toHaveBeenCalledTimes(1);
    const updateArgs = prismaMod.tenant.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 42 });
    expect(updateArgs.data).toEqual({
      embedAllowlistJson: JSON.stringify(['https://partner1.com']),
    });
  });

  test('8. empty array → embedAllowlistJson = null (wildcard back-compat)', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 42,
      embedAllowlistJson: JSON.stringify(['https://old.com']),
    });
    prismaMod.tenant.update.mockResolvedValue({
      id: 42,
      embedAllowlistJson: null,
      updatedAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins: [] });

    expect(res.status).toBe(200);
    expect(res.body.origins).toEqual([]);
    const updateArgs = prismaMod.tenant.update.mock.calls[0][0];
    expect(updateArgs.data).toEqual({ embedAllowlistJson: null });
  });

  test('9. rejects HTTP origin → 400 INVALID_ORIGIN', async () => {
    const res = await request(makeApp({ tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins: ['http://partner.com'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ORIGIN');
    expect(res.body.invalid).toContain('http://partner.com');
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });

  test('10. rejects malformed string → 400 INVALID_ORIGIN, lists all bad entries', async () => {
    const res = await request(makeApp({ tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({
        origins: [
          'https://valid.com',
          'not-a-url',
          'https:// space.com',
          'ftp://wrong-scheme.com',
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ORIGIN');
    expect(res.body.invalid).toEqual(
      expect.arrayContaining(['not-a-url', 'https:// space.com', 'ftp://wrong-scheme.com']),
    );
    // The valid entry should NOT be in the invalid list.
    expect(res.body.invalid).not.toContain('https://valid.com');
  });

  test('11. rejects non-array body → 400 INVALID_BODY', async () => {
    const res = await request(makeApp({ tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins: 'https://partner.com' }); // string, not array

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });

  test('12. dedupe + trim: duplicate + whitespace-padded entries normalised', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 42,
      embedAllowlistJson: null,
    });
    prismaMod.tenant.update.mockResolvedValue({
      id: 42,
      embedAllowlistJson: JSON.stringify(['https://partner.com', 'https://other.com']),
      updatedAt: new Date(),
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({
        origins: [
          '  https://partner.com  ',
          'https://partner.com', // duplicate
          'https://other.com',
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.origins).toEqual(['https://partner.com', 'https://other.com']);
    const updateArgs = prismaMod.tenant.update.mock.calls[0][0];
    expect(updateArgs.data.embedAllowlistJson).toBe(
      JSON.stringify(['https://partner.com', 'https://other.com']),
    );
  });

  test('13. 100-entry cap: 101 entries → 400 ALLOWLIST_TOO_LARGE', async () => {
    const origins = Array.from({ length: 101 }, (_, i) => `https://partner${i}.com`);
    const res = await request(makeApp({ tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALLOWLIST_TOO_LARGE');
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });

  test('14. cross-tenant → 403 CROSS_TENANT_DENIED, prisma.update never called', async () => {
    const res = await request(makeApp({ tenantId: 1 }))
      .patch('/api/admin/tenants/999/embed-allowlist')
      .send({ origins: ['https://partner.com'] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_TENANT_DENIED');
    expect(prismaMod.tenant.findUnique).not.toHaveBeenCalled();
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });

  test('15. non-existent tenant → 404 TENANT_NOT_FOUND', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 77 }))
      .patch('/api/admin/tenants/77/embed-allowlist')
      .send({ origins: ['https://partner.com'] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });

  test('16. writes audit row with before/after envelope', async () => {
    prismaMod.tenant.findUnique.mockResolvedValue({
      id: 42,
      embedAllowlistJson: JSON.stringify(['https://old.com']),
    });
    prismaMod.tenant.update.mockResolvedValue({
      id: 42,
      embedAllowlistJson: JSON.stringify(['https://new.com']),
      updatedAt: new Date(),
    });

    await request(makeApp({ tenantId: 42, userId: 88 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins: ['https://new.com'] });

    // Audit fires fire-and-forget; give it a microtask to settle.
    await new Promise((r) => setImmediate(r));

    expect(auditMod.writeAudit).toHaveBeenCalledTimes(1);
    const args = auditMod.writeAudit.mock.calls[0];
    expect(args[0]).toBe('Tenant');
    expect(args[1]).toBe('admin.embed-allowlist.update');
    expect(args[2]).toBe(42); // entityId — the tenant being modified
    expect(args[3]).toBe(88); // userId (triggeredBy)
    expect(args[4]).toBe(42); // tenantId
    expect(args[5]).toMatchObject({
      before: JSON.stringify(['https://old.com']),
      after: JSON.stringify(['https://new.com']),
      origins: ['https://new.com'],
    });
  });

  test('17. USER role → 403 RBAC_DENIED, prisma never touched (GET)', async () => {
    const res = await request(makeApp({ role: 'USER', tenantId: 42 }))
      .get('/api/admin/tenants/42/embed-allowlist');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prismaMod.tenant.findUnique).not.toHaveBeenCalled();
  });

  test('18. MANAGER role → 403 RBAC_DENIED (PATCH)', async () => {
    const res = await request(makeApp({ role: 'MANAGER', tenantId: 42 }))
      .patch('/api/admin/tenants/42/embed-allowlist')
      .send({ origins: ['https://partner.com'] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prismaMod.tenant.update).not.toHaveBeenCalled();
  });
});
