// @ts-check
/**
 * GET /api/travel/religious-packets/by-quarter — tenant-wide religious-packet
 * quarterly rollup.
 *
 * PRD §4.8 + §4.10 RFU sub-brand. Sibling to /religious-packets/stats +
 * /religious-packets/by-month in backend/routes/travel_religious_packets.js.
 * Quarter family parallels /itineraries/by-quarter + /suppliers/by-quarter
 * at the religious-packet content-library scale.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 packets across 2 quarters → 2 quarter rows with correct
 *     counts + per-bucket bySubBrand breakdown
 *   - Default orderBy=quarter:asc chronological
 *   - ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (inclusive YYYY-Q[1-4] bounds)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where. NO `OR: [{...}, { null }]`
 *     clause — TravelReligiousPacket.subBrand is non-nullable in the schema
 *     (same posture as /by-month).
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from / ?to is set
 *   - Pagination ?limit / ?offset slices AFTER aggregation
 *   - Falsy subBrand coerces to "_tenant" bucket (forward-compat,
 *     mirrors /stats + /by-month defensive coalesce)
 *   - Unknown ?orderBy token degrades silently to quarter:asc default
 *
 * Pattern mirrors travel-religious-packets-by-month.test.js — patch the
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

// Spread of packets across Q1 + Q2 2026, mixed sub-brands.
//   2026-Q1 (Jan–Mar): 2 packets — 1 rfu + 1 tmc
//   2026-Q2 (Apr–Jun): 1 packet  — 1 rfu
const baseRows = [
  { subBrand: 'rfu', createdAt: new Date('2026-01-15T08:00:00Z') }, // Q1
  { subBrand: 'tmc', createdAt: new Date('2026-02-28T18:45:00Z') }, // Q1
  { subBrand: 'rfu', createdAt: new Date('2026-05-17T10:30:00Z') }, // Q2
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

describe('GET /api/travel/religious-packets/by-quarter', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter');

    expect(res.status).toBe(401);
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token (quarter 5)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.religiousGuidancePacket.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?to token (YYYY-MM not YYYY-Qn)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 3 packets across 2 quarters → 2 rows quarter:asc with per-bucket bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    // Default ordering is quarter:asc → 2026-Q1 first.
    expect(res.body.rows[0]).toMatchObject({
      quarter: '2026-Q1',
      count: 2,
      bySubBrand: { rfu: 1, tmc: 1 },
    });
    expect(res.body.rows[1]).toMatchObject({
      quarter: '2026-Q2',
      count: 1,
      bySubBrand: { rfu: 1 },
    });
  });

  test('default orderBy is quarter:asc (chronological)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
    expect(res.body.rows[1].quarter).toBe('2026-Q2');
  });

  test('orderBy=count:desc puts the busier quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-Q1&to=2026-Q1 narrows the bucket array to a single quarter (inclusive)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?from=2026-Q1&to=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
    expect(res.body.rows[0].count).toBe(2);
  });

  test('admin (subBrandAccess=null) sees ALL sub-brands; no subBrand clause forced into where', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter')
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
      { subBrand: 'rfu', createdAt: new Date('2026-02-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter')
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
      { subBrand: 'rfu', createdAt: new Date('2026-01-15T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-Q1 + 2 in "unknown" → 2 buckets total.
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.quarter === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.bySubBrand).toEqual({ rfu: 1, tmc: 1 });
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-01-15T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
  });

  test('pagination: ?limit=1&offset=1 returns 2nd quarter only (with stable total)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // total reflects the FULL aggregation, not the paged window.
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q2.
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
  });

  test('falsy subBrand coerces to "_tenant" bucket (forward-compat defensive coalesce)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' to match the sibling /stats handler
    // (line 332) and forward-compat with any future nullable migration.
    prisma.religiousGuidancePacket.findMany.mockResolvedValue([
      { subBrand: null, createdAt: new Date('2026-01-10T10:00:00Z') },
      { subBrand: 'rfu', createdAt: new Date('2026-02-11T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[0].bySubBrand).toEqual({
      _tenant: 1,
      rfu: 1,
    });
  });

  test('unknown orderBy token degrades silently to quarter:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/religious-packets/by-quarter?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
    expect(res.body.rows[1].quarter).toBe('2026-Q2');
  });
});
