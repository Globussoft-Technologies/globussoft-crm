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
  updateMany: vi.fn(),
  delete: vi.fn(),
};
// $transaction is used by the feature endpoint (atomic un-feature + feature).
// The mock just runs each operation in order — the supplied operations are
// already plain Prisma promises (vi.fn() resolves) so awaiting them in
// sequence preserves the at-most-one-featured-per-scope contract from the
// test's perspective.
prisma.$transaction = vi.fn(async (ops) => Promise.all(Array.isArray(ops) ? ops : []));
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
// Phase 3 hybrid registration-draft branch — when /submit branches into
// PendingTripRegistration creation, we exercise these mocks; otherwise
// the lead-capture path leaves them untouched (assert with not.toHaveBeenCalled).
prisma.pendingTripRegistration = prisma.pendingTripRegistration || {};
prisma.pendingTripRegistration.create = vi.fn();
prisma.tripParticipant = prisma.tripParticipant || {};
prisma.tripParticipant.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.tripParticipant.findFirst = vi.fn().mockResolvedValue(null);
prisma.tripParticipant.update = vi.fn().mockResolvedValue({ id: 1 });
prisma.tripMicrosite = prisma.tripMicrosite || {};
prisma.tripMicrosite.findUnique = vi.fn();
// Phase 11 — PUT /:id can set tripId, which validates the trip exists
// in the requester's tenant before persisting the link.
prisma.tmcTrip = prisma.tmcTrip || {};
prisma.tmcTrip.findFirst = vi.fn();

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
  prisma.landingPage.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.landingPage.delete.mockReset();
  prisma.$transaction.mockClear();
  prisma.landingPageAnalytics.findMany.mockReset().mockResolvedValue([]);
  prisma.landingPageAnalytics.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.contact.upsert.mockReset().mockResolvedValue({ id: 1 });
  prisma.contact.update.mockReset();
  prisma.deal.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.leadRoutingRule.findFirst.mockReset().mockResolvedValue(null);
  prisma.user.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.pendingTripRegistration.create.mockReset();
  prisma.tripParticipant.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.tripParticipant.findFirst.mockReset().mockResolvedValue(null);
  prisma.tripParticipant.update.mockReset().mockResolvedValue({ id: 1 });
  prisma.tripMicrosite.findUnique.mockReset();
  prisma.tmcTrip.findFirst.mockReset();
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

  // Phase 11 — tripId support on PUT lets the operator link/unlink a
  // landing page to a TMC trip from the existing Landing Pages module.
  // No parallel UI on /travel/trips per decision.

  test('Phase 11 — tripId=42 verifies trip exists in tenant + persists the link', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'trip-page', status: 'DRAFT',
    });
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 42 });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data, tenantId: 1 }));

    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripId: 42 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tripId: 42 });
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
      select: { id: true, tripCode: true, paymentPlan: true },
    });
    expect(prisma.landingPage.update.mock.calls[0][0].data).toMatchObject({ tripId: 42 });
  });

  test('Phase 11 — tripId=null explicitly unlinks (no trip lookup required)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'trip-page', status: 'DRAFT',
    });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data, tenantId: 1 }));

    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripId: null });

    expect(res.status).toBe(200);
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
    expect(prisma.landingPage.update.mock.calls[0][0].data).toMatchObject({ tripId: null });
  });

  test('Phase 11 — tripId pointing at a non-existent / cross-tenant trip → 404 TRIP_NOT_FOUND', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'trip-page', status: 'DRAFT',
    });
    prisma.tmcTrip.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripId: 999 });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TRIP_NOT_FOUND' });
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('Phase 11 — non-numeric tripId → 400 INVALID_TRIP_ID', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'trip-page', status: 'DRAFT',
    });
    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripId: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TRIP_ID' });
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('Phase 11 — Prisma P2002 on tripId @unique surfaces as 409 TRIP_ALREADY_LINKED', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'trip-page', status: 'DRAFT',
    });
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 42 });
    const conflictErr = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['tripId'] },
    });
    prisma.landingPage.update.mockRejectedValue(conflictErr);

    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripId: 42 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TRIP_ALREADY_LINKED' });
  });

  test('Phase 11 — linking a Wanderlux page to a trip defaults register.mode to lead', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, slug: 'wanderlux-trip', status: 'DRAFT',
      templateType: 'wanderlux-v1',
      content: JSON.stringify({ register: { steps: [{ id: 'student' }] } }),
    });
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 42 });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data, tenantId: 1 }));

    const res = await request(makeApp())
      .put('/api/landing-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripId: 42 });

    expect(res.status).toBe(200);
    const updatedContent = prisma.landingPage.update.mock.calls[0][0].data.content;
    expect(JSON.parse(updatedContent).register.mode).toBe('lead');
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
    // PR-A added a publish gate: generic pages must have a valid title,
    // slug, and at least one content block. Provide a minimally-complete
    // page so the gate clears and the test asserts the publish semantics
    // (status flip + publishedAt set), not the gate logic itself —
    // that's covered in e2e/tests/landing-pages-travel-api.spec.js.
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      status: 'DRAFT',
      title: 'Spring Sale',
      slug: 'spring-sale',
      templateType: 'lead_capture',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
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

  test('unpublish auto-clears the featured flag (invariant: featured ⇒ published)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'PUBLISHED', isFeatured: true,
    });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages/50/unpublish')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.isFeatured).toBe(false);
    expect(res.body.featuredAt).toBeNull();
  });
});

// ─── Feature / Unfeature + Public resolver ───────────────────────────
//
// Verifies the "at most one featured page per (tenantId, subBrand)"
// invariant the feature endpoint enforces transactionally, the requires-
// PUBLISHED gate (409 PAGE_NOT_PUBLISHED), idempotency, and the public
// /public/featured resolver shape used by /trips.

