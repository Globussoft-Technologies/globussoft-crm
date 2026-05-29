// @ts-check
/**
 * CRM polish — pin GET /api/sequences/stats contract.
 *
 * Issue context
 * ─────────────
 *   sequences.js is a 553-LOC route with no tenant-wide aggregate
 *   endpoint. The Marketing → Sequences dashboard needs a single
 *   KPI roundtrip ({total, byStatus, totalEnrollments, activeEnrollments,
 *   completedEnrollments, cancelledEnrollments, lastCreatedAt}) instead
 *   of N+1 queries.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant happy path: zeroed envelope + byStatus={active:0,
 *     inactive:0} + lastCreatedAt=null.
 *   - Happy path: 5 sequences (3 active, 2 inactive) + 10 enrollments
 *     spread across statuses → byStatus + enrollment counts correct.
 *   - activeEnrollments counts ONLY status='Active' (excludes Paused +
 *     Completed + Unenrolled).
 *   - lastCreatedAt picks the maximum Sequence.createdAt as ISO string.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId.
 *   - ?from/?to narrows the window via createdAt clauses on the prisma
 *     query (and propagates to the enrollment sub-where via sequence
 *     relation filter).
 *   - NO audit row written (read-only meta surface).
 *
 * Schema reality (verified against prisma/schema.prisma → models
 * Sequence + SequenceEnrollment lines 996, 1018):
 *   - Sequence has NO `status` column. byStatus is sourced from the
 *     isActive Boolean → keys 'active' (true) + 'inactive' (false).
 *   - SequenceEnrollment.status is a free String defaulting to "Active"
 *     (capitalised). Documented values: "Active", "Paused", "Completed",
 *     "Unenrolled" — see route handlers at /enrollments/:id/{pause,resume}
 *     + the DELETE handler that soft-cancels via status='Unenrolled'.
 *     cancelledEnrollments maps to "Unenrolled".
 *
 * Pattern reference: backend/test/routes/accounting-stats.test.js — patches
 * the prisma singleton with vi.fn() BEFORE requiring the router, drives
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.sequence = prisma.sequence || {};
prisma.sequence.findMany = vi.fn();
prisma.sequenceEnrollment = prisma.sequenceEnrollment || {};
prisma.sequenceEnrollment.count = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const sequencesRouter = requireCJS('../../routes/sequences');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sequences', sequencesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.sequence.findMany.mockReset();
  prisma.sequenceEnrollment.count.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/sequences/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/sequences/stats');
    expect(res.status).toBe(401);
    expect(prisma.sequence.findMany).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.sequence.findMany).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.sequence.findMany).not.toHaveBeenCalled();
    expect(prisma.sequenceEnrollment.count).not.toHaveBeenCalled();
  });

  test('empty-tenant happy path: zeroed envelope + byStatus={active:0,inactive:0} + lastCreatedAt=null', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);
    // 4 enrollment count calls (total + active + completed + cancelled).
    prisma.sequenceEnrollment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: { active: 0, inactive: 0 },
      totalEnrollments: 0,
      activeEnrollments: 0,
      completedEnrollments: 0,
      cancelledEnrollments: 0,
      lastCreatedAt: null,
    });
  });

  test('happy path: 5 sequences (3 active, 2 inactive) + 10 enrollments across statuses', async () => {
    prisma.sequence.findMany.mockResolvedValue([
      { id: 1, isActive: true,  createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true,  createdAt: new Date('2026-05-02T10:00:00Z') },
      { id: 3, isActive: true,  createdAt: new Date('2026-05-03T10:00:00Z') },
      { id: 4, isActive: false, createdAt: new Date('2026-05-04T10:00:00Z') },
      { id: 5, isActive: false, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);
    // total=10, active=6, completed=2, cancelled(Unenrolled)=2.
    // Paused (10 - 6 - 2 - 2 = 0 here) excluded from activeEnrollments.
    prisma.sequenceEnrollment.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(6)  // active
      .mockResolvedValueOnce(2)  // completed
      .mockResolvedValueOnce(2); // cancelled (Unenrolled)

    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({ active: 3, inactive: 2 });
    expect(res.body.totalEnrollments).toBe(10);
    expect(res.body.activeEnrollments).toBe(6);
    expect(res.body.completedEnrollments).toBe(2);
    expect(res.body.cancelledEnrollments).toBe(2);
  });

  test('activeEnrollments excludes completed + cancelled (only counts status="Active")', async () => {
    prisma.sequence.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    // 8 total enrollments: 3 Active, 3 Completed, 2 Unenrolled.
    prisma.sequenceEnrollment.count
      .mockResolvedValueOnce(8) // total
      .mockResolvedValueOnce(3) // active
      .mockResolvedValueOnce(3) // completed
      .mockResolvedValueOnce(2); // cancelled

    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.activeEnrollments).toBe(3);
    expect(res.body.activeEnrollments).toBeLessThan(res.body.totalEnrollments);

    // Verify each enrollment count call applied its expected status filter.
    const calls = prisma.sequenceEnrollment.count.mock.calls;
    expect(calls.length).toBe(4);
    expect(calls[0][0].where.status).toBeUndefined();          // total → no status filter
    expect(calls[1][0].where.status).toBe('Active');
    expect(calls[2][0].where.status).toBe('Completed');
    expect(calls[3][0].where.status).toBe('Unenrolled');
  });

  test('lastCreatedAt picks the maximum Sequence.createdAt as ISO string', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.sequence.findMany.mockResolvedValue([
      { id: 1, isActive: true,  createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true,  createdAt: newest }, // newest
      { id: 3, isActive: false, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.sequenceEnrollment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);
    prisma.sequenceEnrollment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const seqWhere = prisma.sequence.findMany.mock.calls[0][0].where;
    expect(seqWhere.tenantId).toBe(42);
    // Enrollment counts must scope through the sequence relation filter.
    const enrWhere = prisma.sequenceEnrollment.count.mock.calls[0][0].where;
    expect(enrWhere.sequence.tenantId).toBe(42);
  });

  test('?from/?to narrows the window via createdAt clauses on the prisma query', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);
    prisma.sequenceEnrollment.count.mockResolvedValue(0);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/sequences/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const seqWhere = prisma.sequence.findMany.mock.calls[0][0].where;
    expect(seqWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(seqWhere.createdAt.lte).toEqual(new Date(toIso));
    // Date window must propagate to enrollment sub-where too.
    const enrWhere = prisma.sequenceEnrollment.count.mock.calls[0][0].where;
    expect(enrWhere.sequence.createdAt.gte).toEqual(new Date(fromIso));
    expect(enrWhere.sequence.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.sequence.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    prisma.sequenceEnrollment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/sequences/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
