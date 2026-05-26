// @ts-check
/**
 * Arc 2 #904 slice 21 — GET /api/travel/inbound/leads/by-quarter contract
 * tests (PRD_TRAVEL_MULTICHANNEL_LEADS §3).
 *
 * Tenant-wide inbound-lead time-series rollup bucketed by UTC YYYY-Q[1-4].
 * Sibling to slice-20 /by-month and slice-18 /stats — this endpoint is the
 * quarterly surface that lets the operator dashboard render a quarterly
 * trend chart (finance review cadence, supplier reconciliation, RFU Umrah
 * seasonal planning) without summing 3 month rows client-side.
 *
 * Mirrors the slice-17 /api/travel/itineraries/by-quarter pattern for the
 * YYYY-Q[1-4] bucket-key derivation (Math.floor(getUTCMonth()/3)+1) plus
 * the "unknown" fallback bucket for null/invalid createdAt rows. Auth /
 * sub-brand handling mirrors slice-20 /by-month EXACTLY (no verifyToken,
 * tenantSlug-scoped, no sub-brand restriction).
 *
 * Contracts asserted
 * ------------------
 *   - Auth gate: route is mounted on an open path, so happy-path needs no
 *     Authorization header. Test 1 below pins the no-header → 400/200
 *     posture (NOT 401) since the inbound-leads rollup family is unauthed.
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from (e.g. "2026-Q5", "2026-13").
 *   - 400 INVALID_QUARTER_FORMAT on bad ?to.
 *   - Happy path: 3 leads across 2 quarters → 2 quarter rows + correct
 *     counts + per-bucket bySubBrand breakdown.
 *   - Default orderBy=quarter:asc chronological.
 *   - ?orderBy=count:desc flips ordering.
 *   - ?from / ?to YYYY-Q[1-4] window applied to bucket selection
 *     (inclusive).
 *   - Sub-brand restriction mirrors /by-month posture exactly (no
 *     subBrandAccess narrowing on the rollup family — the test pins this
 *     by asserting cross-sub-brand rows aren't filtered out).
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from/?to set.
 *   - Pagination ?limit=2&offset=1 slices AFTER aggregation.
 *   - Falsy subBrand coerces to "_tenant" bucket.
 *   - Unknown ?orderBy token degrades silently to default quarter:asc.
 *
 * Test mount pattern mirrors sibling slice-20 by-month test — patch the
 * prisma singleton with vi.fn() BEFORE requiring the router, then drive
 * supertest against the mounted router directly. The endpoint lives under
 * server.js's openPaths list (`/travel/inbound/leads`) so no auth
 * middleware applies.
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

describe('GET /api/travel/inbound/leads/by-quarter — slice 21 quarterly rollup', () => {
  test('no Authorization header → unauthed-family open endpoint (200, not 401)', async () => {
    // The inbound-leads rollup family lives under server.js openPaths
    // — sibling /by-month + /stats + /by-channel are all unauthed. This
    // test pins that posture: a missing Authorization header does NOT
    // trip a 401, just goes straight to the tenantSlug-presence check.
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, rows: [] });
  });

  test('invalid ?from (out-of-range quarter "2026-Q5") → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', from: '2026-Q5' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUARTER_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?from (YYYY-MM not YYYY-Qn) → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', from: '2026-13' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUARTER_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?to (full ISO not YYYY-Qn) → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({
        tenantSlug: 'travel-stall',
        to: '2026-05-25T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUARTER_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('happy path: 3 leads across 2 quarters → 2 rows + counts + bySubBrand', async () => {
    // Two Q2 (Apr/May 2026) + one Q3 (Jul 2026)
    prisma.contact.findMany.mockResolvedValueOnce([
      {
        source: 'inbound:voyagr',
        subBrand: 'tmc',
        createdAt: new Date('2026-04-05T10:00:00.000Z'),
      },
      {
        source: 'inbound:webform',
        subBrand: 'rfu',
        createdAt: new Date('2026-05-20T12:00:00.000Z'),
      },
      {
        source: 'inbound:metaads',
        subBrand: 'tmc',
        createdAt: new Date('2026-07-10T08:00:00.000Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    // Default order: quarter:asc → Q2 first, then Q3.
    const q2 = res.body.rows[0];
    const q3 = res.body.rows[1];
    expect(q2.quarter).toBe('2026-Q2');
    expect(q2.count).toBe(2);
    expect(q2.bySubBrand).toEqual({ tmc: 1, rfu: 1 });
    expect(q2.byChannel.voyagr).toBe(1);
    expect(q2.byChannel.webform).toBe(1);
    expect(q2.byChannel.metaads).toBe(0);

    expect(q3.quarter).toBe('2026-Q3');
    expect(q3.count).toBe(1);
    expect(q3.bySubBrand).toEqual({ tmc: 1 });
    expect(q3.byChannel.metaads).toBe(1);
  });

  test('default orderBy=quarter:asc is chronological across 4 quarters', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-10-05T10:00:00.000Z') }, // Q4
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-01-05T10:00:00.000Z') }, // Q1
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') }, // Q3
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') }, // Q2
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.quarter)).toEqual([
      '2026-Q1',
      '2026-Q2',
      '2026-Q3',
      '2026-Q4',
    ]);
  });

  test('?orderBy=count:desc flips bucket ordering by descending count', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      // 3 in Q1
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-02-10T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-03-20T10:00:00.000Z') },
      // 1 in Q2
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      // 2 in Q3
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') },
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-08-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', orderBy: 'count:desc' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows[0].quarter).toBe('2026-Q1');
    expect(res.body.rows[0].count).toBe(3);
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
    expect(res.body.rows[1].count).toBe(2);
    expect(res.body.rows[2].quarter).toBe('2026-Q2');
    expect(res.body.rows[2].count).toBe(1);
  });

  test('?from / ?to YYYY-Q[1-4] window filters buckets (inclusive)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-01-05T10:00:00.000Z') }, // Q1
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') }, // Q2
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') }, // Q3
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-10-05T10:00:00.000Z') }, // Q4
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', from: '2026-Q2', to: '2026-Q3' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.quarter)).toEqual(['2026-Q2', '2026-Q3']);
  });

  test('sub-brand restriction mirrors /by-month: cross-sub-brand rows NOT filtered', async () => {
    // Pin the posture that this rollup family does NOT narrow by
    // subBrandAccess (unlike /api/travel/itineraries/by-quarter which
    // does). Three rows across three distinct sub-brands; all three
    // counted. The findMany where-clause must NOT carry a `subBrand`
    // narrowing predicate.
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: new Date('2026-04-10T10:00:00.000Z') },
      { source: 'inbound:metaads', subBrand: 'travelstall', createdAt: new Date('2026-04-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].count).toBe(3);
    expect(res.body.rows[0].bySubBrand).toEqual({
      tmc: 1,
      rfu: 1,
      travelstall: 1,
    });
    // findMany.where must NOT carry a subBrand predicate.
    const whereArg = prisma.contact.findMany.mock.calls[0][0].where;
    expect(whereArg.subBrand).toBeUndefined();
    expect(whereArg.tenantId).toBe(42);
  });

  test('null createdAt → "unknown" bucket (no ?from/?to bounds set)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: null },
      { source: 'inbound:metaads', subBrand: null, createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.quarter === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.bySubBrand).toEqual({ rfu: 1, _tenant: 1 });
  });

  test('null createdAt → "unknown" bucket excluded when ?from is set', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', from: '2026-Q1' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows.find((r) => r.quarter === 'unknown')).toBeUndefined();
  });

  test('pagination ?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-01-05T10:00:00.000Z') }, // Q1
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') }, // Q2
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') }, // Q3
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-10-05T10:00:00.000Z') }, // Q4
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', limit: '2', offset: '1' });

    expect(res.status).toBe(200);
    // total reports the pre-pagination bucket count.
    expect(res.body.total).toBe(4);
    // Page slice in default quarter:asc order: skip Q1, take Q2 + Q3.
    expect(res.body.rows.map((r) => r.quarter)).toEqual(['2026-Q2', '2026-Q3']);
  });

  test('falsy subBrand coerces to "_tenant" bucket', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: null, createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: '', createdAt: new Date('2026-04-10T10:00:00.000Z') },
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-04-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].bySubBrand).toEqual({ _tenant: 2, tmc: 1 });
  });

  test('unknown ?orderBy token degrades silently to default quarter:asc', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') }, // Q3
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-01-05T10:00:00.000Z') }, // Q1
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') }, // Q2
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', orderBy: 'something:nonsense' });

    expect(res.status).toBe(200);
    // Silent degrade → default quarter:asc applied.
    expect(res.body.rows.map((r) => r.quarter)).toEqual([
      '2026-Q1',
      '2026-Q2',
      '2026-Q3',
    ]);
  });

  test('missing tenantSlug → 400 MISSING_TENANT_SLUG (no DB call)', async () => {
    const res = await request(makeApp()).get(
      '/api/travel/inbound/leads/by-quarter',
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT_SLUG' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('unknown tenantSlug → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'no-such-tenant' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 400 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 7, vertical: 'wellness' });

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'wellness-tenant' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('?limit out-of-range → 400 INVALID_LIMIT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', limit: '500' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LIMIT' });
  });

  test('invalid ?channel → 400 INVALID_CHANNEL (no DB call)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', channel: 'fax-machine' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CHANNEL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('?channel=metaads narrows findMany source predicate to literal', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-05-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall', channel: 'metaads' });

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.source).toBe('inbound:metaads');
    expect(call.where.tenantId).toBe(42);
    expect(call.where.deletedAt).toBeNull();
  });

  test('500 generic envelope on findMany throw (no stack leak)', async () => {
    prisma.contact.findMany.mockRejectedValueOnce(
      new Error('P1001 cannot reach database'),
    );

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-quarter')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Failed to roll up inbound leads by quarter',
    });
    expect(res.body.error).not.toMatch(/P1001/);
  });
});
