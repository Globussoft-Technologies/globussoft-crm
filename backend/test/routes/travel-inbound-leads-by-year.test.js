// @ts-check
/**
 * Arc 2 #904 slice 22 — GET /api/travel/inbound/leads/by-year contract
 * tests (PRD_TRAVEL_MULTICHANNEL_LEADS §3).
 *
 * Tenant-wide inbound-lead time-series rollup bucketed by UTC YYYY.
 * Completes the inbound-leads rollup triplet (by-month + by-quarter + now
 * by-year; sibling to /stats) — this endpoint is the annual surface that
 * lets the operator dashboard render a year-over-year trend chart (annual
 * finance review, RFU Umrah season-vs-season planning) without summing 4
 * quarter rows client-side.
 *
 * Mirrors the slice-21 /by-quarter pattern EXACTLY — same handler shape,
 * same auth posture (no verifyToken, tenantSlug-scoped, no sub-brand
 * restriction), same JS-side aggregation over a light projection, same
 * per-bucket bySubBrand + byChannel sub-maps, same "unknown" fallback
 * bucket for null/invalid createdAt, same pagination-after-aggregation
 * posture. Only the bucket-key derivation collapses to YYYY (just
 * getUTCFullYear; no Math.floor needed).
 *
 * Contracts asserted
 * ------------------
 *   - Auth gate: route lives under server.js openPaths (`/travel/inbound/leads`),
 *     so happy-path needs no Authorization header. The no-header case goes
 *     straight to the tenantSlug-presence check (not 401).
 *   - 400 INVALID_YEAR_FORMAT on bad ?from (e.g. "2026-Q1", "26", "abcd").
 *   - 400 INVALID_YEAR_FORMAT on bad ?to.
 *   - Happy path: 3 leads across 2 years → 2 year rows + correct counts
 *     + per-bucket bySubBrand breakdown.
 *   - Default orderBy=year:asc chronological.
 *   - ?orderBy=count:desc flips ordering by descending count.
 *   - ?from / ?to YYYY window applied to bucket selection (inclusive).
 *   - ?channel=metaads narrows findMany source predicate to literal.
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from/?to set.
 *   - Pagination ?limit=2&offset=1 slices AFTER aggregation.
 *   - Falsy subBrand coerces to "_tenant" bucket.
 *   - Unknown ?orderBy token degrades silently to default year:asc.
 *
 * Test mount pattern mirrors sibling slice-21 by-quarter test — patch the
 * prisma singleton with vi.fn() BEFORE requiring the router, then drive
 * supertest against the mounted router directly. The endpoint lives under
 * server.js's openPaths list so no auth middleware applies.
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

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue(TRAVEL_TENANT);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.count.mockReset().mockResolvedValue(0);
});

describe('GET /api/travel/inbound/leads/by-year — slice 22 annual rollup', () => {
  test('no Authorization header → unauthed-family open endpoint (200, not 401)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, rows: [] });
  });

  test('invalid ?from (YYYY-Qn not YYYY) → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', from: '2026-Q1' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?from (non-numeric) → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', from: 'abcd' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?to (2-digit year) → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', to: '26' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('happy path: 3 leads across 2 years → 2 rows + counts + bySubBrand', async () => {
    // Two 2026 + one 2027
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
        createdAt: new Date('2027-02-10T08:00:00.000Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    // Default order: year:asc → 2026 first, then 2027.
    const y26 = res.body.rows[0];
    const y27 = res.body.rows[1];
    expect(y26.year).toBe('2026');
    expect(y26.count).toBe(2);
    expect(y26.bySubBrand).toEqual({ tmc: 1, rfu: 1 });
    expect(y26.byChannel.voyagr).toBe(1);
    expect(y26.byChannel.webform).toBe(1);
    expect(y26.byChannel.metaads).toBe(0);

    expect(y27.year).toBe('2027');
    expect(y27.count).toBe(1);
    expect(y27.bySubBrand).toEqual({ tmc: 1 });
    expect(y27.byChannel.metaads).toBe(1);
  });

  test('default orderBy=year:asc is chronological across 4 years', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2027-10-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2025-04-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.year)).toEqual([
      '2024',
      '2025',
      '2026',
      '2027',
    ]);
  });

  test('?orderBy=count:desc flips bucket ordering by descending count', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      // 3 in 2024
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-02-10T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-03-20T10:00:00.000Z') },
      // 1 in 2025
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: new Date('2025-04-05T10:00:00.000Z') },
      // 2 in 2026
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-07-05T10:00:00.000Z') },
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-08-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', orderBy: 'count:desc' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows[0].year).toBe('2024');
    expect(res.body.rows[0].count).toBe(3);
    expect(res.body.rows[1].year).toBe('2026');
    expect(res.body.rows[1].count).toBe(2);
    expect(res.body.rows[2].year).toBe('2025');
    expect(res.body.rows[2].count).toBe(1);
  });

  test('?from / ?to YYYY window filters buckets (inclusive)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2023-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-04-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2025-07-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-10-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', from: '2024', to: '2025' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.year)).toEqual(['2024', '2025']);
  });

  test('?channel=metaads narrows findMany source predicate to literal', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-05-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', channel: 'metaads' });

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.source).toBe('inbound:metaads');
    expect(call.where.tenantId).toBe(42);
    expect(call.where.deletedAt).toBeNull();
  });

  test('null createdAt → "unknown" bucket (no ?from/?to bounds set)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: null },
      { source: 'inbound:metaads', subBrand: null, createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.year === 'unknown');
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
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', from: '2024' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].year).toBe('2026');
    expect(res.body.rows.find((r) => r.year === 'unknown')).toBeUndefined();
  });

  test('pagination ?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2023-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-04-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2025-07-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-10-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', limit: '2', offset: '1' });

    expect(res.status).toBe(200);
    // total reports the pre-pagination bucket count.
    expect(res.body.total).toBe(4);
    // Page slice in default year:asc order: skip 2023, take 2024 + 2025.
    expect(res.body.rows.map((r) => r.year)).toEqual(['2024', '2025']);
  });

  test('falsy subBrand coerces to "_tenant" bucket', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: null, createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: '', createdAt: new Date('2026-04-10T10:00:00.000Z') },
      { source: 'inbound:metaads', subBrand: 'tmc', createdAt: new Date('2026-04-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].bySubBrand).toEqual({ _tenant: 2, tmc: 1 });
  });

  test('unknown ?orderBy token degrades silently to default year:asc', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2027-07-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2024-01-05T10:00:00.000Z') },
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2025-04-05T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', orderBy: 'something:nonsense' });

    expect(res.status).toBe(200);
    // Silent degrade → default year:asc applied.
    expect(res.body.rows.map((r) => r.year)).toEqual([
      '2024',
      '2025',
      '2027',
    ]);
  });

  test('missing tenantSlug → 400 MISSING_TENANT_SLUG (no DB call)', async () => {
    const res = await request(makeApp()).get(
      '/api/travel/inbound/leads/by-year',
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TENANT_SLUG' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('unknown tenantSlug → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'no-such-tenant' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 400 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 7, vertical: 'wellness' });

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'wellness-tenant' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('?limit out-of-range → 400 INVALID_LIMIT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', limit: '500' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LIMIT' });
  });

  test('invalid ?channel → 400 INVALID_CHANNEL (no DB call)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall', channel: 'fax-machine' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CHANNEL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand restriction mirrors /by-quarter: cross-sub-brand rows NOT filtered', async () => {
    // Pin the posture that this rollup family does NOT narrow by
    // subBrandAccess. Three rows across three distinct sub-brands; all
    // three counted. The findMany where-clause must NOT carry a `subBrand`
    // narrowing predicate.
    prisma.contact.findMany.mockResolvedValueOnce([
      { source: 'inbound:voyagr', subBrand: 'tmc', createdAt: new Date('2026-04-05T10:00:00.000Z') },
      { source: 'inbound:webform', subBrand: 'rfu', createdAt: new Date('2026-04-10T10:00:00.000Z') },
      { source: 'inbound:metaads', subBrand: 'travelstall', createdAt: new Date('2026-04-15T10:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
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

  test('500 generic envelope on findMany throw (no stack leak)', async () => {
    prisma.contact.findMany.mockRejectedValueOnce(
      new Error('P1001 cannot reach database'),
    );

    const res = await request(makeApp())
      .get('/api/travel/inbound/leads/by-year')
      .query({ tenantSlug: 'travel-stall' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: 'Failed to roll up inbound leads by year',
    });
    expect(res.body.error).not.toMatch(/P1001/);
  });
});
