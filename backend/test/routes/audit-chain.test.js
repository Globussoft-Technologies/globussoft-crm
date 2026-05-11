// @ts-check
/**
 * Route-level tests for backend/routes/audit.js — the #558 strict hash-chain
 * tamper-evidence trail.
 *
 * What this file pins
 * ───────────────────
 *   1. GET  /api/audit/verify   — strict envelope: chainLength === totalRows,
 *                                  unhashedRows reported, brokenAt + reason
 *                                  populated when ANY row has a null hash.
 *                                  ADMIN-only (MANAGER/USER → 403).
 *   2. POST /api/audit/backfill — admin-only, tenant-scoped. Idempotent on
 *                                  a clean run; 409 with conflictRowId when
 *                                  existing hashes disagree with recomputation.
 *                                  MANAGER/USER → 403.
 *
 * Test pattern mirrors audit-viewer.test.js: patch the prisma singleton with
 * vi.fn() BEFORE requiring the router, mount on a bare express app with
 * supertest, sign real HS256 JWTs against the dev-fallback secret so the
 * actual verifyToken + verifyRole middleware run unmodified.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { computeHash } from '../../lib/audit.js';

// Patch BEFORE requiring the router.
prisma.auditLog = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

const auditRouter = requireCJS('../../routes/audit');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit', auditRouter);
  return app;
}

function tokenFor(role, tenantId) {
  return jwt.sign(
    { userId: 1, tenantId: tenantId ?? 1, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function buildValidChain(tenantId, n) {
  const rows = [];
  let lastHash = null;
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(Date.UTC(2026, 3, i + 1));
    const prevHash = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
    const row = {
      id: i + 1,
      action: 'CREATE',
      entity: 'Contact',
      entityId: 1000 + i,
      userId: 5,
      details: JSON.stringify({ i }),
      createdAt,
      prevHash,
      hash: null,
    };
    row.hash = computeHash(prevHash, {
      tenantId,
      entity: row.entity, action: row.action,
      entityId: row.entityId, userId: row.userId,
      details: row.details, createdAt: createdAt.toISOString(),
    });
    lastHash = row.hash;
    rows.push(row);
  }
  return rows;
}

beforeAll(() => {
  prisma.revokedToken = prisma.revokedToken || {};
  prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
});

beforeEach(() => {
  prisma.auditLog.findMany.mockReset();
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.update.mockReset();
  prisma.auditLog.update.mockResolvedValue({});
});

describe('GET /api/audit/verify — strict envelope', () => {
  test('clean chain → integrityVerified=true, chainLength === totalRows, reason=null', async () => {
    const rows = buildValidChain(1, 4);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const res = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(200);
    expect(res.body.integrityVerified).toBe(true);
    expect(res.body.chainLength).toBe(4);
    expect(res.body.totalRows).toBe(4);
    expect(res.body.unhashedRows).toBe(0);
    expect(res.body.brokenAt).toBeNull();
    expect(res.body.reason).toBeNull();
    expect(typeof res.body.lastVerifiedAt).toBe('string');
  });

  test('null-hash legacy row → integrityVerified=false, brokenAt + reason populated', async () => {
    // 1 legacy + 2 chained rows. Strict semantics flip what was a false-green
    // (chainLength=2, integrityVerified=true) into a true negative.
    const stale = {
      id: 99, action: 'CREATE', entity: 'X', entityId: 1, userId: 1,
      details: null, createdAt: new Date(Date.UTC(2026, 0, 1)),
      prevHash: null, hash: null,
    };
    const chained = buildValidChain(1, 2);
    prisma.auditLog.findMany.mockResolvedValueOnce([stale, ...chained]);
    const res = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(200);
    expect(res.body.integrityVerified).toBe(false);
    expect(res.body.brokenAt).toBe(99);
    expect(res.body.reason).toMatch(/null hash/i);
    expect(res.body.totalRows).toBe(3);
    expect(res.body.unhashedRows).toBe(1);
  });

  test('hash mismatch (row content tampered) → brokenAt + reason populated', async () => {
    const rows = buildValidChain(1, 3);
    // Mutate details WITHOUT updating .hash → recomputed != stored.
    rows[1].details = JSON.stringify({ evil: true });
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const res = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.body.integrityVerified).toBe(false);
    expect(res.body.brokenAt).toBe(rows[1].id);
    expect(res.body.reason).toMatch(/hash mismatch/i);
  });

  test('prevHash mismatch → brokenAt + reason populated', async () => {
    const rows = buildValidChain(1, 3);
    rows[1].prevHash = 'NOT-THE-ACTUAL-PREV';
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const res = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.body.integrityVerified).toBe(false);
    expect(res.body.brokenAt).toBe(rows[1].id);
    expect(res.body.reason).toMatch(/prevHash mismatch/i);
  });

  test('MANAGER token → 403 RBAC_DENIED on /verify', async () => {
    const res = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('USER token → 403 RBAC_DENIED on /verify', async () => {
    const res = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });

  test('missing Authorization → 401 on /verify', async () => {
    const res = await request(makeApp()).get('/api/audit/verify');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/audit/backfill — admin-only, tenant-scoped, idempotent', () => {
  test('fully unchained tenant → 200 with updatedRows count, scoped to caller tenant', async () => {
    // Tenant 7's rows have null hashes; the route must call findMany with
    // where.tenantId === 7 (NOT 1) and run update for every row.
    //
    // v3.7.5 — backfill now snapshots maxId via findFirst before findMany,
    // and findMany's where clause carries an `id: { lte: maxIdAtStart }`
    // ceiling. Mock findFirst with the chain's tail id so the ceiling
    // asserts a concrete value rather than the empty-chain default of 0.
    const unchainedRows = buildValidChain(7, 3).map(r => ({ ...r, prevHash: null, hash: null }));
    const tailId = unchainedRows[unchainedRows.length - 1].id;
    prisma.auditLog.findFirst.mockResolvedValueOnce({ id: tailId });
    prisma.auditLog.findMany.mockResolvedValueOnce(unchainedRows);
    const res = await request(makeApp())
      .post('/api/audit/backfill')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 7)}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(7);
    expect(res.body.walkedRows).toBe(3);
    expect(res.body.updatedRows).toBe(3);
    expect(res.body.skippedRows).toBe(0);
    expect(typeof res.body.backfilledAt).toBe('string');
    expect(prisma.auditLog.findFirst.mock.calls[0][0].where).toEqual({ tenantId: 7 });
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 7,
      id: { lte: tailId },
    });
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(3);
  });

  test('already-chained tenant → 200 with updatedRows=0 (idempotent)', async () => {
    const rows = buildValidChain(1, 4);
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const res = await request(makeApp())
      .post('/api/audit/backfill')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(200);
    expect(res.body.updatedRows).toBe(0);
    expect(res.body.skippedRows).toBe(4);
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  test('post-hash tampering → 409 with conflictRowId', async () => {
    const rows = buildValidChain(1, 3);
    rows[1].hash = 'b'.repeat(64); // forge stored hash mid-chain
    prisma.auditLog.findMany.mockResolvedValueOnce(rows);
    const res = await request(makeApp())
      .post('/api/audit/backfill')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(409);
    expect(res.body.conflictRowId).toBe(rows[1].id);
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason).toMatch(/existing chain disagrees/i);
  });

  test('MANAGER token → 403 RBAC_DENIED on /backfill', async () => {
    const res = await request(makeApp())
      .post('/api/audit/backfill')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('USER token → 403 RBAC_DENIED on /backfill', async () => {
    const res = await request(makeApp())
      .post('/api/audit/backfill')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });

  test('missing Authorization → 401 on /backfill', async () => {
    const res = await request(makeApp()).post('/api/audit/backfill');
    expect(res.status).toBe(401);
  });
});

describe('audit chain — multi-tenant isolation', () => {
  test('tampering in tenant A does not flag tenant B', async () => {
    // Tenant A: build a chain, tamper one row → /verify says broken.
    // Tenant B: build a CLEAN chain → /verify says clean. Two separate
    // calls to the route via different tokens; each sees only its tenant's
    // rows because findMany.where.tenantId scopes the query.
    const tamperedA = buildValidChain(1, 3);
    tamperedA[1].hash = 'f'.repeat(64);

    const cleanB = buildValidChain(2, 3);

    prisma.auditLog.findMany
      .mockResolvedValueOnce(tamperedA)
      .mockResolvedValueOnce(cleanB);

    const resA = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(resA.body.integrityVerified).toBe(false);
    expect(resA.body.brokenAt).toBe(tamperedA[1].id);
    // The findMany for tenant A's verify was scoped to tenantId=1.
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ tenantId: 1 });

    const resB = await request(makeApp())
      .get('/api/audit/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', 2)}`);
    expect(resB.body.integrityVerified).toBe(true);
    expect(resB.body.brokenAt).toBeNull();
    expect(prisma.auditLog.findMany.mock.calls[1][0].where).toEqual({ tenantId: 2 });
  });
});
