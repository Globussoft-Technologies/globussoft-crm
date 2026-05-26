// @ts-check
/**
 * Arc 2 #907 slice 8 — Itinerary items bulk-reorder endpoint.
 *
 * Pins POST /api/travel/itineraries/:id/items/bulk-reorder added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Body shape { updates: [{ itemId, position, dayOffset? }, ...] }.
 *   - Atomic via prisma.$transaction — N updates land together or none.
 *   - 200 happy path returns { updatedCount, items: [...] } ordered by
 *     post-update position asc.
 *   - dayOffset (when supplied) merges into detailsJson preserving other
 *     keys; stale dayNumber removed (slice-2 convention).
 *   - Validation: EMPTY_UPDATES, TOO_MANY_UPDATES (>200), INVALID_ITEM_ID,
 *     DUPLICATE_ITEM_ID, INVALID_POSITION (non-int / negative),
 *     INVALID_DAY_OFFSET (non-int / negative), ITEM_NOT_IN_ITINERARY
 *     (cross-itinerary or unknown ids).
 *   - Tenant + sub-brand guard delegated to loadItineraryWithGuard —
 *     401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts inherited.
 *
 * Pattern mirrors travel-itinerary-supplier-rollup.test.js — CJS prisma
 * singleton patched BEFORE the router is required; eventBus mocked at
 * vitest module-load time for parity (this endpoint is a write but
 * intentionally does not emit — pin via mock so a future emit isn't
 * silently coupled to a real bus listener).
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
// $transaction passes through — collect the array of update promises.
prisma.$transaction = vi.fn((ops) => Promise.all(ops));

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
    status: 'draft',
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
    totalPrice: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.itineraryItem.update.mockReset().mockResolvedValue({});
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.$transaction.mockClear();
  prisma.$transaction.mockImplementation((ops) => Promise.all(ops));
});

describe('POST /api/travel/itineraries/:id/items/bulk-reorder — happy paths', () => {
  test('updates positions of 3 items atomically and returns refreshed items asc by position', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));
    // First findMany call = existence check (id+detailsJson select);
    // second findMany call = post-update refreshed rows.
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([
        { id: 1, detailsJson: null },
        { id: 2, detailsJson: null },
        { id: 3, detailsJson: null },
      ])
      .mockResolvedValueOnce([
        makeItem({ id: 1, position: 0, description: 'A' }),
        makeItem({ id: 2, position: 1, description: 'B' }),
        makeItem({ id: 3, position: 2, description: 'C' }),
      ]);
    prisma.itineraryItem.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        updates: [
          { itemId: 1, position: 0 },
          { itemId: 2, position: 1 },
          { itemId: 3, position: 2 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(3);
    expect(res.body.items.map((it) => it.id)).toEqual([1, 2, 3]);
    expect(res.body.items.map((it) => it.position)).toEqual([0, 1, 2]);
    // Atomic — all updates passed to $transaction together.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.itineraryItem.update).toHaveBeenCalledTimes(3);
  });

  test('dayOffset merges into detailsJson preserving other keys and dropping stale dayNumber', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([
        { id: 11, detailsJson: JSON.stringify({ pnr: 'AI6E-001', dayNumber: 3, cabin: 'Y' }) },
      ])
      .mockResolvedValueOnce([
        makeItem({ id: 11, position: 5 }),
      ]);

    await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 11, position: 5, dayOffset: 4 }] });

    // The update call should carry merged detailsJson:
    //   - pnr + cabin preserved
    //   - dayOffset = 4 (new value)
    //   - dayNumber removed (stale dual-source)
    const updateCall = prisma.itineraryItem.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe(11);
    expect(updateCall.data.position).toBe(5);
    const merged = JSON.parse(updateCall.data.detailsJson);
    expect(merged.pnr).toBe('AI6E-001');
    expect(merged.cabin).toBe('Y');
    expect(merged.dayOffset).toBe(4);
    expect(merged.dayNumber).toBeUndefined();
  });

  test('omitted dayOffset only updates position (detailsJson not touched in update payload)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([{ id: 9, detailsJson: JSON.stringify({ pnr: 'XYZ' }) }])
      .mockResolvedValueOnce([makeItem({ id: 9, position: 7 })]);

    await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 9, position: 7 }] });

    const updateCall = prisma.itineraryItem.update.mock.calls[0][0];
    expect(updateCall.data.position).toBe(7);
    // detailsJson key absent → Prisma leaves the column untouched.
    expect(updateCall.data.detailsJson).toBeUndefined();
  });

  test('dayOffset merge on a row with null detailsJson starts fresh (no JSON parse error)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([{ id: 42, detailsJson: null }])
      .mockResolvedValueOnce([makeItem({ id: 42, position: 0 })]);

    await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 42, position: 0, dayOffset: 0 }] });

    const updateCall = prisma.itineraryItem.update.mock.calls[0][0];
    const merged = JSON.parse(updateCall.data.detailsJson);
    expect(merged).toEqual({ dayOffset: 0 });
  });

  test('dayOffset merge tolerates malformed detailsJson (resets to fresh object)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany
      .mockResolvedValueOnce([{ id: 51, detailsJson: '{not-json' }])
      .mockResolvedValueOnce([makeItem({ id: 51, position: 1 })]);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 51, position: 1, dayOffset: 2 }] });

    expect(res.status).toBe(200);
    const updateCall = prisma.itineraryItem.update.mock.calls[0][0];
    const merged = JSON.parse(updateCall.data.detailsJson);
    expect(merged).toEqual({ dayOffset: 2 });
  });
});

describe('POST /api/travel/itineraries/:id/items/bulk-reorder — validation', () => {
  test('400 EMPTY_UPDATES when updates is missing', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_UPDATES');
  });

  test('400 EMPTY_UPDATES when updates is empty array', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_UPDATES');
  });

  test('400 TOO_MANY_UPDATES when updates exceeds the 200-row cap', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    const updates = Array.from({ length: 201 }, (_, i) => ({ itemId: i + 1, position: i }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_UPDATES');
  });

  test('400 INVALID_ITEM_ID when an update lacks numeric itemId', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 'abc', position: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_ID');
  });

  test('400 DUPLICATE_ITEM_ID when same itemId appears twice', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        updates: [
          { itemId: 7, position: 0 },
          { itemId: 7, position: 1 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DUPLICATE_ITEM_ID');
    expect(res.body.itemId).toBe(7);
  });

  test('400 INVALID_POSITION when position is negative', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 1, position: -1 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_POSITION');
  });

  test('400 INVALID_POSITION when position is a float', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 1, position: 1.5 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_POSITION');
  });

  test('400 INVALID_DAY_OFFSET when dayOffset is negative', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 1, position: 0, dayOffset: -1 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAY_OFFSET');
  });

  test('400 ITEM_NOT_IN_ITINERARY when an itemId belongs to another itinerary', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    // findMany returns only the rows whose itineraryId matches → 99 missing.
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      { id: 1, detailsJson: null },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        updates: [
          { itemId: 1, position: 0 },
          { itemId: 99, position: 1 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ITEM_NOT_IN_ITINERARY');
    expect(res.body.missing).toEqual([99]);
    // No $transaction call when validation fails.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/itineraries/:id/items/bulk-reorder — auth + guard contracts', () => {
  test('401 when no Authorization header', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .send({ updates: [{ itemId: 1, position: 0 }] });

    expect(res.status).toBe(401);
  });

  test('404 NOT_FOUND when target itinerary is in another tenant', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/9999/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 1, position: 0 }] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('400 INVALID_ID when :id is non-numeric', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/abc/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 1, position: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('403 SUB_BRAND_DENIED when operator lacks itinerary sub-brand access', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: 'tmc' });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-reorder')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ updates: [{ itemId: 1, position: 0 }] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });
});
