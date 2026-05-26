// @ts-check
/**
 * Arc 2 #907 slice 9 — Itinerary version-chain endpoint.
 *
 * Pins GET /api/travel/itineraries/:id/versions added to
 * backend/routes/travel_itineraries.js.
 *
 * Contracts asserted:
 *   - Read-only — no audit log writes, no eventBus emits.
 *   - Resolves chain root via original.parentItineraryId || original.id;
 *     querying a non-root version still returns the full chain (root + all
 *     siblings sharing the same parentItineraryId pointer).
 *   - Returns rows sorted by version asc.
 *   - Per-version itemCount computed via single groupBy on itineraryId;
 *     skipped when the chain is empty (defensive, though
 *     loadItineraryWithGuard guarantees ≥1 row).
 *   - isRoot true on the chain-root row only.
 *   - isLatest true on the highest-version row only (last entry after
 *     version-asc sort).
 *   - totalAmount Decimal coerced to Number; null preserved as null.
 *   - Tenant + sub-brand guard delegated to loadItineraryWithGuard —
 *     401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED contracts inherited.
 *
 * Pattern mirrors travel-itinerary-supplier-rollup.test.js — CJS prisma
 * singleton patched BEFORE the router is required; eventBus mocked at
 * vitest module-load time for parity (this endpoint is a read but the
 * mock keeps a future emit from silently coupling to a real bus listener);
 * HS256 JWT via dev fallback secret.
 *
 * PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §5.1 (Versioning).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// eventBus mock — versions endpoint is read-only and never emits, but we
// patch the shared helper to match sibling-test discipline so route
// refactors that add an emit don't silently couple to a real listener.
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
  groupBy: vi.fn().mockResolvedValue([]),
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

function makeVersionRow(overrides = {}) {
  return {
    id: 100,
    version: 1,
    status: 'draft',
    destination: 'Goa',
    totalAmount: '14999.00',
    currency: 'INR',
    parentItineraryId: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itinerary.findFirst.mockReset();
  prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
  prisma.itineraryItem.groupBy.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/itineraries/:id/versions — happy paths', () => {
  test('single-row chain (no revisions yet) returns one version flagged root + latest', async () => {
    // loadItineraryWithGuard call.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    // chainRoot resolution call.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, parentItineraryId: null });
    // Chain fetch.
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, parentItineraryId: null }),
    ]);
    prisma.itineraryItem.groupBy.mockResolvedValueOnce([
      { itineraryId: 100, _count: { _all: 5 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itineraryId).toBe(100);
    expect(res.body.chainRootId).toBe(100);
    expect(res.body.versionCount).toBe(1);
    expect(res.body.latestVersionId).toBe(100);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0]).toMatchObject({
      id: 100,
      version: 1,
      status: 'draft',
      destination: 'Goa',
      totalAmount: 14999,
      currency: 'INR',
      itemCount: 5,
      isRoot: true,
      isLatest: true,
    });
  });

  test('multi-version chain: root + 2 revisions, version-asc order, isLatest only on highest version', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, parentItineraryId: null });
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, status: 'sent',     totalAmount: '10000.00', parentItineraryId: null }),
      makeVersionRow({ id: 201, version: 2, status: 'revised',  totalAmount: '12500.00', parentItineraryId: 100 }),
      makeVersionRow({ id: 305, version: 3, status: 'accepted', totalAmount: '13750.50', parentItineraryId: 100 }),
    ]);
    prisma.itineraryItem.groupBy.mockResolvedValueOnce([
      { itineraryId: 100, _count: { _all: 3 } },
      { itineraryId: 201, _count: { _all: 4 } },
      { itineraryId: 305, _count: { _all: 6 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.chainRootId).toBe(100);
    expect(res.body.versionCount).toBe(3);
    expect(res.body.latestVersionId).toBe(305);
    expect(res.body.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(res.body.versions.map((v) => v.id)).toEqual([100, 201, 305]);
    expect(res.body.versions.map((v) => v.itemCount)).toEqual([3, 4, 6]);
    // isRoot only on v1.
    expect(res.body.versions[0].isRoot).toBe(true);
    expect(res.body.versions[1].isRoot).toBe(false);
    expect(res.body.versions[2].isRoot).toBe(false);
    // isLatest only on v3.
    expect(res.body.versions[0].isLatest).toBe(false);
    expect(res.body.versions[1].isLatest).toBe(false);
    expect(res.body.versions[2].isLatest).toBe(true);
    // Half-up to 2dp via Number coercion.
    expect(res.body.versions[2].totalAmount).toBe(13750.5);
  });

  test('querying a non-root version returns the full chain (resolves root from parentItineraryId)', async () => {
    // Operator asks for v3 (id=305) directly.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 305, subBrand: 'tmc' });
    // Chain-root resolution reads parentItineraryId off the queried row.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 305, parentItineraryId: 100 });
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, parentItineraryId: null }),
      makeVersionRow({ id: 201, version: 2, parentItineraryId: 100 }),
      makeVersionRow({ id: 305, version: 3, parentItineraryId: 100 }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/305/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.itineraryId).toBe(305);
    expect(res.body.chainRootId).toBe(100);
    expect(res.body.versionCount).toBe(3);
    expect(res.body.latestVersionId).toBe(305);
    // Chain query should have used the resolved chainRootId, not the
    // requested id, in the OR clause.
    const findManyArgs = prisma.itinerary.findMany.mock.calls[0][0];
    expect(findManyArgs.where.OR).toEqual([
      { id: 100 },
      { parentItineraryId: 100 },
    ]);
  });

  test('null totalAmount preserved as null (not coerced to 0)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, parentItineraryId: null });
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, totalAmount: null, parentItineraryId: null }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.versions[0].totalAmount).toBeNull();
  });

  test('versions with no items get itemCount=0 (groupBy returns no row for them)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, parentItineraryId: null });
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, parentItineraryId: null }),
      makeVersionRow({ id: 201, version: 2, parentItineraryId: 100 }),
    ]);
    // groupBy only returns v2 — v1 has zero items so it's absent from the
    // groupBy result entirely (a Prisma quirk). Route must default to 0.
    prisma.itineraryItem.groupBy.mockResolvedValueOnce([
      { itineraryId: 201, _count: { _all: 7 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.versions[0].itemCount).toBe(0);
    expect(res.body.versions[1].itemCount).toBe(7);
  });
});

describe('GET /api/travel/itineraries/:id/versions — guards', () => {
  test('401 when no auth header', async () => {
    const res = await request(makeApp()).get('/api/travel/itineraries/100/versions');
    expect(res.status).toBe(401);
  });

  test('404 NOT_FOUND when itinerary not in tenant', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/999/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('403 SUB_BRAND_DENIED when operator lacks sub-brand access', async () => {
    // Itinerary exists in 'rfu' but operator only has 'tmc'.
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'rfu' });
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('400 INVALID_ID when id is not numeric', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/abc/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('GET /api/travel/itineraries/:id/versions — query scoping', () => {
  test('chain query is tenant-scoped (tenantId in where clause)', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, parentItineraryId: null });
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, parentItineraryId: null }),
    ]);

    await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    const findManyArgs = prisma.itinerary.findMany.mock.calls[0][0];
    expect(findManyArgs.where.tenantId).toBe(1);
    expect(findManyArgs.orderBy).toEqual({ version: 'asc' });
  });

  test('groupBy is keyed on itineraryId and scoped to chain row ids only', async () => {
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, subBrand: 'tmc' });
    prisma.itinerary.findFirst.mockResolvedValueOnce({ id: 100, parentItineraryId: null });
    prisma.itinerary.findMany.mockResolvedValueOnce([
      makeVersionRow({ id: 100, version: 1, parentItineraryId: null }),
      makeVersionRow({ id: 201, version: 2, parentItineraryId: 100 }),
    ]);

    await request(makeApp())
      .get('/api/travel/itineraries/100/versions')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    const groupByArgs = prisma.itineraryItem.groupBy.mock.calls[0][0];
    expect(groupByArgs.by).toEqual(['itineraryId']);
    expect(groupByArgs.where.itineraryId.in).toEqual([100, 201]);
    expect(groupByArgs._count).toEqual({ _all: true });
  });
});
