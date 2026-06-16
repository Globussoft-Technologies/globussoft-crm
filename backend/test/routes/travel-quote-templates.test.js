// @ts-check
/**
 * Travel CRM — Quote Template Library CRUD + apply-to-quote (S31 slice,
 * docs/TRAVEL_BIG_SCOPE_BACKLOG.md) — route tests.
 *
 * Pins the 6-endpoint contract for /api/travel/quote-templates:
 *   GET    /                list, paginated, tenant + sub-brand scoped
 *   POST   /                create (ADMIN+MANAGER) — name + linesJson required
 *   GET    /:id             get one, sub-brand gate
 *   PATCH  /:id             update (ADMIN+MANAGER)
 *   DELETE /:id             soft-delete (ADMIN only) via isActive=false
 *   POST   /:id/apply       apply to quote (ADMIN+MANAGER); 409 if quote
 *                           already has lines (idempotency strategy)
 *
 * What's pinned
 * -------------
 *   - GET happy path returns { items, total, limit, offset }
 *   - GET non-travel tenant → 403 WRONG_VERTICAL (requireTravelTenant)
 *   - GET unauthenticated → 401 (verifyToken)
 *   - GET ?limit clamp: >200 → 200, <1 → 1
 *   - GET MANAGER subBrandAccess=['rfu'] threads `OR: [{ subBrand: null },
 *     { subBrand: { in: ['rfu'] } }]` (nullable subBrand semantics —
 *     tenant-wide rows visible to everyone)
 *   - GET ?category / ?isActive thread into where
 *   - POST ADMIN happy path → 201 + record; linesJson re-stringified
 *   - POST missing name → 400 MISSING_NAME
 *   - POST missing linesJson → 400 MISSING_LINES_JSON
 *   - POST malformed linesJson (not JSON) → 400 INVALID_LINES_JSON
 *   - POST linesJson as object (not array) → 400 INVALID_LINES_JSON
 *   - POST line item missing description → 400 INVALID_LINES_JSON
 *   - POST line item with bad lineType → 400 INVALID_LINES_JSON
 *   - POST lowercase currency "inr" → 400 INVALID_CURRENCY
 *   - POST USER role → 403 (RBAC gate)
 *   - GET /:id found / invalid id / not-found shapes
 *   - PATCH /:id happy path + empty body + not found
 *   - DELETE /:id sets isActive=false (no destructive delete); MANAGER → 403
 *   - POST /:id/apply happy path: clones lines into target quote;
 *     201 + { applied, templateId, quoteId, totalAmount }
 *   - POST /:id/apply with existing lines → 409 ALREADY_HAS_LINES
 *   - POST /:id/apply missing quoteId → 400 INVALID_QUOTE_ID
 *   - POST /:id/apply template not found → 404 QUOTE_TEMPLATE_NOT_FOUND
 *   - POST /:id/apply target quote not found → 404 QUOTE_NOT_FOUND
 *   - POST /:id/apply template inactive → 400 TEMPLATE_INACTIVE
 *   - POST /:id/apply USER role → 403 (RBAC gate)
 *
 * Pattern mirrors travel-itinerary-templates.test.js — patch prisma BEFORE
 * requiring the router, drive with real HS256 JWTs against the dev
 * fallback secret. verifyToken + requirePermission + requireTravelTenant +
 * getSubBrandAccessSet all run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelQuoteTemplate = prisma.travelQuoteTemplate || {};
prisma.travelQuoteTemplate.findMany = vi.fn();
prisma.travelQuoteTemplate.findFirst = vi.fn();
prisma.travelQuoteTemplate.count = vi.fn();
prisma.travelQuoteTemplate.create = vi.fn();
prisma.travelQuoteTemplate.update = vi.fn();
prisma.travelQuote = prisma.travelQuote || {};
prisma.travelQuote.findFirst = vi.fn();
prisma.travelQuote.update = vi.fn();
prisma.travelQuoteLine = prisma.travelQuoteLine || {};
prisma.travelQuoteLine.count = vi.fn();
prisma.travelQuoteLine.createMany = vi.fn();
prisma.travelQuoteLine.findMany = vi.fn();
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
const templatesRouter = requireCJS('../../routes/travel_quote_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/quote-templates', templatesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const sampleTemplates = [
  {
    id: 301,
    tenantId: 1,
    name: 'Umrah 7-day Standard',
    description: 'Standard 7-day Umrah package with Madinah + Mecca stay.',
    subBrand: 'rfu',
    category: 'Umrah',
    currency: 'INR',
    linesJson: JSON.stringify([
      { lineType: 'hotel', description: 'Madinah hotel — 3 nights', quantity: 3, unitPrice: 4500, sortOrder: 0 },
      { lineType: 'hotel', description: 'Mecca hotel — 4 nights', quantity: 4, unitPrice: 6000, sortOrder: 1 },
      { lineType: 'transport', description: 'Madinah → Mecca coach', quantity: 1, unitPrice: 1200, sortOrder: 2 },
      { lineType: 'visa', description: 'Umrah visa fee', quantity: 1, unitPrice: 7500, sortOrder: 3 },
    ]),
    isActive: true,
    createdAt: new Date('2026-05-10T09:00:00Z'),
    updatedAt: new Date('2026-05-10T09:00:00Z'),
  },
  {
    id: 302,
    tenantId: 1,
    name: 'Golden Triangle 5-day',
    description: 'Delhi + Agra + Jaipur classic India tour.',
    subBrand: 'travelstall',
    category: 'India-tour',
    currency: 'INR',
    linesJson: JSON.stringify([
      { lineType: 'hotel', description: 'Delhi hotel — 2 nights', quantity: 2, unitPrice: 4000, sortOrder: 0 },
      { lineType: 'hotel', description: 'Agra hotel — 1 night', quantity: 1, unitPrice: 3500, sortOrder: 1 },
      { lineType: 'hotel', description: 'Jaipur hotel — 2 nights', quantity: 2, unitPrice: 4500, sortOrder: 2 },
    ]),
    isActive: true,
    createdAt: new Date('2026-05-09T08:00:00Z'),
    updatedAt: new Date('2026-05-09T08:00:00Z'),
  },
];

beforeEach(() => {
  prisma.travelQuoteTemplate.findMany.mockReset().mockResolvedValue(sampleTemplates);
  prisma.travelQuoteTemplate.findFirst.mockReset();
  prisma.travelQuoteTemplate.count.mockReset().mockResolvedValue(sampleTemplates.length);
  prisma.travelQuoteTemplate.create.mockReset();
  prisma.travelQuoteTemplate.update.mockReset();
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.travelQuoteLine.count.mockReset().mockResolvedValue(0);
  prisma.travelQuoteLine.createMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/travel/quote-templates — list
// ---------------------------------------------------------------------------
describe('GET /api/travel/quote-templates — list', () => {
  test('happy path: returns paginated envelope', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.items[0].name).toBe('Umrah 7-day Standard');
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelQuoteTemplate.findMany).not.toHaveBeenCalled();
  });

  test('unauthenticated (no header) → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/quote-templates');
    expect(res.status).toBe(401);
    expect(prisma.travelQuoteTemplate.findMany).not.toHaveBeenCalled();
  });

  test('?limit=300 clamps to 200; ?limit=0 clamps to 1', async () => {
    let res = await request(makeApp())
      .get('/api/travel/quote-templates?limit=300')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(prisma.travelQuoteTemplate.findMany.mock.calls[0][0].take).toBe(200);

    res = await request(makeApp())
      .get('/api/travel/quote-templates?limit=0')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(prisma.travelQuoteTemplate.findMany.mock.calls[1][0].take).toBe(1);
  });

  test('MANAGER subBrandAccess=["rfu"] threads OR clause (nullable subBrand)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .get('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuoteTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.OR).toEqual([
      { subBrand: null },
      { subBrand: { in: ['rfu'] } },
    ]);
  });

  test('?category + ?isActive filters thread into where', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quote-templates?category=Umrah&isActive=true')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuoteTemplate.findMany.mock.calls[0][0];
    expect(call.where.category).toBe('Umrah');
    expect(call.where.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/travel/quote-templates — create
// ---------------------------------------------------------------------------
describe('POST /api/travel/quote-templates — create', () => {
  test('ADMIN happy path → 201 + record; linesJson re-stringified', async () => {
    prisma.travelQuoteTemplate.create.mockImplementation(({ data }) => ({
      id: 999,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const linesArray = [
      { lineType: 'hotel', description: 'Tokyo hotel — 6 nights', quantity: 6, unitPrice: 8000, sortOrder: 0 },
      { lineType: 'transport', description: 'Tokyo metro pass', quantity: 1, unitPrice: 1500, sortOrder: 1 },
    ];

    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Tokyo Discovery 7-day',
        category: 'Asia-tour',
        currency: 'INR',
        linesJson: JSON.stringify(linesArray),
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(999);
    expect(res.body.name).toBe('Tokyo Discovery 7-day');
    expect(res.body.isActive).toBe(true);
    expect(prisma.travelQuoteTemplate.create).toHaveBeenCalled();
    const data = prisma.travelQuoteTemplate.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(1);
    expect(data.name).toBe('Tokyo Discovery 7-day');
    expect(data.currency).toBe('INR');
    expect(JSON.parse(data.linesJson)).toEqual(linesArray);
  });

  test('accepts linesJson as a raw array (not just stringified)', async () => {
    prisma.travelQuoteTemplate.create.mockImplementation(({ data }) => ({
      id: 1000,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const linesArray = [
      { lineType: 'visa', description: 'Visa Sure assist fee', quantity: 1, unitPrice: 2500 },
    ];

    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Visa Sure Standard',
        linesJson: linesArray,
      });

    expect(res.status).toBe(201);
    const data = prisma.travelQuoteTemplate.create.mock.calls[0][0].data;
    expect(JSON.parse(data.linesJson)).toEqual(linesArray);
  });

  test('missing name → 400 MISSING_NAME', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ linesJson: '[]' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_NAME');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('missing linesJson → 400 MISSING_LINES_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Untested Template' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_LINES_JSON');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('malformed linesJson (not JSON) → 400 INVALID_LINES_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Bad JSON Template', linesJson: 'this is not JSON {{{' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINES_JSON');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('linesJson as object (not array) → 400 INVALID_LINES_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Object Template', linesJson: JSON.stringify({ notArray: true }) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINES_JSON');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('line item missing description → 400 INVALID_LINES_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Bad Item Template',
        linesJson: JSON.stringify([{ lineType: 'hotel', quantity: 1, unitPrice: 100 }]),
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINES_JSON');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('line item with bad lineType → 400 INVALID_LINES_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Bad LineType Template',
        linesJson: JSON.stringify([{ lineType: 'spaceship', description: 'X', quantity: 1, unitPrice: 1 }]),
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINES_JSON');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('lowercase currency "inr" → 400 INVALID_CURRENCY', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Test',
        currency: 'inr',
        linesJson: JSON.stringify([{ description: 'X' }]),
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENCY');
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole gate; create blocked)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ name: 'Test', linesJson: '[]' });

    expect(res.status).toBe(403);
    expect(prisma.travelQuoteTemplate.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/travel/quote-templates/:id
// ---------------------------------------------------------------------------
describe('GET /api/travel/quote-templates/:id', () => {
  test('found → 200 + row', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);

    const res = await request(makeApp())
      .get('/api/travel/quote-templates/301')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(301);
    expect(res.body.name).toBe('Umrah 7-day Standard');
  });

  test('invalid id "abc" → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quote-templates/abc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelQuoteTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('not found → 404 QUOTE_TEMPLATE_NOT_FOUND', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/quote-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_TEMPLATE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/travel/quote-templates/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/travel/quote-templates/:id', () => {
  test('ADMIN happy path → 200 + updated', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);
    prisma.travelQuoteTemplate.update.mockResolvedValue({
      ...sampleTemplates[0],
      name: 'Umrah 7-day VIP',
    });

    const res = await request(makeApp())
      .patch('/api/travel/quote-templates/301')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Umrah 7-day VIP' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Umrah 7-day VIP');
  });

  test('empty body → 400 EMPTY_BODY', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);

    const res = await request(makeApp())
      .patch('/api/travel/quote-templates/301')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
    expect(prisma.travelQuoteTemplate.update).not.toHaveBeenCalled();
  });

  test('not found → 404', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .patch('/api/travel/quote-templates/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_TEMPLATE_NOT_FOUND');
    expect(prisma.travelQuoteTemplate.update).not.toHaveBeenCalled();
  });

  test('PATCH linesJson revalidated on update; malformed → 400', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);

    const res = await request(makeApp())
      .patch('/api/travel/quote-templates/301')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ linesJson: 'still not JSON' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINES_JSON');
    expect(prisma.travelQuoteTemplate.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/travel/quote-templates/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/travel/quote-templates/:id', () => {
  test('ADMIN happy path → 200 with isActive=false (soft delete)', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);
    prisma.travelQuoteTemplate.update.mockResolvedValue({
      ...sampleTemplates[0],
      isActive: false,
    });

    const res = await request(makeApp())
      .delete('/api/travel/quote-templates/301')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(prisma.travelQuoteTemplate.update).toHaveBeenCalledWith({
      where: { id: 301 },
      data: { isActive: false },
    });
  });

  test('MANAGER role → 403 (verifyRole gate; delete is ADMIN-only)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/quote-templates/301')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelQuoteTemplate.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/travel/quote-templates/:id/apply
// ---------------------------------------------------------------------------
describe('POST /api/travel/quote-templates/:id/apply — clone into quote', () => {
  const targetQuote = {
    id: 5001,
    tenantId: 1,
    subBrand: 'rfu',
    contactId: 100,
    status: 'Draft',
    totalAmount: 0,
    currency: 'INR',
  };

  test('happy path: clones lines + recomputes total; 201', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);
    prisma.travelQuote.findFirst.mockResolvedValue(targetQuote);
    prisma.travelQuoteLine.count.mockResolvedValue(0);
    prisma.travelQuoteLine.createMany.mockResolvedValue({ count: 4 });
    // After-write findMany returns the 4 lines with their amounts
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      { amount: 13500 }, // 3 * 4500
      { amount: 24000 }, // 4 * 6000
      { amount: 1200 },
      { amount: 7500 },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/quote-templates/301/apply')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quoteId: 5001 });

    expect(res.status).toBe(201);
    expect(res.body.applied).toBe(4);
    expect(res.body.templateId).toBe(301);
    expect(res.body.quoteId).toBe(5001);
    expect(res.body.totalAmount).toBe(46200);
    expect(prisma.travelQuoteLine.createMany).toHaveBeenCalled();
    const created = prisma.travelQuoteLine.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(4);
    expect(created[0].quoteId).toBe(5001);
    expect(created[0].tenantId).toBe(1);
    expect(created[0].lineType).toBe('hotel');
    expect(created[0].amount).toBe(13500);
    expect(prisma.travelQuote.update).toHaveBeenCalledWith({
      where: { id: 5001 },
      data: { totalAmount: 46200 },
    });
  });

  test('idempotency: existing lines → 409 ALREADY_HAS_LINES', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);
    prisma.travelQuote.findFirst.mockResolvedValue(targetQuote);
    prisma.travelQuoteLine.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .post('/api/travel/quote-templates/301/apply')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quoteId: 5001 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_HAS_LINES');
    expect(res.body.existingLineCount).toBe(3);
    expect(prisma.travelQuoteLine.createMany).not.toHaveBeenCalled();
  });

  test('missing quoteId → 400 INVALID_QUOTE_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates/301/apply')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUOTE_ID');
    expect(prisma.travelQuoteTemplate.findFirst).not.toHaveBeenCalled();
  });

  test('template not found → 404 QUOTE_TEMPLATE_NOT_FOUND', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/quote-templates/9999/apply')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quoteId: 5001 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_TEMPLATE_NOT_FOUND');
  });

  test('target quote not found → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue(sampleTemplates[0]);
    prisma.travelQuote.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/quote-templates/301/apply')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quoteId: 9999 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
    expect(prisma.travelQuoteLine.createMany).not.toHaveBeenCalled();
  });

  test('template inactive → 400 TEMPLATE_INACTIVE', async () => {
    prisma.travelQuoteTemplate.findFirst.mockResolvedValue({
      ...sampleTemplates[0],
      isActive: false,
    });

    const res = await request(makeApp())
      .post('/api/travel/quote-templates/301/apply')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quoteId: 5001 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEMPLATE_INACTIVE');
    expect(prisma.travelQuoteLine.createMany).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole gate; apply blocked)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote-templates/301/apply')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ quoteId: 5001 });

    expect(res.status).toBe(403);
    expect(prisma.travelQuoteLine.createMany).not.toHaveBeenCalled();
  });
});
