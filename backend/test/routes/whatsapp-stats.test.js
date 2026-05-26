// @ts-check
/**
 * Communications polish — GET /api/whatsapp/stats unit tests.
 *
 * Pins the tenant-wide aggregate contract for the FIRST /stats endpoint
 * on the WhatsApp route (backend/routes/whatsapp.js, line ~294). Mirrors
 * the canonical /stats template (travel_suppliers.js slice 23 #903 /
 * commission-profiles/stats #905). Read-only meta surface — no audit row,
 * tenant-scoped via req.user.tenantId, USER-readable (counts +
 * timestamps; no PII).
 *
 * What's pinned
 * -------------
 *   - Happy path returns total + byDirection + byStatus + deliveredCount
 *     + failedCount + inboundCount + lastMessageAt
 *   - Auth: 401 without a JWT (verifyToken stays in the chain)
 *   - Tenant scoping: every prisma call carries the JWT's tenantId in
 *     `where.tenantId` (regression pin against accidental cross-tenant
 *     leakage if a future refactor reads from req.body)
 *   - ?from + ?to ISO date bounds are forwarded into `where.createdAt`
 *     as gte/lte clauses respectively
 *   - 400 INVALID_DATE on malformed ?from
 *   - 400 INVALID_DATE on malformed ?to
 *   - Empty dataset yields total=0, byDirection={INBOUND:0,OUTBOUND:0},
 *     byStatus={}, lastMessageAt=null (no crash on absent rows)
 *   - DELIVERED + READ both fold into deliveredCount (matches the
 *     route's status-filter contract)
 *   - lastMessageAt is the max createdAt rendered as an ISO string
 *   - groupBy results bucket cleanly into byStatus / byDirection
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js —
 * prisma singleton is monkey-patched with vi.fn() shapes BEFORE the
 * router is required so the route's CJS `require('../lib/prisma')`
 * resolves to the patched surface. Real JWTs are signed with the same
 * fallback secret the middleware uses in dev so verifyToken stays in
 * the chain (we don't bypass it) and the 401 path is exercised
 * end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. The route file's top-level
// `require('../lib/prisma')` resolves to this singleton instance.
prisma.whatsAppMessage = {
  count: vi.fn(),
  groupBy: vi.fn(),
  findFirst: vi.fn(),
  // additional surfaces the route module also uses on other handlers
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const whatsappRouter = requireCJS('../../routes/whatsapp');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', whatsappRouter);
  return app;
}

function tokenFor({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.whatsAppMessage.count.mockReset();
  prisma.whatsAppMessage.groupBy.mockReset();
  prisma.whatsAppMessage.findFirst.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/whatsapp/stats — auth', () => {
  test('401 without Authorization header', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/whatsapp/stats');
    expect(res.status).toBe(401);
  });

  test('401 with invalid token', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/whatsapp/stats — happy path shape', () => {
  test('returns total + byDirection + byStatus + deliveredCount + failedCount + inboundCount + lastMessageAt', async () => {
    const lastIso = new Date('2026-05-25T10:30:00.000Z');
    prisma.whatsAppMessage.count
      // total
      .mockResolvedValueOnce(42)
      // deliveredCount (DELIVERED+READ)
      .mockResolvedValueOnce(28)
      // failedCount
      .mockResolvedValueOnce(3)
      // inboundCount
      .mockResolvedValueOnce(11);
    prisma.whatsAppMessage.groupBy
      // first call → direction groupBy
      .mockResolvedValueOnce([
        { direction: 'INBOUND', _count: { _all: 11 } },
        { direction: 'OUTBOUND', _count: { _all: 31 } },
      ])
      // second call → status groupBy
      .mockResolvedValueOnce([
        { status: 'QUEUED', _count: { _all: 2 } },
        { status: 'SENT', _count: { _all: 9 } },
        { status: 'DELIVERED', _count: { _all: 25 } },
        { status: 'READ', _count: { _all: 3 } },
        { status: 'FAILED', _count: { _all: 3 } },
      ]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ createdAt: lastIso });

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 42,
      byDirection: { INBOUND: 11, OUTBOUND: 31 },
      byStatus: {
        QUEUED: 2,
        SENT: 9,
        DELIVERED: 25,
        READ: 3,
        FAILED: 3,
      },
      deliveredCount: 28,
      failedCount: 3,
      inboundCount: 11,
      lastMessageAt: lastIso.toISOString(),
    });
  });

  test('empty dataset yields total=0 + zero buckets + lastMessageAt=null', async () => {
    prisma.whatsAppMessage.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.whatsAppMessage.groupBy
      .mockResolvedValueOnce([]) // direction
      .mockResolvedValueOnce([]); // status
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byDirection).toEqual({ INBOUND: 0, OUTBOUND: 0 });
    expect(res.body.byStatus).toEqual({});
    expect(res.body.deliveredCount).toBe(0);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.inboundCount).toBe(0);
    expect(res.body.lastMessageAt).toBeNull();
  });
});

describe('GET /api/whatsapp/stats — tenant scoping', () => {
  test('every prisma call carries tenantId from the JWT', async () => {
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy.mockResolvedValue([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 99 })}`);

    // total count call
    expect(prisma.whatsAppMessage.count.mock.calls[0][0].where.tenantId).toBe(99);
    // groupBy(direction) call
    expect(prisma.whatsAppMessage.groupBy.mock.calls[0][0].where.tenantId).toBe(99);
    // groupBy(status) call
    expect(prisma.whatsAppMessage.groupBy.mock.calls[1][0].where.tenantId).toBe(99);
    // findFirst (lastMessageAt)
    expect(prisma.whatsAppMessage.findFirst.mock.calls[0][0].where.tenantId).toBe(99);
  });
});

describe('GET /api/whatsapp/stats — ?from / ?to date bounds', () => {
  test('?from forwards into where.createdAt.gte', async () => {
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy.mockResolvedValue([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats?from=2026-05-01')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    const firstCountWhere = prisma.whatsAppMessage.count.mock.calls[0][0].where;
    expect(firstCountWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(firstCountWhere.createdAt.gte.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  test('?to forwards into where.createdAt.lte', async () => {
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy.mockResolvedValue([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats?to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    const firstCountWhere = prisma.whatsAppMessage.count.mock.calls[0][0].where;
    expect(firstCountWhere.createdAt.lte).toBeInstanceOf(Date);
    expect(firstCountWhere.createdAt.lte.toISOString().slice(0, 10)).toBe('2026-05-31');
  });

  test('?from + ?to together yield both gte + lte on createdAt', async () => {
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy.mockResolvedValue([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    const firstCountWhere = prisma.whatsAppMessage.count.mock.calls[0][0].where;
    expect(firstCountWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(firstCountWhere.createdAt.lte).toBeInstanceOf(Date);
  });
});

describe('GET /api/whatsapp/stats — 400 INVALID_DATE', () => {
  test('400 INVALID_DATE on malformed ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(res.body.error).toMatch(/from/i);
    // No prisma call should have fired.
    expect(prisma.whatsAppMessage.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on malformed ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats?to=not-a-date-either')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(res.body.error).toMatch(/to/i);
    expect(prisma.whatsAppMessage.count).not.toHaveBeenCalled();
  });
});

describe('GET /api/whatsapp/stats — DELIVERED + READ fold into deliveredCount', () => {
  test('deliveredCount filters status IN (DELIVERED, READ)', async () => {
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy.mockResolvedValue([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor()}`);

    // The route fires 4 .count calls in order: total, delivered, failed, inbound.
    const deliveredCall = prisma.whatsAppMessage.count.mock.calls[1][0];
    expect(deliveredCall.where.status).toEqual({ in: ['DELIVERED', 'READ'] });

    const failedCall = prisma.whatsAppMessage.count.mock.calls[2][0];
    expect(failedCall.where.status).toBe('FAILED');

    const inboundCall = prisma.whatsAppMessage.count.mock.calls[3][0];
    expect(inboundCall.where.direction).toBe('INBOUND');
  });
});

describe('GET /api/whatsapp/stats — lastMessageAt rendering', () => {
  test('lastMessageAt is the max createdAt rendered as ISO string', async () => {
    const latest = new Date('2026-05-20T08:15:30.000Z');
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy.mockResolvedValue([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ createdAt: latest });

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body.lastMessageAt).toBe('2026-05-20T08:15:30.000Z');
    // Sort key is createdAt desc — pinning ordering contract.
    const findFirstCall = prisma.whatsAppMessage.findFirst.mock.calls[0][0];
    expect(findFirstCall.orderBy).toEqual({ createdAt: 'desc' });
    expect(findFirstCall.select).toEqual({ createdAt: true });
  });
});

describe('GET /api/whatsapp/stats — groupBy bucket folding', () => {
  test('direction groupBy folds into {INBOUND, OUTBOUND} with defaults', async () => {
    // Only INBOUND rows exist — OUTBOUND should still default to 0.
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy
      .mockResolvedValueOnce([{ direction: 'INBOUND', _count: { _all: 7 } }])
      .mockResolvedValueOnce([]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body.byDirection).toEqual({ INBOUND: 7, OUTBOUND: 0 });
  });

  test('status groupBy folds into object map with each status as a key', async () => {
    prisma.whatsAppMessage.count.mockResolvedValue(0);
    prisma.whatsAppMessage.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { status: 'SENT', _count: { _all: 5 } },
        { status: 'FAILED', _count: { _all: 1 } },
      ]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/whatsapp/stats')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual({ SENT: 5, FAILED: 1 });
  });
});
