// @ts-check
/**
 * Unit tests for backend/routes/sandbox.js — pins the SandboxSnapshot CRUD +
 * destructive restore/reset surface that backs the Settings → Sandbox page.
 *
 * Why this file exists
 * ────────────────────
 * sandbox.js is a 452-LOC route surface that encodes several historical
 * contracts which were previously untested at the vitest layer:
 *   - #527 (CRIT-02) — destructive WRITES (DELETE / restore / reset) are
 *                      admin-only via verifyRole(['ADMIN']). LIST + GET +
 *                      CREATE + DOWNLOAD stay open to any authenticated
 *                      tenant member (analyst can take a snapshot, only the
 *                      admin can blow it away or restore from it).
 *   - #550          — DELETE → 204 No Content (empty body). The restore +
 *                      reset endpoints return the v3.4.x { status, code, ... }
 *                      envelope ('SNAPSHOT_RESTORED' / 'TENANT_WIPED').
 *   - reset safety  — POST /reset rejects 400 unless the body carries
 *                      { confirm: 'DELETE_EVERYTHING' } verbatim. Misspelled
 *                      / missing confirm token is a 400 without wiping.
 *   - tenant isolation — every read filters on req.user.tenantId via
 *                      findFirst (NOT findUnique). Cross-tenant id lookups
 *                      return 404, never the foreign row's data.
 *   - corrupted JSON — POST /:id/restore rejects 400 when snap.data is
 *                      unparseable JSON (defense-in-depth: stored data
 *                      should always be a JSON.stringify result, but a
 *                      bad migration / direct DB edit could break that).
 *   - id parsing    — every /:id endpoint rejects non-numeric ids with 400
 *                      BEFORE touching prisma. parseInt('foo') is NaN.
 *
 * What this file pins (30 cases across 14 describe blocks — extended
 * 2026-05-25 from 15 → 30 to lift c8 coverage from 11.72% lines on the
 * 452-LOC route. New cases hit: 500 error envelopes on every endpoint,
 * non-numeric / not-found edge cases on download + delete + restore,
 * RBAC enforcement on restore + reset, legacy blob shape fallback
 * (data || blob), safeStripIds on quote/estimate line items, full-scope
 * restore wiring across all 13 models, sizes-aggregate fallback when
 * the raw query returns a partial map.)
 * ───────────────────────────────────────────────────────
 *   1. GET /            — tenant-scoped list with sizeBytes attached per row.
 *   2. GET /            — empty-list short-circuits the raw-query and
 *                          returns []. (ids.length === 0 branch)
 *   3. POST /           — captures snapshot, returns 201 + envelope with
 *                          sizeBytes; 13 prisma findMany calls fire
 *                          (the modeled scope).
 *   4. POST /           — rejects missing/empty name with 400.
 *   5. POST /           — non-string name (numeric) also 400 — typeof guard.
 *   6. GET /:id         — happy path returns metadata + sizeBytes, no data
 *                          field leaked.
 *   7. GET /:id         — non-numeric id returns 400 INVALID_ID without
 *                          touching prisma.
 *   8. GET /:id         — cross-tenant id returns 404 (tenant-isolation).
 *   9. GET /:id/download — happy path streams JSON with Content-Disposition
 *                          attachment header; safeName scrubs special chars.
 *  10. DELETE /:id      — happy admin delete returns 204 No Content (#550),
 *                          empty body.
 *  11. DELETE /:id      — non-ADMIN role rejected with 403 (#527).
 *  12. POST /:id/restore — happy path wipes-then-restores, returns
 *                          { status:'ok', code:'SNAPSHOT_RESTORED', restored }.
 *  13. POST /:id/restore — corrupted snapshot data (invalid JSON) → 400
 *                          BEFORE the destructive wipe runs.
 *  14. POST /reset      — rejects 400 unless body.confirm ===
 *                          'DELETE_EVERYTHING'. Misspelled / missing token
 *                          does NOT wipe.
 *  15. POST /reset      — happy admin reset wipes all tenant scope, returns
 *                          { status:'ok', code:'TENANT_WIPED', tenantId } (#550).
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/pipelines.test.js — prisma singleton patch +
 * real JWT bearer signed with config/secrets.JWT_SECRET so verifyToken
 * (real middleware) + verifyRole(['ADMIN']) (real middleware) both pass.
 * No external lib/service self-mocking needed (route only touches prisma).
 * The Prisma.sql raw-query branch for size lookup is exercised by stubbing
 * prisma.$queryRaw directly.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.

prisma.sandboxSnapshot = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

// The 13 tenant-scope models the create endpoint dumps:
const scopeModels = [
  'contact', 'deal', 'activity', 'task', 'invoice',
  'estimate', 'estimateLineItem', 'contract', 'quote', 'quoteLineItem',
  'pipeline', 'pipelineStage', 'emailMessage', 'travelQuote',
];
for (const m of scopeModels) {
  prisma[m] = prisma[m] || {};
  prisma[m].findMany = vi.fn();
  prisma[m].deleteMany = vi.fn();
  prisma[m].createMany = vi.fn();
}

// $queryRaw — used to read OCTET_LENGTH(data) per snapshot for size info.
prisma.$queryRaw = vi.fn();

// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Use the SAME JWT_SECRET that verifyToken will use — by reaching into the
// already-cached config/secrets module. Matches the canonical pattern from
// backend/test/routes/pipelines.test.js.
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

const sandboxRouter = requireCJS('../../routes/sandbox');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sandbox', sandboxRouter);
  return app;
}

beforeEach(() => {
  prisma.sandboxSnapshot.findMany.mockReset();
  prisma.sandboxSnapshot.findFirst.mockReset();
  prisma.sandboxSnapshot.create.mockReset();
  prisma.sandboxSnapshot.delete.mockReset();
  prisma.$queryRaw.mockReset();
  for (const m of scopeModels) {
    prisma[m].findMany.mockReset();
    prisma[m].deleteMany.mockReset();
    prisma[m].createMany.mockReset();
    // Default: empty list / 0 count for every scope model.
    prisma[m].findMany.mockResolvedValue([]);
    prisma[m].deleteMany.mockResolvedValue({ count: 0 });
    prisma[m].createMany.mockResolvedValue({ count: 0 });
  }
});

// ── GET / — list snapshots ────────────────────────────────────────────

describe('GET / — list sandbox snapshots', () => {
  test('returns tenant-scoped snapshots with sizeBytes attached per row', async () => {
    prisma.sandboxSnapshot.findMany.mockResolvedValue([
      { id: 11, name: 'Pre-migration', description: 'Before #123', userId: 7, createdAt: new Date('2026-05-20') },
      { id: 12, name: 'Daily',         description: null,        userId: 7, createdAt: new Date('2026-05-21') },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      { id: 11, size: 4096 },
      { id: 12, size: 2048 },
    ]);

    const res = await request(makeApp())
      .get('/api/sandbox')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 11, name: 'Pre-migration', sizeBytes: 4096 }));
    expect(res.body[1]).toEqual(expect.objectContaining({ id: 12, name: 'Daily', sizeBytes: 2048 }));

    // Tenant-scoped findMany — DESC ordering, data field excluded.
    expect(prisma.sandboxSnapshot.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        userId: true,
        createdAt: true,
      },
    });
  });

  test('empty list short-circuits the raw-size query (ids.length=0 branch)', async () => {
    prisma.sandboxSnapshot.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/sandbox')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // The OCTET_LENGTH raw query should NOT have been issued for an empty list
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

// ── POST / — create snapshot ──────────────────────────────────────────

describe('POST / — capture a new snapshot', () => {
  test('captures tenant data + persists JSON blob, returns 201 with sizeBytes envelope', async () => {
    // Seed one of the 13 model lists so the resulting JSON blob is non-trivial.
    prisma.contact.findMany.mockResolvedValue([
      { id: 1, name: 'Alice', email: 'a@example.com', tenantId: 1 },
      { id: 2, name: 'Bob',   email: 'b@example.com', tenantId: 1 },
    ]);
    prisma.sandboxSnapshot.create.mockResolvedValue({
      id: 42,
      name: 'Test Snap',
      createdAt: new Date('2026-05-25T00:00:00Z'),
    });

    const res = await request(makeApp())
      .post('/api/sandbox')
      .set('Authorization', makeBearer())
      .send({ name: 'Test Snap', description: 'Manual capture' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: 42,
      name: 'Test Snap',
    }));
    expect(typeof res.body.sizeBytes).toBe('number');
    expect(res.body.sizeBytes).toBeGreaterThan(0);

    // Verify the persist call shape — tenant-scoped, userId from JWT, data is JSON.
    expect(prisma.sandboxSnapshot.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.sandboxSnapshot.create.mock.calls[0][0];
    expect(createArg.data).toEqual(expect.objectContaining({
      name: 'Test Snap',
      description: 'Manual capture',
      tenantId: 1,
      userId: 7,
    }));
    expect(typeof createArg.data.data).toBe('string');
    const blob = JSON.parse(createArg.data.data);
    expect(blob.version).toBe(1);
    expect(blob.tenantId).toBe(1);
    expect(blob.counts.contacts).toBe(2);
    expect(blob.data.contacts).toHaveLength(2);

    // All 13 scope models were queried with tenant scope (12 direct + 1 nested).
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1 },
    }));
    expect(prisma.estimateLineItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { estimate: { tenantId: 1 } },
    }));
  });

  test('rejects missing name with 400 without touching the create path', async () => {
    const res = await request(makeApp())
      .post('/api/sandbox')
      .set('Authorization', makeBearer())
      .send({ description: 'no name here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/);
    expect(prisma.sandboxSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('rejects non-string name (numeric) with 400 — typeof guard', async () => {
    const res = await request(makeApp())
      .post('/api/sandbox')
      .set('Authorization', makeBearer())
      .send({ name: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/);
    expect(prisma.sandboxSnapshot.create).not.toHaveBeenCalled();
  });
});

// ── GET /:id — single snapshot metadata ───────────────────────────────

describe('GET /:id — snapshot metadata', () => {
  test('returns tenant-scoped metadata with sizeBytes, never leaking the data field', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 33,
      name: 'Daily backup',
      description: null,
      userId: 7,
      createdAt: new Date('2026-05-22'),
    });
    prisma.$queryRaw.mockResolvedValue([{ size: 8192 }]);

    const res = await request(makeApp())
      .get('/api/sandbox/33')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: 33,
      name: 'Daily backup',
      sizeBytes: 8192,
    }));
    // The full `data` blob must NOT be in the response.
    expect(res.body.data).toBeUndefined();
    expect(prisma.sandboxSnapshot.findFirst).toHaveBeenCalledWith({
      where: { id: 33, tenantId: 1 },
      select: {
        id: true,
        name: true,
        description: true,
        userId: true,
        createdAt: true,
      },
    });
  });

  test('non-numeric id returns 400 INVALID_ID without touching prisma', async () => {
    const res = await request(makeApp())
      .get('/api/sandbox/not-a-number')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid snapshot id/);
    expect(prisma.sandboxSnapshot.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant id returns 404 — tenant isolation', async () => {
    // findFirst's tenant-scoped where clause returns null for a foreign row.
    prisma.sandboxSnapshot.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/sandbox/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Snapshot not found/);
    // The raw OCTET_LENGTH query MUST NOT run when the snapshot isn't found.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

// ── GET /:id/download — full JSON attachment ──────────────────────────

describe('GET /:id/download — JSON attachment', () => {
  test('streams snap.data with attachment Content-Disposition + safe filename', async () => {
    const dataPayload = JSON.stringify({ version: 1, hello: 'world' });
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 55,
      name: 'Snap/With/Slashes!*', // tests the filename sanitiser
      description: null,
      userId: 7,
      createdAt: new Date(),
      tenantId: 1,
      data: dataPayload,
    });

    const res = await request(makeApp())
      .get('/api/sandbox/55/download')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    // The route replaces non [a-z0-9_-] (case-insensitive) with _
    // Input "Snap/With/Slashes!*" → 3 disallowed chars (/, /, !, *) become 3 underscores
    expect(res.headers['content-disposition']).toMatch(/sandbox_Snap_With_Slashes___55\.json/);
    expect(res.text).toBe(dataPayload);
  });
});

// ── DELETE /:id — admin-only delete ───────────────────────────────────

describe('DELETE /:id — admin-only delete', () => {
  test('deletes the snapshot and returns 204 No Content (#550)', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 77,
      name: 'Old snap',
      tenantId: 1,
    });
    prisma.sandboxSnapshot.delete.mockResolvedValue({ id: 77 });

    const res = await request(makeApp())
      .delete('/api/sandbox/77')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});       // empty body
    expect(res.text).toBe('');           // truly no payload
    expect(prisma.sandboxSnapshot.delete).toHaveBeenCalledWith({ where: { id: 77 } });
  });

  test('non-ADMIN role is rejected with 403 (#527 admin-only destructive)', async () => {
    const res = await request(makeApp())
      .delete('/api/sandbox/77')
      .set('Authorization', makeBearer({ role: 'USER' }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.sandboxSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.sandboxSnapshot.delete).not.toHaveBeenCalled();
  });
});

// ── POST /:id/restore — destructive restore (admin-only) ──────────────

describe('POST /:id/restore — destructive restore', () => {
  test('wipes-then-restores tenant data and returns the SNAPSHOT_RESTORED envelope', async () => {
    const blob = {
      version: 1,
      tenantId: 1,
      counts: { contacts: 2, pipelines: 1 },
      data: {
        contacts: [
          { id: 1, name: 'Alice', tenantId: 1 },
          { id: 2, name: 'Bob', tenantId: 1 },
        ],
        pipelines: [
          { id: 99, name: 'Default', isDefault: true, tenantId: 1 },
        ],
        // Other scope models intentionally empty for this case.
      },
    };
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 88,
      tenantId: 1,
      data: JSON.stringify(blob),
    });
    prisma.pipeline.createMany.mockResolvedValue({ count: 1 });
    prisma.contact.createMany.mockResolvedValue({ count: 2 });

    const res = await request(makeApp())
      .post('/api/sandbox/88/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ok',
      code: 'SNAPSHOT_RESTORED',
      restored: expect.objectContaining({
        contacts: 2,
        pipelines: 1,
      }),
    }));

    // Wipe ran for every scope model (deleteMany was called for each).
    expect(prisma.contact.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.pipeline.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.estimateLineItem.deleteMany).toHaveBeenCalledWith({
      where: { estimate: { tenantId: 1 } },
    });

    // Restore ran for non-empty arrays, tenant-id force-applied.
    expect(prisma.pipeline.createMany).toHaveBeenCalledWith({
      data: [{ id: 99, name: 'Default', isDefault: true, tenantId: 1 }],
    });
    expect(prisma.contact.createMany).toHaveBeenCalledWith({
      data: [
        { id: 1, name: 'Alice', tenantId: 1 },
        { id: 2, name: 'Bob', tenantId: 1 },
      ],
      skipDuplicates: true,
    });
  });

  test('corrupted snapshot data (invalid JSON) returns 400 BEFORE the destructive wipe runs', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 89,
      tenantId: 1,
      data: '{ not valid json',   // intentionally malformed
    });

    const res = await request(makeApp())
      .post('/api/sandbox/89/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/corrupted/i);
    // Critically — the wipe MUST NOT have run on a corrupted snapshot.
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
    expect(prisma.deal.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pipeline.deleteMany).not.toHaveBeenCalled();
  });
});

// ── POST /reset — admin-only destructive wipe ─────────────────────────

describe('POST /reset — destructive tenant wipe', () => {
  test('rejects 400 unless body.confirm === "DELETE_EVERYTHING" — nothing wiped on missing token', async () => {
    const res1 = await request(makeApp())
      .post('/api/sandbox/reset')
      .set('Authorization', makeBearer())
      .send({});                    // missing confirm
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/Safety check failed/);

    const res2 = await request(makeApp())
      .post('/api/sandbox/reset')
      .set('Authorization', makeBearer())
      .send({ confirm: 'delete_everything' });   // wrong case
    expect(res2.status).toBe(400);

    const res3 = await request(makeApp())
      .post('/api/sandbox/reset')
      .set('Authorization', makeBearer())
      .send({ confirm: 'YES' });    // wrong token
    expect(res3.status).toBe(400);

    // Critically — no deleteMany should have run on any of the 3 bad-token attempts.
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
    expect(prisma.deal.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pipeline.deleteMany).not.toHaveBeenCalled();
  });

  test('happy admin reset wipes all tenant scope, returns TENANT_WIPED envelope (#550)', async () => {
    const res = await request(makeApp())
      .post('/api/sandbox/reset')
      .set('Authorization', makeBearer())
      .send({ confirm: 'DELETE_EVERYTHING' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ok',
      code: 'TENANT_WIPED',
      tenantId: 1,
    }));

    // The wipe ran for every model in scope, tenant-scoped.
    expect(prisma.activity.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.task.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.estimateLineItem.deleteMany).toHaveBeenCalledWith({
      where: { estimate: { tenantId: 1 } },
    });
    expect(prisma.estimate.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.quoteLineItem.deleteMany).toHaveBeenCalledWith({
      where: { quote: { tenantId: 1 } },
    });
    expect(prisma.quote.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.invoice.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.contract.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.deal.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.contact.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.pipelineStage.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
    expect(prisma.pipeline.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
  });

  test('non-ADMIN role is rejected with 403 — no wipe runs (#527)', async () => {
    const res = await request(makeApp())
      .post('/api/sandbox/reset')
      .set('Authorization', makeBearer({ role: 'MANAGER' }))
      .send({ confirm: 'DELETE_EVERYTHING' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    // No model wipe should have run when the role check rejects.
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pipeline.deleteMany).not.toHaveBeenCalled();
  });

  test('500 envelope when wipe throws — reset error path', async () => {
    prisma.activity.deleteMany.mockRejectedValueOnce(new Error('FK violation on Activity'));
    const res = await request(makeApp())
      .post('/api/sandbox/reset')
      .set('Authorization', makeBearer())
      .send({ confirm: 'DELETE_EVERYTHING' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Reset failed/);
    expect(res.body.error).toMatch(/FK violation on Activity/);
  });
});

// ── Extended coverage: error envelopes + RBAC + deep restore paths ───

describe('GET / — list error envelope (500 branch)', () => {
  test('returns 500 with "Failed to list snapshots" when findMany throws', async () => {
    prisma.sandboxSnapshot.findMany.mockRejectedValueOnce(new Error('DB unreachable'));
    const res = await request(makeApp())
      .get('/api/sandbox')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to list snapshots/);
  });

  test('rows missing from size aggregate map fall back to sizeBytes=0', async () => {
    // findMany returns 3 rows, but the OCTET_LENGTH aggregate only returns 1.
    prisma.sandboxSnapshot.findMany.mockResolvedValue([
      { id: 21, name: 'A', description: null, userId: 7, createdAt: new Date() },
      { id: 22, name: 'B', description: null, userId: 7, createdAt: new Date() },
      { id: 23, name: 'C', description: null, userId: 7, createdAt: new Date() },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      { id: 22, size: 1024 },
    ]);

    const res = await request(makeApp())
      .get('/api/sandbox')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    // Map sets sizes[r.id]; rows without an entry fall through to sizes[s.id] || 0
    expect(res.body.find((r) => r.id === 21).sizeBytes).toBe(0);
    expect(res.body.find((r) => r.id === 22).sizeBytes).toBe(1024);
    expect(res.body.find((r) => r.id === 23).sizeBytes).toBe(0);
  });
});

describe('POST / — create error envelope (500 branch)', () => {
  test('returns 500 with "Failed to create snapshot" when persist throws', async () => {
    prisma.sandboxSnapshot.create.mockRejectedValueOnce(new Error('Disk full'));
    const res = await request(makeApp())
      .post('/api/sandbox')
      .set('Authorization', makeBearer())
      .send({ name: 'OK Snap' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to create snapshot/);
  });

  test('description omitted → persists with description=null (not undefined)', async () => {
    prisma.sandboxSnapshot.create.mockResolvedValue({
      id: 101,
      name: 'NoDesc',
      createdAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/sandbox')
      .set('Authorization', makeBearer())
      .send({ name: 'NoDesc' });

    expect(res.status).toBe(201);
    const createArg = prisma.sandboxSnapshot.create.mock.calls[0][0];
    // `description: description || null` short-circuits undefined to null.
    expect(createArg.data.description).toBeNull();
  });
});

describe('GET /:id — error + edge envelopes', () => {
  test('returns 500 with "Failed to fetch snapshot" when findFirst throws', async () => {
    prisma.sandboxSnapshot.findFirst.mockRejectedValueOnce(new Error('Connection lost'));
    const res = await request(makeApp())
      .get('/api/sandbox/12')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch snapshot/);
  });

  test('empty raw rows result → sizeBytes defaults to 0', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 44,
      name: 'Zero-size',
      description: null,
      userId: 7,
      createdAt: new Date(),
    });
    prisma.$queryRaw.mockResolvedValue([]); // no rows back from OCTET_LENGTH

    const res = await request(makeApp())
      .get('/api/sandbox/44')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.sizeBytes).toBe(0);
  });
});

describe('GET /:id/download — error + 404 + edge envelopes', () => {
  test('non-numeric id returns 400 without touching prisma', async () => {
    const res = await request(makeApp())
      .get('/api/sandbox/abc/download')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid snapshot id/);
    expect(prisma.sandboxSnapshot.findFirst).not.toHaveBeenCalled();
  });

  test('returns 404 when the snapshot is not found (cross-tenant or absent)', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/sandbox/9999/download')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Snapshot not found/);
  });

  test('null name falls back to "snapshot-<id>" in Content-Disposition filename', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 71,
      name: null, // exercises the `snap.name || ...` fallback
      description: null,
      userId: 7,
      createdAt: new Date(),
      tenantId: 1,
      data: '{}',
    });

    const res = await request(makeApp())
      .get('/api/sandbox/71/download')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    // safeName = (null || `snapshot-71`).replace(...)
    expect(res.headers['content-disposition']).toMatch(/sandbox_snapshot-71_71\.json/);
  });

  test('returns 500 with "Failed to download snapshot" when findFirst throws', async () => {
    prisma.sandboxSnapshot.findFirst.mockRejectedValueOnce(new Error('Boom'));
    const res = await request(makeApp())
      .get('/api/sandbox/5/download')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to download snapshot/);
  });
});

describe('DELETE /:id — edge + error envelopes', () => {
  test('non-numeric id returns 400 without touching prisma', async () => {
    const res = await request(makeApp())
      .delete('/api/sandbox/not-an-id')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid snapshot id/);
    expect(prisma.sandboxSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.sandboxSnapshot.delete).not.toHaveBeenCalled();
  });

  test('returns 404 when the snapshot is not found (tenant-isolation read)', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/sandbox/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Snapshot not found/);
    expect(prisma.sandboxSnapshot.delete).not.toHaveBeenCalled();
  });

  test('returns 500 with "Failed to delete snapshot" when delete throws', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({ id: 77, tenantId: 1 });
    prisma.sandboxSnapshot.delete.mockRejectedValueOnce(new Error('FK constraint'));

    const res = await request(makeApp())
      .delete('/api/sandbox/77')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to delete snapshot/);
  });
});

describe('POST /:id/restore — RBAC + edge + deep paths', () => {
  test('non-ADMIN role is rejected with 403 — no findFirst / wipe runs (#527)', async () => {
    const res = await request(makeApp())
      .post('/api/sandbox/12/restore')
      .set('Authorization', makeBearer({ role: 'MANAGER' }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.sandboxSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
  });

  test('non-numeric id returns 400 — guard fires before tenant lookup', async () => {
    const res = await request(makeApp())
      .post('/api/sandbox/foo/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid snapshot id/);
    expect(prisma.sandboxSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
  });

  test('returns 404 when snapshot not found — no wipe runs on missing source', async () => {
    prisma.sandboxSnapshot.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/sandbox/9999/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Snapshot not found/);
    // Critically — wipe MUST NOT run when the source snapshot doesn't exist.
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pipeline.deleteMany).not.toHaveBeenCalled();
  });

  test('legacy blob shape with top-level data fields (no nested data:{}) — fallback "data || blob"', async () => {
    // Some snapshots may have been written without the { data: { ... } } wrapper.
    // The route's `const data = blob.data || blob;` handles both shapes.
    const legacyBlob = {
      version: 1,
      tenantId: 1,
      // Top-level arrays, not nested under data:
      contacts: [{ id: 5, name: 'Legacy', tenantId: 1 }],
      pipelines: [],
    };
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 200,
      tenantId: 1,
      data: JSON.stringify(legacyBlob),
    });
    prisma.contact.createMany.mockResolvedValue({ count: 1 });

    const res = await request(makeApp())
      .post('/api/sandbox/200/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.restored.contacts).toBe(1);
    expect(prisma.contact.createMany).toHaveBeenCalledWith({
      data: [{ id: 5, name: 'Legacy', tenantId: 1 }],
      skipDuplicates: true,
    });
  });

  test('quoteLineItems + estimateLineItems use safeStripIds (id removed, FK ids preserved)', async () => {
    const blob = {
      version: 1,
      tenantId: 1,
      data: {
        estimateLineItems: [
          { id: 901, estimateId: 50, description: 'Widget', quantity: 2, unitPrice: 10 },
          { id: 902, estimateId: 51, description: 'Gadget', quantity: 1, unitPrice: 25 },
        ],
        quoteLineItems: [
          { id: 701, quoteId: 30, description: 'Service', quantity: 3, unitPrice: 100 },
        ],
      },
    };
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 250,
      tenantId: 1,
      data: JSON.stringify(blob),
    });
    prisma.estimateLineItem.createMany.mockResolvedValue({ count: 2 });
    prisma.quoteLineItem.createMany.mockResolvedValue({ count: 1 });

    const res = await request(makeApp())
      .post('/api/sandbox/250/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.restored.estimateLineItems).toBe(2);
    expect(res.body.restored.quoteLineItems).toBe(1);

    // safeStripIds removes `id` but PRESERVES estimateId / quoteId (FK relations).
    const estimateCall = prisma.estimateLineItem.createMany.mock.calls[0][0];
    expect(estimateCall.data).toEqual([
      { estimateId: 50, description: 'Widget', quantity: 2, unitPrice: 10 },
      { estimateId: 51, description: 'Gadget', quantity: 1, unitPrice: 25 },
    ]);
    // Critically — `id` is stripped (would otherwise collide with auto-increment).
    for (const row of estimateCall.data) {
      expect(row.id).toBeUndefined();
    }

    const quoteCall = prisma.quoteLineItem.createMany.mock.calls[0][0];
    expect(quoteCall.data).toEqual([
      { quoteId: 30, description: 'Service', quantity: 3, unitPrice: 100 },
    ]);
    expect(quoteCall.data[0].id).toBeUndefined();
  });

  test('full-scope restore wires all 13 model createMany calls + ordering — emailMessages, activities, tasks, etc.', async () => {
    const blob = {
      version: 1,
      tenantId: 1,
      data: {
        pipelines: [{ id: 1, name: 'Sales', tenantId: 1 }],
        pipelineStages: [{ id: 1, name: 'Lead', pipelineId: 1, tenantId: 1 }],
        contacts: [{ id: 1, name: 'A', tenantId: 1 }],
        deals: [{ id: 1, title: 'D1', contactId: 1, tenantId: 1 }],
        activities: [{ id: 1, type: 'note', contactId: 1, tenantId: 1 }],
        tasks: [{ id: 1, title: 'T1', tenantId: 1 }],
        invoices: [{ id: 1, contactId: 1, amount: 100, tenantId: 1 }],
        estimates: [{ id: 1, contactId: 1, tenantId: 1 }],
        contracts: [{ id: 1, contactId: 1, tenantId: 1 }],
        quotes: [{ id: 1, dealId: 1, tenantId: 1 }],
        emailMessages: [
          { id: 1, subject: 'Hi', from: 'a@x.com', tenantId: 1 },
          { id: 2, subject: 'Re: Hi', from: 'b@x.com', tenantId: 1 },
        ],
      },
    };
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 300, tenantId: 1, data: JSON.stringify(blob),
    });
    // Each createMany returns the row count for its slice.
    prisma.pipeline.createMany.mockResolvedValue({ count: 1 });
    prisma.pipelineStage.createMany.mockResolvedValue({ count: 1 });
    prisma.contact.createMany.mockResolvedValue({ count: 1 });
    prisma.deal.createMany.mockResolvedValue({ count: 1 });
    prisma.activity.createMany.mockResolvedValue({ count: 1 });
    prisma.task.createMany.mockResolvedValue({ count: 1 });
    prisma.invoice.createMany.mockResolvedValue({ count: 1 });
    prisma.estimate.createMany.mockResolvedValue({ count: 1 });
    prisma.contract.createMany.mockResolvedValue({ count: 1 });
    prisma.quote.createMany.mockResolvedValue({ count: 1 });
    prisma.emailMessage.createMany.mockResolvedValue({ count: 2 });

    const res = await request(makeApp())
      .post('/api/sandbox/300/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('SNAPSHOT_RESTORED');
    expect(res.body.restored).toEqual({
      contacts: 1,
      deals: 1,
      activities: 1,
      tasks: 1,
      invoices: 1,
      estimates: 1,
      estimateLineItems: 0,
      contracts: 1,
      quotes: 1,
      quoteLineItems: 0,
      pipelines: 1,
      pipelineStages: 1,
      emailMessages: 2,
    });
    // Every model's createMany was invoked exactly once.
    expect(prisma.emailMessage.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.activity.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.task.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.contract.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.deal.createMany).toHaveBeenCalledTimes(1);
    // Invoices + estimates use skipDuplicates (handles unique-constraint collisions).
    expect(prisma.invoice.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
    }));
    expect(prisma.estimate.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
    }));
  });

  test('returns 500 with "Restore failed: <msg>" when createMany throws mid-flight', async () => {
    const blob = {
      version: 1,
      tenantId: 1,
      data: {
        contacts: [{ id: 1, name: 'A', tenantId: 1 }],
      },
    };
    prisma.sandboxSnapshot.findFirst.mockResolvedValue({
      id: 400, tenantId: 1, data: JSON.stringify(blob),
    });
    prisma.contact.createMany.mockRejectedValueOnce(new Error('Unique violation on email'));

    const res = await request(makeApp())
      .post('/api/sandbox/400/restore')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Restore failed/);
    expect(res.body.error).toMatch(/Unique violation on email/);
  });
});
