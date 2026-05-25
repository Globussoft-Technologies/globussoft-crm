// @ts-check
/**
 * Unit tests for backend/routes/pipelines.js — pins the Pipeline CRUD +
 * default-toggle + deal-list / stats surface that backs the Settings →
 * Pipelines page and the Pipeline Board's pipeline-selector dropdown.
 *
 * Why this file exists
 * ────────────────────
 * pipelines.js is a 248-LOC route surface that holds several encoded
 * historical contracts:
 *   - #527 (CRIT-02) — admin-config WRITES are admin-only. GET routes
 *                      stay open to all authenticated tenant members
 *                      (USERs need to see the pipeline list to file
 *                      deals against it).
 *   - #568          — every Pipeline write (CREATE / UPDATE / DELETE) is
 *                      audit-logged via writeAudit('Pipeline', ...). The
 *                      audit call is wrapped in try/catch so a downstream
 *                      audit failure NEVER breaks the response — we pin
 *                      the call shape via a CJS self-mocking seam on
 *                      lib/audit so a missed audit emit is caught.
 *   - default-pipeline state machine — at most ONE pipeline per tenant has
 *                      isDefault=true. Creating with isDefault=true (or
 *                      creating the FIRST pipeline for the tenant) atomically
 *                      demotes any prior default within a $transaction.
 *                      Deleting the current default is REJECTED (400) — you
 *                      must promote another first via POST /:id/set-default.
 *   - delete-with-deals guard — DELETE /:id is rejected with 400 when the
 *                      pipeline still has deals pointing at it (FK-protection
 *                      at the application layer; the schema allows nullable
 *                      pipelineId so deals don't cascade).
 *   - tenant isolation — every read filters on req.user.tenantId; cross-
 *                      tenant id lookups return 404, never the foreign row.
 *
 * What this file pins (15 cases across 8 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — list pipelines tenant-scoped, with dealCount attached per row
 *      (via prisma.deal.groupBy aggregation joined into the response).
 *   2. POST / — create happy path: returns 201, isDefault auto-true when
 *      the tenant has no existing pipelines.
 *   3. POST / — create with isDefault=true demotes the prior default via
 *      $transaction.updateMany before creating.
 *   4. POST / — create rejects empty/missing name with 400.
 *   5. POST / — create writes a Pipeline CREATE audit row (#568).
 *   6. PUT /:id — happy update of name + description, audit UPDATE row
 *      (#568) emitted with diffFields() output.
 *   7. PUT /:id — non-numeric id returns 400 INVALID_ID.
 *   8. PUT /:id — cross-tenant id returns 404 (tenant-isolation).
 *   9. DELETE /:id — happy delete returns { success: true }, audit DELETE
 *      row (#568) emitted with the pre-delete name.
 *  10. DELETE /:id — refuses to delete the CURRENT default (400; explicit
 *      "promote another first" message).
 *  11. DELETE /:id — refuses to delete a pipeline with deals attached (400
 *      with deal-count in the error message).
 *  12. POST /:id/set-default — atomically demotes prior default + promotes
 *      target via $transaction.
 *  13. GET /:id/deals — happy path: tenant-scoped, includes contact + owner
 *      relations.
 *  14. GET /:id/deals — non-existent pipeline returns 404.
 *  15. GET /:id/stats — aggregates count + amount by stage; returns the
 *      envelope { pipelineId, pipelineName, totalDeals, totalValue, byStage }.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/field-permissions.test.js — prisma singleton
 * patch + real JWT bearer signed with config/secrets.JWT_SECRET so
 * verifyToken (real middleware) + verifyRole(['ADMIN']) (real middleware)
 * both pass. CJS self-mocking seam on lib/audit replaces writeAudit +
 * diffFields with vi.fn()s so we can assert the audit call shape without
 * relying on the real hash-chain DB write succeeding. vi.mock against the
 * route's `require('../middleware/auth')` does NOT reliably intercept in
 * this repo's vitest config (documented elsewhere) — real-JWT is the
 * canonical workaround.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.
prisma.pipeline = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.groupBy = vi.fn();
prisma.deal.count = vi.fn();

// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// $transaction stub: when called with a callback, invoke it with the
// prisma singleton itself so all tx.* calls hit the same vi.fn() mocks.
// When called with an array of promises, Promise.all them (rare here).
prisma.$transaction = vi.fn().mockImplementation(async (arg) => {
  if (typeof arg === 'function') return arg(prisma);
  if (Array.isArray(arg)) return Promise.all(arg);
  return arg;
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Use the SAME JWT_SECRET that verifyToken will use — by reaching into the
// already-cached config/secrets module. This guarantees the test-token
// signing path matches verifyToken's resolution regardless of env timing.
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// CJS self-mocking seam: the route does `require('../lib/audit')` at
// module load. Node CJS caches modules by resolved path — so the require
// inside the route returns the SAME object identity as our require here.
// We mutate that object's exported fns in place with vi.fn() so we can
// assert audit-emission shape (#568) without firing the real hash-chain
// write path. See cron-learnings 2026-05-24 ~01:43 UTC for the canonical
// pattern.
const auditModule = requireCJS('../../lib/audit');
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
const diffFieldsMock = vi.fn().mockImplementation((before, after, keys) => {
  // Same shape the real diffFields returns: { key: { before, after } } for
  // each key whose value actually changed. Pure helper — safe to inline.
  const out = {};
  for (const k of keys) {
    if (before?.[k] !== after?.[k]) {
      out[k] = { before: before?.[k] ?? null, after: after?.[k] ?? null };
    }
  }
  return out;
});
auditModule.writeAudit = writeAuditMock;
auditModule.diffFields = diffFieldsMock;

const pipelinesRouter = requireCJS('../../routes/pipelines');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipelines', pipelinesRouter);
  return app;
}

beforeEach(() => {
  prisma.pipeline.findMany.mockReset();
  prisma.pipeline.findFirst.mockReset();
  prisma.pipeline.count.mockReset();
  prisma.pipeline.create.mockReset();
  prisma.pipeline.update.mockReset();
  prisma.pipeline.updateMany.mockReset();
  prisma.pipeline.delete.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.deal.groupBy.mockReset();
  prisma.deal.count.mockReset();
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  diffFieldsMock.mockClear();
});

// ── GET / — list pipelines tenant-scoped, with deal counts ──────────────

describe('GET / — list pipelines', () => {
  test('returns tenant-scoped pipelines with dealCount attached', async () => {
    prisma.pipeline.findMany.mockResolvedValue([
      { id: 11, name: 'Default Sales', isDefault: true, description: null, tenantId: 1 },
      { id: 12, name: 'Renewals',      isDefault: false, description: 'Annual',  tenantId: 1 },
    ]);
    prisma.deal.groupBy.mockResolvedValue([
      { pipelineId: 11, _count: { _all: 5 } },
      { pipelineId: 12, _count: { _all: 2 } },
    ]);

    const res = await request(makeApp())
      .get('/api/pipelines')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 11, name: 'Default Sales', dealCount: 5 }));
    expect(res.body[1]).toEqual(expect.objectContaining({ id: 12, name: 'Renewals', dealCount: 2 }));

    // Tenant-scoped + ordered with isDefault=true rows first
    expect(prisma.pipeline.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    // Deal-count aggregation is also tenant-scoped + pipeline-id restricted
    expect(prisma.deal.groupBy).toHaveBeenCalledWith({
      by: ['pipelineId'],
      where: { tenantId: 1, pipelineId: { in: [11, 12] } },
      _count: { _all: true },
    });
  });

  test('attaches dealCount=0 when the pipeline has no deals', async () => {
    prisma.pipeline.findMany.mockResolvedValue([
      { id: 21, name: 'Brand New', isDefault: true, description: null, tenantId: 1 },
    ]);
    prisma.deal.groupBy.mockResolvedValue([]); // no deals at all

    const res = await request(makeApp())
      .get('/api/pipelines')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body[0].dealCount).toBe(0);
  });
});

// ── POST / — create pipeline (admin-only, #527) ─────────────────────────

describe('POST / — create pipeline', () => {
  test('creates a pipeline, auto-sets isDefault when tenant has zero existing pipelines', async () => {
    prisma.pipeline.count.mockResolvedValue(0); // first pipeline for tenant
    prisma.pipeline.create.mockResolvedValue({
      id: 99, name: 'My First Pipeline', description: null, isDefault: true, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/pipelines')
      .set('Authorization', makeBearer())
      .send({ name: '  My First Pipeline  ' }); // padding to verify trim

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: 99,
      name: 'My First Pipeline',
      isDefault: true,
    }));
    // updateMany NOT called (no prior defaults to demote)
    expect(prisma.pipeline.updateMany).not.toHaveBeenCalled();
    // create gets the trimmed name + auto-defaulted isDefault
    expect(prisma.pipeline.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'My First Pipeline',
        isDefault: true,
        tenantId: 1,
        description: null,
      }),
    });
    // #568 — Pipeline CREATE audit row was written
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock).toHaveBeenCalledWith(
      'Pipeline', 'CREATE', 99, 7, 1,
      expect.objectContaining({ name: 'My First Pipeline', isDefault: true }),
    );
  });

  test('isDefault=true demotes any prior default via updateMany inside the transaction', async () => {
    prisma.pipeline.count.mockResolvedValue(3); // tenant already has 3 pipelines
    prisma.pipeline.updateMany.mockResolvedValue({ count: 1 });
    prisma.pipeline.create.mockResolvedValue({
      id: 100, name: 'New Hotness', description: 'Replaces old default', isDefault: true, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/pipelines')
      .set('Authorization', makeBearer())
      .send({ name: 'New Hotness', description: 'Replaces old default', isDefault: true });

    expect(res.status).toBe(201);
    expect(res.body.isDefault).toBe(true);
    // The demote step ran FIRST inside the transaction
    expect(prisma.pipeline.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isDefault: true },
      data: { isDefault: false },
    });
    expect(prisma.pipeline.create).toHaveBeenCalled();
  });

  test('rejects empty / missing name with 400', async () => {
    const res1 = await request(makeApp())
      .post('/api/pipelines')
      .set('Authorization', makeBearer())
      .send({}); // missing name
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/Pipeline name is required/);

    const res2 = await request(makeApp())
      .post('/api/pipelines')
      .set('Authorization', makeBearer())
      .send({ name: '    ' }); // whitespace only — name.trim() falsy
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/Pipeline name is required/);

    expect(prisma.pipeline.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  test('non-ADMIN role is rejected with 403 (#527 admin-only writes)', async () => {
    const res = await request(makeApp())
      .post('/api/pipelines')
      .set('Authorization', makeBearer({ role: 'USER' }))
      .send({ name: 'Forbidden' });

    expect(res.status).toBe(403);
    expect(prisma.pipeline.create).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

// ── PUT /:id — update pipeline (admin-only, #527) ───────────────────────

describe('PUT /:id — update pipeline', () => {
  test('updates name + description, emits Pipeline UPDATE audit row with diffFields output (#568)', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 50, name: 'Old Name', description: 'Old desc', isDefault: false, tenantId: 1,
    });
    prisma.pipeline.update.mockResolvedValue({
      id: 50, name: 'New Name', description: 'New desc', isDefault: false, tenantId: 1,
    });

    const res = await request(makeApp())
      .put('/api/pipelines/50')
      .set('Authorization', makeBearer())
      .send({ name: '  New Name  ', description: 'New desc' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    // findFirst was tenant-scoped (not findUnique by id)
    expect(prisma.pipeline.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
    // update payload had trimmed name + new description
    expect(prisma.pipeline.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'New Name', description: 'New desc' },
    });
    // #568 audit emitted with the changed-fields diff
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock).toHaveBeenCalledWith(
      'Pipeline', 'UPDATE', 50, 7, 1,
      expect.objectContaining({
        changedFields: expect.objectContaining({
          name: { before: 'Old Name', after: 'New Name' },
        }),
      }),
    );
  });

  test('returns 400 on a non-numeric id', async () => {
    const res = await request(makeApp())
      .put('/api/pipelines/not-a-number')
      .set('Authorization', makeBearer())
      .send({ name: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid pipeline id/);
    expect(prisma.pipeline.update).not.toHaveBeenCalled();
  });

  test('cross-tenant id returns 404 — tenant isolation', async () => {
    // findFirst's tenant-scoped where clause returns null for a foreign row
    prisma.pipeline.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/pipelines/9999')
      .set('Authorization', makeBearer())
      .send({ name: 'Cross-tenant attempt' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Pipeline not found/);
    expect(prisma.pipeline.update).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id — delete pipeline (admin-only, #527) ────────────────────

describe('DELETE /:id — delete pipeline', () => {
  test('deletes a non-default pipeline with no deals, returns success + emits DELETE audit (#568)', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 60, name: 'To Delete', isDefault: false, tenantId: 1,
    });
    prisma.deal.count.mockResolvedValue(0); // no deals attached
    prisma.pipeline.delete.mockResolvedValue({ id: 60 });

    const res = await request(makeApp())
      .delete('/api/pipelines/60')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.pipeline.delete).toHaveBeenCalledWith({ where: { id: 60 } });
    // #568 audit emitted with the pre-delete name preserved in details
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock).toHaveBeenCalledWith(
      'Pipeline', 'DELETE', 60, 7, 1,
      expect.objectContaining({ name: 'To Delete' }),
    );
  });

  test('refuses to delete the CURRENT default — 400 with promote-another guidance', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 70, name: 'My Default', isDefault: true, tenantId: 1,
    });

    const res = await request(makeApp())
      .delete('/api/pipelines/70')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot delete the default pipeline/);
    expect(res.body.error).toMatch(/Set another pipeline as default first/);
    expect(prisma.pipeline.delete).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  test('refuses to delete a pipeline with deals attached — 400 with deal-count in error', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 80, name: 'Has Deals', isDefault: false, tenantId: 1,
    });
    prisma.deal.count.mockResolvedValue(7);

    const res = await request(makeApp())
      .delete('/api/pipelines/80')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot delete pipeline with 7 deal\(s\)/);
    expect(prisma.pipeline.delete).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

// ── POST /:id/set-default — atomically swap the default ─────────────────

describe('POST /:id/set-default — promote a pipeline to default', () => {
  test('demotes prior default + promotes target inside a single transaction', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 90, name: 'Become Default', isDefault: false, tenantId: 1,
    });
    prisma.pipeline.updateMany.mockResolvedValue({ count: 1 });
    prisma.pipeline.update.mockResolvedValue({
      id: 90, name: 'Become Default', isDefault: true, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/pipelines/90/set-default')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    // Demote step ran FIRST, then the target was promoted
    expect(prisma.pipeline.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isDefault: true },
      data: { isDefault: false },
    });
    expect(prisma.pipeline.update).toHaveBeenCalledWith({
      where: { id: 90 },
      data: { isDefault: true },
    });
    // The transaction wrapper was used (single atomic step)
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// ── GET /:id/deals — list deals filed against a pipeline ────────────────

describe('GET /:id/deals — pipeline deal list', () => {
  test('returns tenant-scoped deals with contact + owner relations included', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 100, name: 'Sales', isDefault: true, tenantId: 1,
    });
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'Acme Deal', pipelineId: 100, tenantId: 1,
        contact: { id: 1, name: 'A', email: 'a@example.com', company: 'Acme' },
        owner:   { id: 7, name: 'Owner', email: 'o@example.com' } },
    ]);

    const res = await request(makeApp())
      .get('/api/pipelines/100/deals')
      .set('Authorization', makeBearer({ role: 'USER' })); // GET is open to USER

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].contact).toEqual(expect.objectContaining({ name: 'A' }));
    expect(res.body[0].owner).toEqual(expect.objectContaining({ id: 7 }));
    // Tenant-scoped read + include shape
    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, pipelineId: 100 },
      orderBy: { createdAt: 'desc' },
      include: {
        contact: { select: { id: true, name: true, email: true, company: true } },
        owner:   { select: { id: true, name: true, email: true } },
      },
    });
  });

  test('non-existent / cross-tenant pipeline returns 404 without leaking the foreign row', async () => {
    prisma.pipeline.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/pipelines/9999/deals')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Pipeline not found/);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });
});

// ── GET /:id/stats — aggregate deal-count + amount by stage ─────────────

describe('GET /:id/stats — aggregate stats', () => {
  test('returns { totalDeals, totalValue, byStage } envelope aggregated from prisma.deal.groupBy', async () => {
    prisma.pipeline.findFirst.mockResolvedValue({
      id: 110, name: 'Sales', isDefault: true, tenantId: 1,
    });
    prisma.deal.groupBy.mockResolvedValue([
      { stage: 'lead',     _count: { _all: 4 }, _sum: { amount: 1000 } },
      { stage: 'proposal', _count: { _all: 2 }, _sum: { amount: 5000 } },
      { stage: 'won',      _count: { _all: 1 }, _sum: { amount: 9000 } },
    ]);

    const res = await request(makeApp())
      .get('/api/pipelines/110/stats')
      .set('Authorization', makeBearer({ role: 'USER' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pipelineId: 110,
      pipelineName: 'Sales',
      totalDeals: 7,        // 4 + 2 + 1
      totalValue: 15000,    // 1000 + 5000 + 9000
      byStage: [
        { stage: 'lead',     count: 4, value: 1000 },
        { stage: 'proposal', count: 2, value: 5000 },
        { stage: 'won',      count: 1, value: 9000 },
      ],
    });
    expect(prisma.deal.groupBy).toHaveBeenCalledWith({
      by: ['stage'],
      where: { tenantId: 1, pipelineId: 110 },
      _count: { _all: true },
      _sum: { amount: true },
    });
  });
});
