// @ts-check
/**
 * PRD_TRAVEL_MARKETING_FLYER #908 slice 3 — TravelFlyerTemplate CRUD tests.
 *
 * Pins the contract for routes/travel_flyer_templates.js shipped alongside
 * the TravelFlyerTemplate Prisma model and consuming the
 * lib/flyerTemplateValidator.js (slice 1, commit 28146498) palette + layout
 * shape validators. Replaces the frontend STUB endpoint that FlyerTemplates.jsx
 * (slice 2, commit a64c1058) currently calls.
 *
 * What's pinned
 * -------------
 *   - POST   /api/travel/flyer-templates
 *       happy path with valid palette + layout → 201 + audit row
 *       missing name → 400 MISSING_FIELDS
 *       missing paletteJson → 400 MISSING_FIELDS
 *       malformed paletteJson string → 400 INVALID_PALETTE_JSON
 *       malformed layoutJson string → 400 INVALID_LAYOUT_JSON
 *       palette missing required hex (primaryHex) → 400 INVALID_TEMPLATE + errors[]
 *       layout block with negative width → 400 INVALID_TEMPLATE + errors[]
 *       invalid subBrand → 400 INVALID_SUB_BRAND
 *       MANAGER with subBrandAccess outside target → 403 SUB_BRAND_DENIED
 *   - GET    /api/travel/flyer-templates
 *       tenant-scoped list shape
 *       ?subBrand filter narrows where clause
 *   - GET    /api/travel/flyer-templates/:id
 *       cross-tenant lookup returns 404 TEMPLATE_NOT_FOUND
 *   - PUT    /api/travel/flyer-templates/:id
 *       partial update (name only) does NOT re-run validator
 *       PUT replacing paletteJson re-runs validator (rejects bad palette)
 *       cross-tenant returns 404 TEMPLATE_NOT_FOUND
 *   - DELETE /api/travel/flyer-templates/:id
 *       ADMIN happy path → 204 + audit row written before prisma.delete
 *       MANAGER → 403 RBAC_DENIED (route is ADMIN-only on delete)
 *   - POST   /api/travel/flyer-templates/:id/duplicate (slice 6)
 *       happy path with no overrides → 201, name=<source> (copy), inherits shape
 *       body override name → uses override
 *       body override subBrand → uses override (validates against assertValidSubBrand)
 *       invalid subBrand override → 400 INVALID_SUB_BRAND
 *       cross-tenant source → 404 TEMPLATE_NOT_FOUND
 *       MANAGER restricted, source.subBrand not in access set → 403 SUB_BRAND_DENIED
 *       USER role → 403 RBAC_DENIED (route is ADMIN/MANAGER)
 *       source.isActive=false still duplicates (no INVALID_STATE gate)
 *   - templateHash virtual field (slice 9)
 *       GET list rows carry templateHash matching hashTemplateShape({ palette, layout, assets })
 *       GET one carries templateHash
 *       POST create response carries templateHash
 *       PUT update response carries templateHash
 *       POST duplicate response carries templateHash (matches source — shape inherited verbatim)
 *       row with corrupted paletteJson string folds to the same hash as the empty `{}` shape
 *       templateHash is stable across iterations (same shape → same hash)
 *       two semantically-different shapes hash differently
 *
 * Pattern mirrors backend/test/routes/travel-commission-profiles.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed against the
 * same fallback secret the middleware uses in dev. verifyToken +
 * verifyRole + requireTravelTenant + sub-brand gates all run.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelFlyerTemplate = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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
const templatesRouter = requireCJS('../../routes/travel_flyer_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', templatesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Canonical sample shapes that satisfy flyerTemplateValidator.
const validPalette = {
  primaryHex: '#122647',
  secondaryHex: '#C89A4E',
  accentHex: '#F5E6CC',
  textHex: '#1A1A1A',
  bgHex: '#FFFFFF',
};
const validLayout = [
  { type: 'logo', x: 20, y: 20, width: 120, height: 60, src: 'https://cdn.example/logo.png' },
  { type: 'text', x: 20, y: 100, width: 400, height: 40, content: 'Summer Umrah 2026' },
  { type: 'cta', x: 20, y: 600, width: 200, height: 50, content: 'Book Now', href: 'https://example.com/book' },
];
const validAssets = {
  logo: 'https://cdn.example/logo.png',
  hero: 'https://cdn.example/hero.jpg',
};

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelFlyerTemplate.findMany.mockReset();
  prisma.travelFlyerTemplate.findFirst.mockReset();
  prisma.travelFlyerTemplate.count.mockReset();
  prisma.travelFlyerTemplate.create.mockReset();
  prisma.travelFlyerTemplate.update.mockReset();
  prisma.travelFlyerTemplate.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/flyer-templates', () => {
  test('happy path with valid palette + layout returns 201 + writes audit', async () => {
    prisma.travelFlyerTemplate.create.mockResolvedValue({
      id: 42,
      tenantId: 1,
      name: 'Summer Umrah 2026',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: JSON.stringify(validAssets),
      subBrand: 'rfu',
      isActive: true,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Summer Umrah 2026',
        paletteJson: validPalette,
        layoutJson: validLayout,
        assetsJson: validAssets,
        subBrand: 'rfu',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      name: 'Summer Umrah 2026',
      subBrand: 'rfu',
      isActive: true,
    });
    expect(prisma.travelFlyerTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          name: 'Summer Umrah 2026',
          subBrand: 'rfu',
        }),
      }),
    );
    // Each JSON column must be stored as a stringified JSON.
    const callArgs = prisma.travelFlyerTemplate.create.mock.calls[0][0];
    expect(typeof callArgs.data.paletteJson).toBe('string');
    expect(typeof callArgs.data.layoutJson).toBe('string');
    expect(typeof callArgs.data.assetsJson).toBe('string');
    expect(JSON.parse(callArgs.data.paletteJson)).toEqual(validPalette);
    expect(JSON.parse(callArgs.data.layoutJson)).toEqual(validLayout);
    // Audit row must be written.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('rejects missing name with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        paletteJson: validPalette,
        layoutJson: validLayout,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/name/i);
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('rejects missing paletteJson with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'No palette',
        layoutJson: validLayout,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/paletteJson/);
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('rejects malformed paletteJson string with 400 INVALID_PALETTE_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Malformed palette',
        paletteJson: '{not-valid-json',
        layoutJson: validLayout,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PALETTE_JSON' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('rejects malformed layoutJson string with 400 INVALID_LAYOUT_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Malformed layout',
        paletteJson: validPalette,
        layoutJson: '[not-valid-json',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LAYOUT_JSON' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('rejects palette missing primaryHex with 400 INVALID_TEMPLATE + errors[]', async () => {
    const bad = { ...validPalette };
    delete bad.primaryHex;
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Missing primary',
        paletteJson: bad,
        layoutJson: validLayout,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TEMPLATE' });
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.some((e) => /primaryHex/.test(e))).toBe(true);
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('rejects layout block with negative width with 400 INVALID_TEMPLATE + errors[]', async () => {
    const badLayout = [
      { type: 'text', x: 10, y: 10, width: -5, height: 20, content: 'Bad block' },
    ];
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Negative dimensions',
        paletteJson: validPalette,
        layoutJson: badLayout,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TEMPLATE' });
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.some((e) => /width/.test(e))).toBe(true);
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('rejects invalid subBrand with 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'wrong-brand',
        paletteJson: validPalette,
        layoutJson: validLayout,
        subBrand: 'gold-package',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"] creating a "tmc" template gets 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({
        name: 'cross-brand',
        paletteJson: validPalette,
        layoutJson: validLayout,
        subBrand: 'tmc',
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/flyer-templates', () => {
  test('returns tenant-scoped list', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      {
        id: 1,
        tenantId: 1,
        name: 'Summer Umrah 2026',
        paletteJson: JSON.stringify(validPalette),
        layoutJson: JSON.stringify(validLayout),
        assetsJson: null,
        subBrand: 'rfu',
        isActive: true,
      },
    ]);
    prisma.travelFlyerTemplate.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.templates).toHaveLength(1);
    expect(prisma.travelFlyerTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('?subBrand filter narrows the where clause', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([]);
    prisma.travelFlyerTemplate.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/flyer-templates?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelFlyerTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, subBrand: 'rfu' }),
      }),
    );
  });
});

// Slice 13 — GET /api/travel/flyer-templates/sub-brands
// Per-sub-brand counts meta endpoint. USER-readable; powers the library
// UI's sub-brand filter chips. Sub-brand-restricted callers see only
// their allowed sub-brand buckets PLUS the tenant-wide bucket.
describe('GET /api/travel/flyer-templates/sub-brands (slice 13)', () => {
  test('ADMIN with full access → buckets for tenant-wide + all 4 sub-brands', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { subBrand: 'tmc' },
      { subBrand: 'tmc' },
      { subBrand: 'rfu' },
      { subBrand: 'travelstall' },
      { subBrand: 'travelstall' },
      { subBrand: 'travelstall' },
      { subBrand: null },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Stable order: tenant-wide first, then sub-brands alphabetically
    // (rfu, tmc, travelstall, visasure per VALID_SUB_BRANDS order).
    expect(res.body.buckets).toEqual([
      { subBrand: null, count: 1 },
      { subBrand: 'tmc', count: 2 },
      { subBrand: 'rfu', count: 1 },
      { subBrand: 'travelstall', count: 3 },
      { subBrand: 'visasure', count: 0 },
    ]);
    expect(res.body.total).toBe(7);
    // findMany must have been called with the tenant scope; no
    // sub-brand narrowing for an ADMIN with full access.
    const callArgs = prisma.travelFlyerTemplate.findMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(1);
    expect(callArgs.where.OR).toBeUndefined();
    expect(callArgs.select).toEqual({ subBrand: true });
  });

  test('MANAGER restricted to ["rfu"] → only tenant-wide + rfu buckets, OR clause narrows where', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { subBrand: 'rfu' },
      { subBrand: 'rfu' },
      { subBrand: null },
      { subBrand: null },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    // Only buckets the caller can see: tenant-wide + rfu. tmc, travelstall,
    // visasure are absent from the response — frontend never offers a
    // filter chip for a sub-brand the user cannot access.
    expect(res.body.buckets).toEqual([
      { subBrand: null, count: 2 },
      { subBrand: 'rfu', count: 2 },
    ]);
    expect(res.body.total).toBe(4);
    // findMany must have been called with an OR clause narrowing to
    // rfu-or-null rows so cross-sub-brand rows never reach the JS-side
    // aggregator.
    const callArgs = prisma.travelFlyerTemplate.findMany.mock.calls[0][0];
    expect(callArgs.where.OR).toEqual([
      { subBrand: { in: ['rfu'] } },
      { subBrand: null },
    ]);
  });

  test('USER role is allowed (read-only meta endpoint, mirrors /preview.pdf access)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Zero-count buckets are still surfaced so the frontend can render
    // the full set of filter chips with their counts (including 0s).
    expect(res.body.buckets.length).toBe(5); // null + 4 sub-brands
    expect(res.body.total).toBe(0);
  });

  test('?isActive=true narrows the where clause + does not affect bucket order', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { subBrand: 'tmc' },
      { subBrand: null },
    ]);
    await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands?isActive=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelFlyerTemplate.findMany.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({ tenantId: 1, isActive: true });
  });

  test('?isActive=false narrows to archived rows', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands?isActive=false')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const callArgs = prisma.travelFlyerTemplate.findMany.mock.calls[0][0];
    expect(callArgs.where.isActive).toBe(false);
  });

  test('does NOT collide with /:id route — string id "sub-brands" never reaches the :id handler', async () => {
    // Belt-and-braces: confirm Express picks the /sub-brands route
    // FIRST (mounted before /:id). If the wiring regressed and /:id
    // ate this request first, the handler would parseInt('sub-brands')
    // and 400 INVALID_ID. This test pins the route order.
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('buckets');
    expect(res.body).not.toMatchObject({ code: 'INVALID_ID' });
    // /:id handler uses findFirst, not findMany — must NOT have fired.
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('rows with unknown subBrand values are dropped from the response (defensive — should never happen given the OR narrowing, but pinned)', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([
      { subBrand: 'tmc' },
      { subBrand: 'unknown_subbrand_value' }, // shouldn't slip through
      { subBrand: null },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/sub-brands')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const tmcBucket = res.body.buckets.find((b) => b.subBrand === 'tmc');
    const tenantWideBucket = res.body.buckets.find((b) => b.subBrand === null);
    expect(tmcBucket.count).toBe(1);
    expect(tenantWideBucket.count).toBe(1);
    // Total reflects only buckets the response includes (3 of 4 input rows).
    expect(res.body.total).toBe(2);
  });
});

describe('GET /api/travel/flyer-templates/:id', () => {
  test('cross-tenant lookup returns 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(prisma.travelFlyerTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});

describe('PUT /api/travel/flyer-templates/:id', () => {
  test('partial update (name only) returns 200 + does NOT re-run validator', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'old',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null,
      subBrand: 'rfu',
      isActive: true,
    });
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'renamed',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null,
      subBrand: 'rfu',
      isActive: false,
    });
    const res = await request(makeApp())
      .put('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'renamed', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, name: 'renamed', isActive: false });
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ name: 'renamed', isActive: false }),
      }),
    );
    // Untouched shape columns must NOT appear in the update payload.
    const updateData = prisma.travelFlyerTemplate.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('paletteJson');
    expect(updateData).not.toHaveProperty('layoutJson');
    expect(updateData).not.toHaveProperty('assetsJson');
  });

  test('PUT replacing paletteJson with an INVALID palette re-runs validator → 400 INVALID_TEMPLATE', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'old',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null,
      subBrand: null,
      isActive: true,
    });
    const badPalette = { ...validPalette };
    delete badPalette.primaryHex; // shape error
    const res = await request(makeApp())
      .put('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ paletteJson: badPalette });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TEMPLATE' });
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.some((e) => /primaryHex/.test(e))).toBe(true);
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('cross-tenant returns 404 TEMPLATE_NOT_FOUND (no update fires)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/travel/flyer-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'oops' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/flyer-templates/:id (ADMIN-only hard delete)', () => {
  test('ADMIN: returns 204 and writes audit row before prisma.delete fires', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      name: 'doomed',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null,
      subBrand: 'rfu',
      isActive: true,
    });

    const callOrder = [];
    prisma.auditLog.create.mockImplementation(async (args) => {
      callOrder.push('audit');
      return { id: 1, ...args };
    });
    prisma.travelFlyerTemplate.delete.mockImplementation(async () => {
      callOrder.push('delete');
      return { id: 5 };
    });

    const res = await request(makeApp())
      .delete('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(callOrder).toEqual(['audit', 'delete']);

    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data).toMatchObject({
      entity: 'TravelFlyerTemplate',
      action: 'DELETE',
      entityId: 5,
      userId: 7,
      tenantId: 1,
    });
  });

  test('MANAGER: returns 403 RBAC_DENIED (route is ADMIN-only on delete)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/flyer-templates/:id/duplicate (slice 6)', () => {
  const sourceRow = {
    id: 11,
    tenantId: 1,
    name: 'Summer Umrah 2026',
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: JSON.stringify(validAssets),
    subBrand: 'rfu',
    isActive: true,
    notes: 'Brand-approved palette per Yasin 2026-04-15',
  };

  test('happy path with no overrides → 201, name=<source> (copy), inherits shape', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);
    prisma.travelFlyerTemplate.create.mockImplementation(async (args) => ({
      id: 99,
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 99,
      name: 'Summer Umrah 2026 (copy)',
      subBrand: 'rfu',
      isActive: true,
    });

    const callArgs = prisma.travelFlyerTemplate.create.mock.calls[0][0];
    expect(callArgs.data).toMatchObject({
      tenantId: 1,
      name: 'Summer Umrah 2026 (copy)',
      paletteJson: sourceRow.paletteJson,
      layoutJson: sourceRow.layoutJson,
      assetsJson: sourceRow.assetsJson,
      subBrand: 'rfu',
      isActive: true,
      notes: 'Brand-approved palette per Yasin 2026-04-15',
    });

    // Audit row: action=TRAVEL_FLYER_TEMPLATE_DUPLICATED + sourceId + newId
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelFlyerTemplate',
      action: 'TRAVEL_FLYER_TEMPLATE_DUPLICATED',
      entityId: 99,
      userId: 7,
      tenantId: 1,
    });
    const detailsParsed = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(detailsParsed).toMatchObject({ sourceId: 11, newId: 99 });
  });

  test('body override name → uses override (not the "(copy)" suffix)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);
    prisma.travelFlyerTemplate.create.mockImplementation(async (args) => ({
      id: 100,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Diwali Palette Variant' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 100, name: 'Diwali Palette Variant' });
    const callArgs = prisma.travelFlyerTemplate.create.mock.calls[0][0];
    expect(callArgs.data.name).toBe('Diwali Palette Variant');
  });

  test('body override subBrand → uses override (validates against assertValidSubBrand)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);
    prisma.travelFlyerTemplate.create.mockImplementation(async (args) => ({
      id: 101,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 101, subBrand: 'tmc' });
    const callArgs = prisma.travelFlyerTemplate.create.mock.calls[0][0];
    expect(callArgs.data.subBrand).toBe('tmc');
    // Name still inherits the "(copy)" suffix from source
    expect(callArgs.data.name).toBe('Summer Umrah 2026 (copy)');
  });

  test('invalid subBrand override → 400 INVALID_SUB_BRAND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'not-a-real-brand' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('cross-tenant source returns 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/9999/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["tmc"], source.subBrand="rfu" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 RBAC_DENIED (route is ADMIN/MANAGER only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.create).not.toHaveBeenCalled();
  });

  test('source.isActive=false still duplicates fine (no INVALID_STATE gate; new copy is active)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...sourceRow,
      isActive: false,
    });
    prisma.travelFlyerTemplate.create.mockImplementation(async (args) => ({
      id: 102,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/11/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    // Source was archived; the new copy resets isActive=true so it
    // enters the operator's active list.
    expect(res.body.isActive).toBe(true);
    const callArgs = prisma.travelFlyerTemplate.create.mock.calls[0][0];
    expect(callArgs.data.isActive).toBe(true);
  });
});

describe('templateHash virtual field (slice 9)', () => {
  // Direct helper import — pins the route's read-time hash against the
  // same flyerExport.hashTemplateShape the frontend will use as a cache
  // key. If the route's helper choice ever drifts (e.g. different field
  // ordering, different hash function), these tests fail loudly.
  const { hashTemplateShape } = requireCJS('../../lib/flyerExport');

  const sampleRow = {
    id: 5,
    tenantId: 1,
    name: 'Hash sample',
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: JSON.stringify(validAssets),
    subBrand: 'rfu',
    isActive: true,
    notes: null,
  };

  const expectedHash = hashTemplateShape({
    palette: validPalette,
    layout: validLayout,
    assets: validAssets,
  });

  test('GET list rows carry templateHash matching hashTemplateShape', async () => {
    prisma.travelFlyerTemplate.findMany.mockResolvedValue([sampleRow]);
    prisma.travelFlyerTemplate.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0]).toMatchObject({ id: 5, templateHash: expectedHash });
    // Hash must be 64-char hex SHA-256.
    expect(res.body.templates[0].templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('GET one carries templateHash', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sampleRow);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, templateHash: expectedHash });
  });

  test('POST create response carries templateHash', async () => {
    prisma.travelFlyerTemplate.create.mockResolvedValue(sampleRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Hash sample',
        paletteJson: validPalette,
        layoutJson: validLayout,
        assetsJson: validAssets,
        subBrand: 'rfu',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 5, templateHash: expectedHash });
  });

  test('PUT update response carries templateHash', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sampleRow);
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      ...sampleRow,
      name: 'Hash sample renamed',
    });

    const res = await request(makeApp())
      .put('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Hash sample renamed' });

    expect(res.status).toBe(200);
    // Shape unchanged → hash unchanged.
    expect(res.body).toMatchObject({
      id: 5,
      name: 'Hash sample renamed',
      templateHash: expectedHash,
    });
  });

  test('POST duplicate response carries templateHash (matches source — shape inherited verbatim)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sampleRow);
    prisma.travelFlyerTemplate.create.mockImplementation(async (args) => ({
      id: 999,
      ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/5/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    // Duplicate copies paletteJson / layoutJson / assetsJson verbatim
    // from source, so the new row's hash MUST match the source's hash —
    // this is the cache-key promise the frontend relies on (a duplicate
    // can reuse a cached preview render).
    expect(res.body).toMatchObject({ id: 999, templateHash: expectedHash });
  });

  test('row with corrupted paletteJson folds to the same hash as the empty {} envelope', async () => {
    // The empty-shape baseline: { palette: null, layout: null, assets: null }
    // is what hashTemplateShape produces for an unparseable row (see
    // withTemplateHash + hashTemplateShape contracts).
    const emptyEnvelopeHash = hashTemplateShape({});
    const corruptedRow = {
      ...sampleRow,
      id: 6,
      paletteJson: '{not-valid-json',
      layoutJson: '[not-valid-json',
      assetsJson: '{not-valid-json',
    };
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(corruptedRow);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/6')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.templateHash).toBe(emptyEnvelopeHash);
    // Degraded behaviour pin: corrupted rows do NOT throw 500; the
    // response still ships the row + a stable (if useless) hash. Cache
    // misses for these rows; renderer regenerates from whatever it can
    // parse on its own.
  });

  test('templateHash is stable across iterations (same row → same hash)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sampleRow);

    const r1 = await request(makeApp())
      .get('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const r2 = await request(makeApp())
      .get('/api/travel/flyer-templates/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.templateHash).toBe(r2.body.templateHash);
    expect(r1.body.templateHash).toBe(expectedHash);
  });

  test('two semantically-different shapes hash differently', async () => {
    const altPalette = { ...validPalette, primaryHex: '#000000' }; // differs in primaryHex
    const altRow = {
      ...sampleRow,
      id: 7,
      paletteJson: JSON.stringify(altPalette),
    };
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(altRow);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.templateHash).not.toBe(expectedHash);
    expect(res.body.templateHash).toBe(
      hashTemplateShape({ palette: altPalette, layout: validLayout, assets: validAssets }),
    );
  });
});

/**
 * POST /api/travel/flyer-templates/:id/export — slice 10.
 *
 * Pins the validation + cache-key contract the future renderer slice
 * relies on: format/aspect must pass flyerExport.validateExportRequest,
 * cacheKey is the deterministic `<format>:<aspect>:<hash>` produced by
 * flyerExport.buildOutputCacheKey, and the response shape is
 * { format, aspect, hash, cacheKey, status: 'queued', queuedAt } at
 * HTTP 202 ACCEPTED. The actual rendering step is STUBBED — a later
 * slice swaps the STUB for the real renderer + adds a `url` field.
 */
