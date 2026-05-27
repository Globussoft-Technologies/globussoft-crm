// @ts-check
/**
 * #901 — GET /api/travel/invoices/expired-summary actionable overdue rollup.
 *
 * Pins the read-only summary endpoint added to
 * backend/routes/travel_invoices.js:
 *
 *   GET /api/travel/invoices/expired-summary   any verified token
 *
 * Companion to /invoices/aged-receivable (full row list + dueDate
 * bucketing) + /invoices/stats (single overdueCount aggregate). Returns
 * total + totalValue + totalOpenValue + bySubBrand + byAgeRange
 * (0-7d / 8-30d / 31-90d / 90+d) + topCustomers (top-5 by count,
 * tie-break by openValue desc then totalValue desc) + generatedAt ISO.
 *
 * Response shape:
 *   {
 *     total, totalValue, totalOpenValue,
 *     bySubBrand: { tmc|rfu|...|_tenant: {count, value, openValue} },
 *     byAgeRange: { "0-7d"|"8-30d"|"31-90d"|"90+d": {count, value, openValue} },
 *     topCustomers: [ { contactId, count, totalValue, openValue }, ... ],
 *     generatedAt,
 *   }
 *
 * openValue derivation: TravelInvoice has NO `paidAmount` column. The
 * outstanding balance is computed as totalAmount - sum(schedule.receivedAmount)
 * per /invoices/aged-receivable (slice 23). Invoices without schedule rows
 * treat the entire totalAmount as outstanding.
 *
 * Contracts asserted:
 *   - Empty tenant (no overdue invoices) → all-zeros shape, empty
 *     bySubBrand, four age buckets present at {count:0, value:0, openValue:0},
 *     empty topCustomers.
 *   - Happy path: 4-invoice mix across sub-brands + age ranges → correct
 *     total + totalValue + totalOpenValue + per-bucket counts/values.
 *   - byAgeRange bucketing: explicit boundaries (0-7d / 8-30d / 31-90d /
 *     90+d) all populated correctly given mixed overdue ages.
 *   - topCustomers: sorted desc by count, limited to 5, tie-break by
 *     openValue desc; contactId anonymisation (no name leaked).
 *   - MANAGER subBrandAccess=['rfu'] narrows Prisma where.subBrand
 *     BEFORE aggregation.
 *   - Defensive: status NOT IN (Issued, Partial) → excluded; dueDate >= now
 *     → excluded.
 *   - 401 on missing token (verifyToken gate).
 *
 * Pattern mirrors travel-quote-expired-summary.test.js — CJS prisma singleton
 * patched BEFORE the router is required so verifyToken's revokedToken
 * probe + the route's findMany call both hit stubs; HS256 JWT via the
 * dev fallback secret.
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
prisma.travelPaymentSchedule = prisma.travelPaymentSchedule || {
  findMany: vi.fn(),
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

// Helper: a Date N days ago (overdue: dueDate was N days ago).
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000);
}

function makeInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    status: 'Issued',
    contactId: 1,
    totalAmount: '1000.00',
    currency: 'INR',
    dueDate: daysAgo(3),
    schedule: [],
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

describe('GET /api/travel/invoices/expired-summary — empty tenant', () => {
  test('no overdue invoices → all-zeros shape', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.totalValue).toBe(0);
    expect(res.body.totalOpenValue).toBe(0);
    expect(res.body.bySubBrand).toEqual({});
    expect(res.body.byAgeRange).toEqual({
      '0-7d': { count: 0, value: 0, openValue: 0 },
      '8-30d': { count: 0, value: 0, openValue: 0 },
      '31-90d': { count: 0, value: 0, openValue: 0 },
      '90+d': { count: 0, value: 0, openValue: 0 },
    });
    expect(res.body.topCustomers).toEqual([]);
    expect(typeof res.body.generatedAt).toBe('string');
    expect(() => new Date(res.body.generatedAt).toISOString()).not.toThrow();
  });
});

describe('GET /api/travel/invoices/expired-summary — happy path', () => {
  test('4 overdue invoices mix of sub-brands + ages → correct totals + buckets', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      // 3 days overdue → 0-7d, tmc, contact 1, partly paid (received 200)
      makeInvoice({
        id: 1, subBrand: 'tmc', contactId: 1, dueDate: daysAgo(3),
        totalAmount: '1000.00', status: 'Partial',
        schedule: [{ receivedAmount: '200.00' }],
      }),
      // 15 days overdue → 8-30d, rfu, contact 2, unpaid (no schedule)
      makeInvoice({
        id: 2, subBrand: 'rfu', contactId: 2, dueDate: daysAgo(15),
        totalAmount: '2000.00', status: 'Issued', schedule: [],
      }),
      // 60 days overdue → 31-90d, tmc, contact 1, unpaid
      makeInvoice({
        id: 3, subBrand: 'tmc', contactId: 1, dueDate: daysAgo(60),
        totalAmount: '500.00', status: 'Issued', schedule: [],
      }),
      // 120 days overdue → 90+d, visasure, contact 3, unpaid
      makeInvoice({
        id: 4, subBrand: 'visasure', contactId: 3, dueDate: daysAgo(120),
        totalAmount: '750.00', status: 'Issued', schedule: [],
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.totalValue).toBe(4250);
    // openValue = totalAmount - received: 800 + 2000 + 500 + 750 = 4050
    expect(res.body.totalOpenValue).toBe(4050);
    // bySubBrand counts + values + openValues
    expect(res.body.bySubBrand.tmc).toEqual({ count: 2, value: 1500, openValue: 1300 });
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1, value: 2000, openValue: 2000 });
    expect(res.body.bySubBrand.visasure).toEqual({ count: 1, value: 750, openValue: 750 });
  });
});

describe('GET /api/travel/invoices/expired-summary — byAgeRange bucketing', () => {
  test('explicit boundaries: 0-7d / 8-30d / 31-90d / 90+d all populated', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      // 0-7d bucket (3d, 7d edge)
      makeInvoice({ id: 1, dueDate: daysAgo(3), totalAmount: '100.00', contactId: 11 }),
      makeInvoice({ id: 2, dueDate: daysAgo(7), totalAmount: '200.00', contactId: 12 }),
      // 8-30d bucket (8d edge, 30d edge)
      makeInvoice({ id: 3, dueDate: daysAgo(8), totalAmount: '300.00', contactId: 13 }),
      makeInvoice({ id: 4, dueDate: daysAgo(30), totalAmount: '400.00', contactId: 14 }),
      // 31-90d bucket (31d edge, 90d edge)
      makeInvoice({ id: 5, dueDate: daysAgo(31), totalAmount: '500.00', contactId: 15 }),
      makeInvoice({ id: 6, dueDate: daysAgo(90), totalAmount: '600.00', contactId: 16 }),
      // 90+d bucket (91d, 365d)
      makeInvoice({ id: 7, dueDate: daysAgo(91), totalAmount: '700.00', contactId: 17 }),
      makeInvoice({ id: 8, dueDate: daysAgo(365), totalAmount: '800.00', contactId: 18 }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byAgeRange['0-7d']).toEqual({ count: 2, value: 300, openValue: 300 });
    expect(res.body.byAgeRange['8-30d']).toEqual({ count: 2, value: 700, openValue: 700 });
    expect(res.body.byAgeRange['31-90d']).toEqual({ count: 2, value: 1100, openValue: 1100 });
    expect(res.body.byAgeRange['90+d']).toEqual({ count: 2, value: 1500, openValue: 1500 });
    expect(res.body.total).toBe(8);
    expect(res.body.totalValue).toBe(3600);
    expect(res.body.totalOpenValue).toBe(3600);
  });
});

describe('GET /api/travel/invoices/expired-summary — topCustomers ranking', () => {
  test('sorted desc by count, limited to 5, tie-break by openValue desc', async () => {
    // 7 distinct customers; the top-5 by count must surface in order.
    prisma.travelInvoice.findMany.mockResolvedValue([
      // contact 100 → 4 invoices
      makeInvoice({ id: 1, contactId: 100, totalAmount: '100.00' }),
      makeInvoice({ id: 2, contactId: 100, totalAmount: '100.00' }),
      makeInvoice({ id: 3, contactId: 100, totalAmount: '100.00' }),
      makeInvoice({ id: 4, contactId: 100, totalAmount: '100.00' }),
      // contact 200 → 3 invoices
      makeInvoice({ id: 5, contactId: 200, totalAmount: '200.00' }),
      makeInvoice({ id: 6, contactId: 200, totalAmount: '200.00' }),
      makeInvoice({ id: 7, contactId: 200, totalAmount: '200.00' }),
      // contact 300 → 2 invoices, value 5000 each (tie with 400 on count)
      makeInvoice({ id: 8, contactId: 300, totalAmount: '5000.00' }),
      makeInvoice({ id: 9, contactId: 300, totalAmount: '5000.00' }),
      // contact 400 → 2 invoices, value 100 each (tie with 300, loses on openValue)
      makeInvoice({ id: 10, contactId: 400, totalAmount: '100.00' }),
      makeInvoice({ id: 11, contactId: 400, totalAmount: '100.00' }),
      // contact 500 → 1 invoice
      makeInvoice({ id: 12, contactId: 500, totalAmount: '50.00' }),
      // contact 600 → 1 invoice (loses on openValue tie-break to 500)
      makeInvoice({ id: 13, contactId: 600, totalAmount: '10.00' }),
      // contact 700 → 1 invoice (cut off at top-5)
      makeInvoice({ id: 14, contactId: 700, totalAmount: '5.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.topCustomers).toHaveLength(5);
    expect(res.body.topCustomers[0]).toEqual({
      contactId: 100, count: 4, totalValue: 400, openValue: 400,
    });
    expect(res.body.topCustomers[1]).toEqual({
      contactId: 200, count: 3, totalValue: 600, openValue: 600,
    });
    // contact 300 ties with 400 on count(=2) but wins on openValue(10000 vs 200)
    expect(res.body.topCustomers[2]).toEqual({
      contactId: 300, count: 2, totalValue: 10000, openValue: 10000,
    });
    expect(res.body.topCustomers[3]).toEqual({
      contactId: 400, count: 2, totalValue: 200, openValue: 200,
    });
    // contact 500 ties with 600 on count(=1) but wins on openValue(50 vs 10)
    expect(res.body.topCustomers[4]).toEqual({
      contactId: 500, count: 1, totalValue: 50, openValue: 50,
    });
    // No name field leaked; only contactId + counts + values.
    for (const c of res.body.topCustomers) {
      expect(Object.keys(c).sort()).toEqual(['contactId', 'count', 'openValue', 'totalValue']);
    }
  });
});

describe('GET /api/travel/invoices/expired-summary — sub-brand narrowing', () => {
  test('MANAGER with subBrandAccess=["rfu"] narrows Prisma where.subBrand', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    let capturedWhere = null;
    prisma.travelInvoice.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      const all = [
        makeInvoice({ id: 1, subBrand: 'tmc', contactId: 1, totalAmount: '1000.00', dueDate: daysAgo(5) }),
        makeInvoice({ id: 2, subBrand: 'rfu', contactId: 2, totalAmount: '8000.00', dueDate: daysAgo(10) }),
        makeInvoice({ id: 3, subBrand: 'travelstall', contactId: 3, totalAmount: '2000.00', dueDate: daysAgo(15) }),
      ];
      if (where && where.subBrand && where.subBrand.in) {
        return all.filter((q) => where.subBrand.in.includes(q.subBrand));
      }
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(capturedWhere.tenantId).toBe(1);
    expect(capturedWhere.status).toEqual({ in: ['Issued', 'Partial'] });
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1, value: 8000, openValue: 8000 });
    expect(res.body.bySubBrand.tmc).toBeUndefined();
    expect(res.body.bySubBrand.travelstall).toBeUndefined();
  });
});

describe('GET /api/travel/invoices/expired-summary — defensive filtering', () => {
  test('status NOT IN (Issued, Partial) → Prisma filter excludes; dueDate >= now → excluded', async () => {
    let capturedWhere = null;
    // The route's Prisma filter narrows to status IN [Issued, Partial] +
    // dueDate < now. Mock honours the filter so we can assert the where
    // clause shape AND verify that any leaked non-overdue / non-Issued
    // row from a hypothetical broken mock is still defensively skipped
    // by the in-route dueDate guard.
    prisma.travelInvoice.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      return [
        // Real overdue Issued invoice — should be counted.
        makeInvoice({
          id: 1, status: 'Issued', contactId: 1,
          dueDate: daysAgo(5), totalAmount: '1000.00',
        }),
        // Defensive: dueDate in the future — must be skipped by the
        // in-route guard even if the mock leaks it past the lt-filter.
        makeInvoice({
          id: 2, status: 'Issued', contactId: 2,
          dueDate: new Date(Date.now() + 7 * 86_400_000), totalAmount: '9999.00',
        }),
      ];
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Prisma where clause MUST narrow status to Issued|Partial and dueDate to lt: now.
    expect(capturedWhere.status).toEqual({ in: ['Issued', 'Partial'] });
    expect(capturedWhere.dueDate).toBeTruthy();
    expect(capturedWhere.dueDate.lt).toBeInstanceOf(Date);
    // Only the genuinely-overdue row makes it into the aggregate.
    expect(res.body.total).toBe(1);
    expect(res.body.totalValue).toBe(1000);
    expect(res.body.topCustomers).toHaveLength(1);
    expect(res.body.topCustomers[0].contactId).toBe(1);
  });
});

describe('GET /api/travel/invoices/expired-summary — auth gate', () => {
  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/expired-summary');

    expect(res.status).toBe(401);
  });
});
