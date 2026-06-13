// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER G045 (FR-3.1.e, FR-3.5.a, FR-3.5.b) —
 * TravelSupplierCommissionEntry route surface tests.
 *
 * What's pinned
 * -------------
 *   - POST   /suppliers/:id/commission-entries
 *       happy-path with explicit baseAmount + commissionPercent
 *       supplier-default commissionPercent fallback
 *       missing baseAmount → 400 MISSING_FIELDS
 *       negative baseAmount → 400 INVALID_BASE_AMOUNT
 *       commissionPercent > 100 → 400 INVALID_COMMISSION_PERCENT
 *       no rate available → 400 MISSING_COMMISSION_RATE
 *       default 5% TDS applied
 *       tdsPercent=0 honored (TDS = 0)
 *       USER role → 403
 *       cross-tenant parent → 404 SUPPLIER_NOT_FOUND
 *   - GET    /suppliers/:id/commission-entries
 *       happy-path list, ?fiscalYear filter, ?status filter
 *       invalid fiscalYear shape → 400 INVALID_FISCAL_YEAR
 *   - GET    /suppliers/:id/commission-entries/:entryId
 *       detail; 404 ENTRY_NOT_FOUND when missing
 *   - POST   /suppliers/:id/commission-entries/:entryId/settle
 *       happy-path flips to settled + stamps settledAt
 *       409 ALREADY_SETTLED on re-settle
 *       409 ALREADY_REVERSED on already-reversed entry
 *   - POST   /suppliers/:id/commission-entries/:entryId/reverse
 *       happy-path flips to reversed + stamps reversalReason
 *       missing reversalReason → 400 MISSING_FIELDS
 *       MANAGER role → 403 (ADMIN-only)
 *   - GET    /suppliers/:id/commission-statement
 *       per-FY aggregation totals correctness
 *   - GET    /suppliers/:id/commission-statement.csv
 *       CSV header + row count
 *   - GET    /commissions/stats
 *       tenant-wide rollup + distinct-supplier count
 *
 * Test pattern mirrors backend/test/routes/travel-supplier-payables.test.js
 * — patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, drive supertest with real HS256 JWTs.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplierCommissionEntry = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
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
const router = requireCJS('../../routes/travel_supplier_commissions');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', router);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const PARENT_SUPPLIER = {
  id: 100,
  tenantId: 1,
  subBrand: 'tmc',
  name: 'Air India',
  supplierCategory: 'flight',
  isActive: true,
  commissionPercent: '7.50',
};

beforeAll(() => {});

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierCommissionEntry.findMany.mockReset();
  prisma.travelSupplierCommissionEntry.findFirst.mockReset();
  prisma.travelSupplierCommissionEntry.count.mockReset();
  prisma.travelSupplierCommissionEntry.create.mockReset();
  prisma.travelSupplierCommissionEntry.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

// ─── POST /suppliers/:id/commission-entries ─────────────────────────

