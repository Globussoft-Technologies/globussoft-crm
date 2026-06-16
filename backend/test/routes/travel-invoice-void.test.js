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
 *   7. USER role -> 403 (RBAC gate short-circuits before findFirst).
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
// S33 (#920) — CancellationPolicy stub for the void-time auto-CN-issuance
// flow. Default findFirst -> null so pre-S33 tests (no policy in tenant)
// continue to assert the non-auto-issuance path unchanged.
prisma.cancellationPolicy = {
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
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
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.cancellationPolicy.findFirst.mockReset().mockResolvedValue(null);
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

// ===========================================================================
// S33 (#920) — Cancellation-policy auto-CreditNote issuance on void.
//
// PRD_TRAVEL_BILLING FR-3.7.b: when a non-Draft invoice is voided, the
// /void handler walks the cancellation policy tiers, computes
// days-before-service-start from the earliest line's serviceStartDate,
// matches the FIRST tier whose threshold <= daysBeforeStart, and auto-
// creates a CreditNote row for refundPercent * totalAmount.
//
// Tests pin: each refund tier (full / partial / no-refund), missing
// service-start, no-policy fallback, draft-skips, and policyApplied
// envelope. Each test wires `prisma.cancellationPolicy.findFirst` to
// return a policy row; line stubs control the days-before-start window.
// ===========================================================================

const POLICY_TIERS = [
  { daysBeforeServiceStart: 30, refundPercent: 100 },
  { daysBeforeServiceStart: 7, refundPercent: 50 },
  { daysBeforeServiceStart: 0, refundPercent: 0 },
];

function policyRow(overrides = {}) {
  return {
    id: 50,
    tenantId: 1,
    name: 'TMC Default',
    subBrand: 'tmc',
    tiersJson: JSON.stringify(POLICY_TIERS),
    isActive: true,
    ...overrides,
  };
}

function daysFromNow(d) {
  return new Date(Date.now() + d * 86_400_000);
}

describe('POST /invoices/:id/void — S33 cancellation-policy auto-CR-NOTE issuance', () => {
  test('full refund: serviceStart 60d out -> 100% tier -> CN row created with totalAmount=-12000', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 800, totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(policyRow({ id: 50, subBrand: 'tmc' }));
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: daysFromNow(60) },
    ]);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 999, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/800/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Customer cancelled 60 days out — full refund' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Voided');
    expect(res.body.creditNote).toBeTruthy();
    expect(Number(res.body.creditNote.totalAmount)).toBe(-12000);
    expect(res.body.creditNote.docType).toBe('CreditNote');
    expect(res.body.creditNote.parentInvoiceId).toBe(800);
    expect(res.body.creditNote.invoiceNum).toBe('CN-TMC/26-27/0007');
    expect(res.body.policyApplied).toMatchObject({
      policyId: 50,
      policyName: 'TMC Default',
      refundPercent: 100,
    });
    expect(res.body.policyApplied.tier).toMatchObject({
      daysBeforeServiceStart: 30,
      refundPercent: 100,
    });
  });

  test('partial refund: serviceStart 14d out -> 50% tier -> CN totalAmount=-6000', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 801, totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(policyRow({ id: 51 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: daysFromNow(14) },
    ]);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1000, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/801/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Customer cancelled 14 days out — partial refund' });

    expect(res.status).toBe(200);
    expect(res.body.creditNote).toBeTruthy();
    expect(Number(res.body.creditNote.totalAmount)).toBe(-6000);
    expect(res.body.policyApplied.refundPercent).toBe(50);
  });

  test('no-refund: serviceStart 3d out -> 0% tier matched -> NO CN row created, policyApplied still surfaces', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 802, totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(policyRow({ id: 52 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: daysFromNow(3) },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/802/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Customer cancelled 3 days out — no refund per policy' });

    expect(res.status).toBe(200);
    expect(res.body.creditNote).toBeNull();
    expect(res.body.policyApplied.refundPercent).toBe(0);
    expect(res.body.policyApplied.tier).toMatchObject({
      daysBeforeServiceStart: 0,
      refundPercent: 0,
    });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('no service-start date on any line -> creditNote=null + policyApplied=null', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 803, totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(policyRow({ id: 53 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: null },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/803/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'No service date — no refund computable' });

    expect(res.status).toBe(200);
    expect(res.body.creditNote).toBeNull();
    expect(res.body.policyApplied).toBeNull();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('no policy found at any precedence level -> creditNote=null + policyApplied=null', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 804, totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    // findFirst returns null for all 3 lookup attempts (id, sub-brand, tenant-wide).
    prisma.cancellationPolicy.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/invoices/804/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'No policy in tenant — void is a noop refund-side' });

    expect(res.status).toBe(200);
    expect(res.body.creditNote).toBeNull();
    expect(res.body.policyApplied).toBeNull();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('Draft invoice voided -> NO auto-issuance attempted (nothing was billed)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 805, status: 'Draft', totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id, status: 'Draft' }), ...data,
    }));
    // No cancellationPolicy.findFirst calls expected.

    const res = await request(makeApp())
      .post('/api/travel/invoices/805/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Voiding draft invoice before it was issued' });

    expect(res.status).toBe(200);
    expect(res.body.creditNote).toBeNull();
    expect(res.body.policyApplied).toBeNull();
    expect(prisma.cancellationPolicy.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('CreditNote parent voided -> NO auto-issuance (you do not re-credit a credit-note)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 806, docType: 'CreditNote', totalAmount: '-3000.00' }),
    );
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id, docType: 'CreditNote' }), ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/806/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Voiding the credit-note itself' });

    expect(res.status).toBe(200);
    expect(res.body.creditNote).toBeNull();
    expect(res.body.policyApplied).toBeNull();
    expect(prisma.cancellationPolicy.findFirst).not.toHaveBeenCalled();
  });

  test('audit row written for auto-issued CN with autoIssued:true + tier metadata', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 807, totalAmount: '8000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(policyRow({ id: 60 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: daysFromNow(45) },
    ]);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1010, ...data,
    }));

    await request(makeApp())
      .post('/api/travel/invoices/807/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Auto-issuance audit trail probe' });

    // Two audit calls: VOIDED then CREDIT_NOTE_ISSUED.
    expect(prisma.auditLog.create.mock.calls.length).toBe(2);
    const cnAudit = prisma.auditLog.create.mock.calls.find(
      (c) => {
        const action = c[0]?.data?.action;
        return action === 'TRAVEL_INVOICE_CREDIT_NOTE_ISSUED';
      },
    );
    expect(cnAudit).toBeTruthy();
    const details = typeof cnAudit[0].data.details === 'string'
      ? JSON.parse(cnAudit[0].data.details)
      : cnAudit[0].data.details;
    expect(details).toMatchObject({
      parentId: 807,
      amount: 8000,
      policyId: 60,
      refundPercent: 100,
      autoIssued: true,
    });
  });

  test('cancellationPolicyId on invoice overrides sub-brand default lookup', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 808, totalAmount: '5000.00', cancellationPolicyId: 77 }),
    );
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    // First findFirst call (cancellationPolicyId lookup) returns the pinned policy.
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(
      policyRow({ id: 77, name: 'Pinned Policy', subBrand: null }),
    );
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: daysFromNow(60) },
    ]);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1020, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/808/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Pinned policy overrides default' });

    expect(res.status).toBe(200);
    expect(res.body.policyApplied.policyId).toBe(77);
    expect(res.body.policyApplied.policyName).toBe('Pinned Policy');
    expect(Number(res.body.creditNote.totalAmount)).toBe(-5000);
  });

  test('void succeeds even if policy lookup throws (defensive — credit-note issuance is best-effort)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice({ id: 809, totalAmount: '12000.00' }));
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...issuedInvoice({ id: where.id }), ...data,
    }));
    prisma.cancellationPolicy.findFirst.mockRejectedValue(new Error('db is down'));

    const res = await request(makeApp())
      .post('/api/travel/invoices/809/void')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Policy lookup throws — void still completes' });

    // Void still succeeds.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Voided');
    expect(res.body.creditNote).toBeNull();
    expect(res.body.policyApplied).toBeNull();
  });
});

