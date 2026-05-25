// @ts-check
/**
 * Unit tests for backend/routes/knowledge_base.js — pin the contract of the
 * KB article + category CRUD surface + publish/unpublish + tenant isolation.
 *
 * Why this file exists
 * ────────────────────
 * routes/knowledge_base.js (378 LOC) had ZERO vitest coverage prior to this
 * file. It owns KbArticle + KbCategory CRUD with auto-slug generation,
 * publish/unpublish flip handlers, a view counter (best-effort increment),
 * and a /public/:tenantSlug subtree that resolves tenant by slug for the
 * unauthenticated public knowledge base. Tenant isolation is enforced via
 * findFirst({ id, tenantId }) before every mutation, and the DELETE handlers
 * return 204 No Content per the #550 sweep. Silent drift on any of these
 * would either red the KB public-site renderer OR (worse) leak articles
 * across tenants when an operator mis-types a slug.
 *
 * Endpoints under test (14 total)
 * ───────────────────────────────
 *   PUBLIC (no auth):
 *     1. GET    /public/:tenantSlug/categories
 *     2. GET    /public/:tenantSlug/articles?categoryId=
 *     3. GET    /public/:tenantSlug/article/:slug
 *
 *   AUTHENTICATED:
 *     4. GET    /categories                       — with articleCount
 *     5. POST   /categories                       — auto-slug
 *     6. PUT    /categories/:id                   — tenant-scoped
 *     7. DELETE /categories/:id                   — 204 + detach articles
 *     8. GET    /articles?categoryId=&published=
 *     9. GET    /articles/:id
 *    10. POST   /articles                         — auto-slug + default unpublished
 *    11. PUT    /articles/:id                     — slug auto-regen on title change
 *    12. DELETE /articles/:id                     — 204
 *    13. POST   /articles/:id/publish
 *    14. POST   /articles/:id/unpublish
 *    15. POST   /articles/:id/view                — counter increment
 *
 * Cases (24 total)
 * ────────────────
 *   public categories: 404 when tenant slug unknown; 200 lists with PUBLISHED
 *     article counts only (2)
 *   public articles: 200 filters by isPublished:true + categoryId (1)
 *   public article: 404 when slug unknown OR article unpublished; 200 with
 *     best-effort view increment (2)
 *   GET categories: 200 with articleCount + tenant-scoped (1)
 *   POST categories: 400 when name missing; 201 happy with slugified slug;
 *     parentId coerced to int (3)
 *   PUT categories: 400 invalid id; 404 cross-tenant; 200 partial update +
 *     slug regen on rename (3)
 *   DELETE categories: 204 + detaches articles via updateMany (1)
 *   GET articles: filters tenant + categoryId + published=true|false (1)
 *   POST articles: 400 when title missing; 201 default isPublished=false;
 *     ensureUniqueSlug appends -2 when slug collides (3)
 *   PUT articles: 200 auto-regen slug when title changes & slug not supplied;
 *     200 explicit slug honored (2)
 *   DELETE articles: 404 cross-tenant; 204 happy (2)
 *   publish/unpublish: 200 flips isPublished true/false (2)
 *   view increment: 200 returns updated views count (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js (prisma singleton monkey-patch +
 * eventBus stub BEFORE requiring the router; fake-auth middleware in
 * makeApp populates req.user). The kb router doesn't require verifyToken on
 * most handlers (the global guard does); the POST /categories handler IS
 * explicitly gated on verifyToken — we skip that gate by injecting req.user
 * upstream of the router. No RBAC role gates on this route, so role is
 * irrelevant.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';

const requireCJS = createRequire(import.meta.url);
const { JWT_SECRET } = requireCJS('../../config/secrets');

/** Sign a real JWT the verifyToken middleware will accept. */
function signToken({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.kbArticle = prisma.kbArticle || {};
prisma.kbArticle.findMany = vi.fn();
prisma.kbArticle.findFirst = vi.fn();
prisma.kbArticle.count = vi.fn();
prisma.kbArticle.create = vi.fn();
prisma.kbArticle.update = vi.fn();
prisma.kbArticle.updateMany = vi.fn();
prisma.kbArticle.delete = vi.fn();
prisma.kbCategory = prisma.kbCategory || {};
prisma.kbCategory.findMany = vi.fn();
prisma.kbCategory.findFirst = vi.fn();
prisma.kbCategory.create = vi.fn();
prisma.kbCategory.update = vi.fn();
prisma.kbCategory.delete = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
// eventBus's best-effort emit walks automationRule.findMany — stub so it
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
// verifyToken middleware checks revokedToken when JWT carries a `jti` claim
// — our signed test JWTs don't include jti, but stub defensively.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// ── eventBus stubs (best-effort writeAudit / route-side emit) ──────────
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const kbRouter = requireCJS('../../routes/knowledge_base');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Role defaults to ADMIN since some handlers (POST
 * /categories) require verifyToken — fake-auth lets us short-circuit.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/knowledge-base', kbRouter);
  return app;
}

beforeEach(() => {
  prisma.kbArticle.findMany.mockReset();
  prisma.kbArticle.findFirst.mockReset();
  prisma.kbArticle.count.mockReset();
  prisma.kbArticle.create.mockReset();
  prisma.kbArticle.update.mockReset();
  prisma.kbArticle.updateMany.mockReset();
  prisma.kbArticle.delete.mockReset();
  prisma.kbCategory.findMany.mockReset();
  prisma.kbCategory.findFirst.mockReset();
  prisma.kbCategory.create.mockReset();
  prisma.kbCategory.update.mockReset();
  prisma.kbCategory.delete.mockReset();
  prisma.tenant.findUnique.mockReset();

  // Sensible defaults — individual tests override.
  prisma.kbArticle.findMany.mockResolvedValue([]);
  prisma.kbArticle.findFirst.mockResolvedValue(null);
  prisma.kbArticle.count.mockResolvedValue(0);
  prisma.kbArticle.create.mockResolvedValue({ id: 1 });
  prisma.kbArticle.update.mockResolvedValue({ id: 1 });
  prisma.kbArticle.updateMany.mockResolvedValue({ count: 0 });
  prisma.kbArticle.delete.mockResolvedValue({ id: 1 });
  prisma.kbCategory.findMany.mockResolvedValue([]);
  prisma.kbCategory.findFirst.mockResolvedValue(null);
  prisma.kbCategory.create.mockResolvedValue({ id: 1 });
  prisma.kbCategory.update.mockResolvedValue({ id: 1 });
  prisma.kbCategory.delete.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS — tenant resolved by slug, no auth
// ─────────────────────────────────────────────────────────────────────────

describe('GET /public/:tenantSlug/categories', () => {
  test('404 when tenant slug is unknown', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/knowledge-base/public/no-such-slug/categories');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tenant not found/i);
    expect(prisma.kbCategory.findMany).not.toHaveBeenCalled();
  });

  test('200 returns categories with PUBLISHED-only article counts', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 42, slug: 'acme' });
    prisma.kbCategory.findMany.mockResolvedValue([
      { id: 1, name: 'Getting Started', slug: 'getting-started', tenantId: 42 },
      { id: 2, name: 'Billing', slug: 'billing', tenantId: 42 },
    ]);
    // Each category gets its own count() call — return 5 then 3.
    prisma.kbArticle.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3);

    const res = await request(makeApp())
      .get('/api/knowledge-base/public/acme/categories');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].articleCount).toBe(5);
    expect(res.body[1].articleCount).toBe(3);
    // PUBLIC view counts only published articles — assert the where filter.
    expect(prisma.kbArticle.count).toHaveBeenCalledWith({
      where: { categoryId: 1, tenantId: 42, isPublished: true },
    });
  });
});

