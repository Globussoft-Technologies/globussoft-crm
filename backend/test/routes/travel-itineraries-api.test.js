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
 * Contract pinned (14 base + S109 5 = 19 cases):
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
 *   S109a. Route accepts itemType=meals (canonical plural).
 *   S109b. Route accepts itemType=hotel (canonical, not 'accommodation').
 *   S109c. Route rejects pre-S109 singular 'meal' → 400 INVALID_ITEM_TYPE.
 *   S109d. Route rejects pre-S109 'accommodation' → 400 INVALID_ITEM_TYPE.
 *   S109e. Suggest→materialise verbatim round-trip: stub-shape suggestion
 *          (post-S109) is accepted by route with no alias normalisation.
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

// Canonical suggestionJson shape — matches what the FR-3.4 /suggest
// handler emits. Operator gets this from POST /suggest and POSTs it
// back to /from-suggestion.
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

  // ── S109 — service↔route itemType vocabulary reconciliation ─────────
  //
  // Pins that the route's VALID_ITEM_TYPES enum accepts the canonical
  // plural forms the service emits post-S109 ('meals' + 'hotel'). Also
  // pins that a verbatim suggestionJson hand-off from /suggest →
  // /from-suggestion works without alias normalisation.

  test('S109a. route accepts itemType=meals (canonical plural, in VALID_ITEM_TYPES)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: {
          daySplit: [{
            dayNumber: 1,
            items: [{ itemType: 'meals', description: 'Lunch buffet' }],
          }],
        },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    expect(callArg.data.items.create[0].itemType).toBe('meals');
  });

  test('S109b. route accepts itemType=hotel (canonical, in VALID_ITEM_TYPES)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: {
          daySplit: [{
            dayNumber: 1,
            items: [{ itemType: 'hotel', description: 'Stay at Taj Goa' }],
          }],
        },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    expect(callArg.data.items.create[0].itemType).toBe('hotel');
  });

  test('S109c. route REJECTS pre-S109 singular "meal" with 400 INVALID_ITEM_TYPE', async () => {
    // The drift surfaced in S108 — if the service ever regresses to
    // singular 'meal' emit, the route's enum will reject it. Pin the
    // protective error so the drift is visible.
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: {
          daySplit: [{
            dayNumber: 1,
            items: [{ itemType: 'meal', description: 'Lunch' }],
          }],
        },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  test('S109d. route REJECTS pre-S109 "accommodation" with 400 INVALID_ITEM_TYPE', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: {
          daySplit: [{
            dayNumber: 1,
            items: [{ itemType: 'accommodation', description: 'Hotel' }],
          }],
        },
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  test('S109e. suggest→materialise verbatim round-trip: stub emit shape is accepted by route', async () => {
    // The full contract S109 unlocks: the /suggest handler's stub emit
    // goes verbatim to the materialise route. We construct a suggestion
    // that mirrors what the FR-3.4 buildStubSuggestion emits post-S109
    // (only 'activity' + 'meals' itemTypes) and confirm the materialise
    // route accepts every item.
    const app = makeApp();
    const token = tokenFor('USER');
    // Mirror buildStubSuggestion shape — pinned by the FR-3.4 handler
    // in routes/travel_itineraries.js.
    const stubShape = {
      daySplit: [
        {
          dayNumber: 1,
          theme: '[STUB] Day 1 — general theme placeholder',
          items: [
            {
              itemType: 'activity',
              description: '[STUB] Day 1 activity placeholder',
              estimatedCost: null,
              latitude: null,
              longitude: null,
              suggestedSupplierName: null,
            },
            {
              itemType: 'meals', // S109: was 'meal' pre-fix
              description: '[STUB] Day 1 meal placeholder',
              estimatedCost: null,
              latitude: null,
              longitude: null,
              suggestedSupplierName: null,
            },
          ],
        },
        {
          dayNumber: 2,
          theme: '[STUB] Day 2 — general theme placeholder',
          items: [
            {
              itemType: 'activity',
              description: '[STUB] Day 2 activity placeholder',
              estimatedCost: null,
              latitude: null,
              longitude: null,
              suggestedSupplierName: null,
            },
            {
              itemType: 'meals',
              description: '[STUB] Day 2 meal placeholder',
              estimatedCost: null,
              latitude: null,
              longitude: null,
              suggestedSupplierName: null,
            },
          ],
        },
      ],
      summary: '[STUB] 2-day TestDest (standard)',
      thematicNotes: '[STUB-ITINERARY-SUGGEST] Synthetic outline.',
    };
    const res = await request(app)
      .post('/api/travel/itineraries/from-suggestion')
      .set('Authorization', `Bearer ${token}`)
      .send({
        suggestionJson: stubShape,
        contactId: 501,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(201);
    expect(res.body.itemsCreated).toBe(4);
    const callArg = prisma.itinerary.create.mock.calls[0][0];
    const emittedTypes = callArg.data.items.create.map((i) => i.itemType);
    // Verify NO singular 'meal' / 'accommodation' leaked through.
    expect(emittedTypes).not.toContain('meal');
    expect(emittedTypes).not.toContain('accommodation');
    // Verify the canonical plural made it.
    expect(emittedTypes).toContain('meals');
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

// ─── S118 — POST /api/travel/itineraries/:id/items lat/lng whitelist ───
//
// S82 shipped frontend geocode-on-create (Nominatim → lat/lng in POST body)
// but the route handler destructure dropped latitude + longitude silently.
// The PATCH handler accepted them; the bulk-import path accepted them;
// only the single-item POST was missing the field. S118 closes the loop —
// destructure + validate + persist, mirroring the PATCH validation exactly
// (Number.isFinite + lat ∈ [-90,90] + lng ∈ [-180,180] → 400 with
// INVALID_LATITUDE / INVALID_LONGITUDE codes that mirror PATCH).
//
// Tests pin:
//   1.  POST with valid lat + lng → both persisted into prisma create payload.
//   2.  POST without lat/lng → both null (legacy clients unaffected).
//   3.  POST lat=0, lng=0 → both persisted (0 is a legitimate coord).
//   4.  POST lat=90, lng=180 → both persisted (max-boundary inclusive).
//   5.  POST lat=-90, lng=-180 → both persisted (min-boundary inclusive).
//   6.  POST lat=91 → 400 INVALID_LATITUDE.
//   7.  POST lng=181 → 400 INVALID_LONGITUDE.
//   8.  POST lat="not a number" → 400 INVALID_LATITUDE.
//   9.  POST lat=null → persisted as null (explicit-clear path).
//  10.  POST lat="" → persisted as null (form-empty-input path).
//  11.  POST with valid dayNumber → persisted (S118 also added dayNumber).
//  12.  Cross-tenant POST rejects → 404 ITEM_NOT_FOUND-style (regression).
//  13.  POST lng="not a number" → 400 INVALID_LONGITUDE.

describe('POST /api/travel/itineraries/:id/items lat/lng whitelist (S118)', () => {
  let itineraryItemCreateMock;
  let itineraryItemFindFirstMock;
  let itineraryFindFirstMock;

  beforeEach(() => {
    // The router needs to load the parent itinerary first via
    // loadItineraryWithGuard → prisma.itinerary.findFirst.
    itineraryFindFirstMock = vi.fn().mockResolvedValue({
      id: 99,
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 501,
      status: 'draft',
    });
    prisma.itinerary.findFirst = itineraryFindFirstMock;
    // Auto-position lookup — pretend it's the first item.
    itineraryItemFindFirstMock = vi.fn().mockResolvedValue(null);
    prisma.itineraryItem.findFirst = itineraryItemFindFirstMock;
    // Capture what gets created so the assertions can read the data payload.
    itineraryItemCreateMock = vi.fn().mockImplementation(async ({ data }) => ({
      id: 1234,
      itineraryId: data.itineraryId,
      itemType: data.itemType,
      description: data.description,
      position: data.position,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      dayNumber: data.dayNumber ?? null,
    }));
    prisma.itineraryItem.create = itineraryItemCreateMock;
    // syncItineraryAfterItemChange touches itinerary.findUnique + update +
    // items.findMany. Stub all three so the post-create housekeeping
    // doesn't 500.
    prisma.itinerary.findUnique = vi.fn().mockResolvedValue({ id: 99, status: 'draft' });
    prisma.itinerary.update = vi.fn().mockResolvedValue({ id: 99 });
    prisma.itineraryItem.findMany = vi.fn().mockResolvedValue([]);
  });

  test('1. POST with valid lat + lng → both persisted into create payload', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({
        itemType: 'activity',
        description: 'Beach walk',
        latitude: 15.2993,
        longitude: 74.124,
      });
    expect(res.status).toBe(201);
    expect(itineraryItemCreateMock).toHaveBeenCalledTimes(1);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(15.2993);
    expect(data.longitude).toBe(74.124);
    expect(res.body.latitude).toBe(15.2993);
    expect(res.body.longitude).toBe(74.124);
  });

  test('2. POST without lat/lng → both null (legacy-client regression)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'No coords' });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(null);
    expect(data.longitude).toBe(null);
  });

  test('3. POST lat=0, lng=0 → both persisted (0 is valid)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'Null Island', latitude: 0, longitude: 0 });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(0);
    expect(data.longitude).toBe(0);
  });

  test('4. POST lat=90, lng=180 → both persisted (max-boundary inclusive)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'North Pole-ish', latitude: 90, longitude: 180 });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(90);
    expect(data.longitude).toBe(180);
  });

  test('5. POST lat=-90, lng=-180 → both persisted (min-boundary inclusive)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'South Pole-ish', latitude: -90, longitude: -180 });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(-90);
    expect(data.longitude).toBe(-180);
  });

  test('6. POST lat=91 → 400 INVALID_LATITUDE', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'too far north', latitude: 91, longitude: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LATITUDE');
    expect(itineraryItemCreateMock).not.toHaveBeenCalled();
  });

  test('7. POST lng=181 → 400 INVALID_LONGITUDE', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'too far east', latitude: 0, longitude: 181 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LONGITUDE');
    expect(itineraryItemCreateMock).not.toHaveBeenCalled();
  });

  test('8. POST lat="not a number" → 400 INVALID_LATITUDE', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'bad coord', latitude: 'not-a-number', longitude: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LATITUDE');
    expect(itineraryItemCreateMock).not.toHaveBeenCalled();
  });

  test('9. POST lat=null → persisted as null (explicit-clear path)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'explicit null', latitude: null, longitude: null });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(null);
    expect(data.longitude).toBe(null);
  });

  test('10. POST lat="" → persisted as null (form-empty-input path)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'empty string', latitude: '', longitude: '' });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.latitude).toBe(null);
    expect(data.longitude).toBe(null);
  });

  test('11. POST with valid dayNumber → persisted (S118 also wired dayNumber)', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'Day 3 item', dayNumber: 3 });
    expect(res.status).toBe(201);
    const data = itineraryItemCreateMock.mock.calls[0][0].data;
    expect(data.dayNumber).toBe(3);
  });

  test('12. cross-tenant POST → 404 (itinerary guard rejects)', async () => {
    // loadItineraryWithGuard does findFirst({ where: { id, tenantId } }) so
    // a cross-tenant lookup returns null → 404. Simulate by returning null.
    itineraryFindFirstMock.mockResolvedValueOnce(null);
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/77777/items')
      .set('Authorization', `Bearer ${token}`)
      .send({
        itemType: 'activity',
        description: 'cross-tenant attempt',
        latitude: 15.2993,
        longitude: 74.124,
      });
    expect(res.status).toBe(404);
    expect(itineraryItemCreateMock).not.toHaveBeenCalled();
  });

  test('13. POST lng="not a number" → 400 INVALID_LONGITUDE', async () => {
    const app = makeApp();
    const token = tokenFor('USER');
    const res = await request(app)
      .post('/api/travel/itineraries/99/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ itemType: 'activity', description: 'bad lng', latitude: 0, longitude: 'NaN-string' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LONGITUDE');
    expect(itineraryItemCreateMock).not.toHaveBeenCalled();
  });
});
