// @ts-check
/**
 * Unit tests for backend/routes/payments.js GET /api/payments/stats —
 * the first /stats aggregate endpoint on the Payment CRUD route.
 *
 * Why this file exists
 * ────────────────────
 * payments.js historically had no aggregate surface — the finance
 * dashboard could only paginate POST /api/payments and reduce client-
 * side (a structurally-wrong pattern flagged in the 2026-05-06/07
 * standing rule). The /stats endpoint ships the server-side aggregate
 * so the dashboard can pull a single tenant-wide KPI envelope:
 *
 *   { total, byStatus, byMethod, totalAmount, successfulAmount,
 *     lastPaymentAt }
 *
 * Pinning the contract here keeps a future refactor from silently
 * reshaping field names, dropping the half-up rounding, or relaxing
 * the tenant-scope filter (each of which is a load-bearing assertion
 * for the finance tile + the cashflow KPI surface).
 *
 * Schema reality pinned by this spec (from prisma/schema.prisma:2419+):
 *   - Payment.status enum is PENDING / SUCCESS / FAILED / REFUNDED.
 *     (NOT 'COMPLETED' — that's an Invoice-side enum value. The route
 *      and these tests use 'SUCCESS' as the success terminal.)
 *   - Payment.gateway is the method axis (stripe/razorpay/manual/etc.).
 *     The schema has NO separate `method` column — `gateway` IS the
 *     method dimension that the response envelope's `byMethod` keys
 *     are computed from.
 *
 * Pattern reference: billing.test.js (auth-middleware bypass + prisma
 * singleton-monkey-patch + supertest). The route's CJS
 * `require('../middleware/auth')` + destructured `verifyToken` is
 * replaced at module-load with a pass-through fn so we exercise the
 * route logic without minting JWTs; req.user is injected by the test's
 * express middleware. For the 401 case we mount a "real" verifyToken
 * stand-in that 401s when no Authorization header is present.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch the auth middleware BEFORE the payments router is required —
// the router does `const { verifyToken } = require(...)` at module-load,
// so the destructured reference captures whatever `authMw.verifyToken`
// points at THE MOMENT the route is required. Default to pass-through;
// the 401 case below temporarily swaps to a 401-emitting impl.
const authMw = requireCJS('../../middleware/auth');
const passthroughVerify = (_req, _res, next) => next();
authMw.verifyToken = passthroughVerify;
authMw.verifyRole = () => (_req, _res, next) => next();

// Prisma singleton patching — replace prisma.payment with bare vi.fn()
// surfaces. The /stats handler only reads via findMany.
prisma.payment = {
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
// auditLog touch surface — assert NO audit row is written for /stats.
prisma.auditLog = {
  create: vi.fn(),
  findFirst: vi.fn(),
};

import express from 'express';
import request from 'supertest';
const paymentsRouter = requireCJS('../../routes/payments');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', injectUser = true } = {}) {
  const app = express();
  app.use(express.json());
  if (injectUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/payments', paymentsRouter);
  return app;
}

beforeEach(() => {
  prisma.payment.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  // Reset verifyToken to pass-through (the 401 test swaps in a
  // 401-emitting impl mid-test).
  authMw.verifyToken = passthroughVerify;
});

describe('GET /api/payments/stats — pin tenant-wide aggregate envelope', () => {
  test('1. 401 when verifyToken rejects (no Authorization header)', async () => {
    // Swap in a verifyToken that mirrors the real middleware's 401-on-
    // missing-header shape. The router captured the destructured ref at
    // require-time, so mutate the SAME function reference via the module
    // namespace — direct assignment to `authMw.verifyToken` won't reach
    // the router's already-captured binding. Solution: wrap the captured
    // passthrough in a header-check by patching the router stack? Simpler:
    // since payments.js destructures inside its handler block, we can
    // mount a header-guard middleware BEFORE the router in the test app
    // to simulate the global server.js auth guard.
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (!req.headers.authorization) {
        res.set('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ error: 'No token' });
      }
      req.user = { userId: 7, tenantId: 1, role: 'ADMIN' };
      next();
    });
    app.use('/api/payments', paymentsRouter);

    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(401);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  test('2. 200 for any authenticated role (USER/MANAGER/ADMIN) — stats is aggregate, not PHI', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    const app = makeApp({ role: 'USER' });
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('3. 400 INVALID_DATE on unparseable ?from', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  test('4. 400 INVALID_DATE on unparseable ?to', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats?to=garbage-string');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  test('5. Empty-tenant happy path — total=0, byStatus={}, byMethod={}, sums=0, lastPaymentAt=null', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      byMethod: {},
      totalAmount: 0,
      successfulAmount: 0,
      lastPaymentAt: null,
    });
  });

  test('6. Happy path — 5 payments across statuses + methods aggregates byStatus + byMethod correctly', async () => {
    const now = new Date('2026-05-26T10:00:00.000Z');
    prisma.payment.findMany.mockResolvedValue([
      { status: 'SUCCESS', gateway: 'stripe',    amount: 100.0, createdAt: now },
      { status: 'SUCCESS', gateway: 'razorpay',  amount: 250.5, createdAt: now },
      { status: 'PENDING', gateway: 'stripe',    amount: 75.25, createdAt: now },
      { status: 'FAILED',  gateway: 'razorpay',  amount: 10.0,  createdAt: now },
      { status: 'REFUNDED', gateway: 'manual',   amount: 50.0,  createdAt: now },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({
      SUCCESS: 2,
      PENDING: 1,
      FAILED: 1,
      REFUNDED: 1,
    });
    expect(res.body.byMethod).toEqual({
      stripe: 2,
      razorpay: 2,
      manual: 1,
    });
  });

  test('7. totalAmount sums ALL rows regardless of status (half-up 2dp)', async () => {
    prisma.payment.findMany.mockResolvedValue([
      { status: 'SUCCESS',  gateway: 'stripe',   amount: 100.005, createdAt: new Date() }, // rounds to 100.01
      { status: 'PENDING',  gateway: 'stripe',   amount: 50.50,   createdAt: new Date() },
      { status: 'FAILED',   gateway: 'razorpay', amount: 25.25,   createdAt: new Date() },
      { status: 'REFUNDED', gateway: 'manual',   amount: 10.0,    createdAt: new Date() },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    // 100.005 + 50.50 + 25.25 + 10.00 = 185.755 → 185.76 (half-up).
    expect(res.body.totalAmount).toBe(185.76);
  });

  test('8. successfulAmount sums ONLY status=SUCCESS rows', async () => {
    prisma.payment.findMany.mockResolvedValue([
      { status: 'SUCCESS',  gateway: 'stripe',   amount: 200.0, createdAt: new Date() },
      { status: 'SUCCESS',  gateway: 'razorpay', amount: 150.5, createdAt: new Date() },
      { status: 'PENDING',  gateway: 'stripe',   amount: 99.99, createdAt: new Date() }, // excluded
      { status: 'FAILED',   gateway: 'manual',   amount: 50.0,  createdAt: new Date() }, // excluded
      { status: 'REFUNDED', gateway: 'stripe',   amount: 25.0,  createdAt: new Date() }, // excluded
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(res.body.successfulAmount).toBe(350.5);
    expect(res.body.totalAmount).toBe(525.49);
  });

  test('9. lastPaymentAt is ISO of the MAX createdAt across rows', async () => {
    const oldest = new Date('2026-01-01T00:00:00.000Z');
    const middle = new Date('2026-03-15T12:30:00.000Z');
    const newest = new Date('2026-05-26T08:45:00.000Z');
    prisma.payment.findMany.mockResolvedValue([
      { status: 'PENDING', gateway: 'stripe', amount: 10, createdAt: middle },
      { status: 'SUCCESS', gateway: 'stripe', amount: 20, createdAt: oldest },
      { status: 'FAILED',  gateway: 'stripe', amount: 30, createdAt: newest },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(res.body.lastPaymentAt).toBe(newest.toISOString());
  });

  test('10. Tenant isolation — findMany WHERE.tenantId matches req.user.tenantId', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 42 });
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    const callArgs = prisma.payment.findMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(42);
    // Must not be a cross-tenant fetch.
    expect(callArgs.where.tenantId).not.toBe(1);
  });

  test('11. ?from + ?to narrow the createdAt window in the Prisma where clause', async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get(
      '/api/payments/stats?from=2026-01-01T00:00:00.000Z&to=2026-05-26T23:59:59.999Z'
    );
    expect(res.status).toBe(200);
    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    const where = prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect(where.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-05-26T23:59:59.999Z');
  });

  test('12. Defensive — null amount treated as 0 (does NOT NaN the aggregate)', async () => {
    prisma.payment.findMany.mockResolvedValue([
      { status: 'SUCCESS', gateway: 'stripe', amount: null,      createdAt: new Date() },
      { status: 'SUCCESS', gateway: 'stripe', amount: undefined, createdAt: new Date() },
      { status: 'SUCCESS', gateway: 'stripe', amount: 100.0,     createdAt: new Date() },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalAmount).toBe(100);
    expect(res.body.successfulAmount).toBe(100);
    expect(Number.isNaN(res.body.totalAmount)).toBe(false);
    expect(res.body.total).toBe(3);
  });

  test('13. NO audit row written for /stats (read-only aggregate surface)', async () => {
    prisma.payment.findMany.mockResolvedValue([
      { status: 'SUCCESS', gateway: 'stripe', amount: 50, createdAt: new Date() },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/payments/stats');
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
