// @ts-check
/**
 * Unit tests for backend/routes/web_visitors.js — pins the anonymous-visitor
 * tracking + identify + tenant-scoped stats/list/detail surface that powers
 * the Marketing → Web Visitors admin page and the embed-widget JS that POSTs
 * `/api/web-visitors/track` from a tenant's landing-page.
 *
 * Why this file exists
 * ────────────────────
 *   routes/web_visitors.js is a 226-LOC two-tier module:
 *     1. PUBLIC capture — POST /track + POST /identify. Both are open in
 *        server.js's openPaths (see server.js:560 — `/web-visitors/track`).
 *        The embed widget cannot mint a JWT, so it has to be reachable
 *        without auth.
 *     2. AUTHENTICATED reads — GET /stats, GET /, GET /:id are tenant-scoped
 *        by req.user.tenantId.
 *
 * The #646 cross-tenant ESLint allowlist angle
 * ────────────────────────────────────────────
 *   This route is one of the canonical `#646` cases. The embed widget POSTs
 *   from a tenant's website carrying that tenant's id in the body — but the
 *   global `stripDangerous` middleware deletes `req.body.tenantId` to prevent
 *   cross-tenant writes. The fix (per #646 sweep): the body uses a non-stripped
 *   parameter name `siteTenantId`, parsed by getSiteTenantId() at routes/
 *   web_visitors.js:15. Missing `siteTenantId` → 400 INVALID_INPUT (no silent
 *   fallback to tenantId=1). Without this contract, a misconfigured widget
 *   would dump anonymous visitors into tenant 1, polluting the demo seed
 *   tenant with arbitrary internet traffic.
 *
 *   On `/identify` (which IS gated by the global auth guard because it's
 *   NOT in openPaths), req.user.tenantId is the authoritative tenant; body
 *   siteTenantId only acts as a soft fallback for legacy pre-tenant visitors.
 *
 * Tenant-isolation angle
 * ──────────────────────
 *   /stats, /, and /:id all scope by req.user.tenantId. /:id uses findFirst
 *   with `{ id, tenantId }` so a cross-tenant id read returns 404 (not 200
 *   with a different tenant's row). The list endpoint hydrates contact info
 *   via prisma.contact.findMany scoped by the SAME tenantId — so identified
 *   visitors from a leaked sessionId can't pull in another tenant's contact.
 *
 * What this file pins
 * ───────────────────
 *   PUBLIC track
 *    1. POST /track requires sessionId → 400 otherwise.
 *    2. POST /track requires siteTenantId (#646 fallback) → 400 INVALID_INPUT
 *       when missing or non-positive — NO silent fallback to tenantId=1.
 *    3. POST /track creates a new WebVisitor when sessionId is unseen,
 *       persisting `pages` as a JSON-stringified array with the first entry.
 *    4. POST /track on an existing sessionId appends to `pages` and updates
 *       lastSeen — does NOT create a duplicate row.
 *    5. POST /track caps `pages` to the last 200 entries to avoid runaway
 *       growth on long-lived sessions.
 *
 *   PUBLIC identify
 *    6. POST /identify requires sessionId + email → 400 otherwise.
 *    7. POST /identify 404s when the sessionId doesn't exist.
 *    8. POST /identify on an unknown email returns `{identified: false}` (200,
 *       graceful no-match) — does NOT 4xx.
 *    9. POST /identify links the visitor to the contact when a matching email
 *       is found within the visitor's tenant.
 *
 *   AUTHENTICATED reads (tenant isolation pins)
 *   10. GET /stats scopes all 5 counts by req.user.tenantId.
 *   11. GET / scopes findMany by tenantId AND hydrates contacts via
 *       prisma.contact.findMany scoped by the SAME tenantId.
 *   12. GET /:id 404s when the visitor is in another tenant (tenant filter
 *       pinned on findFirst).
 *   13. GET /:id returns the visitor with parsed `pages` array.
 *   14. POST /track 500 envelope when prisma throws.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/chatbots.test.js — prisma singleton
 *   monkey-patch BEFORE the router is required, monkey-patch `verifyToken`
 *   to a pass-through (the route module doesn't itself import verifyToken
 *   — auth is applied at server.js's global guard — but we still mount the
 *   route in a bare express app with a req.user injector so the authed
 *   handlers can read req.user.tenantId).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Prisma singleton patching — BEFORE the router is required.
prisma.webVisitor = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();

import express from 'express';
import request from 'supertest';

const webVisitorsRouter = requireCJS('../../routes/web_visitors');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', anon = false } = {}) {
  const app = express();
  app.use(express.json());
  if (!anon) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/web-visitors', webVisitorsRouter);
  return app;
}

beforeEach(() => {
  prisma.webVisitor.findUnique.mockReset();
  prisma.webVisitor.findFirst.mockReset();
  prisma.webVisitor.findMany.mockReset();
  prisma.webVisitor.create.mockReset();
  prisma.webVisitor.update.mockReset();
  prisma.webVisitor.count.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset();

  // Sensible defaults — empty result sets / no existing visitor
  prisma.webVisitor.findUnique.mockResolvedValue(null);
  prisma.webVisitor.findMany.mockResolvedValue([]);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.webVisitor.count.mockResolvedValue(0);
});

// ─── PUBLIC: POST /track ─────────────────────────────────────────────

describe('POST /api/web-visitors/track', () => {
  test('400 when sessionId missing', async () => {
    const app = makeApp({ anon: true });
    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({ siteTenantId: 1, url: '/foo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/);
  });

  test('400 INVALID_INPUT when siteTenantId missing (#646 — no silent fallback to tenant 1)', async () => {
    const app = makeApp({ anon: true });
    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({ sessionId: 'sess-abc', url: '/home' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.error).toMatch(/siteTenantId/);
    // Critically: NO create call. The #646 fix replaced the silent tenant=1
    // fallback with this hard 400.
    expect(prisma.webVisitor.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_INPUT when siteTenantId is non-positive', async () => {
    const app = makeApp({ anon: true });
    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({ sessionId: 'sess-abc', siteTenantId: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(prisma.webVisitor.create).not.toHaveBeenCalled();
  });

  test('creates a new WebVisitor with stringified pages when sessionId is unseen', async () => {
    const app = makeApp({ anon: true });
    prisma.webVisitor.findUnique.mockResolvedValue(null);
    prisma.webVisitor.create.mockResolvedValue({ id: 99 });

    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({
        sessionId: 'sess-new',
        siteTenantId: 42,
        url: '/landing',
        userAgent: 'TestUA/1.0',
        ipAddress: '1.2.3.4',
        country: 'IN',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      visitorId: 99,
      sessionId: 'sess-new',
      pageCount: 1,
    });

    expect(prisma.webVisitor.create).toHaveBeenCalledTimes(1);
    const args = prisma.webVisitor.create.mock.calls[0][0];
    expect(args.data.sessionId).toBe('sess-new');
    // tenantId comes from siteTenantId body field (#646)
    expect(args.data.tenantId).toBe(42);
    expect(args.data.identified).toBe(false);
    expect(args.data.country).toBe('IN');
    expect(args.data.ipAddress).toBe('1.2.3.4');
    expect(args.data.userAgent).toBe('TestUA/1.0');
    // pages is stringified, not an array.
    expect(typeof args.data.pages).toBe('string');
    const parsed = JSON.parse(args.data.pages);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].url).toBe('/landing');
    expect(typeof parsed[0].timestamp).toBe('string');
  });

  test('appends to pages on an existing sessionId (does NOT duplicate)', async () => {
    const app = makeApp({ anon: true });
    const existingPages = JSON.stringify([
      { url: '/home', timestamp: '2026-05-25T00:00:00.000Z' },
      { url: '/pricing', timestamp: '2026-05-25T00:01:00.000Z' },
    ]);
    prisma.webVisitor.findUnique.mockResolvedValue({
      id: 7,
      sessionId: 'sess-existing',
      pages: existingPages,
      ipAddress: '1.1.1.1',
      userAgent: 'OldUA',
      country: 'US',
      tenantId: 42,
    });
    prisma.webVisitor.update.mockResolvedValue({ id: 7 });

    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({ sessionId: 'sess-existing', siteTenantId: 42, url: '/contact' });

    expect(res.status).toBe(200);
    expect(res.body.pageCount).toBe(3);
    expect(prisma.webVisitor.create).not.toHaveBeenCalled();
    expect(prisma.webVisitor.update).toHaveBeenCalledTimes(1);

    const args = prisma.webVisitor.update.mock.calls[0][0];
    expect(args.where).toEqual({ sessionId: 'sess-existing' });
    const newPages = JSON.parse(args.data.pages);
    expect(newPages).toHaveLength(3);
    expect(newPages[2].url).toBe('/contact');
    // Untouched fields preserved: country wasn't in the request body, so
    // the existing value is kept. (ipAddress + userAgent are always provided
    // by supertest's request itself via req.ip / req.headers, so they
    // legitimately update on every track call — that's intentional, so the
    // visitor's "current" IP/UA reflects the latest session activity.)
    expect(args.data.country).toBe('US');
  });

  test('caps pages to last 200 to avoid runaway growth', async () => {
    const app = makeApp({ anon: true });
    // 200 existing pages; one more push should sit at 200 (oldest dropped).
    const existingPages = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({ url: `/p${i}`, timestamp: '2026-05-25T00:00:00.000Z' })),
    );
    prisma.webVisitor.findUnique.mockResolvedValue({
      id: 8,
      sessionId: 'sess-long',
      pages: existingPages,
      tenantId: 42,
    });
    prisma.webVisitor.update.mockResolvedValue({ id: 8 });

    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({ sessionId: 'sess-long', siteTenantId: 42, url: '/p200' });

    expect(res.status).toBe(200);
    expect(res.body.pageCount).toBe(200);
    const args = prisma.webVisitor.update.mock.calls[0][0];
    const newPages = JSON.parse(args.data.pages);
    expect(newPages).toHaveLength(200);
    // Oldest (`/p0`) trimmed; newest (`/p200`) at the tail.
    expect(newPages[0].url).toBe('/p1');
    expect(newPages[199].url).toBe('/p200');
  });

  test('500 envelope when prisma throws on findUnique', async () => {
    const app = makeApp({ anon: true });
    prisma.webVisitor.findUnique.mockRejectedValue(new Error('db down'));

    const res = await request(app)
      .post('/api/web-visitors/track')
      .send({ sessionId: 'sess-x', siteTenantId: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Tracking failed' });
  });
});

// ─── POST /identify ──────────────────────────────────────────────────

describe('POST /api/web-visitors/identify', () => {
  test('400 when sessionId or email missing', async () => {
    const app = makeApp({ tenantId: 42 });
    const res = await request(app)
      .post('/api/web-visitors/identify')
      .send({ sessionId: 'sess-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId and email/);
  });

  test('404 when sessionId unknown', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.webVisitor.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/web-visitors/identify')
      .send({ sessionId: 'missing', email: 'user@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Visitor not found/);
  });

  test('returns {identified:false} when no matching contact (graceful 200, NOT 4xx)', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.webVisitor.findUnique.mockResolvedValue({
      id: 10,
      sessionId: 'sess-known',
      tenantId: 42,
    });
    prisma.contact.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/web-visitors/identify')
      .send({ sessionId: 'sess-known', email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.identified).toBe(false);
    expect(prisma.webVisitor.update).not.toHaveBeenCalled();
  });

  test('links visitor to contact when email matches within tenant', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.webVisitor.findUnique.mockResolvedValue({
      id: 10,
      sessionId: 'sess-known',
      tenantId: 42,
    });
    prisma.contact.findFirst.mockResolvedValue({ id: 555, name: 'Priya Sharma' });
    prisma.webVisitor.update.mockResolvedValue({ id: 10 });

    const res = await request(app)
      .post('/api/web-visitors/identify')
      .send({ sessionId: 'sess-known', email: 'Priya@Example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      identified: true,
      contactId: 555,
      visitorId: 10,
    });

    // Email lookup uses lowercased + trimmed email scoped to visitor's tenantId.
    const lookupArgs = prisma.contact.findFirst.mock.calls[0][0];
    expect(lookupArgs.where.email).toBe('priya@example.com');
    expect(lookupArgs.where.tenantId).toBe(42);

    // The visitor gets the contactId and identified=true.
    const updateArgs = prisma.webVisitor.update.mock.calls[0][0];
    expect(updateArgs.data).toEqual({ contactId: 555, identified: true });
  });
});

// ─── AUTHENTICATED: GET /stats ───────────────────────────────────────

describe('GET /api/web-visitors/stats', () => {
  test('scopes all 5 counts by req.user.tenantId', async () => {
    const app = makeApp({ tenantId: 99 });
    prisma.webVisitor.count
      .mockResolvedValueOnce(10) // today
      .mockResolvedValueOnce(50) // week
      .mockResolvedValueOnce(200) // month
      .mockResolvedValueOnce(20) // identified
      .mockResolvedValueOnce(200); // total

    const res = await request(app).get('/api/web-visitors/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      today: 10,
      week: 50,
      month: 200,
      identified: 20,
      total: 200,
      pctIdentified: 10,
    });

    // Each of the 5 count calls scopes by tenantId.
    expect(prisma.webVisitor.count).toHaveBeenCalledTimes(5);
    for (const call of prisma.webVisitor.count.mock.calls) {
      expect(call[0].where.tenantId).toBe(99);
    }
  });

  test('pctIdentified is 0 when total=0 (no division-by-zero)', async () => {
    const app = makeApp({ tenantId: 99 });
    prisma.webVisitor.count.mockResolvedValue(0);

    const res = await request(app).get('/api/web-visitors/stats');
    expect(res.status).toBe(200);
    expect(res.body.pctIdentified).toBe(0);
  });
});

// ─── AUTHENTICATED: GET / (list) ─────────────────────────────────────

describe('GET /api/web-visitors', () => {
  test('scopes findMany by tenantId AND hydrates contacts scoped by the SAME tenantId', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.webVisitor.findMany.mockResolvedValue([
      {
        id: 1,
        sessionId: 'sess-a',
        ipAddress: '1.1.1.1',
        userAgent: 'UA',
        country: 'IN',
        city: null,
        identified: true,
        contactId: 555,
        pages: JSON.stringify([
          { url: '/home', timestamp: '2026-05-25T00:00:00.000Z' },
          { url: '/pricing', timestamp: '2026-05-25T00:05:00.000Z' },
        ]),
        firstSeen: new Date('2026-05-25T00:00:00.000Z'),
        lastSeen: new Date('2026-05-25T00:05:00.000Z'),
        tenantId: 42,
      },
      {
        id: 2,
        sessionId: 'sess-b',
        ipAddress: '2.2.2.2',
        userAgent: 'UA2',
        country: 'US',
        city: null,
        identified: false,
        contactId: null,
        pages: JSON.stringify([{ url: '/about', timestamp: '2026-05-25T00:01:00.000Z' }]),
        firstSeen: new Date(),
        lastSeen: new Date(),
        tenantId: 42,
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 555, name: 'Priya Sharma', email: 'priya@example.com', company: 'Acme' },
    ]);

    const res = await request(app).get('/api/web-visitors');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    // Visitor findMany scoped by tenantId.
    const findArgs = prisma.webVisitor.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(42);
    expect(findArgs.take).toBe(200);

    // Contact hydration scoped by the SAME tenantId — critical tenant-isolation pin.
    const contactArgs = prisma.contact.findMany.mock.calls[0][0];
    expect(contactArgs.where.tenantId).toBe(42);
    expect(contactArgs.where.id).toEqual({ in: [555] });

    // Decorated payload: pageCount, firstUrl, lastUrl, contact hydrated.
    expect(res.body[0].pageCount).toBe(2);
    expect(res.body[0].firstUrl).toBe('/home');
    expect(res.body[0].lastUrl).toBe('/pricing');
    expect(res.body[0].contact).toEqual({
      id: 555,
      name: 'Priya Sharma',
      email: 'priya@example.com',
      company: 'Acme',
    });

    // Non-identified visitor: contact is null, pageCount=1.
    expect(res.body[1].contact).toBeNull();
    expect(res.body[1].pageCount).toBe(1);
  });

  test('does NOT call prisma.contact.findMany when zero visitors are identified', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.webVisitor.findMany.mockResolvedValue([
      {
        id: 1,
        sessionId: 'anon',
        identified: false,
        contactId: null,
        pages: JSON.stringify([]),
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    ]);

    const res = await request(app).get('/api/web-visitors');
    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });
});

// ─── AUTHENTICATED: GET /:id ─────────────────────────────────────────

describe('GET /api/web-visitors/:id', () => {
  test('404s when the visitor is in another tenant (tenant filter pinned)', async () => {
    const app = makeApp({ tenantId: 42 });
    // findFirst with `{ id, tenantId: 42 }` returns null when the row's
    // tenantId is something else (e.g. 7) — the filter prevents leak.
    prisma.webVisitor.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/web-visitors/123');

    expect(res.status).toBe(404);
    const args = prisma.webVisitor.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.id).toBe(123);
  });

  test('returns visitor detail with parsed pages array', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.webVisitor.findFirst.mockResolvedValue({
      id: 5,
      sessionId: 'sess-detail',
      ipAddress: '9.9.9.9',
      userAgent: 'UA',
      country: 'IN',
      city: 'Mumbai',
      identified: true,
      contactId: 777,
      pages: JSON.stringify([
        { url: '/home', timestamp: '2026-05-25T00:00:00.000Z' },
      ]),
      firstSeen: new Date('2026-05-25T00:00:00.000Z'),
      lastSeen: new Date('2026-05-25T00:00:00.000Z'),
      tenantId: 42,
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 777,
      name: 'Rohan Kapoor',
      email: 'rohan@example.com',
      company: 'Beta',
      phone: '+91-99999-88888',
    });

    const res = await request(app).get('/api/web-visitors/5');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.city).toBe('Mumbai');
    expect(Array.isArray(res.body.pages)).toBe(true);
    expect(res.body.pages).toHaveLength(1);
    expect(res.body.pages[0].url).toBe('/home');
    expect(res.body.contact).toEqual({
      id: 777,
      name: 'Rohan Kapoor',
      email: 'rohan@example.com',
      company: 'Beta',
      phone: '+91-99999-88888',
    });

    // Contact hydration also scoped by req.user.tenantId.
    const contactArgs = prisma.contact.findFirst.mock.calls[0][0];
    expect(contactArgs.where.tenantId).toBe(42);
  });
});
