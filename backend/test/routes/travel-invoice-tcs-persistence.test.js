// @ts-check
/**
 * Arc 2 #901 slice 10 — TravelInvoice TCS persistence endpoint contract.
 *
 * Pins POST /api/travel/invoices/:id/apply-tcs added on top of the slice-9
 * /tcs-preview read-only handler. Where /tcs-preview shows "what TCS would
 * be IF this invoice were issued today" without writing, /apply-tcs commits
 * the computed TCS to four additive nullable columns on TravelInvoice:
 * tcsAmount, tcsRate, tcsExceedingAmount, tcsAppliedAt.
 *
 * Mirrors backend/test/routes/travel-invoice-issue.test.js (commit b25e7d0e)
 * and backend/test/routes/travel-invoice-tcs-preview.test.js (commit
 * 65842db4) — same prisma-singleton patch + supertest pattern + JWT signing.
 *
 * Contracts asserted:
 *   1. Happy path (overseas, threshold-straddling, applyTcs=true):
 *      200 + applied:true, 4 TCS fields persisted via update, audit row
 *      stamped TRAVEL_INVOICE_TCS_APPLIED with the 4 detail fields.
 *   2. applyTcs=true but below threshold: 200 + applies:false, NO update,
 *      NO audit row.
 *   3. isNonFiler=true: tcsRate=20 persisted (Section 206CCA surcharge).
 *   4. isOverseasPackage=false (domestic): applies:false, NO update.
 *   5. customerCountryCode=IN heuristic → domestic, applies:false.
 *   6. Already-applied (tcsAppliedAt non-null) → 409 TCS_ALREADY_APPLIED,
 *      NO update, NO audit row.
 *   7. Cross-tenant → 404 INVOICE_NOT_FOUND (loadParentInvoice tenant scope).
 *   8. USER role → 403 (RBAC gate short-circuits).
 *   9. Non-numeric :id → 400 INVALID_ID.
 *  10. Audit details payload carries tcsAmount + tcsRate + exceedingAmount +
 *      applies on the happy path.
 *  11. Sub-brand denied (MANAGER w/ restricted access) → 403 SUB_BRAND_DENIED.
 *  12. tcsAppliedAt set to a recent timestamp (within last 10s) on success.
 *
 * Test pattern: patch the prisma singleton with vi.fn() stubs BEFORE the
 * router is required, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev. NO real DB.
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
    invoiceNum: 'TMC/26-27/0001',
    status: 'Issued',
    totalAmount: '500000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    tcsAmount: null,
    tcsRate: null,
    tcsExceedingAmount: null,
    tcsAppliedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoice.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/apply-tcs — TCS persistence on invoice', () => {
  test('happy path: overseas + threshold-straddling + applyTcs=true → 4 fields persisted, audit written', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '500000.00' }),
    );
    // Two prior invoices summing to ₹500K → cumulative ₹1M crosses ₹7L by ₹300K.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '300000.00' },
      { totalAmount: '200000.00' },
    ]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      sourceInvoice({ id: 100, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ applyTcs: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      invoiceId: 100,
      contactId: 999,
      applies: true,
      applied: true,
      exceedingAmount: 300000,
      rate: 5,
      tcsAmount: 15000,
      newFyTotal: 1000000,
    });
    expect(res.body.tcsAppliedAt).toBeTruthy();

    // Verify the update wrote all 4 TCS fields.
    expect(prisma.travelInvoice.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.travelInvoice.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 100 });
    expect(updateArgs.data).toMatchObject({
      tcsAmount: 15000,
      tcsRate: 5,
      tcsExceedingAmount: 300000,
    });
    expect(updateArgs.data.tcsAppliedAt).toBeInstanceOf(Date);
  });

  test('applyTcs=true but below threshold (applies:false) → 200, NO update, NO audit', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 101, totalAmount: '100000.00' }),
    );
    // ₹100K invoice + ₹0 prior → ₹100K cumulative, well under ₹7L.
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/101/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ applyTcs: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applies: false,
      applied: false,
      exceedingAmount: 0,
      tcsAmount: 0,
      tcsAppliedAt: null,
    });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('isNonFiler=true → tcsRate=20 persisted (Section 206CCA surcharge)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 102, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      sourceInvoice({ id: 102, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/102/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ isNonFiler: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applies: true,
      applied: true,
      rate: 20,
      exceedingAmount: 300000,
      tcsAmount: 60000, // ₹300K × 20%
    });
    const updateArgs = prisma.travelInvoice.update.mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({
      tcsRate: 20,
      tcsAmount: 60000,
      tcsExceedingAmount: 300000,
    });
  });

  test('isOverseasPackage=false (domestic) → applies:false, NO update', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 103, totalAmount: '500000.00' }),
    );
    // Even with ₹1M prior spend the domestic flag short-circuits TCS.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '1000000.00' },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/103/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ isOverseasPackage: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isOverseasPackage: false,
      applies: false,
      applied: false,
      tcsAmount: 0,
    });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('customerCountryCode=IN heuristic → domestic, applies:false', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 104, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/104/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ customerCountryCode: 'IN' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isOverseasPackage: false,
      applies: false,
      applied: false,
    });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('already-applied invoice (tcsAppliedAt non-null) → 409 TCS_ALREADY_APPLIED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({
        id: 105,
        tcsAppliedAt: new Date('2026-05-01T10:00:00Z'),
        tcsAmount: '12345.00',
        tcsRate: '5.00',
        tcsExceedingAmount: '246900.00',
      }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/105/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ applyTcs: true });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TCS_ALREADY_APPLIED' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    // The findMany for prior spend should also short-circuit before running.
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant invoice → 404 INVOICE_NOT_FOUND (loadParentInvoice tenant scope)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null); // no row matches tenant filter

    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/oops/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('audit details on happy path carry tcsAmount + tcsRate + exceedingAmount + applies', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 106, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      sourceInvoice({ id: 106, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/106/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_TCS_APPLIED',
      entityId: 106,
      userId: 7,
      tenantId: 1,
    });
    // writeAudit JSON-stringifies details — parse and assert all 4 fields.
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      tcsAmount: 15000,
      tcsRate: 5,
      exceedingAmount: 300000,
      applies: true,
    });
  });

  test('sub-brand denied (MANAGER w/ restricted access) → 403 SUB_BRAND_DENIED', async () => {
    // Invoice belongs to RFU; MANAGER caller's subBrandAccess only permits TMC.
    // (ADMIN bypasses sub-brand checks via getSubBrandAccessSet, so use MANAGER.)
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 107, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/invoices/107/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('tcsAppliedAt set to a recent timestamp (within last 10s) on successful persistence', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 108, totalAmount: '500000.00' }),
    );
    prisma.travelInvoice.findMany.mockResolvedValue([
      { totalAmount: '500000.00' },
    ]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      sourceInvoice({ id: 108, ...data }),
    );

    const before = Date.now();
    const res = await request(makeApp())
      .post('/api/travel/invoices/108/apply-tcs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    const responseTs = new Date(res.body.tcsAppliedAt).getTime();
    // The stamp lives BETWEEN before and after — proves it's set on the
    // server, not lifted from the invoice row's existing-null field.
    expect(responseTs).toBeGreaterThanOrEqual(before);
    expect(responseTs).toBeLessThanOrEqual(after);

    // And the update call's data.tcsAppliedAt sits in the same window.
    const updateArgs = prisma.travelInvoice.update.mock.calls[0][0];
    const updateTs = updateArgs.data.tcsAppliedAt.getTime();
    expect(updateTs).toBeGreaterThanOrEqual(before);
    expect(updateTs).toBeLessThanOrEqual(after);
  });
});
