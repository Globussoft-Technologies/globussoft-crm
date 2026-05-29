// @ts-check
/**
 * Arc 2 #901 slice 27 — TravelInvoice dedicated /void action contract.
 *
 * Pins POST /api/travel/invoices/:id/void — the operator-action "Void this
 * invoice with reason" endpoint. The existing PUT /:id can already mutate
 * status -> Voided, but it does NOT require a reason and does NOT carry
 * one in audit. This dedicated endpoint mirrors the action-endpoint pattern
 * established by mark-paid (slice 19), apply-penalty (slice 25), and
 * convert-to-tax-invoice (slice 26). PRD_TRAVEL_BILLING FR-3.7 (cancellation
 * / refund flow — voiding is a precondition for reissuance).
 *
 * Mirrors backend/test/routes/travel-invoice-convert-to-tax-invoice.test.js
 * (commit d06cfb19, slice 26) — same prisma-singleton-patch + supertest
 * pattern, same JWT signing.
 *
 * Contracts asserted (9 cases):
 *   1. Happy path: Issued -> 200, status flips to Voided + audit row written
 *      with TRAVEL_INVOICE_VOIDED + reason + prevStatus.
 *   2. Paid invoice CAN be voided (refund flow) -> 200; audit captures
 *      prevStatus='Paid'.
 *   3. Already-voided invoice -> 400 ALREADY_VOIDED (idempotency guard).
 *   4. Missing reason (no body) -> 400 INVALID_VOID_REASON.
 *   5. Too-short reason (<5 chars) -> 400 INVALID_VOID_REASON.
 *   6. Too-long reason (>500 chars) -> 400 INVALID_VOID_REASON.
 *   7. USER role -> 403 (verifyRole short-circuits before findFirst).
 *   8. Cross-tenant invoice -> 404 INVOICE_NOT_FOUND.
 *   9. Sub-brand denied (MANAGER without access) -> 403 SUB_BRAND_DENIED.
 *
 * Test pattern: patch the prisma singleton with vi.fn() stubs BEFORE the
 * router is required, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev.
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

function issuedInvoice(overrides = {}) {
  return {
    id: 700,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TMC/26-27/0007',
    status: 'Issued',
    docType: 'TaxInvoice',
    totalAmount: '12000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    parentInvoiceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/void — dedicated void action with reason', () => {
  test('happy path: Issued invoice -> 200, status flips to Voided + audit row written', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 700 }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }),
      ...data,
      updatedAt: new Date(),
    }));

    const reason = 'Customer cancelled trip on 2026-05-20';
    const res = await request(makeApp())
      .post('/api/travel/invoices/700/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Voided');
    expect(res.body.invoiceNum).toBe('TMC/26-27/0007');

    // update called with status='Voided' only (no notes field — schema absent).
    const updateArgs = prisma.travelInvoice.update.mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({ id: 700 });
    expect(updateArgs.data).toEqual({ status: 'Voided' });
    expect(updateArgs.data).not.toHaveProperty('notes');

    // Audit row carries the reason.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_VOIDED',
      entityId: 700,
      userId: 7,
      tenantId: 1,
    });
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      prevStatus: 'Issued',
      reason,
      invoiceNum: 'TMC/26-27/0007',
      subBrand: 'tmc',
    });
  });

  test('Paid invoice CAN be voided (refund flow) — audit captures prevStatus=Paid', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 701, status: 'Paid' }),
    );
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id, status: 'Paid' }),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/701/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Refund issued via wire — voiding original invoice' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Voided');

    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details.prevStatus).toBe('Paid');
  });

  test('already-voided invoice -> 400 ALREADY_VOIDED (idempotency guard)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 702, status: 'Voided' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/702/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Trying to void twice' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ALREADY_VOIDED' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('missing reason -> 400 INVALID_VOID_REASON (no DB read happens)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/700/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_VOID_REASON' });
    // Reason validation runs BEFORE the loadParentInvoice DB read.
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('too-short reason (<5 chars after trim) -> 400 INVALID_VOID_REASON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/700/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: '  no  ' }); // trims to "no" (2 chars)

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_VOID_REASON' });
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
  });

  test('too-long reason (>500 chars) -> 400 INVALID_VOID_REASON', async () => {
    const tooLong = 'x'.repeat(501);
    const res = await request(makeApp())
      .post('/api/travel/invoices/700/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: tooLong });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_VOID_REASON' });
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
  });

  test('USER role -> 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/700/void')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ reason: 'Should never reach the handler' });

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('cross-tenant invoice -> 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Cross-tenant probe' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('sub-brand denied -> 403 SUB_BRAND_DENIED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 706, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/invoices/706/void')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ reason: 'Manager attempting cross-sub-brand void' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });
});
