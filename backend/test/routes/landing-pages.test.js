// @ts-check
/**
 * backend/routes/landing_pages.js — contract tests.
 *
 * Pins landing_pages route (574 LOC, 12 endpoints across authenticated CRUD
 * + public submission/render/tracking):
 *
 *   Authenticated (verifyToken, mounted at /api/landing-pages):
 *     - GET    /                  → list pages (tenant-scoped, summary cols)
 *     - GET    /templates/list    → static TEMPLATES catalogue
 *     - POST   /upload            → multer 5 MB image upload (PNG/JPG/WebP/GIF)
 *     - GET    /:id               → fetch page (tenant-scoped, 404 if missing)
 *     - POST   /                  → create page (#339 dedup, #378 slug validation)
 *     - PUT    /:id               → update (#378 slug + #456 collision/published-confirm)
 *     - DELETE /:id               → tenant-scoped delete
 *     - POST   /:id/publish       → set status=PUBLISHED + publishedAt
 *     - POST   /:id/unpublish     → set status=DRAFT
 *     - POST   /:id/duplicate     → clone with new slug suffix
 *     - GET    /:id/analytics     → events + visits/submissions/conversionRate
 *
 *   Public (no auth, mounted at /p):
 *     - GET    /:slug             → render HTML, increment visits
 *     - POST   /:slug/submit      → form submission → contact + deal + analytics
 *     - GET    /:slug/track       → 1×1 GIF + analytics event
 *
 * What's pinned
 * ─────────────
 *   - Auth gate: missing Bearer → 401 (verifyToken's RFC-7235 contract).
 *   - Tenant isolation: GET/PUT/DELETE/publish/unpublish/duplicate/analytics
 *     all scope via { id, tenantId } in findFirst — cross-tenant → 404.
 *   - POST / requires title; rejects bad slug shape (#378); dedupes against
 *     DRAFT same-title (#339 → 409 with existingId).
 *   - POST / auto-generates slug from title + timestamp suffix; honours
 *     explicit client-supplied valid slug; pulls template content when
 *     templateType supplied without content.
 *   - PUT /:id rejects invalid slug shape (#378); collision check against
 *     same-tenant rows (#456 → 409 with existingId); PUBLISHED slug change
 *     without ?confirmSlugChange=true → 409 PUBLISHED_SLUG_CHANGE_REQUIRES_CONFIRM.
 *   - GET /:id/analytics computes conversionRate as NUMBER (not string), 1 dp,
 *     returns 0 when visits==0 (#639 pin — pre-fix returned a string).
 *   - Public GET /:slug returns 404 for non-PUBLISHED / unknown slug.
 *   - Public POST /:slug/submit returns 404 for unknown slug; otherwise
 *     upserts a Contact by { email_tenantId }, creates a Deal, increments
 *     submissions, writes a FORM_SUBMIT analytics event, returns
 *     { success:true, message }.
 *   - Public GET /:slug/track always returns a 1×1 GIF (image/gif) with
 *     no-store caching; analytics insert is best-effort.
 *
 * Test pattern mirrors backend/test/routes/booking-pages.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router so the
 * route's `require('../lib/prisma')` resolves to the patched object. verifyToken
 * stays in the chain so the 401 contract is exercised end-to-end (no bypass).
 * HS256 JWTs signed with the dev-fallback secret drive authenticated requests;
 * public endpoints are called WITHOUT any Authorization header.
 *
 * Standing-rule notes
 * ───────────────────
 *   - JWT signing payload uses `userId` (not `id`) per the route's
 *     `req.user.userId` reads (lib/middleware/auth.js dev-fallback secret).
 *   - Date-boundary helpers use unambiguously-future dates, not midnight-of-today.
 *   - The `landingPageRenderer` service is the real one — its only side effect
 *     is returning an HTML string, no DB / network. We accept the rendered
 *     HTML output via Content-Type only, not byte-for-byte content.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patch (must run BEFORE the router is required) ──
prisma.landingPage = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.landingPageAnalytics = {
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
};
prisma.contact = prisma.contact || {};
prisma.contact.upsert = vi.fn();
prisma.contact.update = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.leadRoutingRule = prisma.leadRoutingRule || {};
prisma.leadRoutingRule.findFirst = vi.fn().mockResolvedValue(null);
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn().mockResolvedValue(null);
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const { router: authedRouter, publicRouter } = requireCJS('../../routes/landing_pages');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/landing-pages', authedRouter);
  app.use('/p', publicRouter);
  return app;
}

function tokenFor({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: 'admin@test.local' },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.landingPage.findMany.mockReset();
  prisma.landingPage.findFirst.mockReset();
  prisma.landingPage.findUnique.mockReset();
  prisma.landingPage.create.mockReset();
  prisma.landingPage.update.mockReset();
  prisma.landingPage.delete.mockReset();
  prisma.landingPageAnalytics.findMany.mockReset().mockResolvedValue([]);
  prisma.landingPageAnalytics.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.contact.upsert.mockReset();
  prisma.contact.update.mockReset();
  prisma.deal.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.leadRoutingRule.findFirst.mockReset().mockResolvedValue(null);
  prisma.user.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── Authentication gate ──────────────────────────────────────────────

describe('Authentication gate (verifyToken)', () => {
  test('GET / without Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/landing-pages');
    expect(res.status).toBe(401);
    expect(prisma.landingPage.findMany).not.toHaveBeenCalled();
  });

  test('POST / without Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .send({ title: 'Drip Page' });
    expect(res.status).toBe(401);
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('PUT /:id without Bearer → 401', async () => {
    const res = await request(makeApp())
      .put('/api/landing-pages/42')
      .send({ title: 'Updated' });
    expect(res.status).toBe(401);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('DELETE /:id without Bearer → 401', async () => {
    const res = await request(makeApp()).delete('/api/landing-pages/42');
    expect(res.status).toBe(401);
    expect(prisma.landingPage.delete).not.toHaveBeenCalled();
  });

  test('GET /:id/analytics without Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/landing-pages/42/analytics');
    expect(res.status).toBe(401);
    expect(prisma.landingPage.findFirst).not.toHaveBeenCalled();
  });
});

// ─── GET / (list) ─────────────────────────────────────────────────────

describe('GET /api/landing-pages (list)', () => {
  test('happy path: returns summary rows scoped to tenant', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { id: 1, title: 'Spring Sale', slug: 'spring-sale-abc', status: 'PUBLISHED', visits: 12, submissions: 3, templateType: 'lead_capture', createdAt: new Date(), updatedAt: new Date() },
      { id: 2, title: 'Demo Webinar', slug: 'demo-webinar-xyz', status: 'DRAFT', visits: 0, submissions: 0, templateType: 'webinar_signup', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await request(makeApp())
      .get('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ id: 1, title: 'Spring Sale', visits: 12, submissions: 3 });
    // Tenant scoping + summary-column select + recent-first ordering.
    expect(prisma.landingPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1 },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const args = prisma.landingPage.findMany.mock.calls[0][0];
    expect(args.select).toMatchObject({ id: true, title: true, slug: true, status: true, visits: true, submissions: true });
  });

  test('GET /templates/list returns the static template catalogue', async () => {
    const res = await request(makeApp())
      .get('/api/landing-pages/templates/list')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // All four shipped templates by id.
    const ids = res.body.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['lead_capture', 'product_showcase', 'event_registration', 'webinar_signup']));
  });
});

// ─── GET /:id ─────────────────────────────────────────────────────────

describe('GET /api/landing-pages/:id', () => {
  test('happy path: tenant-scoped fetch returns the row', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 5, title: 'Brand Launch', slug: 'brand-launch-foo', tenantId: 1, content: '[]',
    });
    const res = await request(makeApp())
      .get('/api/landing-pages/5')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, title: 'Brand Launch' });
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
  });

  test('cross-tenant → 404', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/landing-pages/5')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 2 },
    });
  });
});

// ─── POST / (create) ──────────────────────────────────────────────────

describe('POST /api/landing-pages (create)', () => {
  test('happy path: 201 with auto-generated slug + persists tenantId from req.user', async () => {
    // No existing DRAFT for this title.
    prisma.landingPage.findMany.mockResolvedValue([]);
    prisma.landingPage.create.mockImplementation(async (args) => ({ id: 100, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'Discovery Call' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 100,
      title: 'Discovery Call',
      tenantId: 1,
      userId: 7,
    });
    // Slug auto-generated: lowercased + hyphens + timestamp suffix.
    expect(res.body.slug).toMatch(/^discovery-call-[a-z0-9]+$/);
    // tenantId from req.user, not body.
    const createArgs = prisma.landingPage.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.userId).toBe(7);
    // Empty content defaults to "[]" (not null).
    expect(createArgs.data.content).toBe('[]');
  });

  test('missing title → 400', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('whitespace-only title → 400', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('#378 invalid slug shape (uppercase) → 400 with helpful copy', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'Page', slug: 'INVALID-SLUG' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid slug/i);
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('#339 duplicate DRAFT title (case-insensitive trim) → 409 with existingId', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { id: 77, title: 'Discovery Call' },
    ]);
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: '  discovery call  ' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ existingId: 77 });
    expect(res.body.error).toMatch(/already exists/i);
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('templateType without content pulls the template body', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);
    prisma.landingPage.create.mockImplementation(async (args) => ({ id: 101, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'Webinar Launch', templateType: 'webinar_signup' });
    expect(res.status).toBe(201);
    const createArgs = prisma.landingPage.create.mock.calls[0][0];
    // Content comes from the matching TEMPLATES entry (stringified JSON of array).
    expect(typeof createArgs.data.content).toBe('string');
    expect(createArgs.data.content).toContain('Scaling Your Sales Pipeline');
  });
});

// ─── PUT /:id (update) ────────────────────────────────────────────────

describe('PUT /api/landing-pages/:id (update)', () => {
  test('happy path: tenant-scoped update returns 200; only present keys go to update', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'existing-foo', status: 'DRAFT', title: 'Old',
    });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'New Title', metaTitle: 'SEO title' });
    expect(res.status).toBe(200);
    const updateArgs = prisma.landingPage.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 50 });
    expect(updateArgs.data).toMatchObject({ title: 'New Title', metaTitle: 'SEO title' });
    expect(updateArgs.data.slug).toBeUndefined(); // not in body, not in update
    expect(updateArgs.data.content).toBeUndefined();
  });

  test('cross-tenant page → 404 (tenant isolation)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/landing-pages/999')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`)
      .send({ title: 'Hijack Attempt' });
    expect(res.status).toBe(404);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 2 },
    });
  });

  test('#378 invalid slug shape on update → 400', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1, slug: 'existing', status: 'DRAFT' });
    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ slug: 'Bad Slug Has Spaces' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid slug/i);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('#456 slug collision against another row in same tenant → 409 with existingId', async () => {
    prisma.landingPage.findFirst
      // 1st call: load the row we're updating
      .mockResolvedValueOnce({ id: 50, tenantId: 1, slug: 'old-slug', status: 'DRAFT' })
      // 2nd call: collision lookup hits another row
      .mockResolvedValueOnce({ id: 77, title: 'Other Page', status: 'PUBLISHED' });
    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ slug: 'taken-slug' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ existingId: 77 });
    expect(res.body.error).toMatch(/already used/i);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('#456 changing slug on PUBLISHED page without confirmSlugChange → 409 PUBLISHED_SLUG_CHANGE_REQUIRES_CONFIRM', async () => {
    prisma.landingPage.findFirst
      .mockResolvedValueOnce({ id: 50, tenantId: 1, slug: 'live-promo', status: 'PUBLISHED' })
      .mockResolvedValueOnce(null); // no collision
    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ slug: 'new-promo' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'PUBLISHED_SLUG_CHANGE_REQUIRES_CONFIRM',
      currentSlug: 'live-promo',
      requestedSlug: 'new-promo',
    });
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('#456 PUBLISHED slug change with ?confirmSlugChange=true proceeds', async () => {
    prisma.landingPage.findFirst
      .mockResolvedValueOnce({ id: 50, tenantId: 1, slug: 'live-promo', status: 'PUBLISHED' })
      .mockResolvedValueOnce(null);
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .put('/api/landing-pages/50?confirmSlugChange=true')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ slug: 'new-promo' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'new-promo' });
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────

describe('DELETE /api/landing-pages/:id', () => {
  test('happy path: tenant-scoped delete returns success envelope', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.landingPage.delete.mockResolvedValue({ id: 50 });
    const res = await request(makeApp())
      .delete('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.landingPage.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });

  test('cross-tenant page → 404, no delete attempted', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/landing-pages/777')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(404);
    expect(prisma.landingPage.delete).not.toHaveBeenCalled();
  });
});

// ─── publish / unpublish / duplicate ─────────────────────────────────

describe('POST /api/landing-pages/:id/publish | /unpublish | /duplicate', () => {
  test('publish: sets PUBLISHED + publishedAt', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1, status: 'DRAFT' });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages/50/publish')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PUBLISHED');
    expect(res.body.publishedAt).toBeTruthy();
  });

  test('unpublish: flips PUBLISHED back to DRAFT', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1, status: 'PUBLISHED' });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages/50/unpublish')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DRAFT');
  });

  test('duplicate: returns 201 with new id + "Copy of"-prefixed title + suffixed slug', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, title: 'Spring Sale', slug: 'spring-sale-foo',
      content: '[]', cssOverrides: null, templateType: 'lead_capture',
      metaTitle: null, metaDescription: null,
    });
    prisma.landingPage.create.mockImplementation(async (args) => ({ id: 51, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages/50/duplicate')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 51, title: 'Copy of Spring Sale' });
    expect(res.body.slug).toMatch(/^spring-sale-foo-copy-[a-z0-9]+$/);
    const createArgs = prisma.landingPage.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.userId).toBe(7);
  });

  test('publish on cross-tenant page → 404', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/landing-pages/999/publish')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });
});

// ─── GET /:id/analytics ──────────────────────────────────────────────

describe('GET /api/landing-pages/:id/analytics', () => {
  test('happy path: returns events + visits/submissions + numeric conversionRate (#639)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.landingPageAnalytics.findMany.mockResolvedValue([
      { id: 1, eventType: 'VISIT', createdAt: new Date() },
      { id: 2, eventType: 'VISIT', createdAt: new Date() },
      { id: 3, eventType: 'VISIT', createdAt: new Date() },
      { id: 4, eventType: 'FORM_SUBMIT', createdAt: new Date() },
    ]);
    const res = await request(makeApp())
      .get('/api/landing-pages/50/analytics')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.visits).toBe(3);
    expect(res.body.submissions).toBe(1);
    // #639: conversionRate must be a NUMBER, not a string. 1/3 → 33.3 (1 dp).
    expect(typeof res.body.conversionRate).toBe('number');
    expect(res.body.conversionRate).toBeCloseTo(33.3, 5);
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  test('zero visits returns conversionRate=0 (numeric), not NaN/string', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.landingPageAnalytics.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/landing-pages/50/analytics')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ visits: 0, submissions: 0, conversionRate: 0 });
    expect(typeof res.body.conversionRate).toBe('number');
  });

  test('cross-tenant → 404, no analytics fetch attempted', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/landing-pages/999/analytics')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(prisma.landingPageAnalytics.findMany).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC GET /:slug ────────────────────────────────────────────────

describe('GET /p/:slug (public render, no auth)', () => {
  test('happy path WITHOUT auth: PUBLISHED page renders HTML, visits incremented, VISIT event logged', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.landingPage.update.mockResolvedValue({ id: 50, visits: 1 });
    const res = await request(makeApp()).get('/p/live-page');
    // NO Authorization header — public route must succeed.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Increment + analytics insert both fired.
    expect(prisma.landingPage.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { visits: { increment: 1 } },
    });
    expect(prisma.landingPageAnalytics.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          landingPageId: 50,
          eventType: 'VISIT',
          tenantId: 1,
        }),
      }),
    );
  });

  test('DRAFT (non-PUBLISHED) page → 404 HTML, NO visit recorded', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'draft-page', status: 'DRAFT', content: '[]', tenantId: 1,
    });
    const res = await request(makeApp()).get('/p/draft-page');
    expect(res.status).toBe(404);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
    expect(prisma.landingPageAnalytics.create).not.toHaveBeenCalled();
  });

  test('unknown slug → 404', async () => {
    prisma.landingPage.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get('/p/missing-slug');
    expect(res.status).toBe(404);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC POST /:slug/submit ────────────────────────────────────────

describe('POST /p/:slug/submit (public submission, no auth)', () => {
  test('happy path WITHOUT auth: upserts contact, creates deal, increments submissions, returns success envelope', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, email: 'asha@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/live-page/submit')
      .send({ email: 'asha@example.com', name: 'Asha Iyer', phone: '+919876543210', company: 'Acme Inc' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.message).toMatch(/thank you/i);

    // Contact upsert uses the composite email_tenantId unique key (per the
    // route's explicit fix-note about Contact's @@unique([email, tenantId])).
    expect(prisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email_tenantId: { email: 'asha@example.com', tenantId: 1 } },
      }),
    );
    // Deal created with stage="lead" and the page's tenantId (not body).
    expect(prisma.deal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: 'lead',
          contactId: 999,
          tenantId: 1,
        }),
      }),
    );
    // submissions incremented + FORM_SUBMIT event logged.
    expect(prisma.landingPage.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { submissions: { increment: 1 } },
    });
    expect(prisma.landingPageAnalytics.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'FORM_SUBMIT',
          tenantId: 1,
        }),
      }),
    );
  });

  test('unknown slug → 404 (no contact/deal/analytics writes)', async () => {
    prisma.landingPage.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/p/missing/submit')
      .send({ email: 'asha@example.com', name: 'Asha' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
    expect(prisma.landingPageAnalytics.create).not.toHaveBeenCalled();
  });

  test('submission without an email synthesises a placeholder address (anonymous tracking)', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 1001, tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/live-page/submit')
      .send({ name: 'Anon User' }); // no email
    expect(res.status).toBe(200);
    const upsertArgs = prisma.contact.upsert.mock.calls[0][0];
    // Synthesised placeholder: "lp-<slug>-<ts>@anonymous.local".
    expect(upsertArgs.where.email_tenantId.email).toMatch(/^lp-live-page-\d+@anonymous\.local$/);
  });
});

// ─── PUBLIC GET /:slug/track ──────────────────────────────────────────

describe('GET /p/:slug/track (public 1×1 pixel, no auth)', () => {
  test('happy path: returns 1×1 GIF with no-store cache; analytics event logged', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', tenantId: 1,
    });
    const res = await request(makeApp()).get('/p/live-page/track?event=VISIT');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(prisma.landingPageAnalytics.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          landingPageId: 50,
          eventType: 'VISIT',
          tenantId: 1,
        }),
      }),
    );
  });

  test('unknown slug still returns the GIF (silent) — no analytics insert', async () => {
    prisma.landingPage.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get('/p/missing/track');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(prisma.landingPageAnalytics.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 38)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors the slim-shape contract pinned in slices 1-36. The default list
// path already excludes the heavy content @db.LongText + cssOverrides @db.Text
// + metaTitle/metaDescription columns (LandingPage schema's body JSON lives
// in `content`). When the caller passes ?fields=summary the route projects
// further down to only id + title + slug + status — exactly what a picker /
// dropdown / slug-collision-check UI needs. Anything other than the exact
// string "summary" is treated as default (analytics-bearing shape with
// visits + submissions + templateType + createdAt + updatedAt).
describe('GET /?fields=summary — slim-shape opt-in', () => {
  test('omitted ?fields returns analytics-bearing default shape (visits/submissions/templateType included)', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      {
        id: 1,
        title: 'Spring Sale',
        slug: 'spring-sale-abc',
        status: 'PUBLISHED',
        visits: 42,
        submissions: 7,
        templateType: 'lead_capture',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-10T00:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/landing-pages')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ visits: 42, submissions: 7, templateType: 'lead_capture' });
    const arg = prisma.landingPage.findMany.mock.calls[0][0];
    // Default path: full analytics-bearing select.
    expect(arg.select).toEqual({
      id: true,
      title: true,
      slug: true,
      status: true,
      visits: true,
      submissions: true,
      templateType: true,
      createdAt: true,
      updatedAt: true,
    });
    expect(arg.where).toEqual({ tenantId: 1 });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary forwards select with id+title+slug+status only', async () => {
    prisma.landingPage.findMany.mockResolvedValue([
      { id: 1, title: 'Spring Sale', slug: 'spring-sale-abc', status: 'PUBLISHED' },
      { id: 2, title: 'Demo Webinar', slug: 'demo-webinar-xyz', status: 'DRAFT' },
    ]);

    const res = await request(makeApp())
      .get('/api/landing-pages?fields=summary')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const arg = prisma.landingPage.findMany.mock.calls[0][0];
    // Heavy/analytics columns MUST NOT appear in the slim select.
    expect(arg.select).toEqual({
      id: true,
      title: true,
      slug: true,
      status: true,
    });
    expect(arg.select.visits).toBeUndefined();
    expect(arg.select.submissions).toBeUndefined();
    expect(arg.select.templateType).toBeUndefined();
    expect(arg.select.createdAt).toBeUndefined();
    expect(arg.select.updatedAt).toBeUndefined();
    expect(arg.select.content).toBeUndefined();
    expect(arg.select.cssOverrides).toBeUndefined();
    // where + orderBy unchanged from default path.
    expect(arg.where).toEqual({ tenantId: 1 });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary respects tenant scoping (cross-tenant token → different where)', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/landing-pages?fields=summary')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 99 })}`);

    const arg = prisma.landingPage.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 99 });
    expect(arg.select).toEqual({
      id: true,
      title: true,
      slug: true,
      status: true,
    });
  });

  test('?fields=full (anything not exactly "summary") falls back to default shape', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/landing-pages?fields=full')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    const arg = prisma.landingPage.findMany.mock.calls[0][0];
    // Exact-string gate: only "summary" trips the slim branch.
    expect(arg.select.visits).toBe(true);
    expect(arg.select.submissions).toBe(true);
    expect(arg.select.templateType).toBe(true);
  });

  test('?fields=SUMMARY (uppercase) is treated as default — case-sensitive gate', async () => {
    prisma.landingPage.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/landing-pages?fields=SUMMARY')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    const arg = prisma.landingPage.findMany.mock.calls[0][0];
    // The gate is `req.query.fields === "summary"` (case-sensitive). Pin
    // the contract so a future refactor to .toLowerCase() shows up as a
    // deliberate spec edit, not a silent behaviour change.
    expect(arg.select.visits).toBe(true);
    expect(arg.select.submissions).toBe(true);
    expect(arg.select.templateType).toBe(true);
  });
});
