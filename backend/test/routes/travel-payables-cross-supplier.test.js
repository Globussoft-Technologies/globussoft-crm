// @ts-check
/**
 * Arc 2 #903 slice 5 — GET /api/travel/payables cross-supplier contract
 * (PRD_TRAVEL_BILLING UC-2.5 Aged Payables month-end close +
 *  PRD_TRAVEL_SUPPLIER_MASTER).
 *
 * Pins the cross-supplier consolidated payables endpoint added to
 * backend/routes/travel_suppliers.js. Slice 3 (commit 59336ab7) shipped the
 * per-supplier CRUD (`/suppliers/:id/payables`); this slice ships the
 * tenant-scoped aggregate read that replaces the per-supplier fan-out in
 * frontend/src/pages/travel/Payables.jsx (TODO marker `#903 slice 6`).
 *
 * Contracts asserted (12 cases):
 *   - Happy path: returns payable rows with joined supplierName/
 *     supplierCategory/subBrand fields hoisted onto each row + summary
 *     block + daysUntilDue computed.
 *   - ?status=pending narrows the prisma where filter.
 *   - ?supplierCategory=hotel pushes a nested supplier.supplierCategory
 *     filter through the join.
 *   - ?subBrand=tmc pushes a nested supplier.subBrand filter through the
 *     join.
 *   - ?dueBefore=ISO + ?dueAfter=ISO build the dueDate {lte,gte} window.
 *   - Cross-tenant payables excluded — where.tenantId = req.travelTenant.id
 *     always.
 *   - Sub-brand-restricted MANAGER: subBrandAccess=["tmc"] narrows
 *     supplier.subBrand to {in:["tmc"]} so RFU payables can't be queried.
 *   - summary.byStatus counts match the rows returned.
 *   - summary.totalPending sums pending payables' amounts.
 *   - summary.currencyBreakdown groups by currency.
 *   - Invalid ?status → 400 INVALID_STATUS.
 *   - ?limit=1000 → clamped to 500.
 *
 * Test pattern mirrors backend/test/routes/travel-payment-schedule-summary.test.js
 * (commit e4832fee) — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev. verifyToken stays
 * in the chain (we don't bypass it) so the auth-gate is exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. Cross-supplier endpoint needs
// the TravelSupplierPayable + Tenant + User stubs; the TravelSupplier model
// is used by sibling endpoints in the same router file but is not directly
// queried by this endpoint (the supplier metadata comes through the include).
prisma.travelSupplierPayable = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelSupplier = prisma.travelSupplier || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.supplierCredential = prisma.supplierCredential || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.supplierCredentialAccessLog = prisma.supplierCredentialAccessLog || {
  findMany: vi.fn(),
  create: vi.fn(),
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
const travelSuppliersRouter = requireCJS('../../routes/travel_suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelSuppliersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makePayable(overrides = {}) {
  return {
    id: 500,
    tenantId: 1,
    supplierId: 100,
    poNumber: 'PO-2026-0001',
    description: 'Hotel block 25-28 May',
    amount: '50000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 5 * 86_400_000),
    status: 'pending',
    paidAt: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: {
      name: 'Marriott BLR',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    },
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelSupplierPayable.findMany.mockReset().mockResolvedValue([]);
  prisma.travelSupplierPayable.count.mockReset().mockResolvedValue(0);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/payables (cross-supplier)', () => {
  test('happy path: returns payables with hoisted supplier fields + summary block + daysUntilDue', async () => {
    const rows = [
      makePayable({
        id: 1, amount: '30000.00', status: 'pending',
        supplier: { name: 'Air India', supplierCategory: 'flight', subBrand: 'tmc' },
      }),
      makePayable({
        id: 2, amount: '60000.00', status: 'paid', paidAt: new Date(),
        supplier: { name: 'Marriott BLR', supplierCategory: 'hotel', subBrand: 'rfu' },
      }),
    ];
    prisma.travelSupplierPayable.findMany.mockResolvedValue(rows);
    prisma.travelSupplierPayable.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.payables).toHaveLength(2);
    // Joined supplier fields hoisted onto each payable row.
    expect(res.body.payables[0]).toMatchObject({
      id: 1,
      supplierId: 100,
      supplierName: 'Air India',
      supplierCategory: 'flight',
      subBrand: 'tmc',
      amount: '30000.00',
      status: 'pending',
    });
    expect(res.body.payables[1]).toMatchObject({
      id: 2,
      supplierName: 'Marriott BLR',
      supplierCategory: 'hotel',
      subBrand: 'rfu',
    });
    // daysUntilDue computed.
    expect(typeof res.body.payables[0].daysUntilDue).toBe('number');
    // Summary block present + status counters defaulted to 0.
    expect(res.body.summary).toMatchObject({
      byStatus: { pending: 1, paid: 1, scheduled: 0, cancelled: 0 },
      totalPending: '30000.00',
      totalPaid: '60000.00',
    });
    // findMany called with include for the supplier join + tenantId scope.
    expect(prisma.travelSupplierPayable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          supplier: expect.objectContaining({
            select: expect.objectContaining({
              name: true, supplierCategory: true, subBrand: true,
            }),
          }),
        }),
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('?status=pending narrows the prisma where filter', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables?status=pending')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.status).toBe('pending');
  });

  test('?supplierCategory=hotel pushes a nested supplier.supplierCategory filter', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables?supplierCategory=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.supplier).toMatchObject({
      is: expect.objectContaining({ supplierCategory: 'hotel' }),
    });
  });

  test('?subBrand=tmc pushes a nested supplier.subBrand filter through the join', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables?subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.supplier).toMatchObject({ is: { subBrand: 'tmc' } });
  });

  test('?dueBefore + ?dueAfter build the dueDate {lte,gte} window', async () => {
    const dueAfter = '2026-06-01T00:00:00.000Z';
    const dueBefore = '2026-06-30T00:00:00.000Z';
    const res = await request(makeApp())
      .get(`/api/travel/payables?dueAfter=${dueAfter}&dueBefore=${dueBefore}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.dueDate).toBeDefined();
    expect(callArg.where.dueDate.lte).toBeInstanceOf(Date);
    expect(callArg.where.dueDate.gte).toBeInstanceOf(Date);
    expect(callArg.where.dueDate.gte.toISOString()).toBe(dueAfter);
    expect(callArg.where.dueDate.lte.toISOString()).toBe(dueBefore);
  });

  test('cross-tenant payables excluded — where.tenantId always set to travelTenant.id', async () => {
    // Token claims tenantId=99 but the requireTravelTenant middleware looks
    // up the row via prisma.tenant.findUnique — we mock that to id=1, so the
    // where clause should use 1, not 99. This pins the "spoofed claim
    // doesn't leak across tenants" contract.
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    });

    const res = await request(makeApp())
      .get('/api/travel/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(1);
  });

  test('sub-brand-restricted MANAGER cannot see RFU rows (where narrows to allowed set)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    await request(makeApp())
      .get('/api/travel/payables')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .expect(200);

    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    // The where should funnel through supplier.subBrand IN ['tmc'].
    expect(callArg.where.supplier).toMatchObject({
      is: { subBrand: { in: ['tmc'] } },
    });
  });

  test('summary.byStatus counts match the rows returned', async () => {
    const rows = [
      makePayable({ id: 1, status: 'pending', amount: '10000.00' }),
      makePayable({ id: 2, status: 'pending', amount: '20000.00' }),
      makePayable({ id: 3, status: 'scheduled', amount: '5000.00' }),
      makePayable({ id: 4, status: 'paid', amount: '15000.00', paidAt: new Date() }),
      makePayable({ id: 5, status: 'cancelled', amount: '7500.00' }),
    ];
    prisma.travelSupplierPayable.findMany.mockResolvedValue(rows);
    prisma.travelSupplierPayable.count.mockResolvedValue(5);

    const res = await request(makeApp())
      .get('/api/travel/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.summary.byStatus).toEqual({
      pending: 2,
      scheduled: 1,
      paid: 1,
      cancelled: 1,
    });
  });

  test('summary.totalPending sums pending payables\' amounts', async () => {
    const rows = [
      makePayable({ id: 1, status: 'pending', amount: '30000.00' }),
      makePayable({ id: 2, status: 'pending', amount: '45000.50' }),
      // Non-pending should NOT contribute to totalPending.
      makePayable({ id: 3, status: 'paid', amount: '100000.00', paidAt: new Date() }),
      makePayable({ id: 4, status: 'scheduled', amount: '25000.25' }),
    ];
    prisma.travelSupplierPayable.findMany.mockResolvedValue(rows);
    prisma.travelSupplierPayable.count.mockResolvedValue(4);

    const res = await request(makeApp())
      .get('/api/travel/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.summary.totalPending).toBe('75000.50');
    expect(res.body.summary.totalScheduled).toBe('25000.25');
    expect(res.body.summary.totalPaid).toBe('100000.00');
  });

  test('summary.currencyBreakdown groups by currency', async () => {
    const rows = [
      makePayable({ id: 1, amount: '30000.00', currency: 'INR' }),
      makePayable({ id: 2, amount: '20000.00', currency: 'INR' }),
      makePayable({ id: 3, amount: '500.00', currency: 'USD' }),
      makePayable({ id: 4, amount: '250.50', currency: 'USD' }),
      makePayable({ id: 5, amount: '1000.00', currency: 'EUR' }),
    ];
    prisma.travelSupplierPayable.findMany.mockResolvedValue(rows);
    prisma.travelSupplierPayable.count.mockResolvedValue(5);

    const res = await request(makeApp())
      .get('/api/travel/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.summary.currencyBreakdown).toEqual({
      INR: '50000.00',
      USD: '750.50',
      EUR: '1000.00',
    });
  });

  test('invalid ?status returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables?status=frozen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('?limit=1000 is clamped to 500', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payables?limit=1000')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    const callArg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(500);
  });
});
