// @ts-check
/**
 * Unit tests for backend/routes/attribution.js — pin the Marketing
 * Attribution contract (Touchpoint capture + report aggregation + first-touch
 * and multi-touch revenue + voyagr (OJR) sub-brand summary).
 *
 * What this file pins
 * ───────────────────
 *   1. POST /track happy path: creates a Touchpoint, updates Contact.lastTouchSource,
 *      sets Contact.firstTouchSource only when previously null.
 *   2. POST /track validation: missing contactId or channel → 400.
 *   3. POST /track tenant isolation: cross-tenant contactId → 404 (the
 *      contact.findFirst is scoped by tenantId — never 201).
 *   4. GET /contact/:id happy path: returns { contact, touchpoints }
 *      sorted ascending by timestamp; 404 when cross-tenant.
 *   5. GET /report aggregates touchpoints by channel + source with deal
 *      revenue attached via won-deal contactId join; deterministic sort
 *      by deals desc then contacts desc.
 *   6. GET /report drops junk sources (#268 — test-skip / e2e-* / qa-* /
 *      rbac-*) from BOTH the bySource AND byChannel surfaces (the route
 *      filters at the touchpoint level — if a touchpoint's source is
 *      junk, the row drops entirely, taking its channel bucket with it).
 *   7. GET /report rejects inverted ?from=...&to=... (to < from) with
 *      400 + code=INVERTED_DATE_RANGE (#665).
 *   8. GET /first-touch-revenue attributes each won deal's revenue to
 *      its contact's firstTouchSource; totalRevenue still includes deals
 *      whose source is junk OR null (real revenue), but those deals do
 *      NOT get bucketed against a source row.
 *   9. GET /multi-touch-revenue splits each won deal's amount equally
 *      across the contact's unique source set (linear model). A contact
 *      with no touchpoints gets bucketed under 'unknown'.
 *  10. GET /voyagr/summary auth gate: ADMIN passes, USER → 403 RBAC_DENIED.
 *  11. GET /voyagr/summary days param validation: non-integer / <1 / >365
 *      / non-finite all return 400 + code=INVALID_DAYS.
 *  12. GET /voyagr/summary happy path: returns the envelope shape
 *      { windowDays, totalLeads, bySubBrand[], byUtmSource[], byChannel[],
 *      bySiteSlug:[] } with junk sources filtered from byUtmSource.
 *
 * Pattern reference
 * ─────────────────
 *   Mirrors backend/test/routes/pos-cashLedger.test.js — prisma singleton
 *   monkey-patch BEFORE requiring the router, supertest with a fake
 *   auth middleware that sets req.user. The router's verifyRole gate
 *   on /voyagr/summary is exercised end-to-end (not stubbed).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router. attribution.js
// touches contact + touchpoint + deal models.
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.update = vi.fn();
prisma.touchpoint = prisma.touchpoint || {};
prisma.touchpoint.create = vi.fn();
prisma.touchpoint.findMany = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const attributionRouter = requireCJS('../../routes/attribution');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  withUser = true,
} = {}) {
  const app = express();
  app.use(express.json());
  if (withUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/attribution', attributionRouter);
  return app;
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.update.mockReset();
  prisma.touchpoint.create.mockReset();
  prisma.touchpoint.findMany.mockReset();
  prisma.deal.findMany.mockReset();
});

// ── POST /track ────────────────────────────────────────────────────────

describe('POST /api/attribution/track', () => {
  test('happy path: creates touchpoint, updates lastTouchSource + firstTouchSource when previously null', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      firstTouchSource: null,
      lastTouchSource: null,
    });
    prisma.touchpoint.create.mockResolvedValue({
      id: 7,
      contactId: 42,
      channel: 'web',
      source: 'google',
      tenantId: 1,
    });
    prisma.contact.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/attribution/track')
      .send({ contactId: 42, channel: 'web', source: 'google' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 7, channel: 'web', source: 'google' });
    expect(prisma.touchpoint.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactId: 42,
          channel: 'web',
          source: 'google',
          tenantId: 1,
        }),
      })
    );
    // firstTouch + lastTouch both set on first-ever touch.
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lastTouchSource: 'google', firstTouchSource: 'google' },
    });
  });

  test('happy path: does NOT overwrite firstTouchSource when already populated', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      firstTouchSource: 'organic',
      lastTouchSource: 'organic',
    });
    prisma.touchpoint.create.mockResolvedValue({ id: 8 });
    prisma.contact.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/attribution/track')
      .send({ contactId: 42, channel: 'web', source: 'paid-search' });

    expect(res.status).toBe(201);
    // lastTouchSource updates; firstTouchSource is NOT in the update payload.
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lastTouchSource: 'paid-search' },
    });
  });

  test('falls back to channel when source omitted (sourceLabel = channel)', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      firstTouchSource: null,
    });
    prisma.touchpoint.create.mockResolvedValue({ id: 9 });
    prisma.contact.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/attribution/track')
      .send({ contactId: 42, channel: 'whatsapp' });

    expect(res.status).toBe(201);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { lastTouchSource: 'whatsapp', firstTouchSource: 'whatsapp' },
    });
  });

  test('missing contactId returns 400', async () => {
    const res = await request(makeApp())
      .post('/api/attribution/track')
      .send({ channel: 'web' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactId/);
    expect(prisma.touchpoint.create).not.toHaveBeenCalled();
  });

  test('missing channel returns 400', async () => {
    const res = await request(makeApp())
      .post('/api/attribution/track')
      .send({ contactId: 42 });
    expect(res.status).toBe(400);
    expect(prisma.touchpoint.create).not.toHaveBeenCalled();
  });

  test('cross-tenant contactId returns 404 (tenant isolation)', async () => {
    // contact.findFirst is tenant-scoped → returns null for foreign-tenant row.
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 9 }))
      .post('/api/attribution/track')
      .send({ contactId: 42, channel: 'web', source: 'google' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.touchpoint.create).not.toHaveBeenCalled();
  });

  test('500 on Prisma blow-up (defensive try/catch)', async () => {
    prisma.contact.findFirst.mockRejectedValue(new Error('boom'));
    const res = await request(makeApp())
      .post('/api/attribution/track')
      .send({ contactId: 42, channel: 'web' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

// ── GET /contact/:id ───────────────────────────────────────────────────

describe('GET /api/attribution/contact/:id', () => {
  test('happy path returns { contact, touchpoints }', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 42,
      name: 'Alice',
      email: 'alice@example.com',
      firstTouchSource: 'organic',
      lastTouchSource: 'paid-search',
    });
    prisma.touchpoint.findMany.mockResolvedValue([
      { id: 1, channel: 'web', source: 'organic', timestamp: '2026-01-01T00:00:00Z' },
      { id: 2, channel: 'web', source: 'paid-search', timestamp: '2026-02-01T00:00:00Z' },
    ]);

    const res = await request(makeApp())
      .get('/api/attribution/contact/42');

    expect(res.status).toBe(200);
    expect(res.body.contact).toMatchObject({ id: 42, name: 'Alice' });
    expect(res.body.touchpoints).toHaveLength(2);
    // Ordering pinned at the prisma call site.
    expect(prisma.touchpoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId: 42, tenantId: 1 },
        orderBy: { timestamp: 'asc' },
      })
    );
  });

  test('cross-tenant contactId returns 404', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 9 })).get('/api/attribution/contact/42');
    expect(res.status).toBe(404);
    expect(prisma.touchpoint.findMany).not.toHaveBeenCalled();
  });
});

// ── GET /report ────────────────────────────────────────────────────────

describe('GET /api/attribution/report', () => {
  test('aggregates touchpoints by channel + source with won-deal revenue attribution', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { id: 1, contactId: 10, channel: 'web', source: 'google' },
      { id: 2, contactId: 10, channel: 'web', source: 'google' },
      { id: 3, contactId: 11, channel: 'whatsapp', source: 'campaign-a' },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { id: 100, contactId: 10, amount: 50000 },
      { id: 101, contactId: 11, amount: 25000 },
    ]);

    const res = await request(makeApp()).get('/api/attribution/report');

    expect(res.status).toBe(200);
    expect(res.body.byChannel).toBeInstanceOf(Array);
    expect(res.body.bySource).toBeInstanceOf(Array);

    const webChannel = res.body.byChannel.find((e) => e.channel === 'web');
    expect(webChannel).toMatchObject({
      touchpoints: 2,
      contacts: 1, // dedup by contactId
      deals: 1,
      revenue: 50000,
    });
    const waChannel = res.body.byChannel.find((e) => e.channel === 'whatsapp');
    expect(waChannel).toMatchObject({
      touchpoints: 1,
      contacts: 1,
      deals: 1,
      revenue: 25000,
    });

    const googleSrc = res.body.bySource.find((e) => e.source === 'google');
    expect(googleSrc).toMatchObject({
      touchpoints: 2,
      contacts: 1,
      deals: 1,
      revenue: 50000,
    });
  });

  test('drops junk sources from #268 list (test-skip / e2e-* / qa-* / rbac-*)', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([
      { id: 1, contactId: 10, channel: 'web', source: 'google' },          // keep
      { id: 2, contactId: 11, channel: 'web', source: 'test-skip' },       // drop
      { id: 3, contactId: 12, channel: 'web', source: 'e2e-flow-1' },      // drop
      { id: 4, contactId: 13, channel: 'web', source: 'qa-bot' },          // drop
      { id: 5, contactId: 14, channel: 'web', source: 'rbac-helper' },     // drop
    ]);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/report');

    expect(res.status).toBe(200);
    // bySource should ONLY contain google.
    const sources = res.body.bySource.map((e) => e.source);
    expect(sources).toEqual(['google']);
    // byChannel: the junk-source rows drop entirely (the route filters at
    // the touchpoint level, not the per-bucket level), so 'web' only shows
    // the 1 surviving touchpoint.
    const web = res.body.byChannel.find((e) => e.channel === 'web');
    expect(web.touchpoints).toBe(1);
    expect(web.contacts).toBe(1);
  });

  test('rejects inverted ?from=...&to=... with 400 INVERTED_DATE_RANGE (#665)', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/report?from=2026-12-01&to=2026-01-01');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVERTED_DATE_RANGE' });
    // Should reject BEFORE touching the DB.
    expect(prisma.touchpoint.findMany).not.toHaveBeenCalled();
  });

  test('valid ?from=...&to=... applies a timestamp window to the prisma where clause', async () => {
    prisma.touchpoint.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/attribution/report?from=2026-01-01&to=2026-02-01');
    expect(res.status).toBe(200);
    const callArgs = prisma.touchpoint.findMany.mock.calls[0][0];
    expect(callArgs.where.tenantId).toBe(1);
    expect(callArgs.where.timestamp).toBeDefined();
    expect(callArgs.where.timestamp.gte).toBeInstanceOf(Date);
    expect(callArgs.where.timestamp.lte).toBeInstanceOf(Date);
  });

  test('500 on Prisma blow-up (defensive try/catch)', async () => {
    prisma.touchpoint.findMany.mockRejectedValue(new Error('boom'));
    const res = await request(makeApp()).get('/api/attribution/report');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

// ── GET /first-touch-revenue ───────────────────────────────────────────

describe('GET /api/attribution/first-touch-revenue', () => {
  test('attributes won-deal revenue to each contact firstTouchSource', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 100, contactId: 10, amount: 50000 },
      { id: 101, contactId: 11, amount: 25000 },
      { id: 102, contactId: 12, amount: 100000 },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 10, firstTouchSource: 'google' },
      { id: 11, firstTouchSource: 'whatsapp' },
      { id: 12, firstTouchSource: 'google' },
    ]);

    const res = await request(makeApp()).get('/api/attribution/first-touch-revenue');

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('first-touch');
    expect(res.body.totalRevenue).toBe(175000);
    expect(res.body.attributedRevenue).toBe(175000);
    // bySource sorted by revenue desc.
    expect(res.body.bySource[0]).toMatchObject({
      source: 'google',
      deals: 2,
      revenue: 150000,
    });
    expect(res.body.bySource[1]).toMatchObject({
      source: 'whatsapp',
      deals: 1,
      revenue: 25000,
    });
  });

  test('junk-source contacts still count in totalRevenue but are NOT bucketed', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 100, contactId: 10, amount: 50000 },  // real source
      { id: 101, contactId: 11, amount: 99999 },  // junk source
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 10, firstTouchSource: 'google' },
      { id: 11, firstTouchSource: 'test-skip' },
    ]);

    const res = await request(makeApp()).get('/api/attribution/first-touch-revenue');

    expect(res.status).toBe(200);
    // totalRevenue counts the junk-source deal (it's real revenue).
    expect(res.body.totalRevenue).toBe(50000 + 99999);
    // attributedRevenue EXCLUDES the junk-source deal (skipped before bucketing).
    expect(res.body.attributedRevenue).toBe(50000);
    expect(res.body.bySource).toHaveLength(1);
    expect(res.body.bySource[0].source).toBe('google');
  });

  test('zero won-deals → empty bySource + zero totals', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/attribution/first-touch-revenue');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      model: 'first-touch',
      totalRevenue: 0,
      attributedRevenue: 0,
      bySource: [],
    });
  });
});

// ── GET /multi-touch-revenue ───────────────────────────────────────────

describe('GET /api/attribution/multi-touch-revenue', () => {
  test('splits won-deal revenue equally across unique sources per contact (linear)', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 100, contactId: 10, amount: 100000 },
    ]);
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 10, source: 'google', channel: 'web' },
      { contactId: 10, source: 'whatsapp', channel: 'whatsapp' },
      { contactId: 10, source: 'google', channel: 'web' }, // dup — still 2 unique sources
    ]);

    const res = await request(makeApp()).get('/api/attribution/multi-touch-revenue');

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('multi-touch-linear');
    expect(res.body.totalRevenue).toBe(100000);
    expect(res.body.attributedRevenue).toBe(100000);
    // 100k split across 2 unique sources → 50k each.
    const google = res.body.bySource.find((e) => e.source === 'google');
    const wa = res.body.bySource.find((e) => e.source === 'whatsapp');
    expect(google.revenue).toBe(50000);
    expect(wa.revenue).toBe(50000);
  });

  test('contact with no touchpoints → revenue goes to unknown bucket', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 100, contactId: 10, amount: 75000 },
    ]);
    prisma.touchpoint.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/attribution/multi-touch-revenue');

    expect(res.status).toBe(200);
    expect(res.body.bySource).toEqual([{ source: 'unknown', deals: 1, revenue: 75000 }]);
    expect(res.body.attributedRevenue).toBe(75000);
  });

  test('junk-source touchpoints are dropped from the denominator', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 100, contactId: 10, amount: 60000 },
    ]);
    prisma.touchpoint.findMany.mockResolvedValue([
      { contactId: 10, source: 'google', channel: 'web' },     // keep
      { contactId: 10, source: 'test-skip', channel: 'web' },  // junk — drop
      { contactId: 10, source: 'e2e-bot', channel: 'web' },    // junk — drop
    ]);

    const res = await request(makeApp()).get('/api/attribution/multi-touch-revenue');

    expect(res.status).toBe(200);
    // Only 'google' remains as unique source → 100% of revenue.
    expect(res.body.bySource).toHaveLength(1);
    expect(res.body.bySource[0]).toMatchObject({ source: 'google', revenue: 60000 });
  });
});

// ── GET /voyagr/summary — auth + days validation + happy path ──────────

describe('GET /api/attribution/voyagr/summary — auth gate (verifyRole ADMIN/MANAGER)', () => {
  test('ADMIN gets 200', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.touchpoint.findMany.mockResolvedValue([]);
    const res = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/attribution/voyagr/summary');
    expect(res.status).toBe(200);
  });

  test('MANAGER gets 200', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.touchpoint.findMany.mockResolvedValue([]);
    const res = await request(makeApp({ role: 'MANAGER' }))
      .get('/api/attribution/voyagr/summary');
    expect(res.status).toBe(200);
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .get('/api/attribution/voyagr/summary');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    // Should never query.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('missing req.user (no JWT) → 403 RBAC_DENIED', async () => {
    // verifyRole short-circuits when !req.user even without a verifyToken
    // mounted. In production verifyToken runs first and 401s; here we
    // pin the verifyRole-internal fallback.
    const res = await request(makeApp({ withUser: false }))
      .get('/api/attribution/voyagr/summary');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
  });
});

describe('GET /api/attribution/voyagr/summary — days param validation', () => {
  test('days=0 → 400 INVALID_DAYS', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary?days=0');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAYS' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('days=366 → 400 INVALID_DAYS (upper bound)', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary?days=366');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAYS' });
  });

  test('days=garbage → 400 INVALID_DAYS', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary?days=abc');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAYS' });
  });

  test('days=7.5 → 400 INVALID_DAYS (must be integer)', async () => {
    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary?days=7.5');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DAYS' });
  });

  test('days param absent → defaults to 30', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.touchpoint.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
  });
});

describe('GET /api/attribution/voyagr/summary — happy path envelope', () => {
  test('zero leads → all-empty envelope with bySiteSlug placeholder', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.touchpoint.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary?days=14');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      windowDays: 14,
      totalLeads: 0,
      bySubBrand: [],
      byUtmSource: [],
      byChannel: [],
      bySiteSlug: [],
    });
  });

  test('happy path: aggregates voyagr-sourced contacts by sub-brand + utmSource + channel; bySiteSlug placeholder always []', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 10, subBrand: 'tmc' },
      { id: 11, subBrand: 'rfu' },
      { id: 12, subBrand: 'tmc' },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { contactId: 10, subBrand: 'tmc', amount: 50000, stage: 'won' },
      { contactId: 11, subBrand: 'rfu', amount: 25000, stage: 'open' },
    ]);
    prisma.touchpoint.findMany.mockResolvedValue([
      { source: 'google', channel: 'web', medium: 'cpc' },
      { source: 'google', channel: 'web', medium: 'cpc' },
      { source: 'whatsapp-cta', channel: 'web', medium: 'social' },
      { source: 'test-skip', channel: 'web', medium: null },  // junk — dropped from byUtmSource
    ]);

    const res = await request(makeApp())
      .get('/api/attribution/voyagr/summary?days=30');

    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.totalLeads).toBe(3);

    // bySubBrand: tmc has 2 contacts + 1 won deal of 50000, rfu has 1 contact + 1 open deal.
    const tmc = res.body.bySubBrand.find((e) => e.subBrand === 'tmc');
    expect(tmc).toMatchObject({ count: 2, deals: 1, wonValue: 50000 });
    const rfu = res.body.bySubBrand.find((e) => e.subBrand === 'rfu');
    expect(rfu).toMatchObject({ count: 1, deals: 1, wonValue: 0 });

    // byUtmSource: junk source filtered out.
    const sources = res.body.byUtmSource.map((e) => e.utmSource);
    expect(sources).toContain('google');
    expect(sources).toContain('whatsapp-cta');
    expect(sources).not.toContain('test-skip');
    const googleSrc = res.body.byUtmSource.find((e) => e.utmSource === 'google');
    expect(googleSrc.count).toBe(2);

    // byChannel: 'web' counts ALL 4 touchpoints — channel bucketing happens
    // AFTER the junk-source guard in the route, but the guard's `continue`
    // skips the channel increment too. So 'web' = 3 (the 3 non-junk rows).
    const web = res.body.byChannel.find((e) => e.channel === 'web');
    expect(web.count).toBe(3);

    // bySiteSlug always []
    expect(res.body.bySiteSlug).toEqual([]);
  });

  test('scopes prisma queries by tenantId from req.user (tenant isolation)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.touchpoint.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 9 }))
      .get('/api/attribution/voyagr/summary');

    // Contact query MUST scope by tenantId=9.
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 9, source: 'voyagr' }),
      })
    );
  });
});
