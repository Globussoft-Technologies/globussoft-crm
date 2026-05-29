// @ts-check
/**
 * #901 slice 32 — GET /api/travel/invoices/stats tenant-wide rollup.
 *
 * Pins the read-only point-in-time KPI-tile endpoint added to
 * backend/routes/travel_invoices.js:
 *
 *   GET /api/travel/invoices/stats   any verified token
 *
 * Mirrors #900 slice 19 (/quotes/stats) — same KPI shape with the
 * 5-status invoice taxonomy (Draft|Issued|Partial|Paid|Voided) +
 * paidRate (paid / (paid + open)) + overdueCount (non-paid status AND
 * dueDate past) + lastIssuedAt (most-recent updatedAt where
 * status='Issued').
 *
 *   {
 *     total,
 *     byStatus: { Draft|Issued|Partial|Paid|Voided: {count, totalValue} },
 *     bySubBrand: { tmc|rfu|...|_tenant: {count} },
 *     grandTotalValue, grandPaidValue, grandOpenValue,
 *     paidRate,        // paid / (paid + open); null if denom = 0
 *     overdueCount,    // status IN (Issued, Partial) AND dueDate < now
 *     lastIssuedAt,
 *   }
 *
 * Contracts asserted:
 *   - Empty tenant (no invoices) → zeroed shape with paidRate=null,
 *     overdueCount=0, all 5 byStatus buckets present at {count:0,totalValue:0}.
 *   - Happy path: 4-invoice mix of statuses → correct per-status counts +
 *     sums + grandTotalValue + grandPaidValue + grandOpenValue + paidRate.
 *   - Cross-tenant: where.tenantId narrows aggregation to the caller's tenant.
 *   - MANAGER subBrandAccess=['rfu'] narrows the Prisma where.subBrand to
 *     `{ in: ['rfu'] }` BEFORE aggregation.
 *   - USER role → 200 (anodyne aggregate, USER-readable; no role gate).
 *   - 401 on missing token (verifyToken gate).
 *   - overdueCount: 1 Issued past dueDate → counted; Paid past dueDate →
 *     NOT counted (terminal state).
 *   - paidRate: 2 Paid + 1 Issued → 0.67 (half-up 2dp).
 *
 * Pattern mirrors travel-quote-stats.test.js — CJS prisma singleton patched
 * BEFORE the router is required so verifyToken's revokedToken probe + the
 * route's findMany call both hit stubs; HS256 JWT via the dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    status: 'Draft',
    totalAmount: '10000.00',
    currency: 'INR',
    dueDate: null,
    updatedAt: new Date(Date.UTC(2026, 4, 1)),
    createdAt: new Date(Date.UTC(2026, 4, 1)),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/stats — empty tenant', () => {
  test('no invoices → all-zeros shape with paidRate=null', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byStatus.Draft).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Issued).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Partial).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Paid).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Voided).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.bySubBrand).toEqual({});
    expect(res.body.grandTotalValue).toBe(0);
    expect(res.body.grandPaidValue).toBe(0);
    expect(res.body.grandOpenValue).toBe(0);
    expect(res.body.paidRate).toBeNull();
    expect(res.body.overdueCount).toBe(0);
    expect(res.body.lastIssuedAt).toBeNull();
  });
});

describe('GET /api/travel/invoices/stats — happy path', () => {
  test('4 invoices (Draft/Issued/Paid/Voided) → correct buckets + sums + paidRate', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Draft', totalAmount: '1000.00', subBrand: 'tmc' }),
      makeInvoice({ id: 2, status: 'Issued', totalAmount: '2000.00', subBrand: 'rfu' }),
      makeInvoice({ id: 3, status: 'Paid', totalAmount: '5000.00', subBrand: 'tmc' }),
      makeInvoice({ id: 4, status: 'Voided', totalAmount: '500.00', subBrand: 'visasure' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.byStatus.Draft).toEqual({ count: 1, totalValue: 1000 });
    expect(res.body.byStatus.Issued).toEqual({ count: 1, totalValue: 2000 });
    expect(res.body.byStatus.Partial).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Paid).toEqual({ count: 1, totalValue: 5000 });
    expect(res.body.byStatus.Voided).toEqual({ count: 1, totalValue: 500 });
    // grandTotalValue = 1000 + 2000 + 5000 + 500 = 8500
    expect(res.body.grandTotalValue).toBe(8500);
    // grandPaidValue = 5000 (only Paid)
    expect(res.body.grandPaidValue).toBe(5000);
    // grandOpenValue = 8500 - 5000 (Paid) - 500 (Voided) = 3000
    expect(res.body.grandOpenValue).toBe(3000);
    // paidRate = 5000 / (5000 + 3000) = 0.625 → 0.63 half-up 2dp
    expect(res.body.paidRate).toBe(0.63);
    expect(res.body.bySubBrand.tmc).toEqual({ count: 2 });
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1 });
    expect(res.body.bySubBrand.visasure).toEqual({ count: 1 });
  });
});

describe('GET /api/travel/invoices/stats — cross-tenant isolation', () => {
  test('Prisma findMany where.tenantId is the caller token tenant, not arbitrary', async () => {
    let capturedWhere = null;
    prisma.travelInvoice.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      return [];
    });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.tenantId).toBe(1);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/travel/invoices/stats — sub-brand narrowing', () => {
  test('MANAGER with subBrandAccess=["rfu"] sees only rfu invoices', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    let capturedWhere = null;
    prisma.travelInvoice.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      const all = [
        makeInvoice({ id: 1, subBrand: 'tmc', status: 'Paid', totalAmount: '1000.00' }),
        makeInvoice({ id: 2, subBrand: 'rfu', status: 'Paid', totalAmount: '8000.00' }),
        makeInvoice({ id: 3, subBrand: 'travelstall', status: 'Draft', totalAmount: '2000.00' }),
      ];
      if (where && where.subBrand && where.subBrand.in) {
        return all.filter((q) => where.subBrand.in.includes(q.subBrand));
      }
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1 });
    expect(res.body.bySubBrand.tmc).toBeUndefined();
    expect(res.body.bySubBrand.travelstall).toBeUndefined();
    expect(res.body.grandPaidValue).toBe(8000);
  });
});

describe('GET /api/travel/invoices/stats — USER role allowed', () => {
  test('USER role → 200 (anodyne aggregate, no role gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Issued', totalAmount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/travel/invoices/stats — auth gate', () => {
  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/stats');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/invoices/stats — overdueCount semantics', () => {
  test('Issued + dueDate past → counted; Paid past → NOT counted; Issued + future → NOT counted', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const tomorrow = new Date(Date.now() + 86_400_000);
    prisma.travelInvoice.findMany.mockResolvedValue([
      // Issued + past → overdue
      makeInvoice({ id: 1, status: 'Issued', dueDate: yesterday, totalAmount: '1000.00' }),
      // Paid + past → NOT overdue (terminal state)
      makeInvoice({ id: 2, status: 'Paid', dueDate: yesterday, totalAmount: '2000.00' }),
      // Issued + future → NOT overdue
      makeInvoice({ id: 3, status: 'Issued', dueDate: tomorrow, totalAmount: '3000.00' }),
      // Issued + null dueDate → NOT overdue (no due-date policy)
      makeInvoice({ id: 4, status: 'Issued', dueDate: null, totalAmount: '500.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.overdueCount).toBe(1);
    expect(res.body.total).toBe(4);
  });

  test('Partial + dueDate past → counted (billing-active non-terminal status)', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Partial', dueDate: yesterday, totalAmount: '1000.00' }),
      // Draft past dueDate is NOT overdue (Draft isn't issued yet, no SLA on dueDate).
      makeInvoice({ id: 2, status: 'Draft', dueDate: yesterday, totalAmount: '500.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.overdueCount).toBe(1);
  });
});

describe('GET /api/travel/invoices/stats — paidRate math', () => {
  test('2 Paid + 1 Issued → 0.67 (half-up 2dp)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Paid', totalAmount: '1000.00' }),
      makeInvoice({ id: 2, status: 'Paid', totalAmount: '1000.00' }),
      makeInvoice({ id: 3, status: 'Issued', totalAmount: '1000.00' }),
      // Voided does NOT contribute to either numerator or denominator
      // (it's subtracted from total when computing open).
      makeInvoice({ id: 4, status: 'Voided', totalAmount: '5000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus.Paid.count).toBe(2);
    expect(res.body.byStatus.Issued.count).toBe(1);
    expect(res.body.grandPaidValue).toBe(2000);
    // grandOpenValue = 8000 - 2000 - 5000 = 1000
    expect(res.body.grandOpenValue).toBe(1000);
    // paidRate = 2000 / (2000 + 1000) = 0.6666... → 0.67 half-up 2dp
    expect(res.body.paidRate).toBe(0.67);
  });
});

describe('GET /api/travel/invoices/stats — defensive math', () => {
  test('null/non-numeric totalAmount → 0; no NaN poisoning', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Paid', totalAmount: null }),
      makeInvoice({ id: 2, status: 'Paid', totalAmount: 'not-a-number' }),
      makeInvoice({ id: 3, status: 'Paid', totalAmount: '5000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus.Paid.count).toBe(3);
    expect(res.body.byStatus.Paid.totalValue).toBe(5000);
    expect(Number.isNaN(res.body.grandTotalValue)).toBe(false);
    expect(res.body.grandTotalValue).toBe(5000);
    expect(res.body.grandPaidValue).toBe(5000);
  });
});

describe('GET /api/travel/invoices/stats — lastIssuedAt', () => {
  test('most-recent updatedAt where status=Issued; Paid updatedAt ignored', async () => {
    const older = new Date(Date.UTC(2026, 0, 1));
    const newer = new Date(Date.UTC(2026, 4, 1));
    const newest = new Date(Date.UTC(2026, 5, 15));
    prisma.travelInvoice.findMany.mockResolvedValue([
      makeInvoice({ id: 1, status: 'Issued', updatedAt: older, totalAmount: '1000.00' }),
      makeInvoice({ id: 2, status: 'Issued', updatedAt: newer, totalAmount: '2000.00' }),
      // Paid row's updatedAt is the highest — must be IGNORED for lastIssuedAt.
      makeInvoice({ id: 3, status: 'Paid', updatedAt: newest, totalAmount: '5000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastIssuedAt).toBe(newer.toISOString());
  });
});