describe('POST /api/travel/flyer-templates/:id/export (slice 10)', () => {
  const {
    buildOutputCacheKey: keyFor,
    hashTemplateShape,
  } = requireCJS('../../lib/flyerExport');

  const sourceRow = {
    id: 21,
    tenantId: 1,
    name: 'RFU Summer Umrah Flyer',
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: JSON.stringify(validAssets),
    subBrand: 'rfu',
    isActive: true,
    notes: null,
  };

  test('happy path: pdf+a4 returns 202 queued + cache key + audit row', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'a4' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      format: 'pdf',
      aspect: 'a4',
      status: 'queued',
    });
    // Hash + cacheKey must match the canonical helpers.
    const expectedHash = hashTemplateShape({
      palette: validPalette,
      layout: validLayout,
      assets: validAssets,
    });
    expect(res.body.hash).toBe(expectedHash);
    expect(res.body.cacheKey).toBe(keyFor({ format: 'pdf', aspect: 'a4', hash: expectedHash }));
    expect(res.body.cacheKey).toMatch(/^pdf:a4:[0-9a-f]{64}$/);
    expect(typeof res.body.queuedAt).toBe('string');
    // ISO-8601 sanity.
    expect(new Date(res.body.queuedAt).toString()).not.toBe('Invalid Date');

    // Audit row carries the export intent.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelFlyerTemplate',
      action: 'TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED',
      entityId: 21,
      userId: 7,
      tenantId: 1,
    });
    const detailsParsed = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(detailsParsed).toMatchObject({
      format: 'pdf',
      aspect: 'a4',
      cacheKey: res.body.cacheKey,
    });
  });

  test('png + portrait happy path produces png:portrait:<hash> cache key', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'png', aspect: 'portrait' });

    expect(res.status).toBe(202);
    expect(res.body.format).toBe('png');
    expect(res.body.aspect).toBe('portrait');
    expect(res.body.cacheKey).toMatch(/^png:portrait:[0-9a-f]{64}$/);
    expect(res.body.status).toBe('queued');
  });

  test('mismatched format/aspect (pdf + square) → 400 INVALID_EXPORT_REQUEST + errors[]', async () => {
    // Validator runs BEFORE the DB lookup so findFirst is NOT called.
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'square' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXPORT_REQUEST');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('missing format → 400 INVALID_EXPORT_REQUEST', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ aspect: 'a4' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXPORT_REQUEST');
  });

  test('cross-tenant source → 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/9999/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'a4' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["tmc"], source.subBrand="rfu" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ format: 'pdf', aspect: 'a4' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 RBAC_DENIED (route is ADMIN/MANAGER only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ format: 'pdf', aspect: 'a4' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  // ── Slice 11: inline-PDF path ──────────────────────────────────
  // When ?inline=1 + format='pdf', the route synchronously renders the
  // PDF via lib/flyerPdfRender and streams the Buffer back as
  // `application/pdf` 200 OK (instead of the slice-10 202 queued
  // envelope). Cache-key + template-hash surface in custom headers
  // so the frontend can still index/dedupe on them.
  test('slice 11: ?inline=1 + pdf returns 200 application/pdf with valid PDF bytes', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export?inline=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'a4' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['x-flyer-cache-key']).toMatch(/^pdf:a4:[0-9a-f]{64}$/);
    expect(res.headers['x-flyer-template-hash']).toMatch(/^[0-9a-f]{64}$/);
    // supertest collects the response body into res.body as a Buffer
    // when Content-Type is application/pdf.
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(500);
    // PDF magic bytes %PDF.
    expect(res.body[0]).toBe(0x25);
    expect(res.body[1]).toBe(0x50);
    expect(res.body[2]).toBe(0x44);
    expect(res.body[3]).toBe(0x46);
    // Audit row uses the EXPORTED action (vs QUEUED for the STUB path).
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelFlyerTemplate',
      action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED',
      entityId: 21,
      tenantId: 1,
    });
  });

  test('slice 11: ?inline=1 + png stays on the STUB 202-queued contract (Puppeteer pending)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export?inline=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'png', aspect: 'square' });

    // PNG is still STUB regardless of inline=1.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.format).toBe('png');
  });

  test('slice 11: pdf without ?inline=1 stays on the slice-10 202-queued contract', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'a4' });

    // Without ?inline=1, PDF stays async/queued — preserves the
    // slice-10 contract for the future cache-lookup + url-field path.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.format).toBe('pdf');
  });

  test('slice 11: ?inline=1 inherits the same INVALID_EXPORT_REQUEST + 404 + 403 gates', async () => {
    // Mismatched format/aspect still fails the validator (PRE-DB).
    const r1 = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export?inline=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'square' });
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('INVALID_EXPORT_REQUEST');

    // Cross-tenant still 404s.
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);
    const r2 = await request(makeApp())
      .post('/api/travel/flyer-templates/9999/export?inline=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'a4' });
    expect(r2.status).toBe(404);
    expect(r2.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('same template + same {format, aspect} produces identical cacheKey across calls (content-addressed)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(sourceRow);

    const r1 = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'us_letter' });
    const r2 = await request(makeApp())
      .post('/api/travel/flyer-templates/21/export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ format: 'pdf', aspect: 'us_letter' });

    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r1.body.cacheKey).toBe(r2.body.cacheKey);
    expect(r1.body.hash).toBe(r2.body.hash);
    // queuedAt may differ across calls (timestamp), but cacheKey is
    // content-addressed and stable — the future renderer can dedupe
    // on cacheKey alone.
  });
});