describe('POST /api/landing-pages/:id/feature | /unfeature', () => {
  test('feature on DRAFT page → 409 PAGE_NOT_PUBLISHED (gate)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'DRAFT', isFeatured: false, subBrand: null,
    });
    const res = await request(makeApp())
      .post('/api/landing-pages/50/feature')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAGE_NOT_PUBLISHED');
    expect(res.body.currentStatus).toBe('DRAFT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('feature on PUBLISHED page → demotes siblings + sets isFeatured + returns the updated row', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'PUBLISHED', isFeatured: false, subBrand: 'tmc',
    });
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, tenantId: 1, status: 'PUBLISHED', isFeatured: true, featuredAt: new Date(), subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .post('/api/landing-pages/50/feature')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.isFeatured).toBe(true);
    // Transaction is what enforces the invariant — must have been called.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // updateMany should target the same scope EXCLUDING the target row.
    const updateManyArgs = prisma.landingPage.updateMany.mock.calls[0]?.[0];
    expect(updateManyArgs?.where?.tenantId).toBe(1);
    expect(updateManyArgs?.where?.subBrand).toBe('tmc');
    expect(updateManyArgs?.where?.isFeatured).toBe(true);
    expect(updateManyArgs?.where?.NOT?.id).toBe(50);
  });

  test('feature is idempotent — already-featured page is a no-op (no transaction)', async () => {
    const existing = {
      id: 50, tenantId: 1, status: 'PUBLISHED', isFeatured: true,
      featuredAt: new Date('2026-06-01T00:00:00Z'), subBrand: 'tmc',
    };
    prisma.landingPage.findFirst.mockResolvedValue(existing);
    const res = await request(makeApp())
      .post('/api/landing-pages/50/feature')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.isFeatured).toBe(true);
    // No transaction fired, original featuredAt preserved.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('feature on cross-tenant page → 404', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/landing-pages/999/feature')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('unfeature clears the flag + featuredAt', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, status: 'PUBLISHED', isFeatured: true,
      featuredAt: new Date(), subBrand: 'tmc',
    });
    prisma.landingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .post('/api/landing-pages/50/unfeature')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.isFeatured).toBe(false);
    expect(res.body.featuredAt).toBeNull();
  });

  test('unfeature is idempotent on non-featured row — returns the row unchanged', async () => {
    const existing = {
      id: 50, tenantId: 1, status: 'PUBLISHED', isFeatured: false,
      featuredAt: null, subBrand: 'tmc',
    };
    prisma.landingPage.findFirst.mockResolvedValue(existing);
    const res = await request(makeApp())
      .post('/api/landing-pages/50/unfeature')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.isFeatured).toBe(false);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/landing-pages/public/featured (no auth, /trips resolver)', () => {
  test('200 returns featured PUBLISHED row when one exists', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'japan-2026', title: 'Japan 2026', destination: 'Japan',
      subBrand: 'tmc', featuredAt: new Date('2026-06-22T10:00:00Z'),
    });
    // Public route — no Bearer header.
    const res = await request(makeApp()).get('/api/landing-pages/public/featured');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 50, slug: 'japan-2026', title: 'Japan 2026',
      destination: 'Japan', subBrand: 'tmc',
    });
    // Filter must include isFeatured: true AND status: PUBLISHED.
    const findArgs = prisma.landingPage.findFirst.mock.calls[0][0];
    expect(findArgs.where.isFeatured).toBe(true);
    expect(findArgs.where.status).toBe('PUBLISHED');
    // Recency-ordered.
    expect(findArgs.orderBy).toEqual({ featuredAt: 'desc' });
  });

  test('404 NO_FEATURED_PAGE when no row matches', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/landing-pages/public/featured');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_FEATURED_PAGE');
  });

  test('?subBrand=tmc narrows the lookup to that bucket', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'umrah-2026', title: 'Umrah', subBrand: 'tmc', featuredAt: new Date(),
    });
    const res = await request(makeApp()).get('/api/landing-pages/public/featured?subBrand=tmc');
    expect(res.status).toBe(200);
    const findArgs = prisma.landingPage.findFirst.mock.calls[0][0];
    expect(findArgs.where.subBrand).toBe('tmc');
  });

  test('?subBrand=none filters to subBrand IS NULL', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'g', title: 'Generic', subBrand: null, featuredAt: new Date(),
    });
    const res = await request(makeApp()).get('/api/landing-pages/public/featured?subBrand=none');
    expect(res.status).toBe(200);
    const findArgs = prisma.landingPage.findFirst.mock.calls[0][0];
    expect(findArgs.where.subBrand).toBeNull();
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
    prisma.landingPage.findFirst.mockResolvedValue({
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

  test('DRAFT (non-PUBLISHED) page → 302 redirect to /trips, NO visit recorded', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'draft-page', status: 'DRAFT', content: '[]', tenantId: 1,
    });
    const res = await request(makeApp()).get('/p/draft-page');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/trips');
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
    expect(prisma.landingPageAnalytics.create).not.toHaveBeenCalled();
  });

  test('unknown slug → 404', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/p/missing-slug');
    expect(res.status).toBe(404);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC POST /:slug/submit ────────────────────────────────────────

describe('POST /p/:slug/submit (public submission, no auth)', () => {
  test('happy path WITHOUT auth: upserts contact, creates deal, increments submissions, returns success envelope', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
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

  test('generic landing-page lead uses canonical web-form source + preserves page attribution', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, email: 'asha@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/live-page/submit')
      .send({ email: 'asha@example.com', name: 'Asha Iyer', phone: '+919876543210' });

    expect(res.status).toBe(200);
    const createArgs = prisma.contact.upsert.mock.calls[0][0].create;
    expect(createArgs.source).toBe('inbound:webform');
    expect(createArgs.firstTouchSource).toBe('Landing Page: Live Page');
  });

  test('trip-linked landing-page registration uses tmc_registration source', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 51, slug: 'australia-2026', status: 'PUBLISHED', title: 'Australia 7-Day Tour',
      content: '[]', templateType: 'travel_destination',
      tenantId: 1, tripId: 7,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 500, email: 'parent@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 51, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/australia-2026/submit')
      .send({
        fields: {
          student_name: 'Aarav Iyer',
          name: 'Ravi Iyer',
          email: 'parent@example.com',
          phone: '+919876543210',
        },
      });

    expect(res.status).toBe(200);
    const createArgs = prisma.contact.upsert.mock.calls[0][0].create;
    expect(createArgs.source).toBe('tmc_registration');
    expect(createArgs.firstTouchSource).toBe('Landing Page: Australia 7-Day Tour');
  });

  test('brochure request uses brochure_request source so it maps to the Web channel', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: JSON.stringify({ register: { mode: 'registration-draft', steps: [{ id: 'student' }] } }),
      templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100, subBrand: 'tmc',
    });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        brochureRequest: true,
        parentName: 'Rohan Iyer',
        email: 'rohan@example.com',
        phone: '+919876543210',
      });

    expect(res.status).toBe(200);
    const createArgs = prisma.contact.upsert.mock.calls[0][0].create;
    expect(createArgs.source).toBe('brochure_request');
    expect(createArgs.firstTouchSource).toBe('Landing Page: Bali Trip');
  });

  test('trip-linked student registration in lead mode also creates a TripParticipant', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 51, slug: 'australia-2026', status: 'PUBLISHED', title: 'Australia 7-Day Tour',
      content: '[]', templateType: 'travel_destination',
      tenantId: 1, tripId: 7,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 500, email: 'parent@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 51, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/australia-2026/submit')
      .send({
        fields: {
          student_name: 'Aarav Iyer',
          student_grade: '8th Grade',
          student_school: 'DPS North',
          name: 'Ravi Iyer',
          email: 'parent@example.com',
          phone: '+919876543210',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.deal.create).toHaveBeenCalled();
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();

    expect(prisma.tripParticipant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tripId: 7,
          fullName: 'Aarav Iyer',
          OR: [
            { parentEmail: 'parent@example.com' },
            { parentPhone: '+919876543210' },
          ],
        }),
        orderBy: { id: 'desc' },
      }),
    );
    expect(prisma.tripParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 7,
          fullName: 'Aarav Iyer',
          parentName: 'Ravi Iyer',
          parentEmail: 'parent@example.com',
          parentPhone: '+919876543210',
          medicalNotes: 'Grade: 8th Grade\nSchool: DPS North',
          applicationStatus: 'pending',
        }),
      }),
    );
  });

  test('trip-linked registration without explicit student_name still enrols a participant from the contact name', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 51, slug: 'australia-2026', status: 'PUBLISHED', title: 'Australia 7-Day Tour',
      content: JSON.stringify([{ type: 'registrationForm', props: { audience: 'School students' } }]),
      templateType: 'travel_destination',
      tenantId: 1, tripId: 7, subBrand: 'tmc',
    });
    prisma.contact.upsert.mockResolvedValue({ id: 501, email: 'mrinal@demo.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 51, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/australia-2026/submit')
      .send({
        audience: 'School students',
        name: 'Mrinal',
        email: 'mrinal@demo.com',
        phone: '+919876543210',
        school: 'DPS North',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.tripParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 7,
          fullName: 'Mrinal',
          parentName: null,
          parentEmail: 'mrinal@demo.com',
          parentPhone: '+919876543210',
          medicalNotes: 'School: DPS North',
          applicationStatus: 'pending',
        }),
      }),
    );
  });

  test('unknown slug → 404 (no contact/deal/analytics writes)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
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
    prisma.landingPage.findFirst.mockResolvedValue({
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

  test('re-registration after contact deletion restores the soft-deleted contact', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, email: 'returning@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/live-page/submit')
      .send({ email: 'returning@example.com', name: 'Returning User' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const upsertArgs = prisma.contact.upsert.mock.calls[0][0];
    // The update branch must clear deletedAt so a previously-deleted contact
    // becomes visible again and the newly-created deal shows up in leads lists.
    expect(upsertArgs.update).toMatchObject({
      source: 'inbound:webform',
      deletedAt: null,
    });
    expect(prisma.deal.create).toHaveBeenCalled();
  });
});

// ─── PUBLIC POST /:slug/submit — Phase 3 hybrid registration-draft branch ─

describe('POST /p/:slug/submit (registration-draft branch — trip-linked + mode)', () => {
  // Minimal Wanderlux templatePayload that triggers the registration-draft
  // path via page.content.register.mode === 'registration-draft'. Generic
  // block-array pages can also trigger via formProps.mode (covered below).
  const wanderluxContent = JSON.stringify({
    register: { mode: 'registration-draft', steps: [{ id: 'student' }] },
  });

  test('happy path: trip-linked Wanderlux page creates PendingTripRegistration + returns microsite redirect with opaque token', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100, subBrand: 'tmc',
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({
      id: 7001, tenantId: 1, tripId: 100, status: 'DRAFT', otpVerified: false,
      draftToken: 'aaaa1111bbbb2222cccc3333dddd4444',
    });
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      publicUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      publishedAt: new Date(),
      expiresAt: null,
    });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });
    prisma.contact.upsert.mockResolvedValue({ id: 8001, tenantId: 1 });

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        student: { name: 'Aarav Iyer', dob: '2010-04-12', school: 'DPS North' },
        parent: { name: 'Rohan Iyer', email: 'rohan@example.com', phone: '+919876543210' },
        passport: { number: 'M1234567', expiry: '2031-09-01' },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      draftId: 7001,
      redirect: {
        type: 'microsite',
        // URL must carry ONLY the opaque draftToken — no PII fields
        url: expect.stringMatching(/^\/p\/tripmicrosite\/[0-9a-f-]+\?draftToken=[0-9a-f]{64}$/),
      },
    });
    // PII must NOT appear in the redirect URL
    expect(res.body.redirect.url).not.toContain('Aarav');
    expect(res.body.redirect.url).not.toContain('rohan@example.com');
    expect(res.body.redirect.url).not.toContain('919876543210');
    expect(res.body.redirect.url).not.toContain('M1234567');

    // PendingTripRegistration row was created with the right shape
    expect(prisma.pendingTripRegistration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 1,
        tripId: 100,
        landingPageId: 50,
        studentName: 'Aarav Iyer',
        studentSchool: 'DPS North',
        parentName: 'Rohan Iyer',
        parentEmail: 'rohan@example.com',
        parentPhone: '+919876543210',
        passportNumber: 'M1234567',
        subBrand: 'tmc',
        status: 'DRAFT',
        otpVerified: false,
      }),
    });
    // draftToken is 64 hex chars and TTL is ~72h ahead
    const created = prisma.pendingTripRegistration.create.mock.calls[0][0].data;
    expect(created.draftToken).toMatch(/^[0-9a-f]{64}$/);
    const ttlHours = (created.draftTokenExpiresAt.getTime() - Date.now()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(70);
    expect(ttlHours).toBeLessThan(73);

    // Contact + Deal are also created so the registration appears in leads
    // and travel-leads lists, not just the TMC trip participants tab.
    expect(prisma.contact.upsert).toHaveBeenCalled();
    const draftContactCreate = prisma.contact.upsert.mock.calls[0][0].create;
    expect(draftContactCreate.source).toBe('tmc_registration');
    expect(draftContactCreate.firstTouchSource).toBe('Landing Page: Bali Trip');
    expect(prisma.deal.create).toHaveBeenCalled();

    // Analytics still recorded for funnel reporting
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

  test('falls back to thank-you (no redirect) when trip has no published microsite', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100,
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({
      id: 7002, status: 'DRAFT',
      draftToken: 'token',
    });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null); // no microsite yet

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        student: { name: 'Priya Singh' },
        parent: { name: 'Anil Singh', email: 'anil@example.com', phone: '+919811112222' },
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      draftId: 7002,
      redirect: { type: 'thanks' },
    });
    // Draft still created — the microsite-less state doesn't block onboarding
    expect(prisma.pendingTripRegistration.create).toHaveBeenCalled();
  });

  test('falls back to thank-you when microsite is unpublished (publishedAt null)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1', tenantId: 1, tripId: 100,
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({ id: 7003, draftToken: 't' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      publicUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      publishedAt: null, // unpublished draft
      expiresAt: null,
    });
    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        student: { name: 'X' },
        parent: { name: 'Y', email: 'y@e.com', phone: '+911234567890' },
      });
    expect(res.status).toBe(201);
    expect(res.body.redirect).toMatchObject({ type: 'thanks' });
  });

  test('falls back to thank-you when microsite has expired', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1', tenantId: 1, tripId: 100,
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({ id: 7004, draftToken: 't' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      publicUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      publishedAt: new Date('2026-01-01'),
      expiresAt: new Date('2026-02-01'), // past
    });
    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        student: { name: 'X' },
        parent: { name: 'Y', email: 'y@e.com', phone: '+911234567890' },
      });
    expect(res.status).toBe(201);
    expect(res.body.redirect).toMatchObject({ type: 'thanks' });
  });

  test('missing required fields returns 400 MISSING_FIELDS, no draft created', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1', tenantId: 1, tripId: 100,
    });
    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        student: { name: 'Just a student' }, // parent missing entirely
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
  });

  test('accepts flat `fields` shape from Wanderlux dc-runtime (student_name / parent_phone / etc.)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1', tenantId: 1, tripId: 100,
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({ id: 7005, draftToken: 't' });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        fields: {
          student_name: 'Meera Patel',
          student_school: 'St. Xaviers',
          parent_name: 'Kavita Patel',
          parent_email: 'kavita@example.com',
          parent_phone: '+919900112233',
          passport_number: 'N7654321',
        },
      });
    expect(res.status).toBe(201);
    const created = prisma.pendingTripRegistration.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      studentName: 'Meera Patel',
      studentSchool: 'St. Xaviers',
      parentName: 'Kavita Patel',
      parentEmail: 'kavita@example.com',
      parentPhone: '+919900112233',
      passportNumber: 'N7654321',
    });
  });

  test('non-trip-linked page (tripId=null) does NOT take draft branch, falls through to lead-capture', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'plain-marketing', status: 'PUBLISHED', title: 'Plain Marketing',
      content: wanderluxContent, // mode is set, but...
      templateType: 'wanderlux-v1',
      tenantId: 1,
      tripId: null, // ...not trip-linked — falls back to lead-capture
    });
    prisma.contact.upsert.mockResolvedValue({ id: 998, tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/plain-marketing/submit')
      .send({ email: 'leads@example.com', name: 'Lead Person' });
    expect(res.status).toBe(200);
    expect(prisma.contact.upsert).toHaveBeenCalled();
    expect(prisma.deal.create).toHaveBeenCalled();
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();
  });

  test('trip-linked page WITHOUT registration-draft mode falls through to lead-capture (back-compat)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-event-rsvp', status: 'PUBLISHED', title: 'Trip Event RSVP',
      content: '[{"type":"form","props":{"audience":"inquiry"}}]', // plain form block
      templateType: 'travel_destination',
      tenantId: 1, tripId: 100,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 997, tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/trip-event-rsvp/submit')
      .send({ email: 'rsvp@example.com', name: 'Attendee', audience: 'inquiry' });
    expect(res.status).toBe(200);
    expect(prisma.contact.upsert).toHaveBeenCalled();
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();
  });

  test('trip-linked Wanderlux page WITHOUT explicit register.mode defaults to lead mode and creates a TripParticipant', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      // Wanderlux templatePayload but no register.mode — should NOT default to draft
      content: JSON.stringify({ register: { steps: [{ id: 'student' }] } }),
      templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 997, email: 'parent@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        fields: {
          student_name: 'Ananya Rao',
          name: 'Ravi Rao',
          email: 'parent@example.com',
          phone: '+919876543210',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Must NOT create a PendingTripRegistration — that would show as a draft row
    // with limited actions and would not be counted in the participant stat.
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();
    // Must create a real TripParticipant so actions/counts stay in sync.
    expect(prisma.contact.upsert).toHaveBeenCalled();
    expect(prisma.deal.create).toHaveBeenCalled();
    expect(prisma.tripParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 100,
          fullName: 'Ananya Rao',
          parentName: 'Ravi Rao',
          parentEmail: 'parent@example.com',
          parentPhone: '+919876543210',
          applicationStatus: 'pending',
        }),
      }),
    );
  });

  test('explicit formProps.mode="registration-draft" on a generic block also triggers the draft branch', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'custom-trip', status: 'PUBLISHED', title: 'Custom Trip',
      // Generic block-array page with mode=registration-draft on the form block
      content: JSON.stringify([
        {
          type: 'registrationForm',
          props: {
            mode: 'registration-draft',
            audience: 'tmc',
          },
        },
      ]),
      templateType: 'travel_destination',
      tenantId: 1, tripId: 100,
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({ id: 7006, draftToken: 't' });
    prisma.contact.upsert.mockResolvedValue({ id: 8002, tenantId: 1 });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/p/custom-trip/submit')
      .send({
        audience: 'tmc',
        student: { name: 'Sara K' },
        parent: { name: 'Ravi K', email: 'ravi@example.com', phone: '+919555555555' },
      });
    expect(res.status).toBe(201);
    expect(prisma.pendingTripRegistration.create).toHaveBeenCalled();
    expect(prisma.contact.upsert).toHaveBeenCalled();
    expect(prisma.deal.create).toHaveBeenCalled();
    // Audience metadata flows through to the draft row
    expect(prisma.pendingTripRegistration.create.mock.calls[0][0].data.audience).toBe('tmc');
  });

  test('brochureRequest=true bypasses registration-draft and creates a lead instead', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100, subBrand: 'tmc',
    });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        brochureRequest: true,
        parentName: 'Rohan Iyer',
        email: 'rohan@example.com',
        phone: '+919876543210',
      });

    expect(res.status).toBe(200);
    // Brochure requests should never create a PendingTripRegistration.
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();
    // They should fall through to the lead-capture path.
    expect(prisma.contact.upsert).toHaveBeenCalled();
    expect(prisma.deal.create).toHaveBeenCalled();
  });

  test('type=brochure (Wanderlux payload) bypasses registration-draft and maps camelCase fields', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: wanderluxContent, templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100, subBrand: 'tmc',
    });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/p/trip-bali2026/submit')
      .send({
        type: 'brochure',
        fields: {
          parentName: 'Rohan Iyer',
          email: 'rohan@example.com',
          phone: '+919876543210',
          school: 'DPS North',
        },
      });

    expect(res.status).toBe(200);
    expect(prisma.pendingTripRegistration.create).not.toHaveBeenCalled();
    expect(prisma.contact.upsert).toHaveBeenCalled();
    const upsertArgs = prisma.contact.upsert.mock.calls[0][0];
    expect(upsertArgs.create.name).toBe('Rohan Iyer');
    expect(upsertArgs.create.email).toBe('rohan@example.com');
    expect(upsertArgs.create.phone).toBe('+919876543210');
    expect(upsertArgs.create.company).toBe('DPS North');
    expect(upsertArgs.create.subBrand).toBe('tmc');
    expect(prisma.deal.create).toHaveBeenCalled();
  });
});

