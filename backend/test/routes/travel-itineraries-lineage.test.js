// @ts-check
/**
 * G047 + G049 + G051 — Itinerary lineage + template metrics + AI provenance
 * (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.1.e, FR-3.1.h, FR-3.4.h).
 *
 * What's pinned (12 cases):
 *   G047 lineage (POST /api/travel/itineraries with clonedFromTemplateId):
 *     1. happy path: body { clonedFromTemplateId: 201 } → persisted on
 *        the new Itinerary row AND the parent template's usageCount is
 *        incremented + lastUsedAt bumped to ~now()
 *     2. cross-tenant template id → 404 TEMPLATE_NOT_FOUND
 *     3. malformed templateId (empty string / NaN) → silently degrades
 *        to null (no lineage); the create still succeeds with lineage=null
 *     4. no clonedFromTemplateId on body → lineage stays null + NO
 *        template.update is called (no spurious metric bump on manual
 *        creates)
 *     5. metric-bump failure is non-fatal (template.update rejects) — the
 *        itinerary create still returns 201
 *
 *   G049 accept-hook metrics (POST /api/travel/itineraries/:id/accept):
 *     6. accept on a clonedFromTemplate itinerary → template.acceptedCount
 *        is incremented; avgFinalPrice on first accept = newPrice
 *     7. accept on a clonedFromTemplate itinerary (2nd accept) → rolling
 *        average formula: ((oldAvg * oldCount) + newPrice) / (oldCount + 1)
 *     8. accept on a NON-cloned itinerary (clonedFromTemplateId=null) →
 *        NO template.findUnique / template.update call (no spurious bump)
 *     9. accept on a clonedFromTemplate itinerary whose totalAmount is null
 *        → NO avgFinalPrice recompute (skip — can't include in avg); the
 *        accept itself still succeeds
 *
 *   G051 AI provenance (POST /api/travel/itineraries/from-suggestion):
 *    10. materialised items have draftedByAi=true on EVERY item
 *    11. POST /api/travel/itineraries (manual create) with items[] in the
 *        body → items have draftedByAi defaulting to false (schema default;
 *        manual create path doesn't set the flag)
 *    12. POST /api/travel/itineraries/:id/items (manual add) → individual
 *        items default to draftedByAi=false (covered by the schema default;
 *        this pins the absence of an explicit `true` in the create payload)
 *
 * Mocking strategy mirrors travel-itineraries-api.test.js — patch prisma
 * singleton BEFORE requiring the router, drive with real HS256 JWTs against
 * the dev fallback secret, real verifyToken + requireTravelTenant +
 * getSubBrandAccessSet middleware run.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. We FORCE-overwrite the model
// surfaces (not `|| vi.fn()`) so each test file's `mockReset()` call hits a
// real vi mock function, not a leftover concrete method from another test
// file's prior import of the prisma singleton.
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findMany = vi.fn();
prisma.itinerary.findFirst = vi.fn();
prisma.itinerary.findUnique = vi.fn();
prisma.itinerary.count = vi.fn();
prisma.itinerary.create = vi.fn();
prisma.itinerary.update = vi.fn();
prisma.itinerary.delete = vi.fn();
prisma.itineraryItem = prisma.itineraryItem || {};
prisma.itineraryItem.findMany = vi.fn();
prisma.itineraryItem.create = vi.fn();
prisma.itineraryItem.findFirst = vi.fn();
prisma.itineraryTemplate = prisma.itineraryTemplate || {};
prisma.itineraryTemplate.findFirst = vi.fn();
prisma.itineraryTemplate.findUnique = vi.fn();
prisma.itineraryTemplate.update = vi.fn();
prisma.$transaction = vi.fn(async (cb) => (typeof cb === 'function' ? cb(prisma) : cb));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.travelDiagnostic = prisma.travelDiagnostic || {};
prisma.travelDiagnostic.count = vi.fn();
prisma.travelDiagnostic.findFirst = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.webCheckin = prisma.webCheckin || {};
prisma.webCheckin.findMany = vi.fn().mockResolvedValue([]);
prisma.webCheckin.create = vi.fn().mockResolvedValue({ id: 1 });

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

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.contact.findFirst.mockReset().mockResolvedValue({ id: 501 });
  prisma.travelDiagnostic.count.mockReset().mockResolvedValue(1);
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue({
    id: 11, recommendedTier: 'primary',
  });
  prisma.itinerary.create.mockReset();
  prisma.itinerary.findFirst.mockReset();
  prisma.itinerary.update.mockReset();
  prisma.itineraryTemplate.findFirst.mockReset();
  prisma.itineraryTemplate.findUnique.mockReset();
  prisma.itineraryTemplate.update.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.webCheckin.findMany.mockReset().mockResolvedValue([]);
  prisma.webCheckin.create.mockReset().mockResolvedValue({ id: 1 });
});

// ─── G047 — lineage on POST /api/travel/itineraries ─────────────────

describe('G047 — POST /api/travel/itineraries with clonedFromTemplateId', () => {
  test('1. happy path: lineage persisted + template metrics bumped', async () => {
    // Template lookup (within-tenant) succeeds.
    prisma.itineraryTemplate.findFirst.mockResolvedValue({ id: 201 });
    prisma.itineraryTemplate.update.mockResolvedValue({});
    prisma.itinerary.create.mockResolvedValue({
      id: 9001,
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 501,
      destination: 'Paris',
      status: 'draft',
      clonedFromTemplateId: 201,
      items: [],
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        contactId: 501,
        destination: 'Paris',
        clonedFromTemplateId: 201,
      });

    expect(res.status).toBe(201);
    expect(res.body.clonedFromTemplateId).toBe(201);
    // Itinerary.create was called with clonedFromTemplateId set.
    const createArg = prisma.itinerary.create.mock.calls[0][0];
    expect(createArg.data.clonedFromTemplateId).toBe(201);
    // Template metrics bumped exactly once with usageCount+1 and lastUsedAt now-ish.
    expect(prisma.itineraryTemplate.update).toHaveBeenCalledTimes(1);
    const tplUpdateArg = prisma.itineraryTemplate.update.mock.calls[0][0];
    expect(tplUpdateArg.where.id).toBe(201);
    expect(tplUpdateArg.data.usageCount).toEqual({ increment: 1 });
    expect(tplUpdateArg.data.lastUsedAt).toBeInstanceOf(Date);
    const skew = Math.abs(tplUpdateArg.data.lastUsedAt.getTime() - Date.now());
    expect(skew).toBeLessThan(5000);
  });

  test('2. cross-tenant template id → 404 TEMPLATE_NOT_FOUND', async () => {
    // Template lookup scoped on (id, tenantId) returns null for a foreign id.
    prisma.itineraryTemplate.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/itineraries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        contactId: 501,
        destination: 'Paris',
        clonedFromTemplateId: 9999,
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
    expect(prisma.itinerary.create).not.toHaveBeenCalled();
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('3. malformed clonedFromTemplateId (empty string / NaN) → silently null', async () => {
    prisma.itinerary.create.mockResolvedValue({
      id: 9002, tenantId: 1, subBrand: 'tmc', contactId: 501,
      destination: 'Bali', status: 'draft', clonedFromTemplateId: null, items: [],
    });
    const res = await request(makeApp())
      .post('/api/travel/itineraries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        contactId: 501,
        destination: 'Bali',
        clonedFromTemplateId: '', // empty
      });
    expect(res.status).toBe(201);
    const createArg = prisma.itinerary.create.mock.calls[0][0];
    expect(createArg.data.clonedFromTemplateId).toBe(null);
    // No template lookup fired (degraded path skips entirely).
    expect(prisma.itineraryTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('4. no clonedFromTemplateId on body → no template bump', async () => {
    prisma.itinerary.create.mockResolvedValue({
      id: 9003, tenantId: 1, subBrand: 'tmc', contactId: 501,
      destination: 'Goa', status: 'draft', clonedFromTemplateId: null, items: [],
    });
    const res = await request(makeApp())
      .post('/api/travel/itineraries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc', contactId: 501, destination: 'Goa' });

    expect(res.status).toBe(201);
    const createArg = prisma.itinerary.create.mock.calls[0][0];
    expect(createArg.data.clonedFromTemplateId).toBe(null);
    expect(prisma.itineraryTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('5. template metric-bump failure is non-fatal — create still returns 201', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue({ id: 201 });
    prisma.itineraryTemplate.update.mockRejectedValue(new Error('db blip'));
    prisma.itinerary.create.mockResolvedValue({
      id: 9004, tenantId: 1, subBrand: 'tmc', contactId: 501,
      destination: 'Maldives', status: 'draft', clonedFromTemplateId: 201, items: [],
    });
    const res = await request(makeApp())
      .post('/api/travel/itineraries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        contactId: 501,
        destination: 'Maldives',
        clonedFromTemplateId: 201,
      });
    expect(res.status).toBe(201);
    expect(res.body.clonedFromTemplateId).toBe(201);
  });
});

// ─── G049 — accept-hook metrics on POST /accept ─────────────────────

describe('G049 — POST /api/travel/itineraries/:id/accept template metrics', () => {
  test('6. accept on cloned itinerary → acceptedCount++ + avgFinalPrice=newPrice (first accept)', async () => {
    // loadItineraryWithGuard finds the itinerary.
    prisma.itinerary.findFirst.mockImplementation(({ select }) => {
      // First call (loadItineraryWithGuard) — only id + subBrand.
      if (select && select.subBrand && !select.totalAmount) {
        return Promise.resolve({ id: 600, tenantId: 1, subBrand: 'tmc' });
      }
      // Second call — the accept handler reads { id, status, clonedFromTemplateId, totalAmount }.
      return Promise.resolve({
        id: 600,
        status: 'sent',
        clonedFromTemplateId: 201,
        totalAmount: '50000.00', // Prisma Decimal-as-string
      });
    });
    prisma.itinerary.update.mockResolvedValue({
      id: 600, status: 'accepted', tenantId: 1, subBrand: 'tmc',
      totalAmount: 50000,
    });
    prisma.itineraryTemplate.findUnique.mockResolvedValue({
      acceptedCount: 0,
      avgFinalPrice: null,
    });
    prisma.itineraryTemplate.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/travel/itineraries/600/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.itineraryTemplate.findUnique).toHaveBeenCalledWith({
      where: { id: 201 },
      select: { acceptedCount: true, avgFinalPrice: true },
    });
    expect(prisma.itineraryTemplate.update).toHaveBeenCalledTimes(1);
    const arg = prisma.itineraryTemplate.update.mock.calls[0][0];
    expect(arg.where.id).toBe(201);
    expect(arg.data.acceptedCount).toEqual({ increment: 1 });
    expect(arg.data.avgFinalPrice).toBe(50000);
  });

  test('7. 2nd accept → rolling average ((oldAvg*oldCount)+newPrice)/(oldCount+1)', async () => {
    prisma.itinerary.findFirst.mockImplementation(({ select }) => {
      if (select && select.subBrand && !select.totalAmount) {
        return Promise.resolve({ id: 601, tenantId: 1, subBrand: 'tmc' });
      }
      return Promise.resolve({
        id: 601,
        status: 'sent',
        clonedFromTemplateId: 201,
        totalAmount: '70000.00',
      });
    });
    prisma.itinerary.update.mockResolvedValue({
      id: 601, status: 'accepted', tenantId: 1, subBrand: 'tmc',
      totalAmount: 70000,
    });
    // Template already has 1 accepted at avgFinalPrice 50000.
    prisma.itineraryTemplate.findUnique.mockResolvedValue({
      acceptedCount: 1,
      avgFinalPrice: '50000.00',
    });
    prisma.itineraryTemplate.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/travel/itineraries/601/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);

    const arg = prisma.itineraryTemplate.update.mock.calls[0][0];
    expect(arg.data.acceptedCount).toEqual({ increment: 1 });
    // Formula: ((50000*1) + 70000) / 2 = 60000.
    expect(arg.data.avgFinalPrice).toBe(60000);
  });

  test('8. accept on a NON-cloned itinerary → no template lookup / no bump', async () => {
    prisma.itinerary.findFirst.mockImplementation(({ select }) => {
      if (select && select.subBrand && !select.totalAmount) {
        return Promise.resolve({ id: 602, tenantId: 1, subBrand: 'tmc' });
      }
      return Promise.resolve({
        id: 602,
        status: 'sent',
        clonedFromTemplateId: null,
        totalAmount: '30000.00',
      });
    });
    prisma.itinerary.update.mockResolvedValue({
      id: 602, status: 'accepted', tenantId: 1, subBrand: 'tmc',
    });

    const res = await request(makeApp())
      .post('/api/travel/itineraries/602/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.itineraryTemplate.findUnique).not.toHaveBeenCalled();
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('9. cloned itinerary with null totalAmount → skip metrics, accept still succeeds', async () => {
    prisma.itinerary.findFirst.mockImplementation(({ select }) => {
      if (select && select.subBrand && !select.totalAmount) {
        return Promise.resolve({ id: 603, tenantId: 1, subBrand: 'tmc' });
      }
      return Promise.resolve({
        id: 603,
        status: 'sent',
        clonedFromTemplateId: 201,
        totalAmount: null, // intentional — itinerary not yet priced
      });
    });
    prisma.itinerary.update.mockResolvedValue({
      id: 603, status: 'accepted', tenantId: 1, subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .post('/api/travel/itineraries/603/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.itineraryTemplate.findUnique).not.toHaveBeenCalled();
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });
});

// ─── G051 — draftedByAi provenance ──────────────────────────────────

describe('G051 — draftedByAi provenance', () => {
  test('10. POST /from-suggestion materialise → every item has draftedByAi=true', async () => {
    prisma.itinerary.create.mockResolvedValue({
      id: 9100, tenantId: 1, subBrand: 'tmc', contactId: 501,
      destination: 'Goa outline', status: 'draft', items: [],
    });
    const suggestion = {
      daySplit: [
        {
          dayNumber: 1,
          items: [
            { itemType: 'activity', description: 'Morning walk', estimatedCost: 100 },
            { itemType: 'meals',    description: 'Lunch',         estimatedCost: 500 },
          ],
        },
      ],
      summary: '1-day Goa outline',
    };
    const res = await request(makeApp())
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ suggestionJson: suggestion, contactId: 501, subBrand: 'tmc' });

    expect(res.status).toBe(201);
    const createArg = prisma.itinerary.create.mock.calls[0][0];
    const rows = createArg.data.items.create;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.draftedByAi).toBe(true);
    }
  });

  test('11. POST /itineraries (manual create with items[]) → draftedByAi flag NOT set in payload (schema default false)', async () => {
    prisma.itinerary.create.mockResolvedValue({
      id: 9101, tenantId: 1, subBrand: 'tmc', contactId: 501,
      destination: 'Manual Trip', status: 'draft', items: [],
    });
    const res = await request(makeApp())
      .post('/api/travel/itineraries')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        contactId: 501,
        destination: 'Manual Trip',
        items: [
          { itemType: 'activity', description: 'Hand-picked walk' },
          { itemType: 'hotel',    description: 'Hand-picked stay' },
        ],
      });
    expect(res.status).toBe(201);
    const createArg = prisma.itinerary.create.mock.calls[0][0];
    const rows = createArg.data.items.create;
    expect(rows).toHaveLength(2);
    // Manual create path doesn't set draftedByAi explicitly — schema
    // default (false) wins at the DB layer. Pin the absence of `true`.
    for (const r of rows) {
      expect(r.draftedByAi).toBeUndefined();
    }
  });

  test('12. POST /:id/items (single manual add) → draftedByAi flag NOT set (schema default false)', async () => {
    // loadItineraryWithGuard
    prisma.itinerary.findFirst.mockResolvedValue({
      id: 700, tenantId: 1, subBrand: 'tmc', contactId: 501, status: 'draft',
    });
    prisma.itineraryItem.findFirst.mockResolvedValue(null); // auto-position lookup
    prisma.itineraryItem.create.mockImplementation(async ({ data }) => ({
      id: 8000,
      itineraryId: data.itineraryId,
      itemType: data.itemType,
      description: data.description,
      position: data.position,
      draftedByAi: data.draftedByAi ?? false,
    }));
    // post-create housekeeping
    prisma.itinerary.findUnique = prisma.itinerary.findUnique || vi.fn();
    prisma.itinerary.findUnique.mockResolvedValue({ id: 700, status: 'draft' });
    prisma.itinerary.update.mockResolvedValue({ id: 700 });
    prisma.itineraryItem.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/travel/itineraries/700/items')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itemType: 'activity', description: 'Manual extra' });

    expect(res.status).toBe(201);
    const createArg = prisma.itineraryItem.create.mock.calls[0][0];
    expect(createArg.data.draftedByAi).toBeUndefined();
  });
});
