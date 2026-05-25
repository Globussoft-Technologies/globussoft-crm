// @ts-check
/**
 * Arc 2 #901 slice 9 — TravelInvoice TCS-preview endpoint contract.
 *
 * Pins the GET /api/travel/invoices/:id/tcs-preview handler added to
 * backend/routes/travel_invoices.js on top of the slice-8 lib/tcsCalculation.js
 * (commit 8fee3db8) + lib/travelFiscalYear.js fiscalYearStart helper.
 *
 * Mirrors backend/test/routes/travel-invoice-pdf.test.js (commit pinning the
 * /pdf endpoint) — same prisma-singleton patch + JWT auth + sub-brand
 * convention.
 *
 * Contracts asserted:
 *   - Happy path: invoice ₹500K + no prior spend → applies:false (under ₹7L).
 *   - Threshold-straddling: invoice ₹500K + prior ₹500K → applies:true, rate:5,
 *     exceedingAmount=₹300K, tcsAmount=₹15K, newFyTotal=₹1M.
 *   - ?isNonFiler=true → rate:20 (Section 206CCA non-filer surcharge).
 *   - ?isOverseasPackage=false → applies:false (domestic packages skipped).
 *   - ?customerCountryCode=IN → applies:false (heuristic overrides default).
 *   - ?customerCountryCode=AE → TCS applies per amount thresholds (heuristic
 *     treats non-IN as overseas-eligible).
 *   - Cross-tenant invoice → 404 INVOICE_NOT_FOUND (loadParentInvoice
 *     enforces tenant scope before the TCS math runs).
 *   - Sub-brand denied (MANAGER w/ restricted subBrandAccess) → 403
 *     SUB_BRAND_DENIED.
 *   - Non-numeric :id → 400 INVALID_ID.
 *   - priorFySpend computation excludes the current invoice (assert via
 *     prisma.travelInvoice.findMany call args carrying NOT: { id }).
 *   - priorFySpend computation filters by tenantId + contactId + FY-window
 *     (assert via the same call-args check, verifying createdAt: { gte: ... }
 *     plus tenantId + contactId equality).
 *
 * Test pattern: patch the prisma singleton with vi.fn() stubs BEFORE the
 * router is required, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev. NO writes
 * to disk, NO real Prisma queries — pure mock surface.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
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

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function sourceInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV-2026-0042',
    status: 'Issued',
    totalAmount: '500000.00', // ₹5L baseline; overrides reshape per test
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/invoices/:id/tcs-preview', () => {
  test('happy path: ₹500K invoice + no prior FY spend → applies:false (under ₹7L)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([]); // no prior spend

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      invoiceId: 100,
      contactId: 999,
      invoiceAmount: 500000,
      priorFySpend: 0,
      isOverseasPackage: true, // default
      isNonFiler: false,        // default
      applies: false,
      exceedingAmount: 0,
      rate: 5,                  // filer rate present even when not applied
      tcsAmount: 0,
      newFyTotal: 500000,
    });
  });

  test('threshold-straddling: ₹500K invoice + ₹500K prior → applies:true rate:5 exceedingAmount:₹300K tcsAmount:₹15K', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    // Two prior invoices summing to ₹500K so cumulative crosses the
    // ₹7L threshold by ₹300K within this invoice's window.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '300000.00' },
      { totalAmount: '200000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      invoiceId: 100,
      contactId: 999,
      invoiceAmount: 500000,
      priorFySpend: 500000,
      isOverseasPackage: true,
      isNonFiler: false,
      applies: true,
      exceedingAmount: 300000,
      rate: 5,
      tcsAmount: 15000,
      newFyTotal: 1000000,
    });
  });

  test('?isNonFiler=true flips the rate to 20 (Section 206CCA non-filer surcharge)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview?isNonFiler=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isNonFiler: true,
      applies: true,
      exceedingAmount: 300000,
      rate: 20,
      tcsAmount: 60000, // ₹300K * 20%
    });
  });

  test('?isOverseasPackage=false → applies:false (domestic packages skip TCS entirely)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    // Even with a hefty cumulative spend, the domestic flag short-circuits.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '1000000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview?isOverseasPackage=false')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isOverseasPackage: false,
      applies: false,
      exceedingAmount: 0,
      tcsAmount: 0,
    });
  });

  test('?customerCountryCode=IN → applies:false via isOverseasDestination heuristic (overrides default)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview?customerCountryCode=IN')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isOverseasPackage: false, // heuristic resolved "IN" → domestic
      applies: false,
    });
  });

  test('?customerCountryCode=AE → applies determined by amount math (heuristic treats non-IN as overseas)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview?customerCountryCode=AE')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isOverseasPackage: true,
      applies: true,
      rate: 5,
      exceedingAmount: 300000,
      tcsAmount: 15000,
    });
  });

  test('cross-tenant lookup returns 404 INVOICE_NOT_FOUND (loadParentInvoice tenant scope)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null); // no row matches the tenant filter

    const res = await request(makeApp())
      .get('/api/travel/invoices/9999/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    // findMany for prior spend must NOT have been called once we 404'd.
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denied (MANAGER w/ restricted access) returns 403 SUB_BRAND_DENIED', async () => {
    // Invoice belongs to RFU; caller is MANAGER whose subBrandAccess
    // only permits TMC. ADMIN bypass via getSubBrandAccessSet means we
    // must use a non-admin role to exercise the deny path.
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('malformed :id (non-numeric) returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/oops/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('priorFySpend findMany excludes the current invoice via NOT: { id }', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '200000.00' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.travelInvoice.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      NOT: { id: 100 }, // exclude the current invoice from prior-spend
    });
  });

  test('priorFySpend findMany filters by tenantId + contactId + FY-window (createdAt: { gte: fyStart })', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00', contactId: 777 }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tcs-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.contactId).toBe(777);
    // FY-window filter — must be `createdAt: { gte: <Date> }` (the schema
    // has no issuedAt today, so the route falls back to createdAt per
    // the slice-5 NOTE near the /issue handler).
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    // Slim projection — only totalAmount is needed.
    expect(call.select).toMatchObject({ totalAmount: true });
  });
});
