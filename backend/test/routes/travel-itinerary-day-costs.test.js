// @ts-check
/**
 * Arc 2 #907 slice 2 — Itinerary per-day cost endpoint.
 *
 * Pins the read-only endpoint added to backend/routes/travel_itineraries.js:
 *
 *   GET /api/travel/itineraries/:id/day-costs    any verified token
 *
 * Consumes lib/itineraryDayCostCalculator.js (slice 1, commit 3072e5bf).
 *
 * Contracts asserted:
 *   - Loads parent itinerary tenant-scoped + sub-brand-scoped (shared
 *     loadItineraryWithGuard helper → INVALID_ID / ITINERARY_NOT_FOUND /
 *     SUB_BRAND_DENIED shape).
 *   - Maps ItineraryItem rows → helper input shape ({ cost, itemType,
 *     dayOffset|dayNumber|date }) by parsing detailsJson + reading
 *     totalPrice (fallback unitCost).
 *   - tripStart precedence: ?tripStart query > itinerary.startDate >
 *     today UTC.
 *   - Returns helper envelope { itineraryId, days, grandTotal, totalDays,
 *     averageDailyCost }.
 *   - Item with dayOffset=0 + dayOffset=1 → 2 days; dayNumber=2 converts
 *     to dayOffset=1; date-based items resolve against tripStart.
 *   - byType groups items per type within a day.
 *   - averageDailyCost === grandTotal / totalDays (rounded to 2 dp).
 *
 * Pattern mirrors travel-quote-pricing-preview.test.js (CJS prisma
 * singleton patched BEFORE the router is required; HS256 JWT via the
 * dev fallback secret).
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
    description: 'Hotel night 1',
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

describe('GET /api/travel/itineraries/:id/day-costs — happy paths', () => {
  test('3 items across 2 days → days length=2, grandTotal correct, averageDailyCost rounded', async () => {
    // loadItineraryWithGuard issues 1 findFirst, then handler issues a second
    // findFirst with a narrower select. Stub both with mockResolvedValueOnce.
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: parentItinerary().startDate });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'hotel', totalPrice: '5000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 2, itemType: 'flight', totalPrice: '12000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 3, itemType: 'activity', totalPrice: '3000.00',
        detailsJson: JSON.stringify({ dayOffset: 1 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itineraryId).toBe(100);
    expect(res.body.days).toHaveLength(2);
    expect(res.body.grandTotal).toBe(20000);
    expect(res.body.totalDays).toBe(2);
    expect(res.body.averageDailyCost).toBe(10000);
    expect(res.body.days[0]).toMatchObject({
      dayOffset: 0,
      totalCost: 17000,
      itemCount: 2,
    });
    expect(res.body.days[0].byType).toMatchObject({ hotel: 5000, flight: 12000 });
    expect(res.body.days[1]).toMatchObject({
      dayOffset: 1,
      totalCost: 3000,
      itemCount: 1,
    });
  });

  test('empty itinerary (0 items) → grandTotal=0, totalDays=0, days=[]', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: null });
    prisma.itineraryItem.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      itineraryId: 100,
      days: [],
      grandTotal: 0,
      totalDays: 0,
      averageDailyCost: 0,
    });
  });

  test('item with dayNumber=2 converts to dayOffset=1', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: parentItinerary().startDate });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'hotel', totalPrice: '7500.00',
        detailsJson: JSON.stringify({ dayNumber: 2 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0].dayOffset).toBe(1);
    expect(res.body.days[0].totalCost).toBe(7500);
  });

  test('absolute date-based item resolves against itinerary.startDate', async () => {
    const startDate = new Date('2026-06-01T00:00:00.000Z');
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary({ startDate }))
      .mockResolvedValueOnce({ id: 100, startDate });
    // Item on day 3 of trip (2026-06-04) → dayOffset=3.
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'activity', totalPrice: '2000.00',
        detailsJson: JSON.stringify({ date: '2026-06-04' }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0].dayOffset).toBe(3);
  });

  test('?tripStart override re-bases day grouping (date-based items)', async () => {
    // Itinerary's startDate is June 1; query overrides to June 4 → an item
    // dated June 4 lands at dayOffset=0 instead of dayOffset=3.
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: parentItinerary().startDate });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'activity', totalPrice: '2000.00',
        detailsJson: JSON.stringify({ date: '2026-06-04' }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs?tripStart=2026-06-04')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0].dayOffset).toBe(0);
  });

  test('byType groups items per type within the same day', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: parentItinerary().startDate });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'hotel', totalPrice: '5000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 2, itemType: 'hotel', totalPrice: '3000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 3, itemType: 'flight', totalPrice: '12000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0].byType).toMatchObject({
      hotel: 8000,
      flight: 12000,
    });
    expect(res.body.days[0].totalCost).toBe(20000);
  });

  test('cost falls back to unitCost when totalPrice is null', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: parentItinerary().startDate });
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'transfer', totalPrice: null, unitCost: '1500.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.grandTotal).toBe(1500);
    expect(res.body.days[0].totalCost).toBe(1500);
  });

  test('averageDailyCost equals round2(grandTotal / totalDays)', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockResolvedValueOnce({ id: 100, startDate: parentItinerary().startDate });
    // 3 days, irregular costs → average should be rounded half-up to 2 dp.
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({
        id: 1, itemType: 'hotel', totalPrice: '1000.00',
        detailsJson: JSON.stringify({ dayOffset: 0 }),
      }),
      makeItem({
        id: 2, itemType: 'hotel', totalPrice: '2000.00',
        detailsJson: JSON.stringify({ dayOffset: 1 }),
      }),
      makeItem({
        id: 3, itemType: 'hotel', totalPrice: '3000.01',
        detailsJson: JSON.stringify({ dayOffset: 2 }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalDays).toBe(3);
    expect(res.body.grandTotal).toBe(6000.01);
    expect(res.body.averageDailyCost).toBe(2000); // round2(6000.01 / 3)
  });
});

describe('GET /api/travel/itineraries/:id/day-costs — auth / scoping', () => {
  test('cross-tenant → 404 ITINERARY_NOT_FOUND', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_NOT_FOUND');
    // Items should NOT have been queried before parent-not-found.
    expect(prisma.itineraryItem.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denial → 403 SUB_BRAND_DENIED', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(parentItinerary({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('INVALID_ID non-numeric → 400', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/notanumber/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.itinerary.findFirst).not.toHaveBeenCalled();
  });

  test('no auth header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/itineraries/100/day-costs');
    expect(res.status).toBe(401);
  });

  test('prisma error → 500 generic envelope', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(parentItinerary())
      .mockRejectedValueOnce(new Error('boom'));

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/day-costs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to compute per-day costs/i);
  });
});