/**
 * Slice 12 — GET /api/travel/flyer-templates/:id/preview.pdf
 *
 * Read-only inline PDF preview surface for the list-page "preview this
 * template before picking" UX. Opens up to USER as well as ADMIN/MANAGER
 * (the export POST stays gated). Sub-brand isolation enforced
 * identically to GET /:id. No audit row (every list-page hover would
 * otherwise pollute audit). Aspect defaults to 'a4'; invalid aspect
 * yields 400 INVALID_ASPECT (reuses lib/flyerExport's PDF_PAPER_SIZES).
 */
describe('GET /api/travel/flyer-templates/:id/preview.pdf (slice 12)', () => {
  const previewSource = {
    id: 33,
    tenantId: 1,
    name: 'TMC Summer Greece',
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: JSON.stringify(validAssets),
    subBrand: 'tmc',
    isActive: true,
    notes: null,
  };

  test('USER role: returns 200 application/pdf with valid PDF bytes (USER can preview but cannot export)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(previewSource);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline; filename="flyer-33-preview-a4\.pdf"/);
    expect(res.headers['x-flyer-template-hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers['cache-control']).toMatch(/private/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(500);
    // PDF magic bytes %PDF.
    expect(res.body[0]).toBe(0x25);
    expect(res.body[1]).toBe(0x50);
    expect(res.body[2]).toBe(0x44);
    expect(res.body[3]).toBe(0x46);
    // No audit row for read-only preview.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('ADMIN role: returns 200 application/pdf (same surface, no role narrowing)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(previewSource);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(500);
  });

  test('?aspect=us_letter renders the US-letter variant + disposition reflects aspect', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(previewSource);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf?aspect=us_letter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/flyer-33-preview-us_letter\.pdf/);
    expect(res.body[0]).toBe(0x25); // %PDF
  });

  test('invalid aspect → 400 INVALID_ASPECT (no DB lookup fires)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf?aspect=square')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ASPECT' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/notanumber/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant source → 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/9999/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  test('MANAGER restricted to ["rfu"], source.subBrand="tmc" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(previewSource);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });

  test('tenant-wide (subBrand=null) row is previewable by any role regardless of subBrandAccess', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...previewSource,
      subBrand: null,
    });

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('corrupted paletteJson still renders a placeholder PDF (defensive — does not 500)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...previewSource,
      paletteJson: '{not-valid-json',
      layoutJson: '[]',
      assetsJson: null,
    });

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/33/preview.pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body[0]).toBe(0x25); // %PDF
  });
});

