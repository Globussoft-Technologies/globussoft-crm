// @ts-check
/**
 * Travel CRM — ReligiousGuidancePacket admin-CRUD contract pin (PRD §4.8 + §4.10 RFU).
 *
 * Source: backend/routes/travel_religious_packets.js (362 LOC, 5 endpoints).
 *
 * What's pinned
 * -------------
 *   - GET    /api/travel/religious-packets          tenant-scope, ?subBrand + ?isActive filters,
 *                                                   sub-brand access narrowing for non-admins.
 *   - POST   /api/travel/religious-packets          ADMIN-only; required-field guard, INVALID_SUB_BRAND,
 *                                                   dayOffset bounds [0,365], INVALID_TITLE, INVALID_CONTENT,
 *                                                   CONTENT_TOO_LARGE @ 20_000 bytes, INVALID_CHANNELS regex.
 *   - GET    /api/travel/religious-packets/:id      404 cross-tenant; 403 SUB_BRAND_DENIED for non-admin
 *                                                   advisors viewing a packet outside their sub-brand list.
 *   - PATCH  /api/travel/religious-packets/:id      ADMIN-only; checks access on EXISTING + NEW subBrand
 *                                                   on migrate; EMPTY_BODY guard; per-field validators.
 *   - DELETE /api/travel/religious-packets/:id      ADMIN-only; tenant-scope; hard delete returns
 *                                                   { deleted: true, id }.
 *
 * Pattern mirrors backend/test/routes/travel_suppliers.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router so the
 * route's `require('../lib/prisma')` resolves to our stubs; drive supertest
 * with real HS256 JWTs signed with the dev-fallback secret so verifyToken
 * stays in the chain (auth gate is exercised end-to-end, not bypassed).
 *
 * Multi-tenant + sub-brand isolation: drHarsh-style advisor (USER role
 * with subBrandAccess=["tmc"]) is denied access to packets tagged "rfu".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Patch prisma BEFORE requiring router ──────────────────────────────
prisma.religiousGuidancePacket = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS('../../routes/travel_religious_packets');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/travel', router);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const TRAVEL_TENANT = { id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel' };
const GENERIC_TENANT = { id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic' };

beforeEach(() => {
  prisma.religiousGuidancePacket.findMany.mockReset();
  prisma.religiousGuidancePacket.findFirst.mockReset();
  prisma.religiousGuidancePacket.count.mockReset();
  prisma.religiousGuidancePacket.create.mockReset();
  prisma.religiousGuidancePacket.update.mockReset();
  prisma.religiousGuidancePacket.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue(TRAVEL_TENANT);
  // Default: admin user, full sub-brand access (subBrandAccess=null → null set).
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ───────────────────────────────────────────────────────────────────────
// Auth gates (verifyToken / requirePermission / requireTravelTenant)
// ───────────────────────────────────────────────────────────────────────

describe('Auth + vertical gates', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/religious-packets');
    expect(res.status).toBe(401);
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant returns 403 WRONG_VERTICAL on list', async () => {
    prisma.tenant.findUnique.mockResolvedValue(GENERIC_TENANT);
    const res = await request(makeApp())
      .get('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('USER role cannot POST (verifyRole gate, 403)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: '["tmc"]' });
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ subBrand: 'tmc', dayOffset: 7, title: 'X', contentHtml: '<p>x</p>' });
    expect(res.status).toBe(403);
    expect(prisma.religiousGuidancePacket.create).not.toHaveBeenCalled();
  });

  test('MANAGER role cannot PATCH (verifyRole gate is ADMIN-only)', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/5')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ title: 'New' });
    expect(res.status).toBe(403);
    expect(prisma.religiousGuidancePacket.update).not.toHaveBeenCalled();
  });

  test('MANAGER role cannot DELETE (verifyRole gate is ADMIN-only)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/religious-packets/5')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(prisma.religiousGuidancePacket.delete).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/religious-packets  (list)
// ───────────────────────────────────────────────────────────────────────

describe('GET /api/travel/religious-packets', () => {
  test('returns tenant-scoped list with totals', async () => {
    const rows = [
      { id: 1, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'Visa Reminder', contentHtml: '<p>...</p>', channels: 'wa,email', isActive: true },
      { id: 2, tenantId: 1, subBrand: 'rfu', dayOffset: 7,  title: 'Ihram Guidance', contentHtml: '<p>...</p>', channels: 'wa,email', isActive: true },
    ];
    prisma.religiousGuidancePacket.findMany.mockResolvedValue(rows);
    prisma.religiousGuidancePacket.count.mockResolvedValue(rows.length);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(res.body.packets).toHaveLength(2);
    expect(prisma.religiousGuidancePacket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
        take: 50,
        skip: 0,
      }),
    );
  });

  test('?subBrand=rfu narrows the where clause', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
    prisma.religiousGuidancePacket.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/religious-packets?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.religiousGuidancePacket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, subBrand: 'rfu' }),
      }),
    );
  });

  test('?subBrand=invalid returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets?subBrand=cruise')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('?isActive=true coerces to boolean filter', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
    prisma.religiousGuidancePacket.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/religious-packets?isActive=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.religiousGuidancePacket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  test('?isActive=garbage returns 400 INVALID_IS_ACTIVE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets?isActive=banana')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_IS_ACTIVE' });
  });

  test('non-admin advisor list is narrowed to their subBrandAccess set', async () => {
    // USER with subBrandAccess=["tmc"] requesting the list (no ?subBrand) —
    // expect the where.subBrand to be { in: ['tmc'] }.
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: JSON.stringify(['tmc']) });
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
    prisma.religiousGuidancePacket.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    const call = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // Set serialises through Prisma as { in: [...] } — exact shape pinned.
    expect(call.where.subBrand).toEqual({ in: ['tmc'] });
  });

  test('non-admin advisor requesting an out-of-bounds ?subBrand gets __none__ sentinel (zero rows, not 403)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: JSON.stringify(['tmc']) });
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
    prisma.religiousGuidancePacket.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.religiousGuidancePacket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, subBrand: '__none__' }),
      }),
    );
  });

  test('limit clamps to 200 max', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);
    prisma.religiousGuidancePacket.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/religious-packets?limit=5000&offset=100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.religiousGuidancePacket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, skip: 100 }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/travel/religious-packets  (create)
// ───────────────────────────────────────────────────────────────────────

describe('POST /api/travel/religious-packets', () => {
  test('happy path returns 201 with the created packet + default channels=wa,email + isActive=true', async () => {
    prisma.religiousGuidancePacket.create.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'rfu', dayOffset: 14,
      title: 'Visa Reminder', contentHtml: '<p>Submit your visa application.</p>',
      channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'rfu',
        dayOffset: 14,
        title: 'Visa Reminder',
        contentHtml: '<p>Submit your visa application.</p>',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 42, title: 'Visa Reminder' });
    expect(prisma.religiousGuidancePacket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'rfu',
          dayOffset: 14,
          title: 'Visa Reminder',
          channels: 'wa,email',
          isActive: true,
        }),
      }),
    );
  });

  test('rejects missing fields with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', title: 'X' }); // missing dayOffset + contentHtml
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.religiousGuidancePacket.create).not.toHaveBeenCalled();
  });

  test('dayOffset === 0 is ACCEPTED (boundary; "fire on the day")', async () => {
    prisma.religiousGuidancePacket.create.mockResolvedValue({
      id: 60, tenantId: 1, subBrand: 'rfu', dayOffset: 0,
      title: 'Departure Day', contentHtml: '<p>Bon voyage</p>', channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 0, title: 'Departure Day', contentHtml: '<p>Bon voyage</p>' });
    expect(res.status).toBe(201);
    expect(prisma.religiousGuidancePacket.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dayOffset: 0 }) }),
    );
  });

  test('dayOffset === -1 rejected with 400 INVALID_DAY_OFFSET', async () => {
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: -1, title: 'Pre-Phase', contentHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAY_OFFSET' });
    expect(prisma.religiousGuidancePacket.create).not.toHaveBeenCalled();
  });

  test('dayOffset === 366 rejected with 400 INVALID_DAY_OFFSET (upper bound)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 366, title: 'Too Far', contentHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAY_OFFSET' });
  });

  test('invalid subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'cruise', dayOffset: 7, title: 'X', contentHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
  });

  test('empty title rejected with 400 MISSING_FIELDS (required-field guard fires before length check)', async () => {
    // Empty string is falsy → !title is truthy → MISSING_FIELDS fires
    // before the dedicated INVALID_TITLE length validator. Order matters
    // here; pinning the actual error code, not the most-specific one.
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 7, title: '', contentHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('over-long title (201 chars) rejected with 400 INVALID_TITLE', async () => {
    const longTitle = 'A'.repeat(201);
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 7, title: longTitle, contentHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TITLE' });
  });

  test('non-string title (number) reaches dedicated INVALID_TITLE branch', async () => {
    // Number coerces truthy → passes the required-field guard → falls
    // through to typeof t !== 'string' → INVALID_TITLE. Pins the
    // type-vs-required ordering distinction.
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 7, title: 42, contentHtml: '<p>x</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TITLE' });
  });

  test('empty contentHtml rejected with 400 MISSING_FIELDS (same order-of-checks reason as empty title)', async () => {
    // Empty string is falsy → !contentHtml is truthy → MISSING_FIELDS
    // fires first; the INVALID_CONTENT branch only reaches non-empty-but-
    // non-string values.
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 7, title: 'X', contentHtml: '' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('non-string contentHtml (number) reaches dedicated INVALID_CONTENT branch', async () => {
    // 42 is truthy → passes required-field guard → typeof c !== 'string'
    // → INVALID_CONTENT. Note: passing `0` would still hit MISSING_FIELDS
    // (falsy) — this test only proves the dedicated branch is reachable.
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 7, title: 'X', contentHtml: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTENT' });
  });

  test('contentHtml >20_000 bytes rejected with 400 CONTENT_TOO_LARGE', async () => {
    const huge = '<p>' + 'x'.repeat(20_001) + '</p>';
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 7, title: 'X', contentHtml: huge });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTENT_TOO_LARGE' });
    expect(prisma.religiousGuidancePacket.create).not.toHaveBeenCalled();
  });

  test('channels="wa,email,sms" accepted; channels="wa, email" rejected (no spaces)', async () => {
    prisma.religiousGuidancePacket.create.mockResolvedValue({
      id: 70, tenantId: 1, subBrand: 'rfu', dayOffset: 1, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email,sms', isActive: true,
    });
    const ok = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 1, title: 'X', contentHtml: '<p>x</p>', channels: 'wa,email,sms' });
    expect(ok.status).toBe(201);

    prisma.religiousGuidancePacket.create.mockReset();

    const bad = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 1, title: 'X', contentHtml: '<p>x</p>', channels: 'wa, email' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'INVALID_CHANNELS' });
    expect(prisma.religiousGuidancePacket.create).not.toHaveBeenCalled();
  });

  test('channels="" (empty string) rejected as INVALID_CHANNELS — empty != default', async () => {
    // The handler defaults channels only when the field is undefined/null. An
    // explicit empty string is coerced via String() then run through the regex,
    // which fails — caller intent was "no channels", which is a junk value.
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu', dayOffset: 1, title: 'X', contentHtml: '<p>x</p>', channels: '' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CHANNELS' });
  });

  test('non-admin (via direct route call) blocked by verifyRole BEFORE sub-brand check', async () => {
    // USER role with tmc access trying to POST to ANY subBrand — the RBAC gate
    // fires first and 403s; we never reach assertSubBrandAccess.
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: JSON.stringify(['tmc']) });
    const res = await request(makeApp())
      .post('/api/travel/religious-packets')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ subBrand: 'tmc', dayOffset: 7, title: 'X', contentHtml: '<p>x</p>' });
    expect(res.status).toBe(403);
    expect(prisma.religiousGuidancePacket.create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/religious-packets/:id
// ───────────────────────────────────────────────────────────────────────

describe('GET /api/travel/religious-packets/:id', () => {
  test('returns 200 with row for same-tenant admin', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'rfu', dayOffset: 7, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, subBrand: 'rfu' });
    expect(prisma.religiousGuidancePacket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 5, tenantId: 1 }) }),
    );
  });

  test('non-numeric :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/banana')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.religiousGuidancePacket.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant / missing row returns 404 NOT_FOUND', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('non-admin advisor viewing out-of-band sub-brand packet returns 403 SUB_BRAND_DENIED', async () => {
    // USER with only tmc access; the packet is rfu — they CAN find the row
    // (tenantId matches) but the explicit sub-brand check 403s.
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: JSON.stringify(['tmc']) });
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 8, tenantId: 1, subBrand: 'rfu', dayOffset: 7, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/8')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });
});

// ───────────────────────────────────────────────────────────────────────
// PATCH /api/travel/religious-packets/:id
// ───────────────────────────────────────────────────────────────────────

describe('PATCH /api/travel/religious-packets/:id', () => {
  test('happy path updates the row (200)', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'Old', contentHtml: '<p>old</p>',
      channels: 'wa,email', isActive: true,
    });
    prisma.religiousGuidancePacket.update.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'New', contentHtml: '<p>new</p>',
      channels: 'wa,email,sms', isActive: false,
    });
    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ title: 'New', contentHtml: '<p>new</p>', channels: 'wa,email,sms', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 10, title: 'New', isActive: false });
    expect(prisma.religiousGuidancePacket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: expect.objectContaining({
          title: 'New',
          contentHtml: '<p>new</p>',
          channels: 'wa,email,sms',
          isActive: false,
        }),
      }),
    );
  });

  test('cross-tenant returns 404 NOT_FOUND (no update call)', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ title: 'X' });
    expect(res.status).toBe(404);
    expect(prisma.religiousGuidancePacket.update).not.toHaveBeenCalled();
  });

  test('empty body rejected with 400 EMPTY_BODY', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.religiousGuidancePacket.update).not.toHaveBeenCalled();
  });

  test('per-field validators fire: bad dayOffset rejected with 400 INVALID_DAY_OFFSET', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ dayOffset: 999 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAY_OFFSET' });
    expect(prisma.religiousGuidancePacket.update).not.toHaveBeenCalled();
  });

  test('per-field validators fire: oversize contentHtml rejected with 400 CONTENT_TOO_LARGE', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });
    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contentHtml: '<p>' + 'z'.repeat(20_001) + '</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTENT_TOO_LARGE' });
  });

  test('subBrand migrate requires access to BOTH existing AND new sub-brand', async () => {
    // Pre-condition: existing row is "rfu". User has access to rfu but
    // attempting to MIGRATE to "tmc" (which user does NOT have access to)
    // must 403 — admin can't sidestep their own access list.
    //
    // Wrinkle: the RBAC gate requires ADMIN to even reach this handler, and
    // ADMIN gets full sub-brand access (per getSubBrandAccessSet which
    // short-circuits role==='ADMIN' to null). So to exercise this path
    // we have to construct an admin whose user-row lookup returns
    // a non-admin role (simulating role drift). Since the route's
    // getSubBrandAccessSet looks up by userId, we can return a
    // {role:'USER', subBrandAccess:['rfu']} row from prisma.user.findUnique
    // even though the JWT claims ADMIN — the RBAC gate sees the JWT and lets
    // us in; the sub-brand guard sees the DB row and narrows.
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: JSON.stringify(['rfu']) });
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });

    const res = await request(makeApp())
      .patch('/api/travel/religious-packets/11')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc' }); // migrating to a sub-brand user lacks

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.religiousGuidancePacket.update).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// DELETE /api/travel/religious-packets/:id
// ───────────────────────────────────────────────────────────────────────

describe('DELETE /api/travel/religious-packets/:id', () => {
  test('returns 200 with { deleted: true, id } (HARD delete, not soft)', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, subBrand: 'rfu', dayOffset: 14, title: 'X', contentHtml: '<p>x</p>',
      channels: 'wa,email', isActive: true,
    });
    prisma.religiousGuidancePacket.delete.mockResolvedValue({ id: 22 });
    const res = await request(makeApp())
      .delete('/api/travel/religious-packets/22')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 22 });
    expect(prisma.religiousGuidancePacket.delete).toHaveBeenCalledWith({ where: { id: 22 } });
  });

  test('cross-tenant / missing returns 404 NOT_FOUND (no delete call)', async () => {
    prisma.religiousGuidancePacket.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/religious-packets/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.religiousGuidancePacket.delete).not.toHaveBeenCalled();
  });

  test('non-numeric :id returns 400 INVALID_ID (no findFirst call)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/religious-packets/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.religiousGuidancePacket.findFirst).not.toHaveBeenCalled();
  });
});
