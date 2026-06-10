// @ts-check
/**
 * S90 — POST /api/travel/itineraries/from-suggestion
 *
 * Pins the materialise-from-suggestion contract per PRD
 * docs/PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6 step (d). Operator hits
 * POST /itineraries/suggest first to brainstorm; this endpoint
 * materialises the accepted suggestion into a real Itinerary +
 * ItineraryItem rows.
 *
 * Contract pinned (14 cases):
 *   1.  Happy path: 2 days × 3 items → 1 itinerary + 6 items with
 *       correct dayNumber + position + descriptions.
 *   2.  suggestionJson missing → 400 INVALID_SUGGESTION_JSON.
 *   3.  Empty days array → 400 INVALID_SUGGESTION_JSON.
 *   4.  Item missing description AND name → 400 ITEM_MISSING_NAME.
 *   5.  Bad itemType → 400 INVALID_ITEM_TYPE.
 *   6.  Bad subBrand → 400 INVALID_SUB_BRAND via assertValidSubBrand.
 *   7.  contactId missing → 400 CONTACT_ID_REQUIRED (schema gap).
 *   8.  Cross-tenant contact → 404 CONTACT_NOT_FOUND.
 *   9.  Diagnostic-required guard fires when no diagnostic exists →
 *       403 DIAGNOSTIC_REQUIRED.
 *  10.  Sub-brand access denied (operator subBrandAccess narrow) → 403
 *       SUB_BRAND_DENIED.
 *  11.  Item with lat/lng + suggestedSupplierName → ItineraryItem.latitude
 *       / longitude populated + detailsJson stores supplier name.
 *  12.  Audit-log emitted with action 'itinerary.materialised-from-
 *       suggestion' + entity 'Itinerary' + details carrying daysProcessed
 *       + itemsCreated counts.
 *  13.  Tenant-scope: created Itinerary's tenantId matches req.user
 *       .tenantId (not body-supplied).
 *  14.  Service-shape compatibility: `daySplit` (service-emitted) key is
 *       accepted in place of `days`.
 *
 * Mocking strategy (mirrors travel-itineraries-stats.test.js):
 *   - Patch prisma singleton with vi.fn() BEFORE requireCJS of the router.
 *   - Real verifyToken + requireTravelTenant middleware runs.
 *   - Real getSubBrandAccessSet runs (user.findUnique controls the
 *     access set).
 *   - HS256 JWTs signed with the dev fallback secret.
 *   - audit lib's writeAudit auto-no-ops when prisma.auditLog.create
 *     resolves, so we just spy on it via prisma.auditLog.create.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findMany = prisma.itinerary.findMany || vi.fn();
prisma.itinerary.findFirst = prisma.itinerary.findFirst || vi.fn();
prisma.itinerary.count = prisma.itinerary.count || vi.fn();
prisma.itinerary.create = vi.fn();
prisma.itinerary.update = prisma.itinerary.update || vi.fn();
prisma.itinerary.delete = prisma.itinerary.delete || vi.fn();
prisma.itineraryItem = prisma.itineraryItem || {};
prisma.itineraryItem.findMany = prisma.itineraryItem.findMany || vi.fn();
prisma.itineraryItem.create = prisma.itineraryItem.create || vi.fn();
prisma.$transaction = vi.fn(async (cb) => (typeof cb === 'function' ? cb(prisma) : cb));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
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

// Canonical suggestionJson shape — matches what itinerarySuggestLLM.js's
// buildStubSuggestion emits. Operator gets this from POST /suggest and
// POSTs it back to /from-suggestion.
const SUGGESTION_2D_3I = {
  daySplit: [
    {
      dayNumber: 1,
      theme: '[STUB] Day 1 — beaches theme placeholder',
      items: [
        { itemType: 'activity', description: 'Beach walk at dawn', estimatedCost: 500 },
        { itemType: 'meals',    description: 'Seafood lunch',        estimatedCost: 1200 },
        { itemType: 'activity', description: 'Sunset cruise',        estimatedCost: 3000 },
      ],
    },
    {
      dayNumber: 2,
      theme: '[STUB] Day 2 — culture theme placeholder',
      items: [
        { itemType: 'sightseeing', description: 'Fort visit', estimatedCost: 200 },
        { itemType: 'meals',       description: 'Local thali', estimatedCost: 400 },
        { itemType: 'activity',    description: 'Spice plantation tour', estimatedCost: 800 },
      ],
    },
  ],
  summary: '2-day Goa (mid) outline',
  thematicNotes: 'Beach + culture blend.',
};

const HAPPY_CREATE_RESULT = {
  id: 12345,
  tenantId: 1,
  subBrand: 'tmc',
  contactId: 501,
  status: 'draft',
  destination: '2-day Goa (mid) outline',
  currency: 'INR',
  productTier: null,
  items: [
    { id: 91, itemType: 'activity', description: 'Beach walk at dawn', position: 0, dayNumber: 1, latitude: null, longitude: null },
    { id: 92, itemType: 'meal',     description: 'Seafood lunch',        position: 1, dayNumber: 1, latitude: null, longitude: null },
    { id: 93, itemType: 'activity', description: 'Sunset cruise',        position: 2, dayNumber: 1, latitude: null, longitude: null },
    { id: 94, itemType: 'sightseeing', description: 'Fort visit', position: 3, dayNumber: 2, latitude: null, longitude: null },
    { id: 95, itemType: 'meal',        description: 'Local thali', position: 4, dayNumber: 2, latitude: null, longitude: null },
    { id: 96, itemType: 'activity',    description: 'Spice plantation tour', position: 5, dayNumber: 2, latitude: null, longitude: null },
  ],
};

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
  prisma.itinerary.create.mockReset().mockResolvedValue(HAPPY_CREATE_RESULT);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/itineraries/from-suggestion (S90)', () => {
  test('1. happy path: 2 days × 3 items → 1 itinerary + 6 items + 201', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    expect(res.body.itemsCreated).toBe(6);
    expect(res.body.daysProcessed).toBe(2);
    expect(res.body.itinerary.id).toBe(12345);
    // Verify the items[] payload passed to prisma.itinerary.create
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    expect(callArg.data.items.create).toHaveLength(6);
    // Position monotonic across days.
    expect(callArg.data.items.create.map((i) => i.position)).toEqual([0, 1, 2, 3, 4, 5]);
    // dayNumber follows the day grouping.
    expect(callArg.data.items.create.map((i) => i.dayNumber)).toEqual([1, 1, 1, 2, 2, 2]);
    // estimatedCost → unitCost mapping.
    expect(callArg.data.items.create[0].unitCost).toBe(500);
    expect(callArg.data.items.create[1].unitCost).toBe(1200);
  });

  test('2. missing suggestionJson → 400 INVALID_SUGGESTION_JSON', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({ contactId: 501, subBrand: 'tmc' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUGGESTION_JSON');
  });

  test('3. empty daySplit array → 400 INVALID_SUGGESTION_JSON', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: { daySplit: [], summary: 'empty' },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUGGESTION_JSON');
  });

  test('4. item missing description AND name → 400 ITEM_MISSING_NAME', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: {
          daySplit: [{
            dayNumber: 1,
            items: [{ itemType: 'activity' }], // no name/description
          }],
        },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ITEM_MISSING_NAME');
  });

  test('5. bad itemType → 400 INVALID_ITEM_TYPE', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: {
          daySplit: [{
            dayNumber: 1,
            items: [{ itemType: 'submarine', description: 'underwater' }],
          }],
        },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  test('6. bad subBrand → 400 INVALID_SUB_BRAND', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 501,
        subBrand: 'made-up',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
  });

  test('7. contactId missing → 400 CONTACT_ID_REQUIRED (schema gap explicit)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTACT_ID_REQUIRED');
  });

  test('7b. contactId not an integer → 400 INVALID_CONTACT_ID', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 'not-a-number',
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTACT_ID');
  });

  test('8. cross-tenant contact lookup → 404 CONTACT_NOT_FOUND', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 999999,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTACT_NOT_FOUND');
  });

  test('9. no diagnostic for sub-brand → 403 DIAGNOSTIC_REQUIRED', async () => {
    prisma.travelDiagnostic.count.mockResolvedValueOnce(0);
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DIAGNOSTIC_REQUIRED');
  });

  test('10. operator without sub-brand access → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'USER',
      subBrandAccess: '["rfu"]', // operator only has rfu access; can't do tmc
    });
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('11. item with lat/lng + suggestedSupplierName → latitude/longitude/detailsJson populated', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const richSuggestion = {
      daySplit: [{
        dayNumber: 1,
        items: [{
          itemType: 'activity',
          description: 'Eiffel Tower visit',
          latitude: 48.8584,
          longitude: 2.2945,
          suggestedSupplierName: 'Paris Tours Ltd',
          notes: 'Skip-the-line pass recommended',
          durationMinutes: 120,
          estimatedCost: 25,
        }],
      }],
      summary: 'Paris in 1 day',
    };
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: richSuggestion,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    const item = callArg.data.items.create[0];
    expect(item.latitude).toBe(48.8584);
    expect(item.longitude).toBe(2.2945);
    expect(item.detailsJson).toBeTruthy();
    const parsed = JSON.parse(item.detailsJson);
    expect(parsed.suggestedSupplierName).toBe('Paris Tours Ltd');
    expect(parsed.notes).toBe('Skip-the-line pass recommended');
    expect(parsed.durationMinutes).toBe(120);
  });

  test('12. audit-log emitted with action "itinerary.materialised-from-suggestion"', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    // Find the create call whose action matches the materialise action.
    const auditCalls = prisma.auditLog.create.mock.calls;
    const matched = auditCalls.find(([arg]) => {
      const data = arg && arg.data;
      return data && data.action === 'itinerary.materialised-from-suggestion';
    });
    expect(matched, `audit create calls: ${JSON.stringify(auditCalls.map(([a]) => a && a.data && a.data.action))}`).toBeTruthy();
    expect(matched[0].data.entity).toBe('Itinerary');
    expect(matched[0].data.entityId).toBe(12345);
    const details = typeof matched[0].data.details === 'string'
      ? JSON.parse(matched[0].data.details)
      : matched[0].data.details;
    expect(details.daysProcessed).toBe(2);
    expect(details.itemsCreated).toBe(6);
  });

  test('13. tenant-scope: created Itinerary tenantId matches req.user.tenantId (not body-supplied)', async () => {
    const app = makeApp();
    const token = tokenFor('USER', { userId: 7, tenantId: 1 });
    await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: SUGGESTION_2D_3I,
        contactId: 501,
        subBrand: 'tmc',
        tenantId: 9999, // body-supplied tenant attempt (also stripped by global middleware)
      });
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    expect(callArg.data.tenantId).toBe(1); // from req.travelTenant.id, not body
  });

  test('14. service-shape compatibility: `days` (prompt key) accepted alongside `daySplit`', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    // Use prompt-shape `days` instead of service-shape `daySplit`.
    const promptShape = {
      days: [
        {
          dayNumber: 1,
          items: [
            { name: 'Activity 1', locationName: 'Goa Beach' },
            { name: 'Activity 2', locationName: 'Anjuna Market' },
          ],
        },
      ],
    };
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: promptShape,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    expect(callArg.data.items.create).toHaveLength(2);
    // name → description fallback.
    expect(callArg.data.items.create[0].description).toBe('Activity 1');
    expect(callArg.data.items.create[1].description).toBe('Activity 2');
    // locationName persisted in detailsJson.
    const parsed = JSON.parse(callArg.data.items.create[0].detailsJson);
    expect(parsed.locationName).toBe('Goa Beach');
  });
});
