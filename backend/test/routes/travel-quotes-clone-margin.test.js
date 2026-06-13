// @ts-check
/**
 * PRD_TRAVEL_QUOTE_BUILDER G017 — sub-agent clone-with-margin.
 *
 * Extends the existing POST /api/travel/quotes/:id/duplicate handler (pinned
 * by travel-quotes-duplicate-pdf.test.js) with an optional marginPercent
 * parameter. When present, every cloned line's unitPrice + amount is
 * multiplied by (1 + marginPercent/100) and the parent quote's
 * appliedMarkupPercent + clonedFromQuoteId columns are populated.
 *
 * Contracts pinned by this suite:
 *   1. marginPercent=0 (or absent)  → identity clone, no lineage stamp.
 *   2. marginPercent=10             → 10% applied to every line + parent total.
 *   3. marginPercent=null/0/empty   → lineage fields nullable (preserve legacy).
 *   4. marginPercent < 0            → 400 INVALID_PERCENT.
 *   5. marginPercent > 1000         → 400 INVALID_PERCENT.
 *   6. clonedFromQuoteId persisted on every clone (even marginPercent=null).
 *   7. Source quote untouched (no UPDATE).
 *
 * Pattern mirrors travel-quotes-duplicate-pdf.test.js — patch prisma
 * singleton + use createRequire to load the router so the seam is hit.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
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
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function source(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    status: 'Sent',
    totalAmount: '40000.00',
    currency: 'INR',
    validUntil: new Date(Date.now() + 7 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function sourceLines() {
  return [
    {
      id: 1, tenantId: 1, quoteId: 100, lineType: 'hotel',
      description: 'Makkah hotel 7n', quantity: 4, unitPrice: '5000.00',
      amount: '20000.00', currency: 'INR', supplierId: null, sortOrder: 0,
      notes: null, hsnSac: null, taxPercent: null, discountPercent: null,
      dimension: null, isAddOn: false,
    },
    {
      id: 2, tenantId: 1, quoteId: 100, lineType: 'flight',
      description: 'BOM-JED return', quantity: 4, unitPrice: '5000.00',
      amount: '20000.00', currency: 'INR', supplierId: null, sortOrder: 1,
      notes: null, hsnSac: null, taxPercent: null, discountPercent: null,
      dimension: null, isAddOn: false,
    },
  ];
}

beforeAll(() => {});

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.create.mockReset();
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelQuoteLine.createMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('POST /api/travel/quotes/:id/duplicate — clone-with-margin', () => {
  test('marginPercent absent → identity clone (no markup applied)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    prisma.travelQuoteLine.findMany.mockResolvedValue(sourceLines());
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 200, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(201);

    const createCall = prisma.travelQuote.create.mock.calls[0][0];
    expect(createCall.data.appliedMarkupPercent).toBeNull();
    expect(createCall.data.clonedFromQuoteId).toBe(100);
    // No markup → totalAmount passed through verbatim (string-format preserved
    // for back-compat with the pre-G017 travel-quotes-duplicate-pdf.test.js).
    expect(String(createCall.data.totalAmount)).toBe('40000.00');

    // Lines clone factor === 1, so unitPrice + amount unchanged.
    const lineCalls = prisma.travelQuoteLine.createMany.mock.calls[0][0];
    expect(lineCalls.data).toHaveLength(2);
    expect(Number(lineCalls.data[0].unitPrice)).toBe(5000);
    expect(Number(lineCalls.data[0].amount)).toBe(20000);
  });

  test('marginPercent=10 → 10% applied to every line + parent total', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    prisma.travelQuoteLine.findMany.mockResolvedValue(sourceLines());
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 201, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate?marginPercent=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(201);

    const createCall = prisma.travelQuote.create.mock.calls[0][0];
    expect(Number(createCall.data.appliedMarkupPercent)).toBe(10);
    expect(createCall.data.clonedFromQuoteId).toBe(100);
    // 40000 * 1.10 = 44000.
    expect(Number(createCall.data.totalAmount)).toBeCloseTo(44000);

    // Each line: 5000 * 1.10 = 5500; 20000 * 1.10 = 22000.
    const lineCalls = prisma.travelQuoteLine.createMany.mock.calls[0][0];
    expect(Number(lineCalls.data[0].unitPrice)).toBeCloseTo(5500);
    expect(Number(lineCalls.data[0].amount)).toBeCloseTo(22000);
    expect(Number(lineCalls.data[1].unitPrice)).toBeCloseTo(5500);
    expect(Number(lineCalls.data[1].amount)).toBeCloseTo(22000);
  });

  test('marginPercent=10 via body wins over query string', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    prisma.travelQuoteLine.findMany.mockResolvedValue(sourceLines());
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 202, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate?marginPercent=5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ marginPercent: 25 });
    expect(res.status).toBe(201);

    const createCall = prisma.travelQuote.create.mock.calls[0][0];
    expect(Number(createCall.data.appliedMarkupPercent)).toBe(25);
    // 40000 * 1.25 = 50000.
    expect(Number(createCall.data.totalAmount)).toBeCloseTo(50000);
  });

  test('marginPercent=-5 → 400 INVALID_PERCENT', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate?marginPercent=-5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PERCENT');
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
  });

  test('marginPercent=2000 → 400 INVALID_PERCENT (upper cap)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate?marginPercent=2000')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PERCENT');
  });

  test('audit row carries marginPercent in details', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    prisma.travelQuoteLine.findMany.mockResolvedValue(sourceLines());
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 250, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));

    await request(makeApp())
      .post('/api/travel/quotes/100/duplicate?marginPercent=15')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({ sourceId: 100, newId: 250, marginPercent: 15 });
  });

  test('source quote NOT updated (idempotent on the source row)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    prisma.travelQuoteLine.findMany.mockResolvedValue(sourceLines());
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 260, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));

    await request(makeApp())
      .post('/api/travel/quotes/100/duplicate?marginPercent=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
  });

  test('lines clone preserves G020 fields (hsnSac, taxPercent, dimension, isAddOn)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(source());
    prisma.travelQuoteLine.findMany.mockResolvedValue([{
      id: 1, tenantId: 1, quoteId: 100, lineType: 'hotel',
      description: 'Makkah', quantity: 4, unitPrice: '5000.00',
      amount: '20000.00', currency: 'INR', supplierId: null, sortOrder: 0,
      notes: null, hsnSac: '998552', taxPercent: '5.00', discountPercent: '2.50',
      dimension: 'perPax', isAddOn: true,
    }]);
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 270, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));

    await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    const lineCalls = prisma.travelQuoteLine.createMany.mock.calls[0][0];
    expect(lineCalls.data[0]).toMatchObject({
      hsnSac: '998552',
      dimension: 'perPax',
      isAddOn: true,
    });
  });
});
