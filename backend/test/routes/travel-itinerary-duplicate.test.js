// @ts-check
/**
 * Arc 2 #907 slice 15 — Itinerary full-itinerary duplicate endpoint.
 *
 * Pins POST /api/travel/itineraries/:id/duplicate added to
 * backend/routes/travel_itineraries.js (parent-level clone — clones the
 * Itinerary row + all its ItineraryItem children atomically). Mirrors
 * #900 slice 1 /quotes/:id/duplicate pattern at the itinerary surface.
 *
 * Contracts asserted:
 *   - Tenant scoping (cross-tenant id → 404 ITINERARY_NOT_FOUND).
 *   - Sub-brand denial (subBrandAccess JSON denies source.subBrand → 403
 *     SUB_BRAND_DENIED).
 *   - INVALID_ID on non-numeric :id (400, no DB read fires).
 *   - 404 ITINERARY_NOT_FOUND when source missing (the slice's named
 *     error code, distinct from /items/:itemId/duplicate's NOT_FOUND).
 *   - Happy path: status reset to 'draft', shareToken null, pdfUrl null,
 *     advancePaidAmount/advancePaidAt/paymentReference null, items count
 *     matches source, items receive new ids via createMany.
 *   - Cloned-item field fidelity: itemType, position, description,
 *     detailsJson, supplierId, unitCost (money) preserved as-passed.
 *   - destination override applied + trimmed; whitespace-only falls
 *     back to source destination (defensive — slice 12 convention).
 *   - Empty-items source clones cleanly (no createMany call fires).
 *   - 201 envelope shape includes `items` array (re-fetched after the
 *     transaction since createMany doesn't return rows).
 *   - Auth-gated (verifyToken) — 401 with no token.
 *
 * Pattern mirrors travel-itineraries-item-duplicate.test.js — CJS prisma
 * singleton patched BEFORE the router is required; HS256 JWT via the
 * dev fallback secret. The $transaction is mocked by passing the
 * callback through with a stub tx that re-uses the same prisma mocks
 * so transaction body assertions stay inspectable.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.itinerary = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.itineraryItem = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'USER', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue({ name: 'Test Customer' });
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
const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelItinerariesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function sourceItinerary(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    leadId: 42,
    status: 'accepted', // ensure clone resets to 'draft' regardless
    version: 3,
    parentItineraryId: 77,
    productTier: 'premium',
    destination: 'Goa',
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    endDate: new Date('2026-06-05T00:00:00.000Z'),
    pricingJson: '{"base":45000}',
    totalAmount: '45000.00',
    currency: 'INR',
    pdfUrl: 'https://example.com/old.pdf',
    shareToken: 'parentShare123',
    advancePaidAmount: '22500.00',
    advancePaidAt: new Date('2026-05-15T00:00:00.000Z'),
    paymentReference: 'pay_xyz',
    draftSummary: 'Old summary',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function sourceItem(overrides = {}) {
  return {
    id: 555,
    itineraryId: 100,
    itemType: 'hotel',
    position: 0,
    description: 'Hotel night 1 — Taj Goa',
    detailsJson: JSON.stringify({ nights: 1 }),
    supplierId: 42,
    unitCost: '4000.00',
    markup: '500.00',
    gstAmount: '900.00',
    totalPrice: '5400.00',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Stub $transaction: pass the callback an inline tx that funnels back
// into the same prisma.itinerary / prisma.itineraryItem mocks so the
// assertions can observe data shapes.
function installTxStub() {
  prisma.$transaction.mockImplementation(async (cbOrArr) => {
    if (typeof cbOrArr === 'function') {
      return cbOrArr({
        itinerary: prisma.itinerary,
        itineraryItem: prisma.itineraryItem,
      });
    }
    return Promise.all(cbOrArr);
  });
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itinerary.findUnique.mockReset();
  prisma.itinerary.create.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.itineraryItem.createMany.mockReset();
  prisma.$transaction.mockReset();
  installTxStub();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ name: 'Test Customer' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/itineraries/:id/duplicate — happy paths', () => {
  test('clones parent + all items; resets status / shareToken / pdfUrl / payment fields', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary());
    const items = [
      sourceItem({ id: 555, position: 0, itemType: 'hotel', description: 'Hotel A' }),
      sourceItem({ id: 556, position: 1, itemType: 'flight', description: 'Flight 1' }),
      sourceItem({ id: 557, position: 2, itemType: 'visa', description: 'Visa fee' }),
    ];
    prisma.itineraryItem.findMany.mockResolvedValueOnce(items);
    prisma.itinerary.create.mockImplementation(async ({ data }) => ({
      id: 9001,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      parentItineraryId: null,
      ...data,
    }));
    prisma.itineraryItem.createMany.mockResolvedValueOnce({ count: 3 });
    prisma.itinerary.findUnique.mockResolvedValueOnce({
      id: 9001,
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 999,
      leadId: 42,
      status: 'draft',
      productTier: 'premium',
      destination: 'Goa',
      startDate: new Date('2026-06-01T00:00:00.000Z'),
      endDate: new Date('2026-06-05T00:00:00.000Z'),
      pricingJson: '{"base":45000}',
      totalAmount: '45000.00',
      currency: 'INR',
      pdfUrl: null,
      shareToken: null,
      advancePaidAmount: null,
      advancePaidAt: null,
      paymentReference: null,
      draftSummary: 'Old summary',
      items: items.map((it, idx) => ({
        id: 9100 + idx,
        itineraryId: 9001,
        itemType: it.itemType,
        position: it.position,
        description: it.description,
        detailsJson: it.detailsJson,
        supplierId: it.supplierId,
        unitCost: it.unitCost,
        markup: it.markup,
        gstAmount: it.gstAmount,
        totalPrice: it.totalPrice,
      })),
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(9001);
    expect(res.body.id).not.toBe(100);
    expect(res.body.status).toBe('draft');
    expect(res.body.shareToken).toBeNull();
    expect(res.body.pdfUrl).toBeNull();
    expect(res.body.advancePaidAmount).toBeNull();
    expect(res.body.advancePaidAt).toBeNull();
    expect(res.body.paymentReference).toBeNull();
    // Copyable top-level fields preserved from source.
    expect(res.body.subBrand).toBe('tmc');
    expect(res.body.contactId).toBe(999);
    expect(res.body.currency).toBe('INR');
    expect(res.body.destination).toBe('Goa');
    expect(res.body.productTier).toBe('premium');
    expect(res.body.items).toHaveLength(3);

    // Verify parent create payload pinned the reset / preserve split.
    const createCall = prisma.itinerary.create.mock.calls[0][0].data;
    expect(createCall.status).toBe('draft');
    expect(createCall.shareToken).toBeNull();
    expect(createCall.pdfUrl).toBeNull();
    expect(createCall.advancePaidAmount).toBeNull();
    expect(createCall.advancePaidAt).toBeNull();
    expect(createCall.paymentReference).toBeNull();
    expect(createCall.subBrand).toBe('tmc');
    expect(createCall.tenantId).toBe(1);
  });

  test('each cloned item preserves itemType / position / description / detailsJson / money — ids assigned by Prisma', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary());
    const items = [
      sourceItem({
        id: 555,
        position: 0,
        itemType: 'hotel',
        description: 'Hotel night 1',
        detailsJson: JSON.stringify({ nights: 2, roomType: 'deluxe' }),
        supplierId: 42,
        unitCost: '4000.00',
        markup: '500.00',
        gstAmount: '900.00',
        totalPrice: '5400.00',
      }),
      sourceItem({
        id: 556,
        position: 1,
        itemType: 'flight',
        description: 'IndiGo BLR-GOI',
        detailsJson: JSON.stringify({ pnr: 'ABC123' }),
        supplierId: null,
        unitCost: '7000.00',
        markup: null,
        gstAmount: null,
        totalPrice: '7000.00',
      }),
    ];
    prisma.itineraryItem.findMany.mockResolvedValueOnce(items);
    prisma.itinerary.create.mockImplementation(async ({ data }) => ({
      id: 9002,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      ...data,
    }));
    prisma.itineraryItem.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.itinerary.findUnique.mockResolvedValueOnce({
      id: 9002,
      items: items.map((it, idx) => ({ ...it, id: 9200 + idx, itineraryId: 9002 })),
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(201);
    const cmCall = prisma.itineraryItem.createMany.mock.calls[0][0].data;
    expect(cmCall).toHaveLength(2);
    // No `id` key on cloned-item payloads — Prisma autoincrement must assign.
    expect(cmCall[0]).not.toHaveProperty('id');
    expect(cmCall[1]).not.toHaveProperty('id');
    // Field fidelity per item.
    expect(cmCall[0].itineraryId).toBe(9002);
    expect(cmCall[0].itemType).toBe('hotel');
    expect(cmCall[0].position).toBe(0);
    expect(cmCall[0].description).toBe('Hotel night 1');
    expect(cmCall[0].detailsJson).toBe(JSON.stringify({ nights: 2, roomType: 'deluxe' }));
    expect(cmCall[0].supplierId).toBe(42);
    expect(cmCall[0].unitCost).toBe('4000.00');
    expect(cmCall[1].itemType).toBe('flight');
    expect(cmCall[1].position).toBe(1);
    expect(cmCall[1].detailsJson).toBe(JSON.stringify({ pnr: 'ABC123' }));
    expect(cmCall[1].supplierId).toBeNull();
    expect(cmCall[1].markup).toBeNull();
  });

  test('optional destination override applied + trimmed', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary({ destination: 'Goa' }));
    prisma.itineraryItem.findMany.mockResolvedValueOnce([]);
    prisma.itinerary.create.mockImplementation(async ({ data }) => ({
      id: 9003,
      ...data,
    }));
    prisma.itinerary.findUnique.mockResolvedValueOnce({
      id: 9003,
      destination: 'Bali',
      items: [],
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ destination: '   Bali   ' });

    expect(res.status).toBe(201);
    const createCall = prisma.itinerary.create.mock.calls[0][0].data;
    expect(createCall.destination).toBe('Bali');
  });

  test('whitespace-only destination override falls back to source destination (defensive)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary({ destination: 'Original Place' }));
    prisma.itineraryItem.findMany.mockResolvedValueOnce([]);
    prisma.itinerary.create.mockImplementation(async ({ data }) => ({
      id: 9004,
      ...data,
    }));
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 9004, destination: 'Original Place', items: [] });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ destination: '   \t  ' });

    expect(res.status).toBe(201);
    const createCall = prisma.itinerary.create.mock.calls[0][0].data;
    expect(createCall.destination).toBe('Original Place');
  });

  test('empty-items source: clone has 0 items, createMany NOT called (no empty-tx error)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary());
    prisma.itineraryItem.findMany.mockResolvedValueOnce([]);
    prisma.itinerary.create.mockImplementation(async ({ data }) => ({ id: 9005, ...data }));
    prisma.itinerary.findUnique.mockResolvedValueOnce({ id: 9005, items: [] });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.items).toEqual([]);
    expect(prisma.itineraryItem.createMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/itineraries/:id/duplicate — auth / scoping / errors', () => {
  test('no auth header → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .send({});
    expect(res.status).toBe(401);
  });

  test('non-numeric :id → 400 INVALID_ID (no DB read fires)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/notanumber/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.itinerary.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404 ITINERARY_NOT_FOUND', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/999/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_NOT_FOUND');
    // No items read fires before parent-not-found.
    expect(prisma.itineraryItem.findMany).not.toHaveBeenCalled();
    expect(prisma.itinerary.create).not.toHaveBeenCalled();
  });

  test('source.subBrand denied for caller → 403 SUB_BRAND_DENIED', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // Clone path must NOT run when sub-brand denied.
    expect(prisma.itinerary.create).not.toHaveBeenCalled();
    expect(prisma.itineraryItem.createMany).not.toHaveBeenCalled();
  });

  test('prisma create error inside transaction → 500 generic envelope', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(sourceItinerary());
    prisma.itineraryItem.findMany.mockResolvedValueOnce([]);
    prisma.itinerary.create.mockRejectedValueOnce(new Error('db boom'));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to duplicate itinerary/i);
  });
});
