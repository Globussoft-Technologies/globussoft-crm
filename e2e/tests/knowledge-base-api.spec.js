// @ts-check
/**
 * /api/knowledge-base — API smoke spec covering 14 handlers in
 * backend/routes/knowledge_base.js. Public + authed paths.
 *
 *   GET    /public/:tenantSlug/categories      (public)
 *   GET    /public/:tenantSlug/articles        (public)
 *   GET    /public/:tenantSlug/article/:slug   (public)
 *   GET    /categories
 *   POST   /categories
 *   PUT    /categories/:id
 *   DELETE /categories/:id
 *   GET    /articles
 *   GET    /articles/:id
 *   POST   /articles
 *   PUT    /articles/:id
 *   DELETE /articles/:id
 *   POST   /articles/:id/publish
 *   POST   /articles/:id/view
 *
 * (UI smoke for the portal lives in knowledge-base.spec.js; this is API-only.)
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EMAIL = 'admin@globussoft.com';
const PASSWORD = 'password123';

let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const createdArticleIds = [];
const createdCategoryIds = [];

test.describe.configure({ mode: 'serial' });

test.describe('knowledge-base API smoke', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    token = (await login.json()).token;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdArticleIds) {
      await request.delete(`${API}/knowledge-base/articles/${id}`, { headers: auth() }).catch(() => {});
    }
    for (const id of createdCategoryIds) {
      await request.delete(`${API}/knowledge-base/categories/${id}`, { headers: auth() }).catch(() => {});
    }
  });

  // ── Public endpoints (no auth) ───────────────────────────────────
  test('GET /public/:tenantSlug/categories is reachable without auth', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/public/default-org/categories`);
    expect([200, 404]).toContain(res.status());
  });

  test('GET /public/:tenantSlug/categories 404s for unknown tenant', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/public/no-such-tenant-xyz/categories`);
    expect(res.status()).toBe(404);
  });

  test('GET /public/:tenantSlug/articles 404s for unknown tenant', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/public/no-such-tenant-xyz/articles`);
    expect(res.status()).toBe(404);
  });

  test('GET /public/:tenantSlug/article/:slug 404s for unknown tenant', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/public/no-such-tenant-xyz/article/anything`);
    expect(res.status()).toBe(404);
  });

  // ── Authenticated endpoints ──────────────────────────────────────
  test('GET /categories requires auth', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/categories`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /categories returns array with article counts', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/categories`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length) expect(body[0]).toHaveProperty('articleCount');
  });

  test('POST /categories rejects missing name', async ({ request }) => {
    const res = await request.post(`${API}/knowledge-base/categories`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /articles rejects missing title', async ({ request }) => {
    const res = await request.post(`${API}/knowledge-base/articles`, {
      headers: auth(),
      data: { content: 'no title here' },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /articles returns list', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/articles`, { headers: auth() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /articles/:id 400s for invalid id', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/articles/abc`, { headers: auth() });
    expect(res.status()).toBe(400);
  });

  test('GET /articles/:id 404s for unknown id', async ({ request }) => {
    const res = await request.get(`${API}/knowledge-base/articles/99999999`, { headers: auth() });
    expect(res.status()).toBe(404);
  });

  test('Full lifecycle: category → article → view → publish → cleanup', async ({ request }) => {
    const stamp = Date.now();

    // Create category
    const catRes = await request.post(`${API}/knowledge-base/categories`, {
      headers: auth(),
      data: { name: `E2E_AUDIT_cat_${stamp}` },
    });
    expect(catRes.status()).toBe(201);
    const cat = await catRes.json();
    expect(cat.id).toBeTruthy();
    createdCategoryIds.push(cat.id);

    // Update category
    const catUpd = await request.put(`${API}/knowledge-base/categories/${cat.id}`, {
      headers: auth(),
      data: { name: `E2E_AUDIT_cat_renamed_${stamp}` },
    });
    expect(catUpd.status()).toBe(200);

    // Create article
    const artRes = await request.post(`${API}/knowledge-base/articles`, {
      headers: auth(),
      data: {
        title: `E2E_AUDIT_art_${stamp}`,
        content: 'How to do the thing',
        categoryId: cat.id,
        isPublished: false,
      },
    });
    expect(artRes.status()).toBe(201);
    const art = await artRes.json();
    expect(art.id).toBeTruthy();
    createdArticleIds.push(art.id);

    // Get article
    const get = await request.get(`${API}/knowledge-base/articles/${art.id}`, { headers: auth() });
    expect(get.status()).toBe(200);

    // Update article
    const upd = await request.put(`${API}/knowledge-base/articles/${art.id}`, {
      headers: auth(),
      data: { content: 'Updated body' },
    });
    expect(upd.status()).toBe(200);

    // View
    const view = await request.post(`${API}/knowledge-base/articles/${art.id}/view`, {
      headers: auth(),
    });
    expect(view.status()).toBe(200);
    expect((await view.json()).views).toBeGreaterThanOrEqual(1);

    // Publish
    const pub = await request.post(`${API}/knowledge-base/articles/${art.id}/publish`, {
      headers: auth(),
    });
    expect(pub.status()).toBe(200);
    expect((await pub.json()).isPublished).toBe(true);

    // Delete
    const delArt = await request.delete(`${API}/knowledge-base/articles/${art.id}`, { headers: auth() });
    expect(delArt.status()).toBe(200);
    createdArticleIds.splice(createdArticleIds.indexOf(art.id), 1);

    const delCat = await request.delete(`${API}/knowledge-base/categories/${cat.id}`, { headers: auth() });
    expect(delCat.status()).toBe(200);
    createdCategoryIds.splice(createdCategoryIds.indexOf(cat.id), 1);
  });

  test('POST /articles/:id/publish 404s for unknown id', async ({ request }) => {
    const res = await request.post(`${API}/knowledge-base/articles/99999999/publish`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  test('POST /articles/:id/view 404s for unknown id', async ({ request }) => {
    const res = await request.post(`${API}/knowledge-base/articles/99999999/view`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });

  test('DELETE /categories/:id 404s for unknown id', async ({ request }) => {
    const res = await request.delete(`${API}/knowledge-base/categories/99999999`, {
      headers: auth(),
    });
    expect(res.status()).toBe(404);
  });
});