describe('GET /public/:tenantSlug/articles', () => {
  test('200 filters by isPublished:true and optional categoryId', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 42, slug: 'acme' });
    prisma.kbArticle.findMany.mockResolvedValue([
      { id: 1, title: 'Welcome', slug: 'welcome', categoryId: 1, views: 10 },
    ]);

    const res = await request(makeApp())
      .get('/api/knowledge-base/public/acme/articles?categoryId=1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.kbArticle.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, isPublished: true, categoryId: 1 },
      select: {
        id: true, title: true, slug: true, categoryId: true,
        views: true, createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  });
});

describe('GET /public/:tenantSlug/article/:slug', () => {
  test('404 when article slug not found OR unpublished', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 42, slug: 'acme' });
    prisma.kbArticle.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/knowledge-base/public/acme/article/hidden');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/article not found/i);
    // findFirst is gated on isPublished:true so unpublished articles are 404
    expect(prisma.kbArticle.findFirst).toHaveBeenCalledWith({
      where: { slug: 'hidden', tenantId: 42, isPublished: true },
    });
  });

  test('200 returns article and fires best-effort view increment', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 42, slug: 'acme' });
    prisma.kbArticle.findFirst.mockResolvedValue({
      id: 99, title: 'Welcome', slug: 'welcome', content: 'Hi', isPublished: true,
    });

    const res = await request(makeApp())
      .get('/api/knowledge-base/public/acme/article/welcome');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(99);
    // Best-effort increment — must have been called (fire-and-forget, no await)
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { views: { increment: 1 } },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AUTHENTICATED — GET /categories
// ─────────────────────────────────────────────────────────────────────────

