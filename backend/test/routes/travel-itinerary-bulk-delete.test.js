// @ts-check
/**
 * Arc 2 #907 slice 11 — Itinerary items bulk-delete endpoint.
 *
 * Pins POST /api/travel/itineraries/:id/items/bulk-delete added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Body shape { itemIds: [1, 2, 3, ...] }.
 *   - Atomic via prisma.itineraryItem.deleteMany — single SQL DELETE.
 *   - 200 happy path returns { deletedCount, deletedIds } where
 *     deletedIds is sorted ascending.
 *   - Validation: EMPTY_ITEM_IDS (missing / empty), TOO_MANY_ITEM_IDS
 *     (>200), INVALID_ITEM_ID (non-int / negative), DUPLICATE_ITEM_ID,
 *     ITEM_NOT_IN_ITINERARY (cross-itinerary or unknown ids).
 *   - Pre-flight existence check ensures partial-set requests fail
 *     400 before any delete fires (no torn state).
 *   - Tenant + sub-brand guard delegated to loadItineraryWithGuard —
 *     401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts inherited.
 *
 * Pattern mirrors travel-itinerary-bulk-reorder.test.js — CJS prisma
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
  deleteMany: vi.fn(),
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
    status: 'draft',
    destination: 'Goa',
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.itineraryItem.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/itineraries/:id/items/bulk-delete — happy paths', () => {
  test('deletes 3 items atomically and returns deletedCount + ascending deletedIds', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100, subBrand: 'tmc' }));
    // Pre-flight existence: all 3 ids present.
    prisma.itineraryItem.findMany.mockResolvedValueOnce([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    prisma.itineraryItem.deleteMany.mockResolvedValueOnce({ count: 3 });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [3, 1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(3);
    // deletedIds returned sorted asc for caller stability.
    expect(res.body.deletedIds).toEqual([1, 2, 3]);

    // Atomic — single deleteMany call scoped to itineraryId.
    expect(prisma.itineraryItem.deleteMany).toHaveBeenCalledTimes(1);
    const delCall = prisma.itineraryItem.deleteMany.mock.calls[0][0];
    expect(delCall.where.itineraryId).toBe(100);
    expect(delCall.where.id.in).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  test('single id delete works and returns deletedCount=1', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValueOnce([{ id: 42 }]);
    prisma.itineraryItem.deleteMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [42] });

    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(1);
    expect(res.body.deletedIds).toEqual([42]);
  });

  test('accepts numeric-string ids (parsed via parseInt) and returns sorted numeric deletedIds', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValueOnce([{ id: 5 }, { id: 9 }]);
    prisma.itineraryItem.deleteMany.mockResolvedValueOnce({ count: 2 });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: ['9', '5'] });

    expect(res.status).toBe(200);
    expect(res.body.deletedIds).toEqual([5, 9]);
  });
});

describe('POST /api/travel/itineraries/:id/items/bulk-delete — validation', () => {
  test('400 EMPTY_ITEM_IDS when itemIds is missing', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_ITEM_IDS');
    // No DB writes attempted.
    expect(prisma.itineraryItem.deleteMany).not.toHaveBeenCalled();
  });

  test('400 EMPTY_ITEM_IDS when itemIds is empty array', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_ITEM_IDS');
  });

  test('400 TOO_MANY_ITEM_IDS when itemIds exceeds the 200-row cap', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    const itemIds = Array.from({ length: 201 }, (_, i) => i + 1);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_ITEM_IDS');
    expect(prisma.itineraryItem.deleteMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_ITEM_ID when an id is non-numeric', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [1, 'abc', 3] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_ID');
  });

  test('400 INVALID_ITEM_ID when an id is negative', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [1, -5, 3] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_ID');
  });

  test('400 DUPLICATE_ITEM_ID when same itemId appears twice', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [7, 7] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DUPLICATE_ITEM_ID');
    expect(res.body.itemId).toBe(7);
    // No DB writes attempted.
    expect(prisma.itineraryItem.deleteMany).not.toHaveBeenCalled();
  });

  test('400 ITEM_NOT_IN_ITINERARY when one id does not belong to itinerary; no delete fires (no torn state)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    // Caller asked for [1, 2, 99]; pre-flight finds only 1 + 2.
    prisma.itineraryItem.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [1, 2, 99] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ITEM_NOT_IN_ITINERARY');
    expect(res.body.missing).toEqual([99]);
    // Critical contract: NO delete fired — partial set must not tear state.
    expect(prisma.itineraryItem.deleteMany).not.toHaveBeenCalled();
  });

  test('400 ITEM_NOT_IN_ITINERARY surfaces ALL missing ids (not just the first)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(itin({ id: 100 }));
    prisma.itineraryItem.findMany.mockResolvedValueOnce([{ id: 5 }]);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [5, 11, 13] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ITEM_NOT_IN_ITINERARY');
    expect(res.body.missing).toEqual([11, 13]);
  });
});

describe('POST /api/travel/itineraries/:id/items/bulk-delete — auth + tenant gate', () => {
  test('401 when no Authorization header is supplied', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .send({ itemIds: [1] });

    expect(res.status).toBe(401);
  });

  test('404 NOT_FOUND when itinerary does not exist (loadItineraryWithGuard gates)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/100/items/bulk-delete')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itemIds: [1] });

    expect(res.status).toBe(404);
  });
});
