// @ts-check
/**
 * Arc 2 #904 slice 18 — GET /api/travel/inbound/leads/stats contract
 * tests (PRD_TRAVEL_MULTICHANNEL_LEADS §3).
 *
 * Complements slice-10 /by-channel (single-window per-channel rollup)
 * with a tenant-wide stats summary suitable for the operator KPI tile-strip:
 * total + per-channel breakdown (pre-seeded 10 channels) + per-source
 * top-10 + per-subBrand + rolling today/week/month counts + lastReceivedAt.
 *
 * Closes the structural-correctness gap in the inbound-leads admin surface
 * — without this endpoint the frontend would have to fetch paginated
 * /api/contacts and reduce() client-side (already a CLAUDE.md anti-pattern).
 *
 * Contracts asserted
 * ------------------
 *   - Empty tenant → all zeros + byChannel has all 10 entries at 0 +
 *     lastReceivedAt:null.
 *   - Happy path: 4 contacts across 2 channels → correct counts in byChannel
 *     + total reconciles.
 *   - Defensive: unknown channel suffixes drop silently from byChannel
 *     (slice contract: byChannel stays exactly 10 keys).
 *   - bySource collapses to top-10 + _other when > 10 distinct sources.
 *   - bySubBrand groups Contact.subBrand correctly + nulls coalesce to _none.
 *   - todayCount / thisWeekCount / thisMonthCount fire separate count()
 *     calls with their own createdAt floors (each independent of the
 *     user-supplied from/to window).
 *   - lastReceivedAt = max(createdAt) across the window.
 *   - Cross-tenant scope: groupBy where-predicate filters tenantId, so a
 *     mis-resolved tenant cannot leak rows from another tenant.
 *   - ?from / ?to ISO bounds are applied to findMany's createdAt.
 *   - tenantSlug missing → 400 MISSING_TENANT_SLUG (no DB call).
 *   - Tenant miss → 404 TENANT_NOT_FOUND.
 *   - Non-travel tenant → 400 WRONG_VERTICAL (no findMany call).
 *   - Invalid from / to → 400 INVALID_DATE.
 *   - 500 envelope on findMany throw (no stack leak).
 *
 * Test mount pattern mirrors backend/test/routes/travel-inbound-leads.test.js
 * — patch prisma singleton with vi.fn() BEFORE requiring the router, then
 * drive supertest against the mounted router directly. Endpoint path lives
 * under server.js's openPaths list (`/travel/inbound/leads`) so no auth
 * middleware applies; tests reflect production behaviour.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.count = vi.fn();
// Sibling slice surfaces — pre-seed so the shared module-state doesn't
// trip up if the route file ever invokes them on a sibling code path.
prisma.contact.create = vi.fn();
prisma.contact.findUnique = vi.fn();
prisma.contact.groupBy = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const inboundLeadsRouter = requireCJS('../../routes/travel_inbound_leads');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', inboundLeadsRouter);
  return app;
}

const TRAVEL_TENANT = { id: 42, vertical: 'travel' };

// Canonical channel enum (mirrors VALID_CHANNELS in the route). If this
// drifts, the route's byChannel pre-seed key set drifts too and the
// shape-stability tests below will catch the divergence.
const VALID_CHANNELS = [
  'voyagr',
  'webform',
  'whatsapp',
  'ads',
  'adsgpt',
  'metaads',
  'manual',
  'indiamart',
  'justdial',
  'tradeindia',
];

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue(TRAVEL_TENANT);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.count.mockReset().mockResolvedValue(0);
});

describe('GET /api/travel/inbound/leads/stats — slice 18 tenant rollup', () => {
  test('empty tenant: all zeros + byChannel has all 10 entries at 0 + lastReceivedAt null', async () => {
    // Default mocks already return []/0. No additional setup.
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 42,
      tenantSlug: 'travel-stall',
      total: 0,
      todayCount: 0,
      thisWeekCount: 0,
      thisMonthCount: 0,
      lastReceivedAt: null,
    });
    // byChannel pre-seed: every VALID_CHANNEL present at 0.
    expect(Object.keys(res.body.byChannel).sort()).toEqual(
      [...VALID_CHANNELS].sort(),
    );
    for (const c of VALID_CHANNELS) {
      expect(res.body.byChannel[c]).toBe(0);
    }
    expect(res.body.bySource).toEqual({});
    expect(res.body.bySubBrand).toEqual({});
  });

  test('happy path: 4 contacts across 2 channels → correct counts + total reconciles', async () => {
    const now = new Date('2026-05-25T12:00:00.000Z');
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'rfu', createdAt: now },
      { source: 'inbound:voyagr', subBrand: 'rfu', createdAt: now },
      { source: 'inbound:webform', subBrand: 'tmc', createdAt: now },
      { source: 'inbound:webform', subBrand: null, createdAt: now },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.byChannel.voyagr).toBe(2);
    expect(res.body.byChannel.webform).toBe(2);
    // Untouched channels stay at 0.
    expect(res.body.byChannel.whatsapp).toBe(0);
    expect(res.body.byChannel.ads).toBe(0);
    // bySource: 2 distinct sources, both within top-10 → no _other.
    expect(res.body.bySource['inbound:voyagr']).toBe(2);
    expect(res.body.bySource['inbound:webform']).toBe(2);
    expect(res.body.bySource._other).toBeUndefined();
    // bySubBrand: rfu=2, tmc=1, _none=1.
    expect(res.body.bySubBrand.rfu).toBe(2);
    expect(res.body.bySubBrand.tmc).toBe(1);
    expect(res.body.bySubBrand._none).toBe(1);
    expect(res.body.lastReceivedAt).toBe(now.toISOString());
  });

  test('defensive: unknown channel suffix drops from byChannel (key set stays at 10)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: null, createdAt: new Date() },
      // Unknown suffix — must NOT pollute byChannel.
      { source: 'inbound:legacydialer', subBrand: null, createdAt: new Date() },
      { source: 'inbound:legacydialer', subBrand: null, createdAt: new Date() },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    // byChannel key count is exactly 10 — slice contract guarantee.
    expect(Object.keys(res.body.byChannel)).toHaveLength(10);
    expect(res.body.byChannel.voyagr).toBe(1);
    // But bySource preserves the literal source string for ops visibility.
    expect(res.body.bySource['inbound:legacydialer']).toBe(2);
  });

  test('bySource collapses to top-10 + _other when > 10 distinct sources', async () => {
    // 12 distinct sources, each appearing once. Top 10 (by count, ties
    // broken by sort ordering) survive; bottom 2 collapse into _other.
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push({
        source: `inbound:custom-${i}`,
        subBrand: null,
        createdAt: new Date(),
      });
    }
    prisma.contact.findMany.mockResolvedValueOnce(rows);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    // bySource caps at 10 distinct keys + _other catch-all.
    const keys = Object.keys(res.body.bySource);
    expect(keys.length).toBe(11);
    expect(keys).toContain('_other');
    expect(res.body.bySource._other).toBe(2);
  });

  test('todayCount / thisWeekCount / thisMonthCount: each fires an independent count() with its own floor', async () => {
    prisma.contact.count
      .mockResolvedValueOnce(3) // today
      .mockResolvedValueOnce(10) // week
      .mockResolvedValueOnce(25); // month

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.todayCount).toBe(3);
    expect(res.body.thisWeekCount).toBe(10);
    expect(res.body.thisMonthCount).toBe(25);
    expect(prisma.contact.count).toHaveBeenCalledTimes(3);
    // Verify each count() call carries tenant + inbound-source predicate +
    // its own createdAt floor (each Date is later than the next).
    const calls = prisma.contact.count.mock.calls;
    for (const [args] of calls) {
      expect(args.where).toMatchObject({
        tenantId: 42,
        deletedAt: null,
        source: { startsWith: 'inbound:' },
      });
      expect(args.where.createdAt.gte).toBeInstanceOf(Date);
    }
    const todayFloor = calls[0][0].where.createdAt.gte.getTime();
    const weekFloor = calls[1][0].where.createdAt.gte.getTime();
    const monthFloor = calls[2][0].where.createdAt.gte.getTime();
    // Today floor is most-recent (startOfDay), then week (now-7d), then month (now-30d).
    expect(todayFloor).toBeGreaterThan(weekFloor);
    expect(weekFloor).toBeGreaterThan(monthFloor);
  });

  test('cross-tenant: findMany predicate scopes to the looked-up tenantId (no leak)', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 99, vertical: 'travel' });

    await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'other-travel' });

    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 99,
          deletedAt: null,
          source: { startsWith: 'inbound:' },
        }),
      }),
    );
    // Sanity check: tenantId NOT 42 (the default-mock tenant) in the where.
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(99);
  });

  test('?from / ?to ISO bounds applied to findMany createdAt window', async () => {
    await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({
        tenantSlug: 'travel-stall',
        from: '2026-04-01T00:00:00.000Z',
        to: '2026-05-25T23:59:59.999Z',
      });

    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(call.where.createdAt.lte.toISOString()).toBe('2026-05-25T23:59:59.999Z');
  });

  test('lastReceivedAt: max(createdAt) when 0 rows → null', async () => {
    // Already the default-mock state — empty findMany. The empty-tenant
    // test above already pins the all-zeros shape; this case extends to
    // pin lastReceivedAt:null specifically when 0 rows but tenant exists.
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.lastReceivedAt).toBeNull();
  });

  test('lastReceivedAt: picks the largest createdAt across the window', async () => {
    const oldest = new Date('2026-04-01T08:00:00.000Z');
    const middle = new Date('2026-04-15T08:00:00.000Z');
    const newest = new Date('2026-05-25T08:00:00.000Z');
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'rfu', createdAt: middle },
      { source: 'inbound:voyagr', subBrand: 'rfu', createdAt: newest },
      { source: 'inbound:voyagr', subBrand: 'rfu', createdAt: oldest },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.lastReceivedAt).toBe(newest.toISOString());
  });

  test('missing tenantSlug → 400 MISSING_TENANT_SLUG, no DB call', async () => {
    const res = await request(makeApp()).get('/api/travel/inbound/leads/stats');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT_SLUG' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.contact.count).not.toHaveBeenCalled();
  });

  test('unknown tenantSlug → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'no-such-tenant' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 400 WRONG_VERTICAL (no findMany call)', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 7, vertical: 'wellness' });

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'wellness-tenant' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?from → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall', from: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?to → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall', to: 'garbage' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('500 generic envelope on findMany throw (no stack leak)', async () => {
    prisma.contact.findMany.mockRejectedValueOnce(
      new Error('P1001 cannot reach database'),
    );

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/stats')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to summarise inbound leads' });
    expect(res.body.error).not.toMatch(/P1001/);
  });
});