describe('GET /categories — list categories with article counts', () => {
  test('200 tenant-scoped findMany ordered by name + per-category articleCount', async () => {
    prisma.kbCategory.findMany.mockResolvedValue([
      { id: 1, name: 'API', slug: 'api' },
      { id: 2, name: 'Onboarding', slug: 'onboarding' },
    ]);
    prisma.kbArticle.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/knowledge-base/categories');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].articleCount).toBe(7);
    expect(prisma.kbCategory.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { name: 'asc' },
    });
    // AUTHENTICATED count — does NOT filter isPublished (includes drafts)
    expect(prisma.kbArticle.count).toHaveBeenCalledWith({
      where: { categoryId: 1, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /categories — create with auto-slug
// ─────────────────────────────────────────────────────────────────────────

describe('POST /categories — create category', () => {
  // POST /categories has an explicit verifyToken middleware — we must
  // present a real signed JWT in the Authorization header. The fake-auth
  // middleware in makeApp() is overwritten by verifyToken's req.user
  // assignment, so the JWT's claims (not fake-auth's) are what reaches
  // the handler.
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/knowledge-base/categories')
      .set('Authorization', `Bearer ${signToken({ tenantId: 1 })}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
    expect(prisma.kbCategory.create).not.toHaveBeenCalled();
  });

  test('201 with auto-slugified slug + tenantId from JWT', async () => {
    prisma.kbCategory.findFirst.mockResolvedValue(null); // no slug collision
    prisma.kbCategory.create.mockResolvedValue({
      id: 99,
      name: 'Hello World!',
      slug: 'hello-world',
      tenantId: 7,
      parentId: null,
    });

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/knowledge-base/categories')
      .set('Authorization', `Bearer ${signToken({ tenantId: 7 })}`)
      .send({ name: 'Hello World!' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    expect(prisma.kbCategory.create).toHaveBeenCalledWith({
      data: {
        name: 'Hello World!',
        slug: 'hello-world', // special chars + spaces collapsed
        parentId: null,
        tenantId: 7,
      },
    });
  });

  test('201 parentId coerced to int when present', async () => {
    prisma.kbCategory.findFirst.mockResolvedValue(null);
    prisma.kbCategory.create.mockResolvedValue({ id: 100 });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/knowledge-base/categories')
      .set('Authorization', `Bearer ${signToken({ tenantId: 1 })}`)
      .send({ name: 'Subcat', parentId: '5' });

    expect(res.status).toBe(201);
    expect(prisma.kbCategory.create.mock.calls[0][0].data.parentId).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /categories/:id — update with cross-tenant 404
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /categories/:id — update category', () => {
  test('400 when :id is not a number', async () => {
    const res = await request(makeApp())
      .put('/api/knowledge-base/categories/not-an-int')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.kbCategory.update).not.toHaveBeenCalled();
  });

  test('404 when category belongs to a different tenant (findFirst returns null)', async () => {
    prisma.kbCategory.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/knowledge-base/categories/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.kbCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.kbCategory.update).not.toHaveBeenCalled();
  });

  test('200 partial update + slug auto-regen on rename', async () => {
    prisma.kbCategory.findFirst
      .mockResolvedValueOnce({ id: 50, tenantId: 1, name: 'Old', slug: 'old' })
      .mockResolvedValueOnce(null); // no collision on the new slug
    prisma.kbCategory.update.mockResolvedValue({
      id: 50, name: 'New Name', slug: 'new-name',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/knowledge-base/categories/50')
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(prisma.kbCategory.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'New Name', slug: 'new-name' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /categories/:id — 204 + detach articles
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /categories/:id — delete category', () => {
  test('204 detaches articles (categoryId→null) then deletes (#550 — DELETE→204 sweep)', async () => {
    prisma.kbCategory.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/knowledge-base/categories/50');

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    // First detach articles, then delete category
    expect(prisma.kbArticle.updateMany).toHaveBeenCalledWith({
      where: { categoryId: 50, tenantId: 1 },
      data: { categoryId: null },
    });
    expect(prisma.kbCategory.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /articles — list with filter
// ─────────────────────────────────────────────────────────────────────────

describe('GET /articles — list articles', () => {
  test('200 filters tenant + optional categoryId + published=true|false', async () => {
    prisma.kbArticle.findMany.mockResolvedValue([
      { id: 1, title: 'A', isPublished: true },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/knowledge-base/articles?categoryId=5&published=true');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.kbArticle.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, categoryId: 5, isPublished: true },
      orderBy: { updatedAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /articles — create with auto-slug
// ─────────────────────────────────────────────────────────────────────────

describe('POST /articles — create article', () => {
  test('400 when title missing', async () => {
    const res = await request(makeApp())
      .post('/api/knowledge-base/articles')
      .send({ content: 'Hi' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title is required/i);
    expect(prisma.kbArticle.create).not.toHaveBeenCalled();
  });

  test('201 default isPublished=false + content defaults to empty string', async () => {
    prisma.kbArticle.findFirst.mockResolvedValue(null); // no slug collision
    prisma.kbArticle.create.mockResolvedValue({
      id: 99, title: 'Quick Start', slug: 'quick-start', isPublished: false,
    });

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/knowledge-base/articles')
      .send({ title: 'Quick Start' });

    expect(res.status).toBe(201);
    expect(prisma.kbArticle.create).toHaveBeenCalledWith({
      data: {
        title: 'Quick Start',
        slug: 'quick-start',
        content: '', // default when not supplied
        categoryId: null,
        isPublished: false, // default
        tenantId: 7,
      },
    });
  });

  test('201 ensureUniqueSlug appends -2 when base slug collides in tenant', async () => {
    // First findFirst → existing article with the base slug (collision).
    // Second findFirst → no collision on -2 suffix.
    prisma.kbArticle.findFirst
      .mockResolvedValueOnce({ id: 1, slug: 'quick-start', tenantId: 7 })
      .mockResolvedValueOnce(null);
    prisma.kbArticle.create.mockResolvedValue({ id: 100 });

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/knowledge-base/articles')
      .send({ title: 'Quick Start' });

    expect(res.status).toBe(201);
    // The suffix-bumping loop should land on 'quick-start-2'.
    expect(prisma.kbArticle.create.mock.calls[0][0].data.slug).toBe('quick-start-2');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /articles/:id — update with slug-regen-on-title-change
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /articles/:id — update article', () => {
  test('200 auto-regens slug when title changes & slug not explicitly supplied', async () => {
    prisma.kbArticle.findFirst
      .mockResolvedValueOnce({ id: 50, tenantId: 1, title: 'Old', slug: 'old' })
      .mockResolvedValueOnce(null); // no collision on regenerated slug
    prisma.kbArticle.update.mockResolvedValue({
      id: 50, title: 'New Title', slug: 'new-title',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/knowledge-base/articles/50')
      .send({ title: 'New Title' });

    expect(res.status).toBe(200);
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { title: 'New Title', slug: 'new-title' },
    });
  });

  test('200 explicit slug honored when supplied (overrides title-based auto-regen)', async () => {
    prisma.kbArticle.findFirst
      .mockResolvedValueOnce({ id: 50, tenantId: 1, title: 'Old', slug: 'old' })
      .mockResolvedValueOnce(null);
    prisma.kbArticle.update.mockResolvedValue({ id: 50 });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/knowledge-base/articles/50')
      .send({ title: 'New Title', slug: 'custom-slug' });

    expect(res.status).toBe(200);
    // Explicit slug wins — gets slugified but not title-derived
    expect(prisma.kbArticle.update.mock.calls[0][0].data.slug).toBe('custom-slug');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /articles/:id — 204 + tenant isolation
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /articles/:id — delete article', () => {
  test('404 when article belongs to a different tenant', async () => {
    prisma.kbArticle.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/knowledge-base/articles/777');

    expect(res.status).toBe(404);
    expect(prisma.kbArticle.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.kbArticle.delete).not.toHaveBeenCalled();
  });

  test('204 No Content on successful delete (#550 — DELETE→204 sweep)', async () => {
    prisma.kbArticle.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/knowledge-base/articles/50');

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.kbArticle.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /articles/:id/publish + /unpublish — isPublished flip
// ─────────────────────────────────────────────────────────────────────────

describe('POST /articles/:id/publish — flip isPublished=true', () => {
  test('200 sets isPublished=true (tenant-scoped lookup first)', async () => {
    prisma.kbArticle.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, isPublished: false,
    });
    prisma.kbArticle.update.mockResolvedValue({
      id: 50, isPublished: true,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/knowledge-base/articles/50/publish');

    expect(res.status).toBe(200);
    expect(res.body.isPublished).toBe(true);
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { isPublished: true },
    });
  });
});

describe('POST /articles/:id/unpublish — flip isPublished=false', () => {
  test('200 sets isPublished=false', async () => {
    prisma.kbArticle.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, isPublished: true,
    });
    prisma.kbArticle.update.mockResolvedValue({
      id: 50, isPublished: false,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/knowledge-base/articles/50/unpublish');

    expect(res.status).toBe(200);
    expect(res.body.isPublished).toBe(false);
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { isPublished: false },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /articles/:id/view — view counter increment
// ─────────────────────────────────────────────────────────────────────────

describe('POST /articles/:id/view — increment view counter', () => {
  test('200 returns updated views count', async () => {
    prisma.kbArticle.findFirst.mockResolvedValue({ id: 50, tenantId: 1, views: 41 });
    prisma.kbArticle.update.mockResolvedValue({ id: 50, views: 42 });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/knowledge-base/articles/50/view');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ views: 42 });
    expect(prisma.kbArticle.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { views: { increment: 1 } },
    });
  });
});
