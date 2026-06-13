// @ts-check
/**
 * G039 — Supplier dispute history + chargeback log
 * (PRD_TRAVEL_SUPPLIER_MASTER FR-3.1.g + FR-3.6.a-c).
 *
 * Pins the contract for the operator-facing dispute endpoints under
 * /api/travel/suppliers/:id/disputes[...]  and /api/travel/disputes/stats.
 *
 * What's pinned
 * -------------
 *   - POST happy:    outbound dispute creation (201) with required fields.
 *   - POST validation: direction/type/amount/description all required;
 *                     amount must be non-negative; invalid direction/type
 *                     → 400 with stable codes.
 *   - POST payable FK:  validates payableId belongs to (tenantId, supplierId).
 *   - POST evidence:    evidenceUrls must be array of strings → 400.
 *   - GET list:      paged + status / direction / type filter validation.
 *   - GET detail:    cross-supplier 404.
 *   - PUT:           open → in_review allowed; arbitrary status flip → 400;
 *                    editing resolved dispute → 409 DISPUTE_CLOSED.
 *   - RESOLVE:       ADMIN only; resolution required; sets resolvedBy +
 *                    resolvedAt + status.
 *   - RESOLVE rejected:  flag `rejected: true` flips to 'rejected' status.
 *   - ESCALATE:      open → escalated; from resolved → 409.
 *   - STATS:         tenant rollup of byStatus + openCount + openAmount +
 *                    avgResolutionDays.
 *   - Sub-brand:     MANAGER scoped to ['tmc'] reading RFU supplier → 403.
 *
 * Pattern mirrors backend/test/routes/travel-suppliers-credentials.test.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findFirst = vi.fn();
prisma.travelInvoice = prisma.travelInvoice || {};
prisma.travelInvoice.findFirst = vi.fn();
prisma.travelSupplierDispute = prisma.travelSupplierDispute || {};
prisma.travelSupplierDispute.findFirst = vi.fn();
prisma.travelSupplierDispute.findMany = vi.fn();
prisma.travelSupplierDispute.create = vi.fn();
prisma.travelSupplierDispute.update = vi.fn();
prisma.travelSupplierDispute.count = vi.fn();
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

const SUPPLIER_TMC = {
  id: 42, name: 'Grand Hilton Mumbai', supplierCategory: 'hotel', subBrand: 'tmc', tenantId: 1,
};
const SUPPLIER_RFU = {
  id: 99, name: 'Al-Madinah Plaza', supplierCategory: 'hotel', subBrand: 'rfu', tenantId: 1,
};

function makeDispute(over = {}) {
  return {
    id: 10, tenantId: 1, supplierId: 42, payableId: null, invoiceId: null,
    direction: 'outbound', type: 'service_failure', status: 'open',
    amount: '1500.00', currency: 'INR',
    description: 'Hotel rooms not delivered as booked',
    evidenceUrls: null,
    raisedBy: 7, raisedAt: new Date('2026-06-01T00:00:00Z'),
    resolvedAt: null, resolvedBy: null, resolution: null, refundedAmount: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierPayable.findFirst.mockReset();
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelSupplierDispute.findFirst.mockReset();
  prisma.travelSupplierDispute.findMany.mockReset();
  prisma.travelSupplierDispute.create.mockReset();
  prisma.travelSupplierDispute.update.mockReset();
  prisma.travelSupplierDispute.count.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/suppliers/:id/disputes (raise)', () => {
  test('happy path: outbound service_failure created (201)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 10, ...data, createdAt: new Date(), updatedAt: new Date(), raisedAt: new Date() }),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        direction: 'outbound',
        type: 'service_failure',
        amount: 1500,
        description: 'Hotel rooms not delivered',
      });

    expect(res.status).toBe(201);
    expect(res.body.direction).toBe('outbound');
    expect(res.body.type).toBe('service_failure');
    expect(res.body.status).toBe('open');
    expect(res.body.amount).toBe('1500');
    expect(res.body.currency).toBe('INR');
    expect(res.body.raisedBy).toBe(7);
  });

  test('missing direction → 400 MISSING_FIELDS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ type: 'service_failure', amount: 100, description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('invalid direction → 400 INVALID_DIRECTION', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ direction: 'sideways', type: 'overbill', amount: 100, description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIRECTION');
  });

  test('invalid type → 400 INVALID_TYPE', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ direction: 'outbound', type: 'banana', amount: 100, description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TYPE');
  });

  test('negative amount → 400 INVALID_AMOUNT', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ direction: 'outbound', type: 'overbill', amount: -100, description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('payableId from wrong supplier → 400 PAYABLE_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        direction: 'outbound', type: 'overbill', amount: 100, description: 'x',
        payableId: 999,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYABLE_NOT_FOUND');
  });

  test('payableId valid: persists FK linkage', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue({ id: 55 });
    prisma.travelSupplierDispute.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 10, ...data, createdAt: new Date(), updatedAt: new Date(), raisedAt: new Date() }),
    );
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        direction: 'outbound', type: 'overbill', amount: 100, description: 'x',
        payableId: 55,
      });
    expect(res.status).toBe(201);
    expect(res.body.payableId).toBe(55);
  });

  test('evidenceUrls non-array → 400 INVALID_EVIDENCE', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        direction: 'outbound', type: 'overbill', amount: 100, description: 'x',
        evidenceUrls: 'not-an-array',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EVIDENCE');
  });

  test('evidenceUrls array of strings: serialized as JSON blob', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 10, ...data, createdAt: new Date(), updatedAt: new Date(), raisedAt: new Date() }),
    );
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        direction: 'outbound', type: 'overbill', amount: 100, description: 'x',
        evidenceUrls: ['http://a', 'http://b'],
      });
    expect(res.status).toBe(201);
    expect(res.body.evidenceUrls).toBe(JSON.stringify(['http://a', 'http://b']));
  });
});

describe('GET /api/travel/suppliers/:id/disputes (list)', () => {
  test('happy path: paged list returns disputes + total', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.count.mockResolvedValue(3);
    prisma.travelSupplierDispute.findMany.mockResolvedValue([makeDispute(), makeDispute({ id: 11 })]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.disputes).toHaveLength(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  test('invalid status filter → 400', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/disputes?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });

  test('USER role can list (read-side)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.count.mockResolvedValue(0);
    prisma.travelSupplierDispute.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/disputes')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
  });

  test('MANAGER scoped to [tmc] blocked from rfu supplier disputes', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_RFU);
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']) });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/99/disputes')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });
});

describe('GET /api/travel/suppliers/:id/disputes/:disputeId (detail)', () => {
  test('happy path', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute());
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/disputes/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(10);
  });

  test('not found returns 404', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/disputes/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('PUT /api/travel/suppliers/:id/disputes/:disputeId', () => {
  test('open → in_review allowed', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'open' }));
    prisma.travelSupplierDispute.update.mockImplementation(({ data }) =>
      Promise.resolve(makeDispute({ ...data })),
    );

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/disputes/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'in_review' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_review');
  });

  test('flipping to resolved via PUT → 400 INVALID_STATUS_TRANSITION', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'open' }));
    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/disputes/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  test('editing resolved dispute → 409 DISPUTE_CLOSED', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'resolved' }));
    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/disputes/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'updated' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DISPUTE_CLOSED');
  });

  test('empty body → 400 EMPTY_BODY', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'open' }));
    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/disputes/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
  });
});

describe('POST /api/travel/suppliers/:id/disputes/:disputeId/resolve', () => {
  test('happy path: ADMIN resolves with resolution + refundedAmount', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'in_review' }));
    prisma.travelSupplierDispute.update.mockImplementation(({ data }) =>
      Promise.resolve(makeDispute({ ...data })),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/resolve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ resolution: 'Supplier issued credit note', refundedAmount: 1500 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.resolution).toBe('Supplier issued credit note');
    expect(res.body.resolvedBy).toBe(7);
    expect(res.body.refundedAmount).toBe('1500');
  });

  test('MANAGER cannot resolve → 403', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/resolve')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ resolution: 'x' });
    expect(res.status).toBe(403);
  });

  test('missing resolution → 400 MISSING_FIELDS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'open' }));
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/resolve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('rejected=true flips status to rejected', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'in_review' }));
    prisma.travelSupplierDispute.update.mockImplementation(({ data }) =>
      Promise.resolve(makeDispute({ ...data })),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/resolve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ resolution: 'No grounds', rejected: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('already-resolved dispute → 409 DISPUTE_CLOSED', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'resolved' }));
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/resolve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ resolution: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DISPUTE_CLOSED');
  });
});

describe('POST /api/travel/suppliers/:id/disputes/:disputeId/escalate', () => {
  test('open → escalated', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'open' }));
    prisma.travelSupplierDispute.update.mockImplementation(({ data }) =>
      Promise.resolve(makeDispute({ ...data })),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/escalate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('escalated');
  });

  test('from resolved → 409', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.travelSupplierDispute.findFirst.mockResolvedValue(makeDispute({ status: 'resolved' }));
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/disputes/10/escalate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('GET /api/travel/disputes/stats', () => {
  test('tenant rollup: byStatus + openCount + avgResolutionDays', async () => {
    prisma.travelSupplierDispute.findMany.mockResolvedValue([
      // 2 open disputes
      { status: 'open', amount: '1000.00', raisedAt: new Date('2026-06-01'), resolvedAt: null },
      { status: 'open', amount: '500.00', raisedAt: new Date('2026-06-02'), resolvedAt: null },
      // 1 in_review
      { status: 'in_review', amount: '750.00', raisedAt: new Date('2026-06-03'), resolvedAt: null },
      // 1 resolved (3 days)
      {
        status: 'resolved', amount: '2000.00',
        raisedAt: new Date('2026-05-01T00:00:00Z'),
        resolvedAt: new Date('2026-05-04T00:00:00Z'),
      },
      // 1 rejected (1 day)
      {
        status: 'rejected', amount: '300.00',
        raisedAt: new Date('2026-05-10T00:00:00Z'),
        resolvedAt: new Date('2026-05-11T00:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/disputes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual({
      open: 2, in_review: 1, resolved: 1, rejected: 1, escalated: 0,
    });
    expect(res.body.openCount).toBe(3);     // 2 open + 1 in_review (escalated excluded since 0)
    expect(res.body.openAmount).toBe(2250); // 1000 + 500 + 750
    expect(res.body.resolvedCount).toBe(2);
    expect(res.body.avgResolutionDays).toBe(2); // (3 + 1) / 2
    expect(res.body.total).toBe(5);
  });

  test('empty: avgResolutionDays=null', async () => {
    prisma.travelSupplierDispute.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/disputes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.avgResolutionDays).toBeNull();
    expect(res.body.total).toBe(0);
  });

  test('USER role gets 403', async () => {
    const res = await request(makeApp())
      .get('/api/travel/disputes/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });
});
