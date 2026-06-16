// @ts-check
/**
 * Arc 2 #901 slice 25 — TravelInvoice apply-penalty endpoint contract
 * (PRD_TRAVEL_BILLING §3 late-payment penalty PERSISTENCE).
 *
 * Pins POST /api/travel/invoices/:id/apply-penalty — the write counterpart
 * to slice 24's read-only GET /:id/late-penalty. Where the preview
 * returns the penalty that WOULD apply, the apply endpoint materialises
 * it as a TravelInvoiceLine (lineType='fee'), recomputes the invoice's
 * totalAmount via the existing pipeline, and writes a
 * TRAVEL_INVOICE_PENALTY_APPLIED audit row.
 *
 * Library consumer: lib/latePenaltyCalculation.js (shipped by slice 24).
 *
 * Contracts asserted:
 *   1. 401 when no token.
 *   2. USER role → 403 (RBAC gate short-circuits).
 *   3. 400 INVALID_ID when :id is not numeric.
 *   4. 404 INVOICE_NOT_FOUND when missing or cross-tenant.
 *   5. 409 INVOICE_NOT_PAYABLE when status is Draft/Paid/Voided.
 *   6. Happy path (Issued, 30d overdue, simple-mode default):
 *      201 + status:'applied' + line created with lineType='fee' +
 *      unitPrice=amount=penalty + recomputeInvoiceTotal called + audit row.
 *   7. applies=false branch (in-grace, not-yet-due, etc.):
 *      200 + status:'not_applied' + NO line created + NO audit row.
 *   8. Idempotency: re-applying with the same idempotencyKey returns 200
 *      + status:'already_applied' + the existing line + NO new create.
 *   9. Operator-supplied description override is persisted on the line.
 *  10. flat-mode override produces a flat-rate penalty line.
 *  11. 400 INVALID_AS_OF when asOf is unparseable.
 *  12. 400 INVALID_MODE when mode is not 'simple' or 'flat'.
 *  13. 400 INVALID_NUMERIC_QUERY when graceDays is negative.
 *  14. Audit row carries the policy details (mode, ratePercent,
 *      daysOverdue, chargeableDays).
 *
 * Pattern mirrors travel-invoice-late-penalty.test.js (slice 24) +
 * travel-invoice-tcs-persistence.test.js (slice 10). CJS prisma singleton
 * patched BEFORE the router require so loadParentInvoice + create + audit
 * write all hit stubs; HS256 JWT via the dev fallback secret.
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
prisma.travelInvoiceLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue(null);
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

const FROZEN_ASOF = '2026-06-01T00:00:00.000Z';
// 30 days before FROZEN_ASOF → 30 daysOverdue, 23 chargeable after 7d grace.
const DUE_30D_BEFORE = new Date(
  new Date(FROZEN_ASOF).getTime() - 30 * 86_400_000,
);

function parentInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    quoteId: null,
    invoiceNum: 'TINV-2026-0001',
    status: 'Issued',
    totalAmount: '10000.00',
    currency: 'INR',
    dueDate: DUE_30D_BEFORE,
    paidAt: null,
    docType: 'TaxInvoice',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function defaultTenantFindUniqueImpl() {
  return Promise.resolve({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelInvoiceLine.findFirst.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoiceLine.create.mockReset();
  prisma.tenant.findUnique.mockReset().mockImplementation(defaultTenantFindUniqueImpl);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/apply-penalty — auth + load gating', () => {
  test('401 when no token', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .send({});
    expect(res.status).toBe(401);
  });

  test('USER role → 403 (verifyRole short-circuits)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('400 INVALID_ID when :id is not numeric', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/not-a-number/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('404 INVOICE_NOT_FOUND when invoice missing', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
  });
});

describe('POST /api/travel/invoices/:id/apply-penalty — status pre-condition', () => {
  test('409 INVOICE_NOT_PAYABLE when status is Draft', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Draft' }),
    );
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_NOT_PAYABLE');
    expect(res.body.currentStatus).toBe('Draft');
    expect(prisma.travelInvoiceLine.create).not.toHaveBeenCalled();
  });

  test('409 INVOICE_NOT_PAYABLE when status is Paid', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Paid' }),
    );
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_NOT_PAYABLE');
  });

  test('409 INVOICE_NOT_PAYABLE when status is Voided', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Voided' }),
    );
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_NOT_PAYABLE');
  });
});

describe('POST /api/travel/invoices/:id/apply-penalty — happy path persistence', () => {
  test('simple-mode default: 30d overdue → line created + audit + 201', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const createdLine = {
      id: 555,
      tenantId: 1,
      invoiceId: 100,
      lineType: 'fee',
      description: 'Late-payment penalty (18% p.a., 23d chargeable)',
      quantity: 1,
      unitPrice: '113.42',
      amount: '113.42',
      currency: 'INR',
      sortOrder: 9999,
      notes: 'mode:simple; ratePercent:18; daysOverdue:30; chargeableDays:23; asOf:2026-06-01T00:00:00.000Z',
    };
    prisma.travelInvoiceLine.create.mockResolvedValue(createdLine);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      { amount: '10000.00' },
      { amount: '113.42' },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('applied');
    expect(res.body.invoiceId).toBe(100);
    expect(res.body.penalty).toBe(113.42);
    expect(res.body.daysOverdue).toBe(30);
    expect(res.body.chargeableDays).toBe(23);
    expect(res.body.mode).toBe('simple');
    expect(res.body.ratePercent).toBe(18);
    expect(res.body.line).toEqual(createdLine);

    // Persistence side-effects.
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.travelInvoiceLine.create.mock.calls[0][0];
    expect(createArgs.data.lineType).toBe('fee');
    expect(createArgs.data.invoiceId).toBe(100);
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.unitPrice).toBe(113.42);
    expect(createArgs.data.amount).toBe(113.42);
    expect(createArgs.data.currency).toBe('INR');
    expect(createArgs.data.sortOrder).toBe(9999);
    expect(createArgs.data.notes).toContain('mode:simple');
    expect(createArgs.data.notes).toContain('ratePercent:18');

    // recomputeInvoiceTotal fired (writes updated total back via update).
    expect(prisma.travelInvoice.update).toHaveBeenCalledTimes(1);

    // Audit row with policy details.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('TRAVEL_INVOICE_PENALTY_APPLIED');
    expect(auditArgs.data.entity).toBe('TravelInvoice');
    // writeAudit JSON-stringifies details before persisting.
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details.lineId).toBe(555);
    expect(details.penalty).toBe(113.42);
    expect(details.mode).toBe('simple');
    expect(details.ratePercent).toBe(18);
    expect(details.daysOverdue).toBe(30);
    expect(details.chargeableDays).toBe(23);
  });

  test('flat-mode override: ₹10,000 × 2% = ₹200 flat penalty line', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockResolvedValue({
      id: 556,
      lineType: 'fee',
      amount: '200.00',
      unitPrice: '200.00',
      currency: 'INR',
    });
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '10200' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF, mode: 'flat' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('applied');
    expect(res.body.mode).toBe('flat');
    expect(res.body.penalty).toBe(200);

    const createArgs = prisma.travelInvoiceLine.create.mock.calls[0][0];
    expect(createArgs.data.unitPrice).toBe(200);
    expect(createArgs.data.amount).toBe(200);
    expect(createArgs.data.description).toContain('flat');
  });

  test('Partial-status invoice accrues penalty just like Issued', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Partial' }),
    );
    prisma.travelInvoiceLine.create.mockResolvedValue({ id: 557, amount: '113.42' });
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '10113.42' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('applied');
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledTimes(1);
  });

  test('operator-supplied description override is persisted on the line', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async ({ data }) => ({
      id: 558,
      ...data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        asOf: FROZEN_ASOF,
        description: 'Custom late-fee per contract clause 7.2',
      });

    expect(res.status).toBe(201);
    const createArgs = prisma.travelInvoiceLine.create.mock.calls[0][0];
    expect(createArgs.data.description).toBe('Custom late-fee per contract clause 7.2');
  });
});

describe('POST /api/travel/invoices/:id/apply-penalty — non-applies branch', () => {
  test('in-grace window → 200 + status:not_applied + NO line created', async () => {
    // 3 days overdue, default 7d grace → reason='IN_GRACE_WINDOW'.
    const due3 = new Date(new Date(FROZEN_ASOF).getTime() - 3 * 86_400_000);
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: due3 }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_applied');
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('IN_GRACE_WINDOW');
    expect(res.body.daysOverdue).toBe(3);
    expect(res.body.chargeableDays).toBe(0);

    // No write side-effects.
    expect(prisma.travelInvoiceLine.create).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('not-yet-due → 200 + status:not_applied + reason:NOT_YET_DUE', async () => {
    const future = new Date(new Date(FROZEN_ASOF).getTime() + 5 * 86_400_000);
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: future }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_applied');
    expect(res.body.reason).toBe('NOT_YET_DUE');
    expect(prisma.travelInvoiceLine.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/invoices/:id/apply-penalty — idempotency', () => {
  test('re-apply with same idempotencyKey → 200 + status:already_applied + NO new create', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const existingLine = {
      id: 999,
      lineType: 'fee',
      amount: '113.42',
      notes: 'mode:simple; ratePercent:18; penaltyKey:run-abc',
    };
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(existingLine);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF, idempotencyKey: 'run-abc' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_applied');
    expect(res.body.line).toEqual(existingLine);
    expect(res.body.idempotencyKey).toBe('run-abc');

    // No new line created; no audit; no recompute.
    expect(prisma.travelInvoiceLine.create).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    // The probe was scoped to this invoice's fee lines + notes match.
    const probeArgs = prisma.travelInvoiceLine.findFirst.mock.calls[0][0];
    expect(probeArgs.where.tenantId).toBe(1);
    expect(probeArgs.where.invoiceId).toBe(100);
    expect(probeArgs.where.lineType).toBe('fee');
    expect(probeArgs.where.notes.contains).toBe('penaltyKey:run-abc');
  });

  test('first-time idempotencyKey threads through to line notes', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(null);
    prisma.travelInvoiceLine.create.mockImplementation(async ({ data }) => ({
      id: 560, ...data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF, idempotencyKey: 'run-xyz' });

    expect(res.status).toBe(201);
    expect(res.body.idempotencyKey).toBe('run-xyz');
    const createArgs = prisma.travelInvoiceLine.create.mock.calls[0][0];
    expect(createArgs.data.notes).toContain('penaltyKey:run-xyz');
  });

  test('400 INVALID_IDEMPOTENCY_KEY when key exceeds 64 chars', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF, idempotencyKey: 'x'.repeat(65) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('POST /api/travel/invoices/:id/apply-penalty — input validation', () => {
  test('400 INVALID_AS_OF when asOf cannot be parsed', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AS_OF');
  });

  test('400 INVALID_MODE when mode is neither simple nor flat', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF, mode: 'tiered' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODE');
  });

  test('400 INVALID_NUMERIC_QUERY when graceDays is negative', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/apply-penalty')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ asOf: FROZEN_ASOF, graceDays: -3 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NUMERIC_QUERY');
  });
});