/**
 * Slice 14 — POST /api/travel/flyer-templates/:id/archive
 *              + POST /api/travel/flyer-templates/:id/unarchive
 *
 * Dedicated lifecycle toggles. Functionally a thin wrapper over
 * `PUT /:id { isActive }` BUT:
 *   - Distinct audit actions (TRAVEL_FLYER_TEMPLATE_ARCHIVED /
 *     TRAVEL_FLYER_TEMPLATE_UNARCHIVED) so reports segment lifecycle
 *     events from generic edits.
 *   - Idempotent: archiving an already-archived row → 200 no-op envelope,
 *     no audit row, no prisma.update call.
 *   - ADMIN/MANAGER gated; sub-brand isolation enforced identically to
 *     PUT / DELETE.
 */
describe('POST /api/travel/flyer-templates/:id/archive (slice 14)', () => {
  const activeSource = {
    id: 77,
    tenantId: 1,
    name: 'Diwali Family Goa',
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: JSON.stringify(validAssets),
    subBrand: 'travelstall',
    isActive: true,
    notes: null,
  };

  test('ADMIN happy path: flips isActive=false, writes TRAVEL_FLYER_TEMPLATE_ARCHIVED audit, returns 200 + templateHash', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(activeSource);
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      ...activeSource,
      isActive: false,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/77/archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 77, isActive: false });
    expect(res.body.templateHash).toMatch(/^[0-9a-f]{64}$/);
    // prisma.update fired with isActive=false ONLY.
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { isActive: false },
    });
    // Distinct audit action.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('TRAVEL_FLYER_TEMPLATE_ARCHIVED');
  });

  test('idempotent: archiving an already-archived row → 200 alreadyArchived=true, no prisma.update, no audit', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...activeSource,
      isActive: false,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/77/archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 77, isActive: false, alreadyArchived: true });
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('non-numeric id → 400 INVALID_ID (no DB lookup fires)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/notanumber/archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant source → 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/9999/archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('MANAGER restricted to ["rfu"], source.subBrand="travelstall" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(activeSource);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/77/archive')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('USER role: rejected at verifyRole → 403 RBAC_DENIED (route is ADMIN/MANAGER)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/77/archive')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    // verifyRole emits a generic role-denied; the exact code may be
    // RBAC_DENIED or similar — pin status + ensure prisma was not hit.
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('tenant-wide (subBrand=null): MANAGER restricted to ["rfu"] CAN archive (NULL subBrand is tenant-wide)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...activeSource,
      subBrand: null,
    });
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      ...activeSource,
      subBrand: null,
      isActive: false,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/77/archive')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 77, isActive: false });
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalled();
  });
});

