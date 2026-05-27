// @ts-check
/**
 * CRM polish — pin GET /api/knowledge-base/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header -> 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope with articlesByStatus={} + lastPublishedAt=null.
 *   - Happy path: mixed published/draft -> totals + articlesByStatus + publishedCount correct.
 *   - totalViews sums the views column (defensive null/undefined -> 0, no NaN poisoning).
 *   - totalCategories is a separate prisma.kbCategory.count call, tenant-scoped.
 *   - lastPublishedAt: max(updatedAt) ACROSS PUBLISHED rows only;
 *     draft updatedAts are ignored even when they are more recent.
 *   - lastPublishedAt=null when no published rows in the result set.
 *   - Tenant isolation: prisma where.tenantId = req.user.tenantId on BOTH
 *     kbArticle.findMany AND kbCategory.count.
 *   - ?from / ?to narrows the window via createdAt clauses on kbArticle
 *     (category count is NOT date-bounded — category cardinality is a
 *     tenant-level fact, not a window-of-time fact).
 *   - NO audit row written (read-only meta surface).
 *
 * Schema notes (verified against prisma/schema.prisma + routes/knowledge_base.js)
 * -----------------------------------------------------------------------------
 *   - KbArticle has NO `status` enum; only `isPublished` Boolean. The brief's
 *     "Draft/Published/Archived" trio is rendered as "Draft" (isPublished=false)
 *     / "Published" (isPublished=true). Archived bucket does not exist.
 *   - KbArticle has NO `publishedAt`; lastPublishedAt is derived from
 *     max(updatedAt) where isPublished=true.
 *   - KbArticle.views is Int; sum is plain integer (no half-up 2dp needed).
 *
 * Pattern reference: estimates-stats.test.js — patches the prisma singleton
 * with vi.fn() BEFORE requiring the router, drives supertest with HS256
 * JWTs signed against the dev-fallback secret. /stats endpoint mounts
 * explicit verifyToken so the 401-gate case can be exercised in isolation
 * without depending on a global guard.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.kbArticle = prisma.kbArticle || {};
prisma.kbArticle.findMany = vi.fn();
prisma.kbCategory = prisma.kbCategory || {};
prisma.kbCategory.count = vi.fn();
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
const kbRouter = requireCJS('../../routes/knowledge_base');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-base', kbRouter);
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
  prisma.kbArticle.findMany.mockReset();
  prisma.kbCategory.count.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/knowledge-base/stats', () => {
  test('auth gate: missing Authorization header -> 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/knowledge-base/stats');
    expect(res.status).toBe(401);
    expect(prisma.kbArticle.findMany).not.toHaveBeenCalled();
    expect(prisma.kbCategory.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.kbArticle.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.kbArticle.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with articlesByStatus={} + lastPublishedAt=null', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([]);
    prisma.kbCategory.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalArticles: 0,
      articlesByStatus: {},
      publishedCount: 0,
      totalCategories: 0,
      totalViews: 0,
      lastPublishedAt: null,
    });
  });

  test('happy path: 5 articles (3 published, 2 draft) -> articlesByStatus + publishedCount + totals correct', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      { isPublished: true,  views: 100, updatedAt: new Date('2026-05-01T10:00:00Z') },
      { isPublished: true,  views:  50, updatedAt: new Date('2026-05-02T10:00:00Z') },
      { isPublished: true,  views:  25, updatedAt: new Date('2026-05-03T10:00:00Z') },
      { isPublished: false, views:  10, updatedAt: new Date('2026-05-04T10:00:00Z') },
      { isPublished: false, views:   5, updatedAt: new Date('2026-05-05T10:00:00Z') },
    ]);
    prisma.kbCategory.count.mockResolvedValue(4);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalArticles).toBe(5);
    expect(res.body.articlesByStatus).toEqual({ Published: 3, Draft: 2 });
    expect(res.body.publishedCount).toBe(3);
    expect(res.body.totalCategories).toBe(4);
    expect(res.body.totalViews).toBe(190); // 100+50+25+10+5
  });

  test('totalViews sums views column; null/undefined views default to 0 (no NaN poisoning)', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      { isPublished: true,  views: null,      updatedAt: new Date('2026-05-01T10:00:00Z') },
      { isPublished: true,  views: undefined, updatedAt: new Date('2026-05-02T10:00:00Z') },
      { isPublished: false, views: 42,        updatedAt: new Date('2026-05-03T10:00:00Z') },
    ]);
    prisma.kbCategory.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(42);
    expect(Number.isFinite(res.body.totalViews)).toBe(true);
  });

  test('totalCategories comes from prisma.kbCategory.count (separate call, tenant-scoped)', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([]);
    prisma.kbCategory.count.mockResolvedValue(12);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 9 })}`);

    expect(res.status).toBe(200);
    expect(res.body.totalCategories).toBe(12);
    expect(prisma.kbCategory.count).toHaveBeenCalledTimes(1);
    const countArg = prisma.kbCategory.count.mock.calls[0][0];
    expect(countArg.where.tenantId).toBe(9);
  });

  test('lastPublishedAt: max(updatedAt) across published rows only; drafts ignored even if more recent', async () => {
    const olderPublished = new Date('2026-05-10T10:00:00Z');
    const newerDraft = new Date('2026-05-20T10:00:00Z'); // newer but draft - must NOT win
    prisma.kbArticle.findMany.mockResolvedValue([
      { isPublished: true,  views: 0, updatedAt: new Date('2026-05-01T10:00:00Z') },
      { isPublished: true,  views: 0, updatedAt: olderPublished },
      { isPublished: false, views: 0, updatedAt: newerDraft },
    ]);
    prisma.kbCategory.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastPublishedAt).toBe(olderPublished.toISOString());
  });

  test('lastPublishedAt=null when no published rows in result set (only drafts)', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      { isPublished: false, views: 0, updatedAt: new Date('2026-05-01T10:00:00Z') },
      { isPublished: false, views: 0, updatedAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.kbCategory.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastPublishedAt).toBeNull();
    expect(res.body.publishedCount).toBe(0);
    expect(res.body.articlesByStatus).toEqual({ Draft: 2 });
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId on kbArticle.findMany', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([]);
    prisma.kbCategory.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const articleWhere = prisma.kbArticle.findMany.mock.calls[0][0].where;
    expect(articleWhere.tenantId).toBe(42);
    const categoryWhere = prisma.kbCategory.count.mock.calls[0][0].where;
    expect(categoryWhere.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via createdAt clauses on kbArticle.findMany only', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([]);
    prisma.kbCategory.count.mockResolvedValue(7);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/knowledge-base/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const articleWhere = prisma.kbArticle.findMany.mock.calls[0][0].where;
    expect(articleWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(articleWhere.createdAt.lte).toEqual(new Date(toIso));
    // Category-count must NOT be window-bounded (cardinality is tenant-level).
    const categoryWhere = prisma.kbCategory.count.mock.calls[0][0].where;
    expect(categoryWhere.createdAt).toBeUndefined();
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      { isPublished: true, views: 5, updatedAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    prisma.kbCategory.count.mockResolvedValue(1);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('articlesByStatus omits a bucket entirely when zero rows fall into it (no "Published: 0" noise)', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      { isPublished: false, views: 0, updatedAt: new Date('2026-05-01T10:00:00Z') },
      { isPublished: false, views: 0, updatedAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.kbCategory.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/knowledge-base/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.articlesByStatus).toEqual({ Draft: 2 });
    expect(res.body.articlesByStatus.Published).toBeUndefined();
  });
});