describe('POST /api/travel/suppliers/:id/commission-entries', () => {
  test('happy path with explicit baseAmount + commissionPercent — TDS defaults to 5%', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.create.mockResolvedValue({
      id: 555, tenantId: 1, supplierId: 100,
      fiscalYear: 'FY2026-27', entryType: 'accrued',
      commissionPercent: '10', baseAmount: '100000',
      commissionAmount: '10000', tdsAmount: '500', netAmount: '9500',
      currency: 'INR', status: 'accrued', accruedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        baseAmount: 100000,
        commissionPercent: 10,
        fiscalYear: 'FY2026-27',
      });
    expect(res.status, `accrue: ${res.text}`).toBe(201);
    expect(prisma.travelSupplierCommissionEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          supplierId: 100,
          fiscalYear: 'FY2026-27',
          baseAmount: '100000',
          commissionAmount: '10000',
          // Default 5% of 10000 = 500
          tdsAmount: '500',
          netAmount: '9500',
          status: 'accrued',
        }),
      }),
    );
  });

  test('falls back to supplier.commissionPercent when not in body', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.create.mockResolvedValue({
      id: 556, commissionAmount: '7500', tdsAmount: '375', netAmount: '7125',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: 100000 });
    expect(res.status).toBe(201);
    // 7.5% of 100000 = 7500; 5% TDS = 375; net = 7125
    expect(prisma.travelSupplierCommissionEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          commissionAmount: '7500',
          tdsAmount: '375',
          netAmount: '7125',
        }),
      }),
    );
  });

  test('tdsPercent=0 honored — TDS becomes 0', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.create.mockResolvedValue({ id: 557 });
    await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: 1000, commissionPercent: 10, tdsPercent: 0 });
    expect(prisma.travelSupplierCommissionEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          commissionAmount: '100',
          tdsAmount: '0',
          netAmount: '100',
        }),
      }),
    );
  });

  test('missing baseAmount → 400 MISSING_FIELDS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ commissionPercent: 10 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
    expect(prisma.travelSupplierCommissionEntry.create).not.toHaveBeenCalled();
  });

  test('negative baseAmount → 400 INVALID_BASE_AMOUNT', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: -100, commissionPercent: 10 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BASE_AMOUNT');
  });

  test('commissionPercent > 100 → 400 INVALID_COMMISSION_PERCENT', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: 1000, commissionPercent: 150 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COMMISSION_PERCENT');
  });

  test('no rate available → 400 MISSING_COMMISSION_RATE', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({ ...PARENT_SUPPLIER, commissionPercent: null });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_COMMISSION_RATE');
  });

  test('invalid fiscalYear shape → 400 INVALID_FISCAL_YEAR', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: 1000, commissionPercent: 10, fiscalYear: '2025-26' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FISCAL_YEAR');
  });

  test('USER role → 403', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ baseAmount: 1000, commissionPercent: 10 });
    expect(res.status).toBe(403);
    expect(prisma.travelSupplierCommissionEntry.create).not.toHaveBeenCalled();
  });

  test('cross-tenant parent → 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/9999/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ baseAmount: 1000, commissionPercent: 10 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SUPPLIER_NOT_FOUND');
  });
});

// ─── GET /suppliers/:id/commission-entries ──────────────────────────

describe('GET /api/travel/suppliers/:id/commission-entries', () => {
  test('happy path returns scoped list', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, supplierId: 100, fiscalYear: 'FY2026-27', status: 'accrued', commissionAmount: '500' },
    ]);
    prisma.travelSupplierCommissionEntry.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-entries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries).toHaveLength(1);
    expect(prisma.travelSupplierCommissionEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, supplierId: 100 }),
      }),
    );
  });

  test('?fiscalYear=FY2025-26 narrows the where clause', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([]);
    prisma.travelSupplierCommissionEntry.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/suppliers/100/commission-entries?fiscalYear=FY2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplierCommissionEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1, supplierId: 100, fiscalYear: 'FY2025-26',
        }),
      }),
    );
  });

  test('invalid ?fiscalYear shape → 400 INVALID_FISCAL_YEAR', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-entries?fiscalYear=FY2025-28')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FISCAL_YEAR');
  });
});

// ─── GET detail ─────────────────────────────────────────────────────

describe('GET /api/travel/suppliers/:id/commission-entries/:entryId', () => {
  test('happy-path detail', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findFirst.mockResolvedValue({
      id: 555, tenantId: 1, supplierId: 100, fiscalYear: 'FY2026-27', status: 'accrued',
    });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-entries/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(555);
  });

  test('missing → 404 ENTRY_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-entries/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ENTRY_NOT_FOUND');
  });
});

// ─── POST settle ────────────────────────────────────────────────────

describe('POST /api/travel/suppliers/:id/commission-entries/:entryId/settle', () => {
  test('happy path flips to settled + stamps settledAt', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findFirst.mockResolvedValue({
      id: 200, status: 'accrued', fiscalYear: 'FY2026-27', supplierId: 100, tenantId: 1,
    });
    prisma.travelSupplierCommissionEntry.update.mockResolvedValue({
      id: 200, status: 'settled', settledAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries/200/settle')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(prisma.travelSupplierCommissionEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 200 },
        data: expect.objectContaining({
          status: 'settled',
          settledAt: expect.any(Date),
        }),
      }),
    );
  });

  test('409 ALREADY_SETTLED on re-settle', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findFirst.mockResolvedValue({
      id: 200, status: 'settled', fiscalYear: 'FY2026-27', supplierId: 100, tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries/200/settle')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_SETTLED');
  });

  test('409 ALREADY_REVERSED on reversed entry', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findFirst.mockResolvedValue({
      id: 200, status: 'reversed', fiscalYear: 'FY2026-27', supplierId: 100, tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries/200/settle')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REVERSED');
  });
});

// ─── POST reverse ───────────────────────────────────────────────────

