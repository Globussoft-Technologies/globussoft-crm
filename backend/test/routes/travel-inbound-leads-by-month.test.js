// @ts-check
/**
 * Arc 2 #904 slice 20 — GET /api/travel/inbound/leads/by-month contract
 * tests (PRD_TRAVEL_MULTICHANNEL_LEADS §3).
 *
 * Tenant-wide inbound-lead time-series rollup bucketed by UTC YYYY-MM.
 * Pairs with slice-10 /by-channel (single-window per-channel) + slice-18
 * /stats (tenant-wide KPI tile-strip) — this endpoint is the time-series
 * surface that lets the operator dashboard render a monthly trend chart
 * without client-side-reducing over /api/contacts?limit=N (the
 * structural-correctness anti-pattern called out in CLAUDE.md).
 *
 * Contracts asserted
 * ------------------
 *   - Happy path: 4 contacts across 2 distinct months → 2 monthly buckets
 *     with reconciling counts + totalMonths + grandCount.
 *   - byChannel pre-seeded: every month bucket carries all 10 VALID_CHANNELS
 *     at the appropriate count (untouched channels at 0).
 *   - ?orderBy=count:desc → months sorted by descending count, ties broken
 *     by ascending month.
 *   - ?from / ?to YYYY-MM bounds applied to bucket selection (inclusive).
 *   - ?channel filter narrows the underlying findMany predicate to the
 *     literal `inbound:<channel>` source.
 *   - Empty tenant → months:[] + totalMonths:0 + grandCount:0.
 *   - tenantSlug missing → 400 MISSING_TENANT_SLUG (no DB call).
 *   - Invalid ?channel → 400 INVALID_CHANNEL.
 *   - Invalid ?from / ?to (not YYYY-MM) → 400 INVALID_MONTH_FORMAT.
 *   - Unknown tenant → 404 TENANT_NOT_FOUND.
 *   - Non-travel tenant → 400 WRONG_VERTICAL.
 *   - 500 envelope on findMany throw (no stack leak).
 *
 * Test mount pattern mirrors sibling slice-18 stats test — patch the prisma
 * singleton with vi.fn() BEFORE requiring the router, then drive supertest
 * against the mounted router directly. The endpoint lives under server.js's
 * openPaths list (`/travel/inbound/leads`) so no auth middleware applies.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.count = vi.fn();
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

// Canonical channel enum (mirrors VALID_CHANNELS in the route).
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

describe('GET /api/travel/inbound/leads/by-month — slice 20 monthly rollup', () => {
  test('happy path: 4 contacts across 2 months → 2 buckets + counts reconcile', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-04-20T12:00:00.000Z') },
      { source: 'inbound:webform', createdAt: new Date('2026-05-10T08:00:00.000Z') },
      { source: 'inbound:webform', createdAt: new Date('2026-05-22T14:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
    // Default order is month:asc — April first, May second.
    expect(res.body.months).toHaveLength(2);
    expect(res.body.months[0].month).toBe('2026-04');
    expect(res.body.months[0].count).toBe(2);
    expect(res.body.months[1].month).toBe('2026-05');
    expect(res.body.months[1].count).toBe(2);
  });

  test('byChannel pre-seeded: every bucket has all 10 VALID_CHANNELS keys', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', createdAt: new Date('2026-04-20T12:00:00.000Z') },
      { source: 'inbound:whatsapp', createdAt: new Date('2026-04-25T15:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    const bucket = res.body.months[0];
    expect(Object.keys(bucket.byChannel).sort()).toEqual([...VALID_CHANNELS].sort());
    expect(bucket.byChannel.voyagr).toBe(1);
    expect(bucket.byChannel.webform).toBe(1);
    expect(bucket.byChannel.whatsapp).toBe(1);
    // Untouched channels stay at 0.
    expect(bucket.byChannel.ads).toBe(0);
    expect(bucket.byChannel.adsgpt).toBe(0);
    expect(bucket.byChannel.metaads).toBe(0);
    expect(bucket.byChannel.manual).toBe(0);
    expect(bucket.byChannel.indiamart).toBe(0);
    expect(bucket.byChannel.justdial).toBe(0);
    expect(bucket.byChannel.tradeindia).toBe(0);
  });

  test('?orderBy=count:desc sorts buckets by descending count', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      // 3 in March
      { source: 'inbound:voyagr', createdAt: new Date('2026-03-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-03-10T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-03-20T10:00:00.000Z') },
      // 1 in April
      { source: 'inbound:webform', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      // 2 in May
      { source: 'inbound:metaads', createdAt: new Date('2026-05-05T10:00:00.000Z') },
      { source: 'inbound:metaads', createdAt: new Date('2026-05-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall', orderBy: 'count:desc' });

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(3);
    expect(res.body.months[0].month).toBe('2026-03');
    expect(res.body.months[0].count).toBe(3);
    expect(res.body.months[1].month).toBe('2026-05');
    expect(res.body.months[1].count).toBe(2);
    expect(res.body.months[2].month).toBe('2026-04');
    expect(res.body.months[2].count).toBe(1);
  });

  test('?from / ?to YYYY-MM window filters buckets (inclusive)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', createdAt: new Date('2026-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-02-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-03-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', createdAt: new Date('2026-05-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({
        tenantSlug: 'travel-stall',
        from: '2026-02',
        to: '2026-04',
      });

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(3);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.months.map((m) => m.month)).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
  });

  test('?channel=metaads narrows findMany source predicate', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:metaads', createdAt: new Date('2026-05-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall', channel: 'metaads' });

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    // When channel is supplied, source predicate becomes the literal
    // `inbound:<channel>` string (not startsWith).
    expect(call.where.source).toBe('inbound:metaads');
    expect(call.where.tenantId).toBe(42);
    expect(call.where.deletedAt).toBeNull();
  });

  test('invalid ?from (not YYYY-MM) → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall', from: '2026-13' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?to (full ISO not YYYY-MM) → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({
        tenantSlug: 'travel-stall',
        to: '2026-05-25T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?channel → 400 INVALID_CHANNEL (no DB call)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall', channel: 'fax-machine' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CHANNEL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant → months:[] + totalMonths:0 + grandCount:0', async () => {
    // Default mock returns [].
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.totalMonths).toBe(0);
    expect(res.body.grandCount).toBe(0);
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('missing tenantSlug → 400 MISSING_TENANT_SLUG (no DB call)', async () => {
    const res = await request(makeApp()).get('/api/travel/inbound/leads/by-month');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT_SLUG' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('unknown tenantSlug → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'no-such-tenant' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 400 WRONG_VERTICAL (no findMany call)', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 7, vertical: 'wellness' });

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'wellness-tenant' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('?limit caps at 60; out-of-range → 400 INVALID_LIMIT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall', limit: '500' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LIMIT' });
  });

  test('500 generic envelope on findMany throw (no stack leak)', async () => {
    prisma.contact.findMany.mockRejectedValueOnce(
      new Error('P1001 cannot reach database'),
    );

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-month')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Failed to roll up inbound leads by month',
    });
    expect(res.body.error).not.toMatch(/P1001/);
  });
});
