// @ts-check
/**
 * Travel CRM — Itinerary Template Library CRUD (#907 slice 6/N) — route
 * tests.
 *
 * Pins the 5-endpoint contract for /api/travel/itinerary-templates:
 *   GET    /            list, paginated, tenant + sub-brand scoped
 *   POST   /            create (ADMIN+MANAGER)
 *   GET    /:id         get one, sub-brand gate
 *   PATCH  /:id         update (ADMIN+MANAGER)
 *   DELETE /:id         soft-delete (ADMIN only) via isActive=false
 *
 * What's pinned
 * -------------
 *   - GET happy path returns { items, total, limit, offset }
 *   - GET non-travel tenant → 403 WRONG_VERTICAL (requireTravelTenant)
 *   - GET unauthenticated → 401 (verifyToken)
 *   - GET ?limit clamp: >200 → 200, <1 → 1
 *   - GET MANAGER subBrandAccess=['rfu'] threads
 *     `OR: [{ subBrand: null }, { subBrand: { in: ['rfu'] } }]` (nullable
 *     subBrand semantics — tenant-wide rows visible to everyone)
 *   - POST ADMIN happy path → 201 + record + usageCount=0
 *   - POST missing name → 400 MISSING_NAME
 *   - POST missing destinationName → 400 MISSING_DESTINATION
 *   - POST missing durationDays → 400 MISSING_DURATION
 *   - POST durationDays=0 (non-positive) → 400 INVALID_DURATION
 *   - POST USER role → 403 (verifyRole gate)
 *   - GET /:id found / invalid id / not-found shapes
 *   - PATCH /:id happy path + empty body + not found
 *   - DELETE /:id sets isActive=false (no destructive delete); MANAGER → 403
 *
 * Pattern mirrors travel-sightseeing.test.js — patch prisma BEFORE
 * requiring the router, drive with real HS256 JWTs against the dev
 * fallback secret. verifyToken + verifyRole + requireTravelTenant +
 * getSubBrandAccessSet all run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.itineraryTemplate = prisma.itineraryTemplate || {};
prisma.itineraryTemplate.findMany = vi.fn();
prisma.itineraryTemplate.findFirst = vi.fn();
prisma.itineraryTemplate.count = vi.fn();
prisma.itineraryTemplate.create = vi.fn();
prisma.itineraryTemplate.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
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
const templatesRouter = requireCJS('../../routes/travel_itinerary_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/itinerary-templates', templatesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const sampleRows = [
  {
    id: 201,
    tenantId: 1,
    name: '5-day Paris City Break',
    destinationName: 'Paris',
    durationDays: 5,
    description: 'Classic Paris itinerary with Eiffel + Louvre + Versailles.',
    thumbnailUrl: 'https://cdn.example.com/paris-template.jpg',
    category: 'City Break',
    subBrand: 'travelstall',
    defaultMarkupPercent: 18.0,
    basePriceMinor: 8500000,
    currency: 'INR',
    templateJson: null,
    llmGeneratedBy: null,
    isActive: true,
    usageCount: 12,
    createdAt: new Date('2026-05-10T09:00:00Z'),
    updatedAt: new Date('2026-05-10T09:00:00Z'),
  },
  {
    id: 202,
    tenantId: 1,
    name: '14-day Umrah Standard',
    destinationName: 'Mecca',
    durationDays: 14,
    description: 'Standard Umrah package with Madinah + Mecca stay.',
    thumbnailUrl: null,
    category: 'Religious',
    subBrand: 'rfu',
    defaultMarkupPercent: 12.0,
    basePriceMinor: 12000000,
    currency: 'INR',
    templateJson: null,
    llmGeneratedBy: null,
    isActive: true,
    usageCount: 38,
    createdAt: new Date('2026-05-09T08:00:00Z'),
    updatedAt: new Date('2026-05-09T08:00:00Z'),
  },
];

beforeEach(() => {
  prisma.itineraryTemplate.findMany.mockReset().mockResolvedValue(sampleRows);
  prisma.itineraryTemplate.findFirst.mockReset();
  prisma.itineraryTemplate.count.mockReset().mockResolvedValue(sampleRows.length);
  prisma.itineraryTemplate.create.mockReset();
  prisma.itineraryTemplate.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/itinerary-templates — list', () => {
  test('happy path: returns paginated envelope', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.items[0].name).toBe('5-day Paris City Break');
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('unauthenticated (no header) → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/itinerary-templates');
    expect(res.status).toBe(401);
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('?limit=300 clamps to 200; ?limit=0 clamps to 1', async () => {
    let res = await request(makeApp())
      .get('/api/travel/itinerary-templates?limit=300')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(prisma.itineraryTemplate.findMany.mock.calls[0][0].take).toBe(200);

    res = await request(makeApp())
      .get('/api/travel/itinerary-templates?limit=0')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(prisma.itineraryTemplate.findMany.mock.calls[1][0].take).toBe(1);
  });

  test('MANAGER subBrandAccess=["rfu"] threads OR clause (nullable subBrand)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.OR).toEqual([
      { subBrand: null },
      { subBrand: { in: ['rfu'] } },
    ]);
  });

  test('?destinationName + ?category + ?isActive filters thread into where', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates?destinationName=Paris&category=City+Break&isActive=true')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.destinationName).toBe('Paris');
    expect(call.where.category).toBe('City Break');
    expect(call.where.isActive).toBe(true);
  });
});

describe('POST /api/travel/itinerary-templates — create', () => {
  test('ADMIN happy path → 201 with usageCount=0', async () => {
    prisma.itineraryTemplate.create.mockImplementation(({ data }) => ({
      id: 999,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: '7-day Tokyo Discovery',
        destinationName: 'Tokyo',
        durationDays: 7,
        description: 'Tokyo discovery template.',
        category: 'City Break',
        currency: 'INR',
        basePriceMinor: 11000000,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(999);
    expect(res.body.name).toBe('7-day Tokyo Discovery');
    expect(res.body.usageCount).toBe(0);
    expect(prisma.itineraryTemplate.create).toHaveBeenCalled();
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(1);
    expect(data.name).toBe('7-day Tokyo Discovery');
    expect(data.durationDays).toBe(7);
    expect(data.currency).toBe('INR');
    expect(data.usageCount).toBe(0);
  });

  test('missing name → 400 MISSING_NAME', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ destinationName: 'Paris', durationDays: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_NAME');
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
  });

  test('missing destinationName → 400 MISSING_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Mystery Trip', durationDays: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DESTINATION');
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
  });

  test('missing durationDays → 400 MISSING_DURATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Paris', destinationName: 'Paris' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DURATION');
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
  });

  test('durationDays=0 (non-positive) → 400 INVALID_DURATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Paris', destinationName: 'Paris', durationDays: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
  });

  test('invalid lowercase currency "inr" → 400 INVALID_CURRENCY', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Paris',
        destinationName: 'Paris',
        durationDays: 5,
        currency: 'inr',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENCY');
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole gate; create blocked)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ name: 'Paris', destinationName: 'Paris', durationDays: 5 });

    expect(res.status).toBe(403);
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S13 — brand-kit-aware POST defaults from tenant.subBrandConfigJson.
//
// Pins per docs/TRAVEL_BIG_SCOPE_BACKLOG.md S13 + PRD_TRAVEL_ITINERARY_
// UPGRADES.md ("Brand-kit-aware itinerary template defaults from
// subBrandConfigJson"). The brand-kit selector:
//   - reads tenant.subBrandConfigJson (extra prisma.tenant.findUnique on
//     create — requireTravelTenant doesn't project the column),
//   - resolves per-sub-brand block first, top-level fallback second,
//     hard-coded BRAND_KIT_FALLBACKS third,
//   - mutates createData.thumbnailUrl + createData.templateJson.branding
//     to seed defaults,
//   - lets caller-supplied values win.
//
// Pinned cases:
//   (a) POST with empty body brand fields + tenant.subBrandConfigJson set
//       → brand fields applied from the per-sub-brand block; branding._source
//       = "subBrandConfig"
//   (b) POST with explicit thumbnailUrl + templateJson.branding overrides
//       → caller values win; config / fallback don't clobber
//   (c) POST when tenant.subBrandConfigJson is null → fallback colors apply;
//       branding._source = "fallback"
//   (d) Sub-brand routing: per-sub-brand block wins over top-level
//   (e) Top-level fallback fires when template has no subBrand
//   (f) Malformed subBrandConfigJson → silent fall-through to fallback
//       defaults (no 500)
// ---------------------------------------------------------------------------
describe('POST /api/travel/itinerary-templates — S13 brand-kit defaults', () => {
  // Helper: stub the tenant lookup for the brand-kit refetch path.
  // requireTravelTenant calls prisma.tenant.findUnique first (selecting
  // id/vertical/name/slug). The brand-kit refetch fires a second
  // findUnique (selecting subBrandConfigJson). The shared mock returns
  // the union of both so each call resolves correctly regardless of
  // select clause.
  function stubTenantConfig(configJson) {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1,
      vertical: 'travel',
      name: 'Test Travel',
      slug: 'test-travel',
      subBrandConfigJson: configJson,
    });
  }

  beforeEach(() => {
    prisma.itineraryTemplate.create.mockImplementation(({ data }) => ({
      id: 9001,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  test('(a) POST without brand fields + config set → branding applied from sub-brand block; _source="subBrandConfig"', async () => {
    stubTenantConfig(JSON.stringify({
      rfu: {
        thumbnailUrl: 'https://cdn.example.com/rfu-cover.jpg',
        primaryColor: '#012345',
        accentColor: '#abcdef',
        headerColor: '#fedcba',
        fontFamily: 'Cairo, sans-serif',
      },
    }));

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: '14-day Umrah Standard',
        destinationName: 'Mecca',
        durationDays: 14,
        subBrand: 'rfu',
      });

    expect(res.status).toBe(201);
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    expect(data.thumbnailUrl).toBe('https://cdn.example.com/rfu-cover.jpg');
    expect(typeof data.templateJson).toBe('string');
    const tj = JSON.parse(data.templateJson);
    expect(tj.branding.primaryColor).toBe('#012345');
    expect(tj.branding.accentColor).toBe('#abcdef');
    expect(tj.branding.headerColor).toBe('#fedcba');
    expect(tj.branding.fontFamily).toBe('Cairo, sans-serif');
    expect(tj.branding._source).toBe('subBrandConfig');
  });

  test('(b) POST with explicit thumbnailUrl + branding overrides — caller wins', async () => {
    stubTenantConfig(JSON.stringify({
      tmc: { thumbnailUrl: 'https://cdn.example.com/tmc-default.jpg', primaryColor: '#000000' },
    }));

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Spain School Trip',
        destinationName: 'Madrid',
        durationDays: 6,
        subBrand: 'tmc',
        thumbnailUrl: 'https://cdn.example.com/operator-custom.jpg',
        templateJson: JSON.stringify({
          items: [{ day: 1, title: 'Arrival' }],
          branding: { primaryColor: '#FF00FF' },
        }),
      });

    expect(res.status).toBe(201);
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    // Caller's thumbnailUrl wins
    expect(data.thumbnailUrl).toBe('https://cdn.example.com/operator-custom.jpg');
    const tj = JSON.parse(data.templateJson);
    // Caller's items[] preserved
    expect(tj.items).toEqual([{ day: 1, title: 'Arrival' }]);
    // Caller's branding.primaryColor wins
    expect(tj.branding.primaryColor).toBe('#FF00FF');
    // Other branding fields backfilled from fallback (config didn't define
    // them; sub-brand was tmc → tmc fallback)
    expect(tj.branding.fontFamily).toBe('Inter, sans-serif');
  });

  test('(c) POST when subBrandConfigJson is null → fallback defaults applied; _source="fallback"', async () => {
    stubTenantConfig(null);

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: '7-day Tokyo Discovery',
        destinationName: 'Tokyo',
        durationDays: 7,
        subBrand: 'travelstall',
      });

    expect(res.status).toBe(201);
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    // Hard-coded fallback color for travelstall is #C0392B
    expect(data.thumbnailUrl).toBeNull();
    const tj = JSON.parse(data.templateJson);
    expect(tj.branding.primaryColor).toBe('#C0392B');
    expect(tj.branding.accentColor).toBe('#F39C12');
    expect(tj.branding.headerColor).toBe('#922B21');
    expect(tj.branding.fontFamily).toBe('Inter, sans-serif');
    expect(tj.branding._source).toBe('fallback');
  });

  test('(d) Sub-brand routing: per-sub-brand block wins over top-level', async () => {
    stubTenantConfig(JSON.stringify({
      // Top-level defaults (used when sub-brand block missing or template
      // has no subBrand)
      primaryColor: '#111111',
      // Per-sub-brand wins for subBrand=visasure
      visasure: { primaryColor: '#222222', fontFamily: 'Roboto, sans-serif' },
    }));

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Schengen Visa Application',
        destinationName: 'Paris',
        durationDays: 1,
        subBrand: 'visasure',
      });

    expect(res.status).toBe(201);
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    const tj = JSON.parse(data.templateJson);
    expect(tj.branding.primaryColor).toBe('#222222'); // visasure block wins
    expect(tj.branding.fontFamily).toBe('Roboto, sans-serif');
    expect(tj.branding._source).toBe('subBrandConfig');
  });

  test('(e) Top-level config used when template has no subBrand', async () => {
    stubTenantConfig(JSON.stringify({
      primaryColor: '#777777',
      fontFamily: 'Lato, sans-serif',
    }));

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Generic Trip Template',
        destinationName: 'Worldwide',
        durationDays: 3,
        // No subBrand → tenant-wide template
      });

    expect(res.status).toBe(201);
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    expect(data.subBrand).toBeNull();
    const tj = JSON.parse(data.templateJson);
    // Top-level wins; sub-brand fallback ("_generic") provides the rest
    expect(tj.branding.primaryColor).toBe('#777777');
    expect(tj.branding.fontFamily).toBe('Lato, sans-serif');
    expect(tj.branding._source).toBe('subBrandConfig');
    // Backfilled from _generic
    expect(tj.branding.accentColor).toBe('#F2B544');
  });

  test('(f) Malformed subBrandConfigJson → fallback applied silently (no 500)', async () => {
    stubTenantConfig('this is not JSON {{{');

    const res = await request(makeApp())
      .post('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Resilience Test',
        destinationName: 'Anywhere',
        durationDays: 2,
        subBrand: 'tmc',
      });

    expect(res.status).toBe(201);
    const data = prisma.itineraryTemplate.create.mock.calls[0][0].data;
    const tj = JSON.parse(data.templateJson);
    expect(tj.branding._source).toBe('fallback');
    expect(tj.branding.primaryColor).toBe('#1F4E79'); // tmc fallback
  });
});

describe('GET /api/travel/itinerary-templates/:id', () => {
  test('found → 200 + row', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(sampleRows[0]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(201);
    expect(res.body.name).toBe('5-day Paris City Break');
  });

  test('invalid id "abc" → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/abc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.itineraryTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('not found → 404 ITINERARY_TEMPLATE_NOT_FOUND', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_TEMPLATE_NOT_FOUND');
  });
});

describe('PATCH /api/travel/itinerary-templates/:id', () => {
  test('ADMIN happy path → 200 + updated', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(sampleRows[0]);
    prisma.itineraryTemplate.update.mockResolvedValue({
      ...sampleRows[0],
      durationDays: 6,
    });

    const res = await request(makeApp())
      .patch('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ durationDays: 6 });

    expect(res.status).toBe(200);
    expect(res.body.durationDays).toBe(6);
    const updateCall = prisma.itineraryTemplate.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe(201);
    expect(updateCall.data.durationDays).toBe(6);
  });

  test('empty body → 400 EMPTY_BODY', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(sampleRows[0]);

    const res = await request(makeApp())
      .patch('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole gate)', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ durationDays: 6 });

    expect(res.status).toBe(403);
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('not found → 404 ITINERARY_TEMPLATE_NOT_FOUND', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .patch('/api/travel/itinerary-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_TEMPLATE_NOT_FOUND');
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('invalid durationDays on PATCH → 400 INVALID_DURATION', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(sampleRows[0]);

    const res = await request(makeApp())
      .patch('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ durationDays: -3 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G049 — library metric columns (acceptedCount, avgFinalPrice, lastUsedAt).
// Pins per PRD_TRAVEL_ITINERARY_UPGRADES FR-3.1.h. The columns are engine-
// bumped by routes/travel_itineraries.js (clone path → usageCount +
// lastUsedAt; accept path → acceptedCount + avgFinalPrice), NEVER set by
// the templates route itself. Tests here only verify:
//   (a) the columns flow through GET responses (no select clause hides them)
//   (b) the columns are NOT in MUTABLE_FIELDS — PATCH ignores them silently
// ---------------------------------------------------------------------------
describe('G049 — library metric columns flow through GET; rejected on PATCH', () => {
  test('GET / returns acceptedCount + avgFinalPrice + lastUsedAt fields', async () => {
    const ts = new Date('2026-06-01T12:00:00Z');
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      {
        ...sampleRows[0],
        acceptedCount: 7,
        avgFinalPrice: '85000.50',
        lastUsedAt: ts,
      },
    ]);
    prisma.itineraryTemplate.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].acceptedCount).toBe(7);
    expect(res.body.items[0].avgFinalPrice).toBe('85000.50');
    expect(res.body.items[0].lastUsedAt).toBe(ts.toISOString());
  });

  test('GET /:id returns metric columns', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue({
      ...sampleRows[0],
      acceptedCount: 3,
      avgFinalPrice: '42000.00',
      lastUsedAt: new Date('2026-05-30T08:00:00Z'),
    });
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.acceptedCount).toBe(3);
    expect(res.body.avgFinalPrice).toBe('42000.00');
  });

  test('PATCH with acceptedCount / avgFinalPrice / lastUsedAt — silently dropped (engine-only)', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(sampleRows[0]);
    prisma.itineraryTemplate.update.mockResolvedValue({
      ...sampleRows[0],
      durationDays: 8,
    });

    const res = await request(makeApp())
      .patch('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        durationDays: 8,
        // Attempt to set engine-only fields — should be filtered out by
        // pickMutable's MUTABLE_FIELDS whitelist.
        acceptedCount: 9999,
        avgFinalPrice: 99999999,
        lastUsedAt: new Date('2099-01-01').toISOString(),
      });

    expect(res.status).toBe(200);
    const dataArg = prisma.itineraryTemplate.update.mock.calls[0][0].data;
    // durationDays passes through (mutable); engine-only fields are absent.
    expect(dataArg.durationDays).toBe(8);
    expect(dataArg.acceptedCount).toBeUndefined();
    expect(dataArg.avgFinalPrice).toBeUndefined();
    expect(dataArg.lastUsedAt).toBeUndefined();
  });
});

describe('DELETE /api/travel/itinerary-templates/:id — soft delete', () => {
  test('ADMIN sets isActive=false (does NOT actually destroy)', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(sampleRows[0]);
    prisma.itineraryTemplate.update.mockResolvedValue({
      ...sampleRows[0],
      isActive: false,
    });

    const res = await request(makeApp())
      .delete('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const updateCall = prisma.itineraryTemplate.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe(201);
    expect(updateCall.data).toEqual({ isActive: false });
  });

  test('MANAGER role → 403 (ADMIN-only gate)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/itinerary-templates/201')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('not found → 404 ITINERARY_TEMPLATE_NOT_FOUND', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/travel/itinerary-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITINERARY_TEMPLATE_NOT_FOUND');
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });
});
