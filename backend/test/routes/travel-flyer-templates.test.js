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
