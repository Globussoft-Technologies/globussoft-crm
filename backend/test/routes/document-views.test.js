// @ts-check
/**
 * Unit tests for backend/routes/document_views.js — pin the contract of the
 * document-view (read-receipt) tracking surface used by the Quote / Estimate
 * / Contract / Proposal email flows.
 *
 * Why this file exists
 * ────────────────────
 * routes/document_views.js (255 LOC) had ZERO vitest coverage prior to this
 * file. The route owns:
 *
 *   1. POST /create                            — creates a tracking record
 *      with a 48-char crypto-random trackingId; returns the public tracking
 *      URL that the sender embeds in outbound email as an <img> beacon or
 *      anchor href.
 *   2. GET  /track/:trackingId                 — PUBLIC (no auth) — records
 *      the first-open timestamp + viewer IP + user-agent, then returns an
 *      HTML page with a JS beforeunload/pagehide beacon that POSTs duration
 *      back. Mounted via openPaths in server.js — never goes through
 *      verifyToken.
 *   3. POST /track/:trackingId/duration        — PUBLIC (no auth) — beacon
 *      target that accumulates viewing-duration across multiple opens
 *      (validates 0 ≤ duration ≤ 86400 seconds).
 *   4. GET  /                                  — list (tenant-scoped,
 *      filterable by documentType / documentId).
 *   5. GET  /document/:type/:id                — per-document detail with a
 *      computed summary envelope (totalRecipients, totalViews,
 *      uniqueViewers, firstViewedAt, lastViewedAt, totalDuration, viewers[]).
 *   6. GET  /stats                             — tenant-wide aggregate KPI
 *      envelope (documentsTracked, totalRecipients, totalViews,
 *      uniqueViewers, avgViewDuration).
 *
 * Silent contract drift on these would break the Quote/Estimate "X recipients
 * opened" indicators on the document tracking dashboard. Pin the wire shape
 * now.
 *
 * Cases (15 total)
 * ────────────────
 *   create: 400 invalid documentType, 400 missing documentId, 201 happy
 *     with trackingUrl shape + tenantId stamp from JWT (3)
 *   public GET /track/:id: 404 unknown trackingId returns HTML 404,
 *     200 first-view stamps viewedAt+ip+ua, 200 subsequent view does NOT
 *     re-stamp viewedAt (3)
 *   public POST /track/:id/duration: 400 negative duration, 400 over-24h
 *     duration, 404 unknown trackingId, 200 accumulates with prior duration (4)
 *   list: tenant-scoped + filter by documentType + filter by documentId (1)
 *   document detail: 400 invalid type, 200 summary envelope shape, tenant
 *     isolation via where-clause (3)
 *   stats: returns 5-field envelope with avgViewDuration rounded (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — prisma singleton monkey-patch
 * BEFORE requiring the router. The route doesn't pull verifyToken itself
 * (the global guard does for the authenticated paths; public paths sit in
 * server.js openPaths). We install a fake-auth middleware in makeApp that
 * populates req.user, but the /track/* handlers ignore it (and the global
 * guard is never wired into our test app, so the public-handlers test what
 * they're documented to do — read the trackingId, write the receipt).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.documentView = prisma.documentView || {};
prisma.documentView.findUnique = vi.fn();
prisma.documentView.findMany = vi.fn();
prisma.documentView.create = vi.fn();
prisma.documentView.update = vi.fn();
// eventBus's best-effort emit may walk automationRule.findMany — stub for safety.
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── eventBus stubs ─────────────────────────────────────────────────────
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const documentViewsRouter = requireCJS('../../routes/document_views');

/**
 * Build an express app with a fake-auth middleware so the authenticated
 * routes see req.user. Public /track/* handlers ignore req.user.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'USER' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/document-views', documentViewsRouter);
  return app;
}

beforeEach(() => {
  prisma.documentView.findUnique.mockReset();
  prisma.documentView.findMany.mockReset();
  prisma.documentView.create.mockReset();
  prisma.documentView.update.mockReset();

  // Sensible defaults — individual tests override.
  prisma.documentView.findUnique.mockResolvedValue(null);
  prisma.documentView.findMany.mockResolvedValue([]);
  prisma.documentView.create.mockResolvedValue({ id: 1 });
  prisma.documentView.update.mockResolvedValue({ id: 1 });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create — create a tracking record
// ─────────────────────────────────────────────────────────────────────────

describe('POST /create — create tracking record', () => {
  test('400 when documentType is not in [Quote, Estimate, Contract, Proposal]', async () => {
    const res = await request(makeApp())
      .post('/api/document-views/create')
      .send({ documentType: 'Invoice', documentId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentType must be one of/i);
    expect(prisma.documentView.create).not.toHaveBeenCalled();
  });

  test('400 when documentId is missing / not a positive integer', async () => {
    const res = await request(makeApp())
      .post('/api/document-views/create')
      .send({ documentType: 'Quote' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentId is required/i);
    expect(prisma.documentView.create).not.toHaveBeenCalled();
  });

  test('201 happy path: returns { id, trackingId, trackingUrl } and stamps tenantId from JWT', async () => {
    prisma.documentView.create.mockResolvedValue({ id: 99 });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/document-views/create')
      .send({ documentType: 'Quote', documentId: 7, viewerEmail: 'a@b.com' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    expect(typeof res.body.trackingId).toBe('string');
    expect(res.body.trackingId).toHaveLength(48); // 24 bytes hex = 48 chars
    expect(res.body.trackingUrl).toMatch(
      /\/api\/document-views\/track\/[a-f0-9]{48}$/,
    );

    expect(prisma.documentView.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.documentView.create.mock.calls[0][0].data;
    expect(createArg.tenantId).toBe(42);
    expect(createArg.documentType).toBe('Quote');
    expect(createArg.documentId).toBe(7);
    expect(createArg.viewerEmail).toBe('a@b.com');
    expect(createArg.viewedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /track/:trackingId — public read-receipt endpoint (HTML response)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /track/:trackingId — public read-receipt', () => {
  test('404 with HTML body when trackingId is unknown', async () => {
    prisma.documentView.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/document-views/track/deadbeef');

    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Document not found/i);
    expect(prisma.documentView.update).not.toHaveBeenCalled();
  });

  test('200 first view: stamps viewedAt + ipAddress + userAgent', async () => {
    prisma.documentView.findUnique.mockResolvedValue({
      id: 50,
      trackingId: 'tid-first',
      viewedAt: null,
    });

    const res = await request(makeApp())
      .get('/api/document-views/track/tid-first')
      .set('User-Agent', 'Mozilla/5.0 (vitest)')
      .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/Loading document/i);

    expect(prisma.documentView.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.documentView.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 50 });
    expect(updateArg.data.viewedAt).toBeInstanceOf(Date);
    // first hop of XFF should win
    expect(updateArg.data.ipAddress).toBe('203.0.113.7');
    expect(updateArg.data.userAgent).toBe('Mozilla/5.0 (vitest)');
  });

  test('200 subsequent view: does NOT overwrite the existing viewedAt (only first view stamps)', async () => {
    const firstSeen = new Date('2026-05-01T10:00:00Z');
    prisma.documentView.findUnique.mockResolvedValue({
      id: 50,
      trackingId: 'tid-second',
      viewedAt: firstSeen, // already opened earlier
    });

    const res = await request(makeApp())
      .get('/api/document-views/track/tid-second');

    expect(res.status).toBe(200);
    // Critical: NO update call should happen on the re-open.
    expect(prisma.documentView.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /track/:trackingId/duration — beacon target for viewing duration
// ─────────────────────────────────────────────────────────────────────────

describe('POST /track/:trackingId/duration — duration beacon', () => {
  test('400 when duration is negative', async () => {
    const res = await request(makeApp())
      .post('/api/document-views/track/tid-x/duration')
      .send({ duration: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid duration/i);
    expect(prisma.documentView.update).not.toHaveBeenCalled();
  });

  test('400 when duration exceeds 24-hour cap (86400 seconds)', async () => {
    const res = await request(makeApp())
      .post('/api/document-views/track/tid-x/duration')
      .send({ duration: 86401 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid duration/i);
    expect(prisma.documentView.update).not.toHaveBeenCalled();
  });

  test('404 when trackingId is unknown', async () => {
    prisma.documentView.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/document-views/track/no-such-tid/duration')
      .send({ duration: 30 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tracking id not found/i);
    expect(prisma.documentView.update).not.toHaveBeenCalled();
  });

  test('200 accumulates new duration with prior duration (sums across multiple beacons)', async () => {
    prisma.documentView.findUnique.mockResolvedValue({
      id: 50,
      trackingId: 'tid-accum',
      duration: 15, // prior accumulated
    });
    prisma.documentView.update.mockResolvedValue({ id: 50, duration: 45 });

    const res = await request(makeApp())
      .post('/api/document-views/track/tid-accum/duration')
      .send({ duration: 30 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, duration: 45 });
    expect(prisma.documentView.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { duration: 45 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list views (tenant-scoped, filterable)
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list views', () => {
  test('200 tenant-scoped + honors documentType + documentId filters', async () => {
    prisma.documentView.findMany.mockResolvedValue([
      { id: 1, documentType: 'Quote', documentId: 7, tenantId: 42 },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-views?documentType=Quote&documentId=7');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.documentView.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, documentType: 'Quote', documentId: 7 },
      orderBy: { createdAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /document/:type/:id — per-document detail with summary envelope
// ─────────────────────────────────────────────────────────────────────────

describe('GET /document/:type/:id — per-document detail', () => {
  test('400 when :type is not in VALID_TYPES', async () => {
    const res = await request(makeApp())
      .get('/api/document-views/document/Invoice/1');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid document type/i);
    expect(prisma.documentView.findMany).not.toHaveBeenCalled();
  });

  test('200 returns { summary, views } envelope with computed aggregates', async () => {
    const earlier = new Date('2026-05-01T10:00:00Z');
    const later = new Date('2026-05-02T11:00:00Z');
    prisma.documentView.findMany.mockResolvedValue([
      // 3 recipients; 2 opened (one shared email); 1 unopened
      { id: 1, viewerEmail: 'a@b.com', viewedAt: earlier, duration: 30, ipAddress: '1.1.1.1', userAgent: 'ua1' },
      { id: 2, viewerEmail: 'a@b.com', viewedAt: later, duration: 60, ipAddress: '1.1.1.2', userAgent: 'ua2' }, // dup email
      { id: 3, viewerEmail: 'c@d.com', viewedAt: null,  duration: null, ipAddress: null, userAgent: null }, // unopened
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-views/document/Quote/7');

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      documentType: 'Quote',
      documentId: 7,
      totalRecipients: 3,
      totalViews: 2,
      uniqueViewers: 1, // a@b.com dedup
      totalDuration: 90, // 30 + 60
    });
    expect(res.body.summary.firstViewedAt).toBe(earlier.toISOString());
    expect(res.body.summary.lastViewedAt).toBe(later.toISOString());
    expect(res.body.summary.viewers).toHaveLength(2);

    // Tenant scoping pinned.
    expect(prisma.documentView.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, documentType: 'Quote', documentId: 7 },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('tenant isolation: cross-tenant requests pass tenantId from JWT into where-clause', async () => {
    prisma.documentView.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 99 }))
      .get('/api/document-views/document/Quote/7');

    expect(res.status).toBe(200);
    expect(res.body.summary.totalRecipients).toBe(0);
    // The route never reads tenantId from query/body — only from req.user.
    expect(prisma.documentView.findMany.mock.calls[0][0].where.tenantId).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (slice 50 of arc-3 #920)
// ─────────────────────────────────────────────────────────────────────────
// Additive opt-in: legacy callers (no ?fields, or any non-"summary" value)
// continue to receive the full row shape unchanged. ?fields=summary swaps in
// a slim Prisma select that drops the heavy ipAddress + userAgent text columns
// from the wire payload, useful for list dashboards that only show
// open-status + duration + viewer-email and don't need forensic IP/UA metadata.
//
// Cases (5 total):
//   1. no ?fields → no `select` key (full-row shape preserved — back-compat)
//   2. ?fields=summary → exact-key slim `select` shape pinned
//   3. ?fields=summary preserves tenant + documentType + documentId filters
//   4. ?fields=other (any non-exact value) → treated as full-row (back-compat)
//   5. ?fields=summary on empty result still returns [] (no crash on slim path)

describe('GET /?fields=summary — slim-shape opt-in', () => {
  test('no ?fields → findMany called WITHOUT a select key (full-row preserved)', async () => {
    prisma.documentView.findMany.mockResolvedValue([
      { id: 1, documentType: 'Quote', documentId: 7, ipAddress: '1.1.1.1', userAgent: 'ua' },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-views');

    expect(res.status).toBe(200);
    const arg = prisma.documentView.findMany.mock.calls[0][0];
    expect(arg.select).toBeUndefined();
    expect(arg).toEqual({
      where: { tenantId: 42 },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('?fields=summary → findMany called with exact slim-shape select keys', async () => {
    prisma.documentView.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-views?fields=summary');

    expect(res.status).toBe(200);
    const arg = prisma.documentView.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      documentType: true,
      documentId: true,
      trackingId: true,
      viewerEmail: true,
      viewedAt: true,
      duration: true,
      createdAt: true,
    });
    // Heavy forensic columns explicitly NOT in the slim shape.
    expect(arg.select.ipAddress).toBeUndefined();
    expect(arg.select.userAgent).toBeUndefined();
  });

  test('?fields=summary preserves tenant + documentType + documentId filter where-clause', async () => {
    prisma.documentView.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-views?fields=summary&documentType=Quote&documentId=7');

    expect(res.status).toBe(200);
    const arg = prisma.documentView.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 42, documentType: 'Quote', documentId: 7 });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.select).toBeDefined();
  });

  test('?fields=other (any non-"summary" value) → treated as full-row (back-compat for typos)', async () => {
    prisma.documentView.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-views?fields=full');

    expect(res.status).toBe(200);
    const arg = prisma.documentView.findMany.mock.calls[0][0];
    expect(arg.select).toBeUndefined();
  });

  test('?fields=summary on empty-result tenant still returns [] (no crash on slim path)', async () => {
    prisma.documentView.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 99 }))
      .get('/api/document-views?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /stats — tenant-wide KPI summary
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stats — tenant-wide aggregates', () => {
  test('200 returns 5-field envelope with avgViewDuration rounded to int', async () => {
    prisma.documentView.findMany.mockResolvedValue([
      // 3 distinct (type, id) pairs; 4 recipients; 3 opened; 2 unique viewers
      { documentType: 'Quote',    documentId: 1, viewerEmail: 'a@b.com', viewedAt: new Date(), duration: 10 },
      { documentType: 'Quote',    documentId: 1, viewerEmail: 'c@d.com', viewedAt: new Date(), duration: 20 },
      { documentType: 'Estimate', documentId: 5, viewerEmail: 'a@b.com', viewedAt: new Date(), duration: 35 },
      { documentType: 'Contract', documentId: 9, viewerEmail: 'a@b.com', viewedAt: null,        duration: null },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/document-views/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      documentsTracked: 3, // 3 unique (type,id) keys
      totalRecipients: 4,
      totalViews: 3, // 3 had a viewedAt
      uniqueViewers: 2, // a@b.com + c@d.com
      avgViewDuration: 22, // round((10 + 20 + 35) / 3) = 22
    });
    expect(prisma.documentView.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      select: {
        documentType: true,
        documentId: true,
        viewerEmail: true,
        viewedAt: true,
        duration: true,
      },
    });
  });
});
