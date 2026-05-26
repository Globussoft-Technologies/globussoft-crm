// @ts-check
/**
 * Arc 2 #907 slice 12 — Itinerary per-item duplicate endpoint.
 *
 * Pins POST /api/travel/itineraries/:id/items/:itemId/duplicate added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Tenant + sub-brand scoping via loadItineraryWithGuard
 *     (INVALID_ID / NOT_FOUND / SUB_BRAND_DENIED).
 *   - Sub-path :itemId is numeric — INVALID_ITEM_ID on non-numeric.
 *   - Source row scoped to (itineraryId, itemId) — ITEM_NOT_FOUND when
 *     either is wrong.
 *   - All copyable fields preserved verbatim from source: itemType,
 *     description, detailsJson, supplierId, unitCost, markup, gstAmount,
 *     totalPrice. Position auto-appended at max(position)+1.
 *   - Optional body.description override: trims, falls back to source
 *     when empty / whitespace-only.
 *   - 201 envelope returns the freshly created row.
 *   - Auth-gated (verifyToken) — 401 with no token.
 *
 * Pattern mirrors travel-itinerary-day-costs.test.js — CJS prisma
 * singleton patched BEFORE the router is required; HS256 JWT via the
 * dev fallback secret.
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
  update: vi.fn(),
  delete: vi.fn(),
};
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

function parentItinerary(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    leadId: null,
    status: 'sent',
    destination: 'Goa',
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    endDate: new Date('2026-06-05T00:00:00.000Z'),
    totalAmount: '45000.00',
    currency: 'INR',
    pricingJson: null,
    shareToken: null,
    version: 1,
    parentItineraryId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    id: 555,
    itineraryId: 100,
    itemType: 'hotel',
    position: 0,
    description: 'Hotel night 1 — Taj Goa',
    detailsJson: null,
    supplierId: null,
    unitCost: null,
    markup: null,
    gstAmount: null,
    totalPrice: '5000.00',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itineraryItem.findFirst.mockReset();
  prisma.itineraryItem.create.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ name: 'Test Customer' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/itineraries/:id/items/:itemId/duplicate — happy paths', () => {
  test('clones all copyable fields verbatim + appends at max(position)+1', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    const source = makeItem({
      id: 555,
      itemType: 'hotel',
      position: 2,
      description: 'Hotel night 1 — Taj Goa',
      detailsJson: JSON.stringify({ dayOffset: 0, nights: 1, roomType: 'deluxe' }),
      supplierId: 42,
      unitCost: '4000.00',
      markup: '500.00',
      gstAmount: '900.00',
      totalPrice: '5400.00',
    });
    prisma.itineraryItem.findFirst
      // 1st call resolves the source row by (id, itineraryId).
      .mockResolvedValueOnce(source)
      // 2nd call resolves max(position) for append target.
      .mockResolvedValueOnce({ position: 5 });

    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: 9001,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(9001);
    expect(res.body.itemType).toBe('hotel');
    expect(res.body.description).toBe('Hotel night 1 — Taj Goa');
    expect(res.body.detailsJson).toBe(JSON.stringify({ dayOffset: 0, nights: 1, roomType: 'deluxe' }));
    expect(res.body.supplierId).toBe(42);
    expect(res.body.unitCost).toBe(4000);
    expect(res.body.markup).toBe(500);
    expect(res.body.gstAmount).toBe(900);
    expect(res.body.totalPrice).toBe(5400);
    // Append: max(5) + 1 = 6.
    expect(res.body.position).toBe(6);
    expect(res.body.itineraryId).toBe(100);
  });

  test('first-item edge case — no other rows → position 0', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findFirst
      .mockResolvedValueOnce(makeItem({ position: 0 }))
      .mockResolvedValueOnce(null); // no row found in max(position) lookup
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: 9002,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(201);
    // (-1) + 1 = 0 when no max row exists.
    expect(res.body.position).toBe(0);
  });

  test('optional description override applied + trimmed', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findFirst
      .mockResolvedValueOnce(makeItem({ description: 'Original' }))
      .mockResolvedValueOnce({ position: 0 });
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: 9003,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ description: '   Hotel Day 5 — backup option   ' });

    expect(res.status).toBe(201);
    expect(res.body.description).toBe('Hotel Day 5 — backup option');
  });

  test('whitespace-only override falls back to source description', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findFirst
      .mockResolvedValueOnce(makeItem({ description: 'Original line' }))
      .mockResolvedValueOnce({ position: 0 });
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: 9004,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ description: '   \t  ' });

    expect(res.status).toBe(201);
    expect(res.body.description).toBe('Original line');
  });

  test('nullable money fields preserved as null (no NaN coercion)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findFirst
      .mockResolvedValueOnce(
        makeItem({
          unitCost: null,
          markup: null,
          gstAmount: null,
          totalPrice: null,
          supplierId: null,
          detailsJson: null,
        }),
      )
      .mockResolvedValueOnce({ position: 0 });
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: 9005,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.unitCost).toBeNull();
    expect(res.body.markup).toBeNull();
    expect(res.body.gstAmount).toBeNull();
    expect(res.body.totalPrice).toBeNull();
    expect(res.body.supplierId).toBeNull();
    expect(res.body.detailsJson).toBeNull();
  });
});

describe('POST /api/travel/itineraries/:id/items/:itemId/duplicate — auth / scoping', () => {
  test('no auth header → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .send({});
    expect(res.status).toBe(401);
  });

  test('cross-tenant itinerary → 404 NOT_FOUND', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    // Source-row lookup must NOT fire before parent-not-found.
    expect(prisma.itineraryItem.findFirst).not.toHaveBeenCalled();
  });

  test('sub-brand denial → 403 SUB_BRAND_DENIED', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('non-numeric itemId → 400 INVALID_ITEM_ID', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/notanumber/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_ID');
    // No DB read for the source row when itemId is malformed.
    expect(prisma.itineraryItem.findFirst).not.toHaveBeenCalled();
  });

  test('item belongs to a different itinerary → 404 ITEM_NOT_FOUND', async () => {
    // Parent itinerary 100 resolves fine, but item 555 lives on itin 200.
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITEM_NOT_FOUND');
    // create() must NOT fire when source resolution fails.
    expect(prisma.itineraryItem.create).not.toHaveBeenCalled();
  });

  test('prisma create error → 500 generic envelope', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary());
    prisma.itineraryItem.findFirst
      .mockResolvedValueOnce(makeItem())
      .mockResolvedValueOnce({ position: 0 });
    prisma.itineraryItem.create.mockRejectedValueOnce(new Error('db boom'));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/555/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to duplicate item/i);
  });
});
