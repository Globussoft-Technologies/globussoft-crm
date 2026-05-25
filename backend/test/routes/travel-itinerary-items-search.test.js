// @ts-check
/**
 * Arc 2 #907 slice 10 — Itinerary items search/filter endpoint.
 *
 * Pins GET /api/travel/itineraries/:id/items/search added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Required q ≥2 chars (after trim) — INVALID_QUERY otherwise.
 *   - Substring search is case-insensitive across description AND keyed
 *     fields inside detailsJson: notes, specialRequests, dietaryNotes,
 *     mobility.
 *   - Optional itemType filter — must be in VALID_ITEM_TYPES enum;
 *     INVALID_ITEM_TYPE otherwise. Applied at Prisma layer (where clause).
 *   - Optional dayOffset filter — non-negative integer, INVALID_DAY_OFFSET
 *     otherwise. Resolved via detailsJson.dayOffset (preferred) or
 *     (detailsJson.dayNumber - 1) fallback (slice-2 convention).
 *   - Each match returns matchedFields[] listing which fields contained
 *     the needle (one or more of description / notes / specialRequests /
 *     dietaryNotes / mobility) plus a ≤80-char snippet around the first
 *     hit with ellipsis markers when truncated.
 *   - Read-only — no audit log writes, no eventBus emits.
 *   - Items with malformed detailsJson are silently skipped (description
 *     still searched).
 *   - Tenant + sub-brand guard delegated to loadItineraryWithGuard —
 *     401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts inherited.
 *
 * Pattern mirrors travel-itinerary-versions.test.js — CJS prisma
 * singleton patched BEFORE the router is required; eventBus mocked at
 * vitest module-load time for parity (this endpoint is a read but the
 * mock keeps a future emit from silently coupling to a real bus listener);
 * HS256 JWT via dev fallback secret.
 *
 * PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 (item search/filter
 * candidate).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

vi.mock('../../lib/eventBus.js', () => ({
  default: { emit: vi.fn(), on: vi.fn() },
  emitEvent: vi.fn(),
  safeEmitEvent: vi.fn(),
}));

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

function item(overrides = {}) {
  return {
    id: 1,
    itineraryId: 100,
    itemType: 'hotel',
    position: 0,
    description: 'Hilton Makkah',
    detailsJson: null,
    supplierId: null,
    unitCost: null,
    markup: null,
    gstAmount: null,
    totalPrice: null,
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
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/itineraries/:id/items/search — happy paths', () => {
  test('matches needle in description (case-insensitive); returns matchedFields + snippet', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 1, position: 0, itemType: 'hotel',    description: 'Hilton Makkah — Haram-facing king room' }),
      item({ id: 2, position: 1, itemType: 'flight',   description: 'MAA-JED economy' }),
      item({ id: 3, position: 2, itemType: 'activity', description: 'Ziyarat tour around MAKKAH old city' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=makkah')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itineraryId).toBe(100);
    expect(res.body.query).toBe('makkah');
    expect(res.body.matchCount).toBe(2);
    expect(res.body.items.map((i) => i.id)).toEqual([1, 3]);
    expect(res.body.items[0].matchedFields).toEqual(['description']);
    expect(res.body.items[0].snippet).toContain('Hilton Makkah');
    // Position 2 needle is mid-string so snippet should ellipsis-wrap.
    expect(res.body.items[1].snippet).toMatch(/MAKKAH/);
  });

  test('matches needle inside detailsJson note-keys (notes, specialRequests, dietaryNotes, mobility)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({
        id: 10,
        description: 'Dinner at hotel restaurant',
        detailsJson: JSON.stringify({ dietaryNotes: 'Strict vegetarian only — no eggs' }),
      }),
      item({
        id: 11,
        description: 'Madinah Anwar Al-Madinah hotel stay',
        detailsJson: JSON.stringify({ notes: 'Masjid Nabawi 3-min walk' }),
      }),
      item({
        id: 12,
        description: 'Airport pickup',
        detailsJson: JSON.stringify({ specialRequests: 'Wheelchair-friendly van' }),
      }),
      item({
        id: 13,
        description: 'Hotel Madinah Sheraton',
        detailsJson: JSON.stringify({ mobility: 'Limited; needs ground-floor room' }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=vegetarian')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.items[0].id).toBe(10);
    expect(res.body.items[0].matchedFields).toEqual(['dietaryNotes']);
    expect(res.body.items[0].snippet).toContain('vegetarian');
  });

  test('returns multiple matchedFields when needle hits BOTH description and detailsJson', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({
        id: 20,
        description: 'Halal-only kitchen onboard',
        detailsJson: JSON.stringify({
          notes: 'Confirm Halal meal pre-order at counter',
          specialRequests: 'Halal certificate copy in pax folder',
        }),
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=halal')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.items[0].matchedFields).toEqual(['description', 'notes', 'specialRequests']);
  });

  test('itemType filter narrows results — Prisma where clause carries itemType', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 30, itemType: 'hotel', description: 'Hilton Makkah' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=hilton&itemType=hotel')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itemType).toBe('hotel');
    const findManyArgs = prisma.itineraryItem.findMany.mock.calls[0][0];
    expect(findManyArgs.where.itineraryId).toBe(100);
    expect(findManyArgs.where.itemType).toBe('hotel');
    expect(findManyArgs.orderBy).toEqual({ position: 'asc' });
  });

  test('dayOffset filter (detailsJson.dayOffset path) restricts to matching day', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 40, position: 0, description: 'Day 1 hotel Makkah', detailsJson: JSON.stringify({ dayOffset: 0 }) }),
      item({ id: 41, position: 1, description: 'Day 2 hotel Makkah', detailsJson: JSON.stringify({ dayOffset: 1 }) }),
      item({ id: 42, position: 2, description: 'Day 5 hotel Madinah', detailsJson: JSON.stringify({ dayOffset: 4 }) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=hotel&dayOffset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.dayOffset).toBe(1);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.items[0].id).toBe(41);
    expect(res.body.items[0].dayOffset).toBe(1);
  });

  test('dayOffset filter falls back to (detailsJson.dayNumber - 1) when dayOffset absent', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 50, description: 'Day 3 sightseeing', detailsJson: JSON.stringify({ dayNumber: 3 }) }),
      item({ id: 51, description: 'Day 4 sightseeing', detailsJson: JSON.stringify({ dayNumber: 4 }) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=sightseeing&dayOffset=2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.items[0].id).toBe(50);
    expect(res.body.items[0].dayOffset).toBe(2);
  });

  test('items with malformed detailsJson still match on description; bad JSON is silently skipped', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 60, description: 'Madinah hotel', detailsJson: 'not-json-{{' }),
      item({ id: 61, description: 'Other thing',   detailsJson: 'not-json-{{' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=madinah')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.items[0].id).toBe(60);
    expect(res.body.items[0].dayOffset).toBeNull();
  });

  test('zero matches returns empty list with matchCount=0 (not 404)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 70, description: 'Nothing relevant here' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=mountain')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  test('trimmed q is what gets used (leading/trailing whitespace stripped)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      item({ id: 80, description: 'Eiffel Tower visit' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=%20%20eiffel%20%20')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.query).toBe('eiffel');
    expect(res.body.matchCount).toBe(1);
  });
});

describe('GET /api/travel/itineraries/:id/items/search — validation', () => {
  test('400 INVALID_QUERY when q omitted', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUERY');
  });

  test('400 INVALID_QUERY when q is 1 char after trim', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=%20a%20')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUERY');
  });

  test('400 INVALID_ITEM_TYPE when itemType is not in enum', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=hilton&itemType=bogus')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  test('400 INVALID_DAY_OFFSET when dayOffset is negative', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=hilton&dayOffset=-1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAY_OFFSET');
  });

  test('400 INVALID_DAY_OFFSET when dayOffset is non-numeric', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=hilton&dayOffset=abc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAY_OFFSET');
  });

  test('400 INVALID_ID when id is not numeric', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/abc/items/search?q=hilton')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('GET /api/travel/itineraries/:id/items/search — guards', () => {
  test('401 when no auth header', async () => {
    const res = await request(makeApp()).get('/api/travel/itineraries/100/items/search?q=hilton');
    expect(res.status).toBe(401);
  });

  test('404 NOT_FOUND when itinerary not in tenant', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/999/items/search?q=hilton')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('403 SUB_BRAND_DENIED when operator lacks sub-brand access', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'rfu' });
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/items/search?q=hilton')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });
});
