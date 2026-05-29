// @ts-check
/**
 * GET /api/travel/religious-packets/stats — tenant-wide religious-packet
 * content-library rollup.
 *
 * Mirrors the broader stats family (#903 slice 23 /suppliers/stats, #905
 * slice 18 /commission-profiles/stats, #908 slice 19 /flyer-templates/
 * global-stats). USER-readable anodyne aggregate that powers the Religious
 * Guidance Packets library page's header summary strip. Pins the contract
 * for the new route handler added at backend/routes/travel_religious_packets.js
 * (placed BEFORE the /religious-packets/:id family so the literal-path
 * /stats wins over the :id matcher).
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty bucket maps and
 *                          lastUpdatedAt=null. byChannel is pre-seeded
 *                          with {wa:0, email:0, sms:0} so the UI has a
 *                          stable shape even with zero packets.
 *   - Happy path:          4 packets across 2 sub-brands + mixed channels +
 *                          mixed dayOffsets → counts + buckets correct.
 *                          A packet with channels="wa,email" contributes
 *                          +1 to wa AND +1 to email (not +1 to a composite
 *                          "wa,email" key).
 *   - Sub-brand bucketing: defensive — a null subBrand lands in `_tenant`
 *                          bucket, not lost.
 *   - MANAGER narrowing:   subBrandAccess=['rfu'] → caller sees ONLY rfu
 *                          packets (other sub-brands filtered before
 *                          aggregation).
 *   - USER-readable:       USER role returns 200 (anodyne aggregate; same
 *                          contract as sibling stats endpoints).
 *   - Cross-tenant:        packets from another tenant must NOT appear in
 *                          counts. The route's tenantId clause +
 *                          requireTravelTenant middleware enforce this.
 *   - Auth gate:           no token → 401.
 *   - ISO date bounds:     ?from + ?to feed into the where.createdAt clause.
 *                          Invalid ISO → 400 INVALID_DATE.
 *   - Defensive channels:  null/empty channels string contributes nothing
 *                          to byChannel; unknown tokens are skipped.
 *
 * Test pattern mirrors travel-supplier-stats.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, then drive
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.religiousGuidancePacket = prisma.religiousGuidancePacket || {};
prisma.religiousGuidancePacket.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN',
  subBrandAccess: null,
});
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
const router = requireCJS('../../routes/travel_religious_packets');

function makeApp() {
  const app = express();
  app.use(express.json());
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

beforeEach(() => {
  prisma.religiousGuidancePacket.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/religious-packets/stats', () => {
  test('empty tenant → zeroed envelope with stable bucket maps', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      active: 0,
      archived: 0,
      bySubBrand: {},
      byDayOffset: {},
      byChannel: { wa: 0, email: 0, sms: 0 },
      lastUpdatedAt: null,
    });
  });

  test('happy path: 4 packets across 2 sub-brands + mixed channels + mixed dayOffsets → buckets correct', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'rfu',
        dayOffset: 14,
        isActive: true,
        channels: 'wa,email',
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        subBrand: 'rfu',
        dayOffset: 7,
        isActive: true,
        channels: 'wa,email,sms',
        updatedAt: newest, // newest updatedAt — drives lastUpdatedAt
      },
      {
        id: 3,
        subBrand: 'rfu',
        dayOffset: 1,
        isActive: false, // archived
        channels: 'wa',
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        id: 4,
        subBrand: 'tmc',
        dayOffset: 7,
        isActive: true,
        channels: 'email',
        updatedAt: new Date('2026-05-18T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.active).toBe(3);
    expect(res.body.archived).toBe(1);
    expect(res.body.bySubBrand).toEqual({
      rfu: { count: 3 },
      tmc: { count: 1 },
    });
    expect(res.body.byDayOffset).toEqual({
      '14': { count: 1 },
      '7': { count: 2 },
      '1': { count: 1 },
    });
    // Channel rollup: a packet with channels="wa,email" contributes +1 to
    // wa AND +1 to email. Per the 4 packets above:
    //   wa: packets 1, 2, 3        = 3
    //   email: packets 1, 2, 4     = 3
    //   sms: packet 2              = 1
    expect(res.body.byChannel).toEqual({ wa: 3, email: 3, sms: 1 });
    expect(res.body.lastUpdatedAt).toBe(newest.toISOString());
  });

  test('sub-brand bucketing: null subBrand lands in `_tenant` bucket (forward-compat defensive)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' to match the sibling /suppliers/stats
    // shape and forward-compat with any future nullable migration.
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: null,
        dayOffset: 0,
        isActive: true,
        channels: 'wa',
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        subBrand: 'rfu',
        dayOffset: 0,
        isActive: true,
        channels: 'wa',
        updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.bySubBrand).toEqual({
      _tenant: { count: 1 },
      rfu: { count: 1 },
    });
  });

  test('MANAGER with subBrandAccess=["rfu"] → query narrowed to rfu before count', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'rfu',
        dayOffset: 7,
        isActive: true,
        channels: 'wa,email',
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });

    // Verify the WHERE clause was narrowed BEFORE the query hit Prisma.
    // The contract: MANAGER subBrandAccess narrowing happens at the route
    // level, not in client code.
    const whereArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0].where;
    expect(whereArg.subBrand).toEqual({ in: ['rfu'] });
  });

  test('USER role → 200 (anodyne aggregate; sibling stats endpoints behave the same)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('cross-tenant: tenantId clause prevents leak from another tenant', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'rfu',
        dayOffset: 7,
        isActive: true,
        channels: 'wa,email',
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(1);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/religious-packets/stats');
    expect(res.status).toBe(401);
  });

  test('ISO date bounds: ?from + ?to feed into createdAt clause', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.religiousGuidancePacket.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt).toBeDefined();
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(whereArg.createdAt.lte.toISOString()).toBe('2026-05-31T23:59:59.000Z');
  });

  test('ISO date bounds: invalid ?from → 400 INVALID_DATE', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('defensive channels: empty/null/unknown channel tokens contribute 0 to byChannel', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      {
        id: 1,
        subBrand: 'rfu',
        dayOffset: 7,
        isActive: true,
        channels: null, // null — skip entirely
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        subBrand: 'rfu',
        dayOffset: 7,
        isActive: true,
        channels: '', // empty — skip entirely
        updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
      {
        id: 3,
        subBrand: 'rfu',
        dayOffset: 7,
        isActive: true,
        channels: 'wa,unknown,fax,email', // unknown tokens skipped, valid kept
        updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/religious-packets/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    // Only packet 3's valid tokens (wa + email) counted; unknown/fax ignored.
    expect(res.body.byChannel).toEqual({ wa: 1, email: 1, sms: 0 });
  });
});