describe('POST /api/travel/flyer-templates/:id/unarchive (slice 14)', () => {
  const archivedSource = {
    id: 78,
    tenantId: 1,
    name: 'Last-Season Bali Family',
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: JSON.stringify(validAssets),
    subBrand: 'travelstall',
    isActive: false,
    notes: null,
  };

  test('ADMIN happy path: flips isActive=true, writes TRAVEL_FLYER_TEMPLATE_UNARCHIVED audit, returns 200 + templateHash', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(archivedSource);
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      ...archivedSource,
      isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/78/unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 78, isActive: true });
    expect(res.body.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledWith({
      where: { id: 78 },
      data: { isActive: true },
    });
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('TRAVEL_FLYER_TEMPLATE_UNARCHIVED');
  });

  test('idempotent: unarchiving an already-active row → 200 alreadyActive=true, no prisma.update, no audit', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...archivedSource,
      isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/78/unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 78, isActive: true, alreadyActive: true });
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('cross-tenant source → 404 TEMPLATE_NOT_FOUND', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/9999/unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  test('MANAGER restricted to ["rfu"], source.subBrand="travelstall" → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(archivedSource);

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/78/unarchive')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('USER role → 403 (route is ADMIN/MANAGER)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/78/unarchive')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/flyer-templates/bulk-archive (slice 15)', () => {
  // Sample rows the per-id findFirst loop returns. Keyed by id so each
  // test can compose its own batch by selecting from this fixture.
  const rowsById = {
    101: {
      id: 101, tenantId: 1, name: 'TMC Summer Greece',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: 'tmc', isActive: true, notes: null,
    },
    102: {
      id: 102, tenantId: 1, name: 'RFU Umrah May',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: 'rfu', isActive: true, notes: null,
    },
    103: {
      id: 103, tenantId: 1, name: 'TS Bali Weekend',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: 'travelstall', isActive: false, notes: null,
    },
    104: {
      id: 104, tenantId: 1, name: 'Tenant-wide Welcome',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: null, isActive: true, notes: null,
    },
  };

  test('happy path: ADMIN archives 3 active rows, partitions into archived/alreadyArchived buckets', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      return Promise.resolve(rowsById[where.id] || null);
    });
    prisma.travelFlyerTemplate.update.mockImplementation(({ where }) => {
      return Promise.resolve({ ...rowsById[where.id], isActive: false });
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [101, 102, 103, 104] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      archived: expect.arrayContaining([101, 102, 104]),
      alreadyArchived: [103],
      notFound: [],
      denied: [],
      total: 4,
    });
    expect(res.body.archived).toHaveLength(3);
    // Three update calls (one per archived id); no update for the already-archived row.
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(3);
    // One audit row per successful archive.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(3);
    const auditActions = prisma.auditLog.create.mock.calls.map(
      (c) => c[0].data.action,
    );
    expect(auditActions.every((a) => a === 'TRAVEL_FLYER_TEMPLATE_ARCHIVED')).toBe(true);
    // Audit row carries the bulk:true marker so reports can distinguish.
    const firstAuditDetails = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(firstAuditDetails.bulk).toBe(true);
  });

  test('rejects non-array ids with 400 INVALID_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('rejects empty ids array with 400 EMPTY_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('rejects ids array >100 with 400 TOO_MANY_IDS', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: tooMany });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('rejects ids array containing a non-integer with 400 INVALID_IDS (whole batch rejected, no partial work)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [101, 'notanid', 102] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('cross-tenant / missing ids land in notFound bucket (no update, no audit)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      // Only id=101 exists; 9998 + 9999 simulate cross-tenant / missing.
      if (where.id === 101) return Promise.resolve(rowsById[101]);
      return Promise.resolve(null);
    });
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      ...rowsById[101],
      isActive: false,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [101, 9998, 9999] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      archived: [101],
      alreadyArchived: [],
      notFound: expect.arrayContaining([9998, 9999]),
      denied: [],
      total: 3,
    });
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  test('MANAGER restricted to ["rfu"]: tmc + travelstall ids land in denied bucket; rfu + tenant-wide get archived', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      return Promise.resolve(rowsById[where.id] || null);
    });
    prisma.travelFlyerTemplate.update.mockImplementation(({ where }) => {
      return Promise.resolve({ ...rowsById[where.id], isActive: false });
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ ids: [101, 102, 103, 104] }); // tmc / rfu / travelstall(already archived) / tenant-wide

    expect(res.status).toBe(200);
    expect(res.body.archived).toEqual(expect.arrayContaining([102, 104]));
    expect(res.body.archived).toHaveLength(2);
    expect(res.body.denied).toEqual(expect.arrayContaining([101, 103]));
    expect(res.body.denied).toHaveLength(2);
    expect(res.body.alreadyArchived).toEqual([]);
    expect(res.body.notFound).toEqual([]);
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  test('USER role: 403 (route is ADMIN/MANAGER) before any DB lookup fires', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ ids: [101, 102] });

    expect(res.status).toBe(403);
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('duplicate ids are de-duped before processing (one archive, total reflects unique count)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      return Promise.resolve(rowsById[where.id] || null);
    });
    prisma.travelFlyerTemplate.update.mockImplementation(({ where }) => {
      return Promise.resolve({ ...rowsById[where.id], isActive: false });
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [101, 101, 101, 102] });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // de-duped
    expect(res.body.archived).toEqual(expect.arrayContaining([101, 102]));
    expect(res.body.archived).toHaveLength(2);
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  test('Express route ordering: /bulk-archive is NOT captured by the /:id family (does not 400 INVALID_ID)', async () => {
    // If the bulk-archive route were declared AFTER /:id-prefixed routes,
    // the request would hit /:id/archive with id="bulk" and 400 INVALID_ID.
    // This test pins the ordering — the request must reach the bulk handler
    // and surface a 400 EMPTY_IDS (its own validator), not 400 INVALID_ID.
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_IDS');
    expect(res.body.code).not.toBe('INVALID_ID');
  });
});

