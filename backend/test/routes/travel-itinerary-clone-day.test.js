// @ts-check
/**
 * Arc 2 #907 slice 6 — Itinerary clone-day endpoint.
 *
 * Pins the bulk-clone-day endpoint added to backend/routes/travel_itineraries.js:
 *
 *   POST /api/travel/itineraries/:id/clone-day   any verified token
 *
 * Body: { sourceItineraryId: Int, sourceDayOffset: Int, targetDayOffset: Int }
 *
 * Contracts asserted:
 *   - Validates sourceItineraryId numeric (INVALID_SOURCE_ID 400).
 *   - Validates sourceDayOffset / targetDayOffset non-negative integer
 *     (INVALID_SOURCE_DAY / INVALID_TARGET_DAY 400).
 *   - Rejects same-itinerary same-day clone (SAME_DAY_CLONE 400).
 *   - 404 SOURCE_NOT_FOUND when source isn't in the requester's tenant.
 *   - 403 SOURCE_SUB_BRAND_DENIED when operator lacks source sub-brand access.
 *   - Filters source items by detailsJson.dayOffset (preferred) or
 *     dayNumber-1 (fallback) — items without a day-source skipped.
 *   - Cloned items get fresh ids + appended positions + rewritten
 *     detailsJson.dayOffset = targetDayOffset (dayNumber dropped).
 *   - Empty source-day → 201 { clonedCount: 0, items: [] } (not an error).
 *   - Target-itinerary load delegates to loadItineraryWithGuard — pin
 *     NOT_FOUND on target (renamed by guard, surfaces as 404 NOT_FOUND).
 *
 * Pattern mirrors travel-itinerary-day-costs.test.js — CJS prisma
 * singleton patched BEFORE the router is required; HS256 JWT via dev
 * fallback secret.
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

function itin(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    status: 'sent',
    destination: 'Goa',
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
  prisma.itineraryItem.findFirst.mockReset().mockResolvedValue(null);
  prisma.itineraryItem.create.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ name: 'Test Customer' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/itineraries/:id/clone-day — happy paths', () => {
  test('clones 2 items from source day 1 → target day 3 with rewritten dayOffset', async () => {
    // 1st findFirst = target load via loadItineraryWithGuard. 2nd = source load.
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 200, subBrand: 'tmc' }))      // target
      .mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));      // source
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, itemType: 'activity', description: 'POI A',
        detailsJson: JSON.stringify({ dayOffset: 1, latitude: 12.34 }),
        totalPrice: '1500.00' }),
      makeItem({ id: 2, itemType: 'hotel', description: 'Hotel B',
        detailsJson: JSON.stringify({ dayOffset: 1 }),
        totalPrice: '6500.00', unitCost: '6000.00', markup: '300.00', gstAmount: '200.00' }),
      makeItem({ id: 3, itemType: 'activity', description: 'POI C — other day',
        detailsJson: JSON.stringify({ dayOffset: 2 }),
        totalPrice: '900.00' }),
    ]);
    // After target items findFirst (max position lookup) — return null (empty target).
    prisma.itineraryItem.findFirst.mockResolvedValue(null);
    let nextCreatedId = 1000;
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: nextCreatedId++,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 1, targetDayOffset: 3 });

    expect(res.status).toBe(201);
    expect(res.body.clonedCount).toBe(2);
    expect(res.body.items).toHaveLength(2);
    // First cloned item: position 0 (empty target), itemType passes through,
    // detailsJson rewrites dayOffset → 3, preserves other keys.
    expect(res.body.items[0]).toMatchObject({
      itineraryId: 200,
      itemType: 'activity',
      position: 0,
      description: 'POI A',
    });
    const d0 = JSON.parse(res.body.items[0].detailsJson);
    expect(d0).toMatchObject({ dayOffset: 3, latitude: 12.34 });
    // Second cloned item: position 1, financial fields flow through.
    expect(res.body.items[1]).toMatchObject({
      itineraryId: 200,
      itemType: 'hotel',
      position: 1,
      description: 'Hotel B',
    });
    expect(JSON.parse(res.body.items[1].detailsJson)).toMatchObject({ dayOffset: 3 });
    expect(Number(res.body.items[1].totalPrice)).toBe(6500);
    expect(Number(res.body.items[1].unitCost)).toBe(6000);
    expect(Number(res.body.items[1].markup)).toBe(300);
    expect(Number(res.body.items[1].gstAmount)).toBe(200);
  });

  test('dayNumber fallback: source items keyed by detailsJson.dayNumber (1-indexed)', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 200, subBrand: 'tmc' }))
      .mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      // dayNumber: 2 → dayOffset 1 — matches sourceDayOffset=1.
      makeItem({ id: 10, itemType: 'activity', description: 'D2 thing',
        detailsJson: JSON.stringify({ dayNumber: 2 }), totalPrice: '700.00' }),
      // dayNumber: 1 → dayOffset 0 — does NOT match.
      makeItem({ id: 11, itemType: 'hotel', description: 'D1 hotel',
        detailsJson: JSON.stringify({ dayNumber: 1 }), totalPrice: '4000.00' }),
    ]);
    prisma.itineraryItem.findFirst.mockResolvedValue({ position: 5 });
    let nextCreatedId = 2000;
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: nextCreatedId++, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 1, targetDayOffset: 4 });

    expect(res.status).toBe(201);
    expect(res.body.clonedCount).toBe(1);
    expect(res.body.items[0].description).toBe('D2 thing');
    // Position appended after target's max (5).
    expect(res.body.items[0].position).toBe(6);
    // detailsJson now uses dayOffset; dayNumber must be dropped.
    const details = JSON.parse(res.body.items[0].detailsJson);
    expect(details.dayOffset).toBe(4);
    expect(details.dayNumber).toBeUndefined();
  });

  test('empty source day → 201 with clonedCount=0 and empty items array (not an error)', async () => {
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 200, subBrand: 'tmc' }))
      .mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));
    prisma.itineraryItem.findMany.mockResolvedValue([
      makeItem({ id: 1, detailsJson: JSON.stringify({ dayOffset: 0 }) }),
      makeItem({ id: 2, detailsJson: JSON.stringify({ dayOffset: 5 }) }),
    ]);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 99, targetDayOffset: 1 });

    expect(res.status).toBe(201);
    expect(res.body.clonedCount).toBe(0);
    expect(res.body.items).toEqual([]);
    // Sanity: no items were created.
    expect(prisma.itineraryItem.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/itineraries/:id/clone-day — validation', () => {
  test('400 INVALID_SOURCE_ID when sourceItineraryId missing', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 200 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceDayOffset: 0, targetDayOffset: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_ID');
  });

  test('400 INVALID_SOURCE_DAY when sourceDayOffset is negative', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 200 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: -1, targetDayOffset: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_DAY');
  });

  test('400 INVALID_TARGET_DAY when targetDayOffset is non-numeric', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 200 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 0, targetDayOffset: 'three' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TARGET_DAY');
  });

  test('400 SAME_DAY_CLONE when source and target are the same itinerary + day', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 2, targetDayOffset: 2 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SAME_DAY_CLONE');
  });
});

describe('POST /api/travel/itineraries/:id/clone-day — auth + tenant scoping', () => {
  test('401 when no Authorization header', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .send({ sourceItineraryId: 100, sourceDayOffset: 0, targetDayOffset: 1 });

    expect(res.status).toBe(401);
  });

  test('404 NOT_FOUND when target itinerary is in another tenant', async () => {
    // loadItineraryWithGuard returns null → 404 NOT_FOUND on target.
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/9999/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 0, targetDayOffset: 1 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('404 SOURCE_NOT_FOUND when source itinerary is in another tenant', async () => {
    // target load ok; source load returns null → SOURCE_NOT_FOUND.
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 200, subBrand: 'tmc' }))
      .mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 9999, sourceDayOffset: 0, targetDayOffset: 1 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
  });

  test('403 SOURCE_SUB_BRAND_DENIED when operator lacks source sub-brand access', async () => {
    // Operator restricted to tmc; source belongs to rfu.
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.itinerary.findFirst
      .mockResolvedValueOnce(itin({ id: 200, subBrand: 'tmc' }))           // target ok
      .mockResolvedValueOnce(itin({ id: 100, subBrand: 'rfu' }));          // source rfu

    const res = await request(makeApp())
      .post('/api/travel/itineraries/200/clone-day')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ sourceItineraryId: 100, sourceDayOffset: 0, targetDayOffset: 1 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOURCE_SUB_BRAND_DENIED');
  });
});
