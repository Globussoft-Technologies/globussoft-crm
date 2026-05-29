// @ts-check
/**
 * Marketing polish — pin GET /api/landing-pages/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header -> 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope with byStatus={} + lastCreatedAt=null +
 *     conversionRate=null (totalViews=0 -> undefined division).
 *   - Happy path: mixed DRAFT/PUBLISHED/ARCHIVED -> byStatus + publishedCount
 *     + totalViews + totalConversions + conversionRate correct.
 *   - totalViews/totalConversions sum the visits/submissions columns
 *     defensively (null/undefined -> 0, no NaN poisoning).
 *   - conversionRate: half-up 4dp (e.g. 5/100 -> 0.05); null when
 *     totalViews=0 even if totalConversions=0 (would be 0/0).
 *   - lastCreatedAt: max(createdAt) across selected rows; ISO string.
 *   - Tenant isolation: prisma where.tenantId = req.user.tenantId on
 *     landingPage.findMany.
 *   - ?from / ?to narrows the window via createdAt gte/lte on the same
 *     findMany call.
 *   - byStatus omits empty buckets entirely (no "PUBLISHED: 0" noise).
 *   - NO audit row written (read-only meta surface).
 *
 * Schema notes (verified against prisma/schema.prisma:1752-1777)
 * ------------------------------------------------------------
 *   - LandingPage.status is String ("DRAFT"|"PUBLISHED"|"ARCHIVED"), NOT a bool.
 *   - LandingPage.visits is Int (mapped to "views" in the response).
 *   - LandingPage.submissions is Int (mapped to "conversions" in response).
 *   - No separate viewCount/conversions columns exist.
 *
 * Pattern reference: knowledge-base-stats.test.js — patches the prisma
 * singleton with vi.fn() BEFORE requiring the router, drives supertest
 * with HS256 JWTs signed against the dev-fallback secret. /stats endpoint
 * mounts explicit verifyToken so the 401-gate case can be exercised in
 * isolation without depending on a global guard.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.landingPage = prisma.landingPage || {};
prisma.landingPage.findMany = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// fieldFilter helpers may query this transitively at router require-time.
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const { router: lpRouter } = requireCJS('../../routes/landing_pages');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/landing-pages', lpRouter);
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
  prisma.landingPage.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/landing-pages/stats', () => {
  test('auth gate: missing Authorization header -> 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/landing-pages/stats');
    expect(res.status).toBe(401);
    expect(prisma.landingPage.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.landingPage.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.landingPage.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with byStatus={} + lastCreatedAt=null + conversionRate=null', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalPages: 0,
      byStatus: {},
      publishedCount: 0,
      totalViews: 0,
      totalConversions: 0,
      conversionRate: null,
      lastCreatedAt: null,
    });
  });

  test('happy path: 5 pages (3 PUBLISHED, 1 DRAFT, 1 ARCHIVED) -> byStatus + publishedCount + totals correct', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'PUBLISHED', visits: 100, submissions: 5, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'PUBLISHED', visits:  50, submissions: 2, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'PUBLISHED', visits:  25, submissions: 1, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'DRAFT',     visits:  10, submissions: 0, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'ARCHIVED',  visits:  15, submissions: 2, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPages).toBe(5);
    expect(res.body.byStatus).toEqual({ PUBLISHED: 3, DRAFT: 1, ARCHIVED: 1 });
    expect(res.body.publishedCount).toBe(3);
    expect(res.body.totalViews).toBe(200); // 100+50+25+10+15
    expect(res.body.totalConversions).toBe(10); // 5+2+1+0+2
    // conversionRate: 10/200 = 0.05 (half-up 4dp)
    expect(res.body.conversionRate).toBe(0.05);
    expect(res.body.lastCreatedAt).toBe(new Date('2026-05-05T10:00:00Z').toISOString());
  });

  test('totalViews/totalConversions sum defensively; null/undefined -> 0 (no NaN poisoning)', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'PUBLISHED', visits: null,      submissions: null,      createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'PUBLISHED', visits: undefined, submissions: undefined, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'DRAFT',     visits: 42,        submissions: 3,         createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(42);
    expect(res.body.totalConversions).toBe(3);
    expect(Number.isFinite(res.body.totalViews)).toBe(true);
    expect(Number.isFinite(res.body.totalConversions)).toBe(true);
  });

  test('conversionRate is null when totalViews=0 even if pages exist', async () => {
    // Three draft pages with zero traffic — conversionRate is undefined (0/0)
    // and should serialise as null, not NaN.
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'DRAFT', visits: 0, submissions: 0, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'DRAFT', visits: 0, submissions: 0, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(0);
    expect(res.body.totalConversions).toBe(0);
    expect(res.body.conversionRate).toBeNull();
  });

  test('conversionRate half-up 4dp: 1/3 -> 0.3333 (no float noise)', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'PUBLISHED', visits: 3, submissions: 1, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.conversionRate).toBe(0.3333);
  });

  test('lastCreatedAt: max(createdAt) ISO across selected rows', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'DRAFT',     visits: 0, submissions: 0, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'PUBLISHED', visits: 0, submissions: 0, createdAt: newest },
      { status: 'ARCHIVED',  visits: 0, submissions: 0, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const pageWhere = prisma.landingPage.findMany.mock.calls[0][0].where;
    expect(pageWhere.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via createdAt gte/lte clauses', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/landing-pages/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const pageWhere = prisma.landingPage.findMany.mock.calls[0][0].where;
    expect(pageWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(pageWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('byStatus omits empty buckets entirely (no "PUBLISHED: 0" noise)', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'DRAFT', visits: 0, submissions: 0, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'DRAFT', visits: 0, submissions: 0, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual({ DRAFT: 2 });
    expect(res.body.byStatus.PUBLISHED).toBeUndefined();
    expect(res.body.byStatus.ARCHIVED).toBeUndefined();
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { status: 'PUBLISHED', visits: 5, submissions: 1, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/landing-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