/**
 * Slice 16 — POST /api/travel/flyer-templates/bulk-unarchive.
 *
 * Mirror of slice 15's bulk-archive contract. Pins:
 *   - happy path: ADMIN restores 3 archived rows; an already-active row
 *     lands in alreadyActive bucket (no update, no audit)
 *   - 400 INVALID_IDS for non-array
 *   - 400 EMPTY_IDS for empty array
 *   - 400 TOO_MANY_IDS for >100 ids
 *   - 400 INVALID_IDS for non-integer entry (whole batch rejected, no partial work)
 *   - cross-tenant / missing ids → notFound bucket (no update, no audit)
 *   - MANAGER restricted to ["rfu"]: tmc + travelstall ids land in denied
 *     bucket; rfu + tenant-wide get unarchived
 *   - USER role → 403 before any DB lookup fires
 *   - duplicate ids de-duped before processing
 *   - Express route ordering: /bulk-unarchive NOT captured by /:id family
 *   - audit row carries the bulk:true marker + UNARCHIVED action
 */
describe('POST /api/travel/flyer-templates/bulk-unarchive (slice 16)', () => {
  // Rows keyed by id so each test composes its own batch. Mirror of the
  // bulk-archive fixture but with the isActive flags FLIPPED — the
  // unarchive bucket targets archived (isActive=false) rows by default.
  const rowsById = {
    201: {
      id: 201, tenantId: 1, name: 'TMC Spring Greece (archived)',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: 'tmc', isActive: false, notes: null,
    },
    202: {
      id: 202, tenantId: 1, name: 'RFU Umrah Feb (archived)',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: 'rfu', isActive: false, notes: null,
    },
    203: {
      id: 203, tenantId: 1, name: 'TS Bali Weekend (still active)',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: 'travelstall', isActive: true, notes: null,
    },
    204: {
      id: 204, tenantId: 1, name: 'Tenant-wide Welcome (archived)',
      paletteJson: JSON.stringify(validPalette),
      layoutJson: JSON.stringify(validLayout),
      assetsJson: null, subBrand: null, isActive: false, notes: null,
    },
  };

  test('happy path: ADMIN restores 3 archived rows, partitions into unarchived/alreadyActive buckets', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      return Promise.resolve(rowsById[where.id] || null);
    });
    prisma.travelFlyerTemplate.update.mockImplementation(({ where }) => {
      return Promise.resolve({ ...rowsById[where.id], isActive: true });
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [201, 202, 203, 204] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      unarchived: expect.arrayContaining([201, 202, 204]),
      alreadyActive: [203],
      notFound: [],
      denied: [],
      total: 4,
    });
    expect(res.body.unarchived).toHaveLength(3);
    // Three update calls (one per restored id); no update for the already-active row.
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(3);
    // One audit row per successful unarchive.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(3);
    const auditActions = prisma.auditLog.create.mock.calls.map(
      (c) => c[0].data.action,
    );
    expect(auditActions.every((a) => a === 'TRAVEL_FLYER_TEMPLATE_UNARCHIVED')).toBe(true);
    // Audit row carries the bulk:true marker so reports can distinguish.
    const firstAuditDetails = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(firstAuditDetails.bulk).toBe(true);
    // Update calls set isActive: true (not false — this is the unarchive surface).
    const updateCalls = prisma.travelFlyerTemplate.update.mock.calls;
    expect(updateCalls.every((c) => c[0].data.isActive === true)).toBe(true);
  });

  test('rejects non-array ids with 400 INVALID_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('rejects empty ids array with 400 EMPTY_IDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('rejects ids array >100 with 400 TOO_MANY_IDS', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: tooMany });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('rejects ids array containing a non-integer with 400 INVALID_IDS (whole batch rejected, no partial work)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [201, 'notanid', 202] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IDS' });
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('cross-tenant / missing ids land in notFound bucket (no update, no audit)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      if (where.id === 201) return Promise.resolve(rowsById[201]);
      return Promise.resolve(null);
    });
    prisma.travelFlyerTemplate.update.mockResolvedValue({
      ...rowsById[201],
      isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [201, 9998, 9999] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      unarchived: [201],
      alreadyActive: [],
      notFound: expect.arrayContaining([9998, 9999]),
      denied: [],
      total: 3,
    });
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  test('MANAGER restricted to ["rfu"]: tmc + travelstall ids land in denied bucket; rfu + tenant-wide get unarchived', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      return Promise.resolve(rowsById[where.id] || null);
    });
    prisma.travelFlyerTemplate.update.mockImplementation(({ where }) => {
      return Promise.resolve({ ...rowsById[where.id], isActive: true });
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ ids: [201, 202, 203, 204] }); // tmc / rfu / travelstall(already active) / tenant-wide

    expect(res.status).toBe(200);
    expect(res.body.unarchived).toEqual(expect.arrayContaining([202, 204]));
    expect(res.body.unarchived).toHaveLength(2);
    expect(res.body.denied).toEqual(expect.arrayContaining([201, 203]));
    expect(res.body.denied).toHaveLength(2);
    expect(res.body.alreadyActive).toEqual([]);
    expect(res.body.notFound).toEqual([]);
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  test('USER role: 403 (route is ADMIN/MANAGER) before any DB lookup fires', async () => {
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ ids: [201, 202] });

    expect(res.status).toBe(403);
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelFlyerTemplate.update).not.toHaveBeenCalled();
  });

  test('duplicate ids are de-duped before processing (one unarchive, total reflects unique count)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockImplementation(({ where }) => {
      return Promise.resolve(rowsById[where.id] || null);
    });
    prisma.travelFlyerTemplate.update.mockImplementation(({ where }) => {
      return Promise.resolve({ ...rowsById[where.id], isActive: true });
    });

    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [201, 201, 201, 202] });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // de-duped
    expect(res.body.unarchived).toEqual(expect.arrayContaining([201, 202]));
    expect(res.body.unarchived).toHaveLength(2);
    expect(prisma.travelFlyerTemplate.update).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
  });

  test('Express route ordering: /bulk-unarchive is NOT captured by the /:id family (does not 400 INVALID_ID)', async () => {
    // If the bulk-unarchive route were declared AFTER /:id-prefixed routes,
    // the request would hit /:id/unarchive with id="bulk" and 400 INVALID_ID.
    // This test pins the ordering — the request must reach the bulk handler
    // and surface a 400 EMPTY_IDS (its own validator), not 400 INVALID_ID.
    const res = await request(makeApp())
      .post('/api/travel/flyer-templates/bulk-unarchive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_IDS');
    expect(res.body.code).not.toBe('INVALID_ID');
  });
});