// ===========================================================================
// S58 — GET /api/travel/invoices/:id/cancel-preview
//
// Read-only refund preview endpoint that wraps resolveCancellationOutcome()
// WITHOUT persisting any state. Powers the InvoiceDetail.jsx void-modal
// (S56): operators see "you'll get ₹X refund per TMC Default tier — 14d
// before service" BEFORE clicking Confirm Void. Same auth gate as the
// void endpoint (ADMIN/MANAGER + travelTenant + sub-brand check).
//
// Contracts pinned (6 cases):
//   (a) happy path — policy + service-start present → 200 with full preview
//   (b) cross-tenant 404 INVOICE_NOT_FOUND
//   (c) already-voided 409 ALREADY_VOIDED (resource-state conflict)
//   (d) no policy resolved → 200 with refundAmount: null + reason: NO_POLICY_RESOLVED
//   (e) idempotency — preview never writes (no update/create/auditLog.create
//       called). Re-calling returns the same shape with invoice status unchanged.
//   (f) USER role 403 (RBAC gate short-circuits before findFirst)
// ===========================================================================
describe('S58 — GET /:id/cancel-preview', () => {
  test('(a) happy path: policy + serviceStart present -> 200 with full preview envelope', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 900, totalAmount: '12000.00' }),
    );
    prisma.cancellationPolicy.findFirst.mockResolvedValueOnce(
      policyRow({ id: 70, subBrand: 'tmc' }),
    );
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      { serviceStartDate: daysFromNow(60) }, // 60d out -> 100% refund tier
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/900/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      invoiceId: 900,
      status: 'Issued',
      refundAmount: 12000,
      refundPercent: 100,
      reason: 'OK',
    });
    expect(res.body.policyApplied).toMatchObject({
      policyId: 70,
      policyName: 'TMC Default',
      refundPercent: 100,
    });
    expect(res.body.policyApplied.tier).toMatchObject({
      daysBeforeServiceStart: 30,
      refundPercent: 100,
    });
    expect(typeof res.body.daysBeforeServiceStart).toBe('number');
    expect(res.body.daysBeforeServiceStart).toBeGreaterThanOrEqual(59);
    expect(typeof res.body.serviceStartDate).toBe('string');

    // CRITICAL: preview must NOT mutate any state.
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('(b) cross-tenant or nonexistent invoice -> 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/invoices/9999/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('(c) already-voided invoice -> 409 ALREADY_VOIDED (resource-state conflict)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 901, status: 'Voided' }),
    );

    const res = await request(makeApp())
      .get('/api/travel/invoices/901/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_VOIDED' });
    // No resolver work for an already-voided invoice.
    expect(prisma.cancellationPolicy.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('(d) no policy resolved -> 200 with refundAmount: null + reason: NO_POLICY_RESOLVED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      issuedInvoice({ id: 902, totalAmount: '12000.00' }),
    );
    // No policy at any precedence level (pinned-id, sub-brand, tenant-wide).
    prisma.cancellationPolicy.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/invoices/902/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invoiceId: 902,
      status: 'Issued',
      policyApplied: null,
      refundAmount: null,
      refundPercent: null,
      daysBeforeServiceStart: null,
      serviceStartDate: null,
      reason: 'NO_POLICY_RESOLVED',
    });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('(e) idempotency: re-calling preview returns same shape + invoice state unchanged', async () => {
    // Each call independently re-mocks findFirst (the route reads fresh).
    // What we pin here is: no .update / .create / auditLog calls happen
    // across both invocations, and the response shape is byte-identical.
    const baseInvoice = issuedInvoice({ id: 903, totalAmount: '12000.00' });

    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(baseInvoice)
      .mockResolvedValueOnce(baseInvoice);
    prisma.cancellationPolicy.findFirst
      .mockResolvedValueOnce(policyRow({ id: 71, subBrand: 'tmc' }))
      .mockResolvedValueOnce(policyRow({ id: 71, subBrand: 'tmc' }));
    prisma.travelInvoiceLine.findMany
      .mockResolvedValueOnce([{ serviceStartDate: daysFromNow(14) }])
      .mockResolvedValueOnce([{ serviceStartDate: daysFromNow(14) }]);

    const res1 = await request(makeApp())
      .get('/api/travel/invoices/903/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const res2 = await request(makeApp())
      .get('/api/travel/invoices/903/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Refund-bearing fields are byte-identical across the two calls.
    expect(res2.body.invoiceId).toBe(res1.body.invoiceId);
    expect(res2.body.status).toBe(res1.body.status);
    expect(res2.body.refundAmount).toBe(res1.body.refundAmount);
    expect(res2.body.refundPercent).toBe(res1.body.refundPercent);
    expect(res2.body.policyApplied).toEqual(res1.body.policyApplied);
    expect(res2.body.reason).toBe(res1.body.reason);

    // 50% tier matched (14d out -> >=7 tier).
    expect(res1.body.refundPercent).toBe(50);
    expect(res1.body.refundAmount).toBe(6000);

    // CRITICAL: zero writes across BOTH calls.
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    // Invoice the route read both times still reports status='Issued'
    // — the route did not mutate baseInvoice.status under the hood.
    expect(baseInvoice.status).toBe('Issued');
  });

  test('(f) USER role -> 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/904/cancel-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });
});
