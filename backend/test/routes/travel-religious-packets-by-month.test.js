// @ts-check
/**
 * GET /api/travel/religious-packets/by-month — tenant-wide religious-packet
 * monthly rollup.
 *
 * PRD §4.8 + §4.10 RFU sub-brand. Sibling to /religious-packets/stats
 * (line 243 in backend/routes/travel_religious_packets.js). Mirrors the
 * by-month family: /suppliers/by-month (#903 slice 24), /flyer-templates/
 * by-month (#908 slice 21), /quotes/by-month (#900 slice 16), /invoices/
 * by-month (#901 slice 29). Same UTC YYYY-MM bucketing, same defensive
 * math, same orderBy semantics.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 packets across 2 months → 2 month rows with correct
 *     counts + per-bucket bySubBrand breakdown
 *   - Default orderBy=month:asc chronological
 *   - ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (inclusive bounds)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where. NO `OR: [{...}, { null }]`
 *     clause — TravelReligiousPacket.subBrand is non-nullable in the schema
 *     (same posture as /suppliers/by-month).
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from / ?to is set
 *   - Pagination ?limit / ?offset slices AFTER aggregation
 *   - Falsy subBrand coerces to "_tenant" bucket (forward-compat,
 *     mirrors /stats line 332's defensive coalesce)
 *   - Unknown ?orderBy token degrades silently to month:asc default
 *   - NO audit row written
 *
 * Pattern mirrors travel-religious-packets-stats.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, then
 * drive supertest with HS256 JWTs signed against the dev-fallback secret.
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

// Spread of packets across May + June 2026, mixed sub-brands.
//   2026-05: 3 packets — 2 rfu + 1 tmc
//   2026-06: 1 packet  — 1 rfu
const baseRows = [
  { subBrand: 'rfu', createdAt: new Date('2026-05-03T08:00:00Z') },
  { subBrand: 'rfu', createdAt: new Date('2026-05-17T10:30:00Z') },
  { subBrand: 'tmc', createdAt: new Date('2026-05-28T18:45:00Z') },
  { subBrand: 'rfu', createdAt: new Date('2026-06-09T09:00:00Z') },
];

beforeEach(() => {
  prisma.religiousGuidancePacket.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/religious-packets/by-month', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month');

    expect(res.status).toBe(401);
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?from token (month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to token (no dash)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 4 packets across 2 months → 2 rows month:asc with per-bucket bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    // Default ordering is month:asc → 2026-05 first.
    expect(res.body.rows[0]).toMatchObject({
      month: '2026-05',
      count: 3,
      bySubBrand: { rfu: 2, tmc: 1 },
    });
    expect(res.body.rows[1]).toMatchObject({
      month: '2026-06',
      count: 1,
      bySubBrand: { rfu: 1 },
    });
  });

  test('default orderBy is month:asc (chronological)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[1].month).toBe('2026-06');
  });

  test('orderBy=count:desc puts the busier month first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[0].count).toBe(3);
    expect(res.body.rows[1].month).toBe('2026-06');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-05&to=2026-05 narrows the bucket array to a single month (inclusive)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[0].count).toBe(3);
  });

  test('admin (subBrandAccess=null) sees ALL sub-brands; no subBrand clause forced into where', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toBeUndefined();
  });

  test('MANAGER subBrandAccess=[rfu] threads { in: [rfu] } into Prisma where (no null OR clause — non-nullable)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.religiousGuidancePacket.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // subBrand is NON-nullable in the schema, so this is a plain
    // `{ in: [...] }` clause — NOT the flyer-templates-style
    // `OR: [{ subBrand: { in } }, { subBrand: null }]`.
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(call.where.OR).toBeUndefined();
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-05-03T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-05 + 2 in "unknown" → 2 buckets total.
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.month === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.bySubBrand).toEqual({ rfu: 1, tmc: 1 });
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-05-03T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-05');
  });

  test('pagination: ?limit=1&offset=1 returns 2nd month only (with stable total)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // total reflects the FULL aggregation, not the paged window.
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.rows[0].month).toBe('2026-06');
  });

  test('falsy subBrand coerces to "_tenant" bucket (forward-compat defensive coalesce)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' to match the sibling /stats handler
    // (line 332) and forward-compat with any future nullable migration.
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { subBrand: null, createdAt: new Date('2026-05-10T10:00:00Z') },
      { subBrand: 'rfu', createdAt: new Date('2026-05-11T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[0].bySubBrand).toEqual({
      _tenant: 1,
      rfu: 1,
    });
  });

  test('unknown orderBy token degrades silently to month:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[1].month).toBe('2026-06');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