/**
 * Slice 17 — GET /api/travel/flyer-templates/:id/usage-stats
 *
 * Pins:
 *   - happy path with mixed audit-history surfaces { total, byAction, exports,
 *     firstActionAt, lastActionAt, lastExportedAt }
 *   - byAction is a stable shape with every KNOWN_ACTIONS key present (zero
 *     when unused) so the frontend never sees a missing bucket
 *   - exports = EXPORTED + EXPORT_QUEUED convenience sum
 *   - lastExportedAt narrows to the export buckets only
 *   - tenant-wide template with empty audit history → all zeros, null
 *     timestamps, 200 OK (not 404)
 *   - cross-tenant id resolves to 404 TEMPLATE_NOT_FOUND BEFORE the audit
 *     read fires (anti-enumeration)
 *   - MANAGER restricted away from the template's sub-brand → 403
 *     SUB_BRAND_DENIED, no auditLog.findMany call
 *   - USER role is allowed (read-only meta endpoint mirrors slice 12)
 *   - unknown action verb folds into `other` bucket without breaking
 *     the known-bucket shape
 *   - non-numeric id → 400 INVALID_ID
 *   - read-only: NO audit row is written by this endpoint
 */
describe('GET /api/travel/flyer-templates/:id/usage-stats (slice 17)', () => {
  const baseTemplate = {
    id: 501,
    tenantId: 1,
    name: 'Bali 7N Family',
    subBrand: null, // tenant-wide
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: null,
    isActive: true,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
  };

  beforeEach(() => {
    prisma.auditLog.findMany = vi.fn().mockResolvedValue([]);
  });

  test('happy path: mixed history surfaces byAction + exports + timestamps', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z') },
      { action: 'UPDATE', createdAt: new Date('2026-05-02T09:30:00Z') },
      { action: 'UPDATE', createdAt: new Date('2026-05-03T10:00:00Z') },
      { action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED', createdAt: new Date('2026-05-05T11:00:00Z') },
      { action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED', createdAt: new Date('2026-05-10T12:30:00Z') },
      { action: 'TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED', createdAt: new Date('2026-05-12T14:00:00Z') },
      { action: 'TRAVEL_FLYER_TEMPLATE_ARCHIVED', createdAt: new Date('2026-05-15T15:00:00Z') },
      { action: 'TRAVEL_FLYER_TEMPLATE_UNARCHIVED', createdAt: new Date('2026-05-16T16:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.templateId).toBe(501);
    expect(res.body.total).toBe(8);
    expect(res.body.byAction).toEqual({
      CREATE: 1,
      UPDATE: 2,
      DELETE: 0,
      TRAVEL_FLYER_TEMPLATE_DUPLICATED: 0,
      TRAVEL_FLYER_TEMPLATE_ARCHIVED: 1,
      TRAVEL_FLYER_TEMPLATE_UNARCHIVED: 1,
      TRAVEL_FLYER_TEMPLATE_EXPORTED: 2,
      TRAVEL_FLYER_TEMPLATE_EXPORT_QUEUED: 1,
    });
    expect(res.body.exports).toBe(3); // EXPORTED(2) + EXPORT_QUEUED(1)
    expect(res.body.firstActionAt).toBe('2026-05-01T08:00:00.000Z');
    expect(res.body.lastActionAt).toBe('2026-05-16T16:00:00.000Z');
    expect(res.body.lastExportedAt).toBe('2026-05-12T14:00:00.000Z');

    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      tenantId: 1,
      entity: 'TravelFlyerTemplate',
      entityId: 501,
    });
  });

  test('empty audit history → all zeros + null timestamps, 200 OK (not 404)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.exports).toBe(0);
    expect(res.body.firstActionAt).toBeNull();
    expect(res.body.lastActionAt).toBeNull();
    expect(res.body.lastExportedAt).toBeNull();
    // Every known bucket present with value 0
    expect(res.body.byAction.CREATE).toBe(0);
    expect(res.body.byAction.UPDATE).toBe(0);
    expect(res.body.byAction.TRAVEL_FLYER_TEMPLATE_EXPORTED).toBe(0);
  });

  test('cross-tenant id resolves to 404 BEFORE auditLog.findMany fires', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/9999/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('MANAGER restricted away from template sub-brand → 403 SUB_BRAND_DENIED, no audit read', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...baseTemplate,
      subBrand: 'tmc',
    });

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('USER role is allowed (mirrors slice 12 read-only-aid contract)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.byAction.CREATE).toBe(1);
  });

  test('unknown action verb folds into `other` bucket without breaking known shape', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z') },
      { action: 'FUTURE_VERB_NOT_YET_IN_LIST', createdAt: new Date('2026-05-02T08:00:00Z') },
      { action: 'ANOTHER_FUTURE_VERB', createdAt: new Date('2026-05-03T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.byAction.CREATE).toBe(1);
    expect(res.body.byAction.other).toBe(2);
    // Known buckets still present and zero (not undefined / missing)
    expect(res.body.byAction.TRAVEL_FLYER_TEMPLATE_EXPORTED).toBe(0);
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/not-a-number/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('lastExportedAt narrows to export buckets only (later UPDATE does NOT bump lastExportedAt)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED', createdAt: new Date('2026-05-05T10:00:00Z') },
      { action: 'UPDATE', createdAt: new Date('2026-05-10T10:00:00Z') }, // later, but not an export
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastActionAt).toBe('2026-05-10T10:00:00.000Z'); // tracks all actions
    expect(res.body.lastExportedAt).toBe('2026-05-05T10:00:00.000Z'); // export-only
    expect(res.body.exports).toBe(1);
  });

  test('NO audit row written by this read-only endpoint (mirrors slice 12 preview.pdf)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/501/usage-stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // The route does a read-only findMany; it must NOT call auditLog.create
    // (slice 13 / 12 read-only-meta convention).
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/flyer-templates/:id/audit-trail (slice 18)', () => {
  const baseTemplate = {
    id: 701,
    tenantId: 1,
    name: 'Diwali Family Combo',
    subBrand: null, // tenant-wide
    paletteJson: JSON.stringify(validPalette),
    layoutJson: JSON.stringify(validLayout),
    assetsJson: null,
    isActive: true,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
  };

  beforeEach(() => {
    prisma.auditLog.findMany = vi.fn().mockResolvedValue([]);
    prisma.auditLog.count = vi.fn().mockResolvedValue(0);
  });

  test('happy path: returns ordered rows (desc) + total + parsed details JSON', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 33, action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED', createdAt: new Date('2026-05-10T12:30:00Z'), userId: 9, details: JSON.stringify({ format: 'pdf', aspect: 'a4' }) },
      { id: 22, action: 'UPDATE', createdAt: new Date('2026-05-05T11:00:00Z'), userId: 9, details: JSON.stringify({ fields: ['name'] }) },
      { id: 11, action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z'), userId: 7, details: JSON.stringify({ name: 'Diwali Family Combo', subBrand: null }) },
    ]);
    prisma.auditLog.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.templateId).toBe(701);
    expect(res.body.total).toBe(3);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.entries).toHaveLength(3);

    // Newest first (route asks orderBy createdAt desc; mock returns
    // already-ordered, but assert the verb at position 0 is the export).
    expect(res.body.entries[0]).toMatchObject({
      id: 33,
      action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED',
      userId: 9,
      createdAt: '2026-05-10T12:30:00.000Z',
    });
    // details JSON parsed back into shape (not a string)
    expect(res.body.entries[0].details).toEqual({ format: 'pdf', aspect: 'a4' });
    expect(res.body.entries[2].details).toEqual({ name: 'Diwali Family Combo', subBrand: null });

    // Prisma call inspection — tenant + entity + entityId pinned; orderBy desc.
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      tenantId: 1,
      entity: 'TravelFlyerTemplate',
      entityId: 701,
    });
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(call.take).toBe(50);
    expect(call.skip).toBe(0);
  });

  test('empty history → 200 with entries=[] and total=0 (not 404)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('cross-tenant id → 404 TEMPLATE_NOT_FOUND BEFORE auditLog.findMany fires', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/9999/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.count).not.toHaveBeenCalled();
  });

  test('MANAGER restricted away from template sub-brand → 403 SUB_BRAND_DENIED, no audit read', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue({
      ...baseTemplate,
      subBrand: 'tmc',
    });

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('USER role is allowed (mirrors slice 17 read-only-aid contract)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 1, action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z'), userId: 7, details: null },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].action).toBe('CREATE');
  });

  test('?action=TRAVEL_FLYER_TEMPLATE_EXPORTED narrows the where clause', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 33, action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED', createdAt: new Date('2026-05-10T12:30:00Z'), userId: 9, details: null },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail?action=TRAVEL_FLYER_TEMPLATE_EXPORTED')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.action).toBe('TRAVEL_FLYER_TEMPLATE_EXPORTED');
    expect(call.where.entity).toBe('TravelFlyerTemplate');
    expect(call.where.entityId).toBe(701);
  });

  test('?limit + ?offset thread into prisma + response envelope; >200 limit capped at 200', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(500);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail?limit=999&offset=50')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200); // cap
    expect(res.body.offset).toBe(50);
    expect(res.body.total).toBe(500);
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.take).toBe(200);
    expect(call.skip).toBe(50);
  });

  test('row with malformed details JSON folds to details=null (row still surfaced)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 50, action: 'UPDATE', createdAt: new Date('2026-05-05T11:00:00Z'), userId: 9, details: '{ this is not json' },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].id).toBe(50);
    expect(res.body.entries[0].action).toBe('UPDATE');
    expect(res.body.entries[0].details).toBeNull();
  });

  test('row with null userId surfaces userId=null in the response', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 60, action: 'TRAVEL_FLYER_TEMPLATE_EXPORTED', createdAt: new Date('2026-05-05T11:00:00Z'), userId: null, details: null },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.entries[0].userId).toBeNull();
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/not-a-number/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelFlyerTemplate.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('NO audit row written by this read-only endpoint (mirrors slice 12 / 17)', async () => {
    prisma.travelFlyerTemplate.findFirst.mockResolvedValue(baseTemplate);
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 1, action: 'CREATE', createdAt: new Date('2026-05-01T08:00:00Z'), userId: 7, details: null },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/flyer-templates/701/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