describe('POST /api/travel/suppliers/:id/commission-entries/:entryId/reverse', () => {
  test('happy path flips to reversed + stamps reason', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findFirst.mockResolvedValue({
      id: 300, status: 'accrued', fiscalYear: 'FY2026-27', supplierId: 100, tenantId: 1,
    });
    prisma.travelSupplierCommissionEntry.update.mockResolvedValue({
      id: 300, status: 'reversed', reversedAt: new Date(),
      reversalReason: 'Customer refund',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries/300/reverse')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reversalReason: 'Customer refund' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reversed');
    expect(prisma.travelSupplierCommissionEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'reversed',
          reversedAt: expect.any(Date),
          reversalReason: 'Customer refund',
        }),
      }),
    );
  });

  test('missing reversalReason → 400 MISSING_FIELDS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries/300/reverse')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
    expect(prisma.travelSupplierCommissionEntry.update).not.toHaveBeenCalled();
  });

  test('MANAGER role → 403 (ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/commission-entries/300/reverse')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ reversalReason: 'x' });
    expect(res.status).toBe(403);
  });
});

// ─── GET statement ──────────────────────────────────────────────────

describe('GET /api/travel/suppliers/:id/commission-statement', () => {
  test('aggregates accrued + settled + reversed totals correctly', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      { id: 1, status: 'accrued', commissionAmount: '1000', tdsAmount: '50', netAmount: '950' },
      { id: 2, status: 'accrued', commissionAmount: '500', tdsAmount: '25', netAmount: '475' },
      { id: 3, status: 'settled', commissionAmount: '2000', tdsAmount: '100', netAmount: '1900' },
      { id: 4, status: 'reversed', commissionAmount: '300', tdsAmount: '15', netAmount: '285' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-statement?fiscalYear=FY2026-27')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.supplierId).toBe(100);
    expect(res.body.fiscalYear).toBe('FY2026-27');
    expect(res.body.counts).toMatchObject({
      accrued: 2, settled: 1, reversed: 1, total: 4,
    });
    expect(res.body.totals.accruedCommission).toBe(1500);
    expect(res.body.totals.settledCommission).toBe(2000);
    expect(res.body.totals.reversedCommission).toBe(300);
    // TDS excludes reversed rows
    expect(res.body.totals.tdsDeducted).toBe(175);
    expect(res.body.totals.netPayable).toBe(1425);
    expect(res.body.totals.netSettled).toBe(1900);
  });

  test('defaults to current FY when not specified', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-statement')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.fiscalYear).toMatch(/^FY\d{4}-\d{2}$/);
  });
});

// ─── GET CSV ────────────────────────────────────────────────────────

describe('GET /api/travel/suppliers/:id/commission-statement.csv', () => {
  test('returns CSV with header + data rows', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      {
        id: 1, fiscalYear: 'FY2026-27', status: 'accrued', entryType: 'accrued',
        accruedAt: new Date('2026-05-01T00:00:00Z'),
        settledAt: null,
        baseAmount: '10000', commissionPercent: '10', commissionAmount: '1000',
        tdsAmount: '50', netAmount: '950', currency: 'INR',
        bookingId: null, invoiceId: 42, notes: 'Test',
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/commission-statement.csv?fiscalYear=FY2026-27')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/commission-statement-100-FY2026-27\.csv/);
    const lines = res.text.split('\n');
    expect(lines[0]).toMatch(/id,fiscalYear,status/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/1,FY2026-27,accrued/);
  });
});

// ─── GET /commissions/stats — tenant-wide rollup ─────────────────────

describe('GET /api/travel/commissions/stats', () => {
  test('aggregates across suppliers + distinct-supplier count', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      { id: 1, supplierId: 100, status: 'accrued', commissionAmount: '1000', tdsAmount: '50', netAmount: '950' },
      { id: 2, supplierId: 200, status: 'accrued', commissionAmount: '500', tdsAmount: '25', netAmount: '475' },
      { id: 3, supplierId: 100, status: 'settled', commissionAmount: '2000', tdsAmount: '100', netAmount: '1900' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/commissions/stats?fiscalYear=FY2026-27')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.fiscalYear).toBe('FY2026-27');
    expect(res.body.distinctSuppliers).toBe(2);
    expect(res.body.counts.total).toBe(3);
    expect(res.body.totals.accruedCommission).toBe(1500);
    expect(res.body.totals.settledCommission).toBe(2000);
    expect(res.body.totals.netPayable).toBe(1425);
  });

  test('invalid ?fiscalYear → 400 INVALID_FISCAL_YEAR', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commissions/stats?fiscalYear=INVALID')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FISCAL_YEAR');
  });
});