// ─── PUBLIC GET /:slug/track ──────────────────────────────────────────

describe('GET /p/:slug/track (public 1×1 pixel, no auth)', () => {
  test('happy path: returns 1×1 GIF with no-store cache; analytics event logged', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
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
    prisma.landingPage.findFirst.mockResolvedValue(null);
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
    // Default path: full analytics-bearing select. PR-A added 6 fields
    // total — 4 travel metadata (destination / subBrand / generatedByAi /
    // generatedAt) so the list grid can render sub-brand chips + "AI
    // draft" badges, plus 2 featured fields (isFeatured / featuredAt) so
    // it can render the "★ Featured" badge + Feature / Unfeature button.
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
      destination: true,
      subBrand: true,
      generatedByAi: true,
      generatedAt: true,
      isFeatured: true,
      featuredAt: true,
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

// ─── D1 follow-up: draft-preview workflow ─────────────────────────────

describe('POST /api/landing-pages/:id/preview-token (mint short-lived token)', () => {
  test('without Bearer → 401', async () => {
    const res = await request(makeApp()).post('/api/landing-pages/77/preview-token');
    expect(res.status).toBe(401);
    expect(prisma.landingPage.findFirst).not.toHaveBeenCalled();
  });

  test('returns { token, pageId, slug } for an authenticated tenant-owned page', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 77, slug: 'japan-2026', title: 'Japan' });
    const res = await request(makeApp())
      .post('/api/landing-pages/77/preview-token')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.pageId).toBe(77);
    expect(res.body.slug).toBe('japan-2026');
    expect(typeof res.body.token).toBe('string');
    // The minted token must be a valid JWT carrying the expected claims.
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.previewOnly).toBe(true);
    expect(decoded.previewLandingPageId).toBe(77);
    expect(decoded.tenantId).toBe(1);
    // 5-minute expiry (give a small buffer for clock drift).
    expect(decoded.exp - decoded.iat).toBeGreaterThanOrEqual(295);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(310);
  });

  test('404 when page belongs to a different tenant', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/landing-pages/77/preview-token')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 99 })}`);
    expect(res.status).toBe(404);
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 77, tenantId: 99 }) })
    );
  });

  test('400 on non-numeric page id', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/abc/preview-token')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('GET /api/landing-pages/:id/preview (render through production renderer)', () => {
  function makePreviewToken({ landingPageId = 77, tenantId = 1, expiresIn = '5m', previewOnly = true } = {}) {
    const payload = { previewOnly, tenantId };
    if (landingPageId != null) payload.previewLandingPageId = landingPageId;
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
  }

  test('rejects request without any auth credential → 401 HTML', async () => {
    const res = await request(makeApp()).get('/api/landing-pages/77/preview');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Preview unavailable');
    expect(prisma.landingPage.findFirst).not.toHaveBeenCalled();
  });

  test('valid preview token → renders the production HTML for the page', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 77,
      slug: 'japan-2026',
      title: 'Japan 2026',
      status: 'DRAFT',
      tenantId: 1,
      templateType: 'educational-trip-v1',
      content: JSON.stringify({ hero: { headline: 'Where Exposure Becomes Perspective' } }),
    });
    const token = makePreviewToken();
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    // The page renders through the production template.
    expect(res.text).toContain('<div class="trips-page">');
    expect(res.text).toContain('Where Exposure Becomes Perspective');
  });

  test('preview renders DRAFT pages (the /p/:slug route would redirect to /trips)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 77, slug: 's', title: 'T', status: 'DRAFT', tenantId: 1, content: '[]',
    });
    const token = makePreviewToken();
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${token}`);
    expect(res.status).toBe(200);
  });

  test('preview suppresses the analytics tracking pixel', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 77, slug: 's', title: 'T', status: 'PUBLISHED', tenantId: 1,
      templateType: 'educational-trip-v1',
      content: JSON.stringify({ hero: { headline: 'X' } }),
    });
    const token = makePreviewToken();
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${token}`);
    expect(res.status).toBe(200);
    // The production render injects an analytics pixel; the preview path
    // must NOT (so operator previews don't inflate visits).
    expect(res.text).not.toContain('/api/pages/s/track?event=VISIT');
  });

  test('expired preview token → 401', async () => {
    const token = makePreviewToken({ expiresIn: '-1s' });
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${token}`);
    expect(res.status).toBe(401);
  });

  test('preview token for a different page id → 401', async () => {
    const token = makePreviewToken({ landingPageId: 999 });
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${token}`);
    expect(res.status).toBe(401);
  });

  test('non-preview JWT (operator auth token) → 401 when supplied as previewToken', async () => {
    // A regular operator JWT lacks `previewOnly: true` — must not be
    // accepted by the preview query-param path.
    const adminToken = tokenFor();
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${adminToken}`);
    expect(res.status).toBe(401);
  });

  test('Authorization header path also works (programmatic callers)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 77, slug: 's', title: 'T', status: 'DRAFT', tenantId: 1, content: '[]',
    });
    const res = await request(makeApp())
      .get('/api/landing-pages/77/preview')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('cross-tenant preview token blocked by findFirst tenant filter', async () => {
    // The preview-token carries tenantId=99; the page is in tenant 1.
    // findFirst with where: { id: 77, tenantId: 99 } → null.
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const token = makePreviewToken({ tenantId: 99 });
    const res = await request(makeApp()).get(`/api/landing-pages/77/preview?previewToken=${token}`);
    expect(res.status).toBe(404);
  });
});

// ─── D1 template catalogue surface (LandingPages picker depends on this) ─

describe('GET /api/landing-pages/template-catalogue (Phase D1 picker)', () => {
  test('without Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/landing-pages/template-catalogue');
    expect(res.status).toBe(401);
  });

  test('returns the registered premium-template catalogue with defaultContent', async () => {
    const res = await request(makeApp())
      .get('/api/landing-pages/template-catalogue')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    const ids = res.body.templates.map((t) => t.id);
    // Road A (2026-06-23): the operator-facing picker now exposes ONLY
    // the Wanderlux dynamic generator. The four family templates remain
    // registered for backwards-compat but are not picker-visible.
    expect(ids).toEqual(['wanderlux-v1']);
    const tmpl = res.body.templates.find((t) => t.id === 'wanderlux-v1');
    expect(tmpl.title).toBeTruthy();
    expect(tmpl.description).toBeTruthy();
    expect(tmpl.status).toBe('ready');
    expect(tmpl.defaultContent).toBeTruthy();
    expect(typeof tmpl.defaultContent).toBe('object');
    expect(tmpl.schema).toBeTruthy();
    expect(Array.isArray(tmpl.schema.editorSlots)).toBe(true);
  });
});

// ─── publish-gate MISSING_FORM accepts all 3 lead-capture block types ─

describe('GET /api/landing-pages/:id/publish-check — lead-capture surfaces', () => {
  // Minimal travel page that satisfies every other gate check (hero with
  // headline + poster, ≥3 highlights, itinerary with day, tier with
  // amount, ≥4 FAQs, ≥3 inclusions, ≥3 cities with images). The lead-
  // capture block is the only variable across these tests.
  function travelPageScaffold(leadCaptureBlock) {
    const blocks = [
      { type: 'destinationHero', props: { headline: 'Trip', posterUrl: '/poster.jpg' } },
      { type: 'highlightsGrid', props: { items: [
        { icon: '◈', title: 'A', body: 'a' },
        { icon: '◇', title: 'B', body: 'b' },
        { icon: '◉', title: 'C', body: 'c' },
      ] } },
      { type: 'cityCards', props: { cards: [
        { tag: 'X', title: 'X', img: '/x.jpg', body: 'x' },
        { tag: 'Y', title: 'Y', img: '/y.jpg', body: 'y' },
        { tag: 'Z', title: 'Z', img: '/z.jpg', body: 'z' },
      ] } },
      { type: 'inclusionsGrid', props: { items: ['Flight', 'Hotel', 'Visa'] } },
      { type: 'itineraryTimeline', props: { days: [
        { day: 1, title: 'Day 1', bullets: ['Arrive'] },
      ] } },
      { type: 'tierPricing', props: { tiers: [{ step: 1, label: 'Deposit', amount: '50,000' }] } },
      { type: 'faqAccordion', props: { faqs: [
        { cat: 'tour', q: 'Q1?', a: 'A1.' },
        { cat: 'tour', q: 'Q2?', a: 'A2.' },
        { cat: 'safety', q: 'Q3?', a: 'A3.' },
        { cat: 'safety', q: 'Q4?', a: 'A4.' },
      ] } },
    ];
    if (leadCaptureBlock) blocks.push(leadCaptureBlock);
    return {
      id: 88, tenantId: 1, status: 'DRAFT',
      title: 'Bali 7-Day School Trip',
      slug: 'bali-school-trip-7d',
      templateType: 'travel_destination',
      content: JSON.stringify(blocks),
    };
  }

  test('travel page with ZERO lead-capture blocks → MISSING_FORM issue', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(travelPageScaffold(null));
    const res = await request(makeApp())
      .get('/api/landing-pages/88/publish-check')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const codes = res.body.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_FORM');
  });

  test('travel page with a generic `form` block → no MISSING_FORM (legacy contract)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(travelPageScaffold({
      type: 'form',
      props: { fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] },
    }));
    const res = await request(makeApp())
      .get('/api/landing-pages/88/publish-check')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const codes = res.body.issues.map((i) => i.code);
    expect(codes).not.toContain('MISSING_FORM');
  });

  test('travel page with a `registrationForm` block → no MISSING_FORM (PR-C addition)', async () => {
    // This is the regression from the Bali school-trip UAT screenshot:
    // the page had a registrationForm + brochureDownload but the gate
    // only accepted `form`, so publish was wrongly blocked.
    prisma.landingPage.findFirst.mockResolvedValue(travelPageScaffold({
      type: 'registrationForm',
      props: { audience: 'tmc-school', fields: [{ name: 'email', label: 'Email', type: 'email' }] },
    }));
    const res = await request(makeApp())
      .get('/api/landing-pages/88/publish-check')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const codes = res.body.issues.map((i) => i.code);
    expect(codes).not.toContain('MISSING_FORM');
    expect(res.body.ok).toBe(true);
  });

  test('travel page with a `brochureDownload` block in form mode (fileUrl empty) → no MISSING_FORM', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(travelPageScaffold({
      type: 'brochureDownload',
      props: { fileUrl: null, formFields: [{ name: 'email', label: 'Email', type: 'email' }] },
    }));
    const res = await request(makeApp())
      .get('/api/landing-pages/88/publish-check')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const codes = res.body.issues.map((i) => i.code);
    expect(codes).not.toContain('MISSING_FORM');
    expect(res.body.ok).toBe(true);
  });

  test('travel page with brochureDownload in DIRECT-DOWNLOAD mode (fileUrl set) → STILL MISSING_FORM', async () => {
    // A brochure block with a fileUrl is a direct PDF download — there's
    // no lead capture. The gate must NOT accept it as a lead-capture
    // surface (defence-in-depth so an operator doesn't accidentally
    // publish a page with no lead intake).
    prisma.landingPage.findFirst.mockResolvedValue(travelPageScaffold({
      type: 'brochureDownload',
      props: { fileUrl: '/uploads/brochures/bali.pdf' },
    }));
    const res = await request(makeApp())
      .get('/api/landing-pages/88/publish-check')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const codes = res.body.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_FORM');
  });

  test('non-travel pages don\'t trigger travel-only gates', async () => {
    // The MISSING_FORM gate is travel-only — generic pages skip the
    // travel block checks.
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 90, tenantId: 1, status: 'DRAFT',
      title: 'Lead Capture',
      slug: 'lead-capture',
      templateType: 'lead_capture',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    const res = await request(makeApp())
      .get('/api/landing-pages/90/publish-check')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const codes = res.body.issues.map((i) => i.code);
    expect(codes).not.toContain('MISSING_FORM');
  });
});

// ─── public submit: lead-routing also recognises brochureDownload ─────

describe('POST /p/:slug/submit — recognises all lead-capture block types', () => {
  test('brochureRequest body picks the brochureDownload block for routing', async () => {
    // Page has both a registrationForm AND a brochureDownload. The
    // submit body carries `brochureRequest: true`, so the routing
    // logic should prefer the brochureDownload block (its own
    // leadRoutingRuleId applies, not the registrationForm's).
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 91, slug: 'bali', tenantId: 1, title: 'Bali',
      content: JSON.stringify([
        { type: 'registrationForm', props: { audience: 'tmc-school', leadRoutingRuleId: '101' } },
        { type: 'brochureDownload', props: { fileUrl: null, leadRoutingRuleId: '202' } },
      ]),
    });
    prisma.contact.upsert.mockResolvedValue({ id: 1001 });
    prisma.contact.update.mockResolvedValue({});
    // Routing rule 202 is the brochure one.
    prisma.leadRoutingRule.findFirst.mockImplementation(async (args) => {
      if (args.where.id === 202) return { id: 202, assignType: 'user', assignTo: '42', tenantId: 1, isActive: true };
      return null;
    });
    const res = await request(makeApp())
      .post('/p/bali/submit')
      .set('Content-Type', 'application/json')
      .send({ brochureRequest: true, name: 'Test Parent', email: 'parent@test.local', phone: '+919999999999' });
    expect(res.status).toBe(200);
    // The brochure rule's user (id 42) was assigned, not the reg form's.
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: 42 }) })
    );
  });

  test('audience body picks the matching registrationForm block (not the brochure)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 92, slug: 'umrah', tenantId: 1, title: 'Umrah',
      content: JSON.stringify([
        { type: 'registrationForm', props: { audience: 'tmc-school', leadRoutingRuleId: '101' } },
        { type: 'brochureDownload', props: { fileUrl: null, leadRoutingRuleId: '202' } },
      ]),
    });
    prisma.contact.upsert.mockResolvedValue({ id: 1002 });
    prisma.contact.update.mockResolvedValue({});
    prisma.leadRoutingRule.findFirst.mockImplementation(async (args) => {
      if (args.where.id === 101) return { id: 101, assignType: 'user', assignTo: '7', tenantId: 1, isActive: true };
      return null;
    });
    const res = await request(makeApp())
      .post('/p/umrah/submit')
      .set('Content-Type', 'application/json')
      .send({ audience: 'tmc-school', name: 'Test', email: 't@test.local' });
    expect(res.status).toBe(200);
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: 7 }) })
    );
  });

  test('fallback path also accepts brochureDownload (no audience, no brochureRequest flag)', async () => {
    // A page with ONLY a brochureDownload block (lead-capture mode)
    // still routes via that block's leadRoutingRuleId.
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 93, slug: 'goa', tenantId: 1, title: 'Goa',
      content: JSON.stringify([
        { type: 'brochureDownload', props: { fileUrl: null, leadRoutingRuleId: '303' } },
      ]),
    });
    prisma.contact.upsert.mockResolvedValue({ id: 1003 });
    prisma.contact.update.mockResolvedValue({});
    prisma.leadRoutingRule.findFirst.mockImplementation(async (args) => {
      if (args.where.id === 303) return { id: 303, assignType: 'user', assignTo: '9', tenantId: 1, isActive: true };
      return null;
    });
    const res = await request(makeApp())
      .post('/p/goa/submit')
      .set('Content-Type', 'application/json')
      .send({ name: 'Test', email: 't@test.local' });
    expect(res.status).toBe(200);
    expect(prisma.contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: 9 }) })
    );
  });
});

// ─── AUTHENTICATED POST /:id/submit (new endpoint) ────────────────────────

describe('POST /api/landing-pages/:id/submit (authenticated endpoint, ID-based)', () => {
  test('401 Unauthorized without Bearer token', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .send({ email: 'asha@example.com', name: 'Asha' });
    // verifyToken blocks the request with 401 RFC-7235 contract
    expect(res.status).toBe(401);
  });

  test('happy path WITH auth: upserts contact, creates deal, increments submissions, returns success + successRedirectUrl', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: JSON.stringify([{ type: 'form', props: { successRedirectUrl: '/thank-you' } }]), tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, email: 'asha@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ email: 'asha@example.com', name: 'Asha Iyer', phone: '+919876543210', company: 'Acme Inc' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.message).toMatch(/thank you/i);
    expect(res.body.successRedirectUrl).toBe('/thank-you');

    // Contact upsert uses the composite email_tenantId unique key
    expect(prisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email_tenantId: { email: 'asha@example.com', tenantId: 1 } },
      }),
    );
    // Deal created with stage="lead" and the page's tenantId
    expect(prisma.deal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: 'lead',
          contactId: 999,
          tenantId: 1,
        }),
      }),
    );
    // submissions incremented + FORM_SUBMIT event logged
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

  test('404 for invalid page ID', async () => {
    prisma.landingPage.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/landing-pages/999/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ email: 'asha@example.com', name: 'Asha' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  test('trip-linked registration creates Contact + Deal + TripParticipant', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 51, slug: 'australia-2026', status: 'PUBLISHED', title: 'Australia 7-Day Tour',
      content: '[]', templateType: 'travel_destination',
      tenantId: 1, tripId: 7,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 500, email: 'parent@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 51, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/51/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        fields: {
          student_name: 'Aarav Iyer',
          student_grade: '8th Grade',
          name: 'Ravi Iyer',
          email: 'parent@example.com',
          phone: '+919876543210',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Contact created with tmc_registration source
    const createArgs = prisma.contact.upsert.mock.calls[0][0].create;
    expect(createArgs.source).toBe('tmc_registration');

    // Deal created
    expect(prisma.deal.create).toHaveBeenCalled();

    // TripParticipant lookup + creation
    expect(prisma.tripParticipant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tripId: 7,
          fullName: 'Aarav Iyer',
        }),
      }),
    );
  });

  test('brochure request uses brochure_request source, no participant created', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: '[]',
      templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100, subBrand: 'tmc',
    });
    prisma.contact.upsert.mockResolvedValue({ id: 501, tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        brochureRequest: true,
        parentName: 'Rohan Iyer',
        email: 'rohan@example.com',
        phone: '+919876543210',
      });

    expect(res.status).toBe(200);
    const createArgs = prisma.contact.upsert.mock.calls[0][0].create;
    expect(createArgs.source).toBe('brochure_request');
    // TripParticipant should NOT be created for brochure requests
    expect(prisma.tripParticipant.create).not.toHaveBeenCalled();
  });

  test('registration-draft mode branches to handleRegistrationDraft', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'trip-bali2026', status: 'PUBLISHED', title: 'Bali Trip',
      content: JSON.stringify({
        register: { mode: 'registration-draft', steps: [{ id: 'student' }] },
      }),
      templateType: 'wanderlux-v1',
      tenantId: 1, tripId: 100, subBrand: 'tmc',
    });
    prisma.pendingTripRegistration.create.mockResolvedValue({
      id: 7001, tenantId: 1, tripId: 100, status: 'DRAFT', otpVerified: false,
      draftToken: 'aaaa1111bbbb2222cccc3333dddd4444',
    });
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      publicUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      publishedAt: new Date(),
      expiresAt: null,
    });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });
    prisma.contact.upsert.mockResolvedValue({ id: 8001, tenantId: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        student: { name: 'Aarav Iyer', dob: '2010-04-12', school: 'DPS North' },
        parent: { name: 'Rohan Iyer', email: 'rohan@example.com', phone: '+919876543210' },
      });

    expect(res.status).toBe(201); // handleRegistrationDraft returns 201 Created
    expect(res.body.ok).toBe(true); // registration-draft returns {ok:true}, not {success:true}
    // PendingTripRegistration should be created (not direct TripParticipant)
    expect(prisma.pendingTripRegistration.create).toHaveBeenCalled();
  });

  test('generic landing-page lead uses inbound:webform source + preserves page attribution', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Marketing Campaign',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, email: 'asha@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ email: 'asha@example.com', name: 'Asha Iyer', phone: '+919876543210' });

    expect(res.status).toBe(200);
    const createArgs = prisma.contact.upsert.mock.calls[0][0].create;
    expect(createArgs.source).toBe('inbound:webform');
    expect(createArgs.firstTouchSource).toBe('Landing Page: Marketing Campaign');
  });

  test('submission without email synthesises placeholder address (anonymous tracking)', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 1001, tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Anon User' }); // no email

    expect(res.status).toBe(200);
    const upsertArgs = prisma.contact.upsert.mock.calls[0][0];
    // Synthesised placeholder: "lp-<slug>-<ts>@anonymous.local"
    expect(upsertArgs.where.email_tenantId.email).toMatch(/^lp-live-page-\d+@anonymous\.local$/);
  });

  test('re-registration after contact deletion restores soft-deleted contact', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: '[]', tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, email: 'returning@example.com', tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ email: 'returning@example.com', name: 'Returning User' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const upsertArgs = prisma.contact.upsert.mock.calls[0][0];
    // The update branch must clear deletedAt
    expect(upsertArgs.update).toMatchObject({
      source: 'inbound:webform',
      deletedAt: null,
    });
  });

  test('CAPTCHA verification gated on TURNSTILE_SECRET_KEY env var', async () => {
    prisma.landingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'live-page', status: 'PUBLISHED', title: 'Live Page',
      content: JSON.stringify([{ type: 'form', props: { enableCaptcha: true } }]),
      tenantId: 1,
    });
    prisma.contact.upsert.mockResolvedValue({ id: 999, tenantId: 1 });
    prisma.landingPage.update.mockResolvedValue({ id: 50, submissions: 1 });

    const res = await request(makeApp())
      .post('/api/landing-pages/50/submit')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        email: 'asha@example.com',
        name: 'Asha',
        cfTurnstileToken: 'invalid-token'
      });

    // Without TURNSTILE_SECRET_KEY, verification is skipped and submission succeeds
    // (see lib/middleware/captcha.js verifyTurnstile — returns true when env var not set)
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
