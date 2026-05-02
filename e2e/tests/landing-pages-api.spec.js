// @ts-check
/**
 * Landing-pages CRUD API — admin surface (/api/landing-pages).
 *
 * G-1 from docs/E2E_GAPS.md. Covers all 10 admin CRUD endpoints on
 * backend/routes/landing_pages.js. The public renderer at /p/:slug is
 * owned by landing-page-renderer.spec.js — this file does NOT duplicate
 * that.
 *
 * Endpoints covered (10):
 *   GET    /api/landing-pages/                — list (own tenant)
 *   GET    /api/landing-pages/templates/list  — hardcoded 4-template catalog
 *   GET    /api/landing-pages/:id             — read
 *   POST   /api/landing-pages/                — create (+ slug validation, dedup, template fill)
 *   PUT    /api/landing-pages/:id             — update (+ slug validation)
 *   DELETE /api/landing-pages/:id
 *   POST   /api/landing-pages/:id/publish     — idempotent (route always 200s)
 *   POST   /api/landing-pages/:id/unpublish   — idempotent (route always 200s)
 *   POST   /api/landing-pages/:id/duplicate
 *   GET    /api/landing-pages/:id/analytics
 *
 * Doc-card-vs-reality drifts found while reading the route:
 *   1. publish/unpublish are IDEMPOTENT — both endpoints return 200 even
 *      on duplicate calls (no 422). Spec asserts the actual behaviour.
 *   2. duplicate inherits status=DRAFT + publishedAt=null from schema
 *      defaults (route never copies those two fields). Spec asserts.
 *   3. POST has 409 dedup-on-title (#339) and 400 slug validation (#378)
 *      — not in the doc card but real and easy to test.
 *
 * Pattern: notifications-api.spec.js. Dual-token across two tenants
 * (generic admin drives main CRUD path, wellness admin drives tenant
 * isolation). Test data tagged E2E_FLOW_LP_<ts> — matches the existing
 * /^E2E_FLOW_/ regex in e2e/test-data-patterns.js. global-teardown does
 * NOT sweep LandingPage rows, so beforeAll pre-cleans any orphan
 * E2E_FLOW_LP_ pages and afterAll deletes everything this run created.
 */
const { test, expect } = require('@playwright/test');

// Serial: helper functions create + track ids, and tenant-isolation
// tests rely on a stable id from the wellness tenant being visible to
// generic admin only as 404. Parallel shuffle would race the cross-
// tenant assertions and the dedup-on-create test.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_LP_${Date.now()}`;

// ── Dual-token auth ────────────────────────────────────────────────
// admin@globussoft.com (ADMIN, generic tenant)  — drives main CRUD
// admin@wellness.demo  (ADMIN, wellness tenant) — drives tenant iso

let genericToken = null;
let genericUserId = null;
let wellnessToken = null;
let wellnessUserId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, userId: j.user.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getGeneric(request) {
  if (!genericToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    genericToken = r.token;
    genericUserId = r.userId;
  }
  return { token: genericToken, userId: genericUserId };
}

async function getWellness(request) {
  if (!wellnessToken) {
    const r = await loginAs(request, 'admin@wellness.demo', 'password123');
    wellnessToken = r.token;
    wellnessUserId = r.userId;
  }
  return { token: wellnessToken, userId: wellnessUserId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function put(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracker keyed by tenant ────────────────────────────────
const createdPagesByTenant = { generic: new Set(), wellness: new Set() };

// Pre-cleanup orphans from prior aborted runs. Demo box has stragglers
// because global-teardown doesn't sweep LandingPage and demo runs with
// E2E_SKIP_SCRUB=1 anyway. Match anything starting with E2E_FLOW_LP_
// in either tenant.
async function purgeOrphansFor(request, tenant) {
  const tok = tenant === 'generic'
    ? (await getGeneric(request)).token
    : (await getWellness(request)).token;
  if (!tok) return;
  const res = await get(request, tok, '/api/landing-pages');
  if (!res.ok()) return;
  const list = await res.json();
  if (!Array.isArray(list)) return;
  const orphans = list.filter((p) => typeof p.title === 'string' && /^E2E_FLOW_LP_/.test(p.title));
  for (const p of orphans) {
    await del(request, tok, `/api/landing-pages/${p.id}`).catch(() => {});
  }
}

test.beforeAll(async ({ request }) => {
  // Warm both tokens up-front so login isn't racing the first test.
  await getGeneric(request);
  await getWellness(request);
  await purgeOrphansFor(request, 'generic');
  await purgeOrphansFor(request, 'wellness');
});

test.afterAll(async ({ request }) => {
  for (const [tenant, ids] of Object.entries(createdPagesByTenant)) {
    const tok = tenant === 'generic'
      ? (await getGeneric(request)).token
      : (await getWellness(request)).token;
    if (!tok) continue;
    for (const id of ids) {
      await del(request, tok, `/api/landing-pages/${id}`).catch(() => {});
    }
  }
});

// Each call to createPage uses a fresh per-call timestamp + counter so
// the dedup-on-create check (case-insensitive title match) doesn't fire
// between unrelated tests.
let titleCounter = 0;
async function createPage(request, tenant, overrides = {}) {
  const tok = tenant === 'generic'
    ? (await getGeneric(request)).token
    : (await getWellness(request)).token;
  if (!tok) throw new Error(`createPage: no ${tenant} token`);
  titleCounter += 1;
  const body = {
    title: overrides.title || `${RUN_TAG} page-${titleCounter}-${Date.now()}`,
    ...overrides,
  };
  // overrides.title wins over the default but if caller provided it we
  // still don't touch the rest.
  if (overrides.title) body.title = overrides.title;
  const res = await post(request, tok, '/api/landing-pages', body);
  expect(res.status(), `createPage(${tenant}): ${await res.text()}`).toBe(201);
  const page = await res.json();
  createdPagesByTenant[tenant].add(page.id);
  return page;
}

// ── GET / list ─────────────────────────────────────────────────────

test.describe('Landing pages API — GET /', () => {
  test('200 returns array shape with documented fields', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} list-shape-${Date.now()}` });
    const res = await get(request, token, '/api/landing-pages');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const row = list.find((p) => p.id === created.id);
    expect(row, 'created page should appear in list').toBeTruthy();
    // Documented field set per the route's `select` clause.
    expect(row).toMatchObject({
      id: created.id,
      title: created.title,
      slug: created.slug,
      status: 'DRAFT',
    });
    expect(typeof row.visits).toBe('number');
    expect(typeof row.submissions).toBe('number');
    expect(typeof row.createdAt).toBe('string');
    expect(typeof row.updatedAt).toBe('string');
    // The list view does NOT include `content` (select clause omits it).
    expect(row.content).toBeUndefined();
  });

  test('list scoped to caller tenant — wellness rows do not leak to generic', async ({ request }) => {
    const { token: genTok } = await getGeneric(request);
    const wellnessPage = await createPage(request, 'wellness', { title: `${RUN_TAG} cross-tenant-list-${Date.now()}` });
    const res = await get(request, genTok, '/api/landing-pages');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.some((p) => p.id === wellnessPage.id)).toBe(false);
  });
});

// ── GET /templates/list ────────────────────────────────────────────

test.describe('Landing pages API — GET /templates/list', () => {
  test('200 returns the 4-template catalog with id/name/description/content', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/landing-pages/templates/list');
    expect(res.status()).toBe(200);
    const tmpls = await res.json();
    expect(Array.isArray(tmpls)).toBe(true);
    expect(tmpls.length).toBe(4);
    const ids = tmpls.map((t) => t.id).sort();
    expect(ids).toEqual(['event_registration', 'lead_capture', 'product_showcase', 'webinar_signup']);
    for (const t of tmpls) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(Array.isArray(t.content)).toBe(true);
    }
  });
});

// ── GET /:id ───────────────────────────────────────────────────────

test.describe('Landing pages API — GET /:id', () => {
  test('200 returns full row including content', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} read-by-id-${Date.now()}` });
    const res = await get(request, token, `/api/landing-pages/${created.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.title).toBe(created.title);
    expect(body.slug).toBe(created.slug);
    expect(body.status).toBe('DRAFT');
    // GET /:id (vs GET /) returns the full Prisma row, including `content`.
    expect(typeof body.content).toBe('string');
  });

  test('404 on unknown numeric id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/landing-pages/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── POST / ─────────────────────────────────────────────────────────

test.describe('Landing pages API — POST / (create)', () => {
  test('201 with auto-generated slug when slug omitted', async ({ request }) => {
    const { token } = await getGeneric(request);
    const title = `${RUN_TAG} auto-slug ${Date.now()}`;
    const res = await post(request, token, '/api/landing-pages', { title });
    expect(res.status(), `auto-slug create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdPagesByTenant.generic.add(body.id);
    expect(body.title).toBe(title.trim());
    // Auto-slug is lowercase a-z0-9- only, max 50 chars.
    expect(body.slug).toMatch(/^[a-z0-9-]+$/);
    expect(body.slug.length).toBeLessThanOrEqual(50);
    expect(body.status).toBe('DRAFT');
    expect(body.publishedAt).toBeNull();
    // Default content when neither content nor templateType supplied is "[]".
    expect(body.content).toBe('[]');
  });

  test('templateType=lead_capture without content hydrates from TEMPLATES catalog', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages', {
      title: `${RUN_TAG} template-fill ${Date.now()}`,
      templateType: 'lead_capture',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdPagesByTenant.generic.add(body.id);
    expect(body.templateType).toBe('lead_capture');
    expect(typeof body.content).toBe('string');
    const parsed = JSON.parse(body.content);
    expect(Array.isArray(parsed)).toBe(true);
    // lead_capture template has a `form` component.
    expect(parsed.some((c) => c && c.type === 'form')).toBe(true);
  });

  test('400 when title missing', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages', {});
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/title.*required/i);
  });

  test('400 when title is whitespace-only', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages', { title: '   ' });
    expect(res.status()).toBe(400);
  });

  test('400 invalid slug — uppercase', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages', {
      title: `${RUN_TAG} bad-slug-upper ${Date.now()}`,
      slug: 'UPPERCASE-NO',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid slug/i);
  });

  test('400 invalid slug — spaces', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages', {
      title: `${RUN_TAG} bad-slug-spaces ${Date.now()}`,
      slug: 'has spaces',
    });
    expect(res.status()).toBe(400);
  });

  test('400 invalid slug — over 50 chars', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages', {
      title: `${RUN_TAG} bad-slug-long ${Date.now()}`,
      slug: 'a'.repeat(51),
    });
    expect(res.status()).toBe(400);
  });

  test('409 dedup-on-create when same-title DRAFT exists in tenant (#339)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const dupeTitle = `${RUN_TAG} dedup-${Date.now()}`;
    const first = await createPage(request, 'generic', { title: dupeTitle });
    const res = await post(request, token, '/api/landing-pages', { title: dupeTitle });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists in Draft/i);
    expect(body.existingId).toBe(first.id);
  });

  test('409 dedup is case-insensitive on title', async ({ request }) => {
    const { token } = await getGeneric(request);
    const baseTitle = `${RUN_TAG} dedup-case-${Date.now()}`;
    await createPage(request, 'generic', { title: baseTitle });
    const res = await post(request, token, '/api/landing-pages', { title: baseTitle.toUpperCase() });
    expect(res.status()).toBe(409);
  });
});

// ── PUT /:id ───────────────────────────────────────────────────────

test.describe('Landing pages API — PUT /:id', () => {
  test('200 partial update merges fields', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} put-merge-${Date.now()}` });
    const newMeta = `${RUN_TAG} meta updated`;
    const res = await put(request, token, `/api/landing-pages/${created.id}`, {
      metaTitle: newMeta,
      metaDescription: 'updated desc',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.metaTitle).toBe(newMeta);
    expect(body.metaDescription).toBe('updated desc');
    // Title not in payload → unchanged.
    expect(body.title).toBe(created.title);
  });

  test('200 content stringifies non-string values', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} put-content-${Date.now()}` });
    const res = await put(request, token, `/api/landing-pages/${created.id}`, {
      content: [{ type: 'heading', props: { text: 'Hello' } }],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.content).toBe('string');
    const parsed = JSON.parse(body.content);
    expect(parsed[0].type).toBe('heading');
  });

  test('400 invalid slug on update (#378)', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} put-bad-slug-${Date.now()}` });
    const res = await put(request, token, `/api/landing-pages/${created.id}`, { slug: 'Bad Slug' });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/invalid slug/i);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await put(request, token, '/api/landing-pages/99999999', { metaTitle: 'x' });
    expect(res.status()).toBe(404);
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────

test.describe('Landing pages API — DELETE /:id', () => {
  test('200 deletes own page; subsequent GET 404', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} delete-target-${Date.now()}` });
    createdPagesByTenant.generic.delete(created.id); // we'll delete here; afterAll skips.
    const res = await del(request, token, `/api/landing-pages/${created.id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);
    const after = await get(request, token, `/api/landing-pages/${created.id}`);
    expect(after.status()).toBe(404);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await del(request, token, '/api/landing-pages/99999999');
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/publish ──────────────────────────────────────────────

test.describe('Landing pages API — POST /:id/publish (idempotent)', () => {
  test('200 sets status=PUBLISHED + publishedAt to a recent ISO', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} publish-1-${Date.now()}` });
    const before = Date.now();
    const res = await post(request, token, `/api/landing-pages/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('PUBLISHED');
    expect(typeof body.publishedAt).toBe('string');
    const ts = Date.parse(body.publishedAt);
    expect(Number.isFinite(ts)).toBe(true);
    // Allow reasonable clock skew (10 minutes).
    expect(Math.abs(ts - before)).toBeLessThan(10 * 60 * 1000);
  });

  test('200 idempotent — publishing an already-published page still returns 200 and bumps publishedAt', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} publish-twice-${Date.now()}` });
    const r1 = await post(request, token, `/api/landing-pages/${created.id}/publish`, {});
    expect(r1.status()).toBe(200);
    const ts1 = Date.parse((await r1.json()).publishedAt);
    // Tiny gap so the second publishedAt is observably different.
    await new Promise((r) => setTimeout(r, 1100));
    const r2 = await post(request, token, `/api/landing-pages/${created.id}/publish`, {});
    expect(r2.status()).toBe(200);
    const body2 = await r2.json();
    expect(body2.status).toBe('PUBLISHED');
    expect(Date.parse(body2.publishedAt)).toBeGreaterThanOrEqual(ts1);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages/99999999/publish', {});
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/unpublish ────────────────────────────────────────────

test.describe('Landing pages API — POST /:id/unpublish (idempotent)', () => {
  test('200 sets status=DRAFT after publish', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} unpublish-1-${Date.now()}` });
    const pub = await post(request, token, `/api/landing-pages/${created.id}/publish`, {});
    expect(pub.status()).toBe(200);
    const res = await post(request, token, `/api/landing-pages/${created.id}/unpublish`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('DRAFT');
  });

  test('200 idempotent — unpublishing an already-DRAFT page still returns 200', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} unpublish-twice-${Date.now()}` });
    expect(created.status).toBe('DRAFT');
    const res = await post(request, token, `/api/landing-pages/${created.id}/unpublish`, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('DRAFT');
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages/99999999/unpublish', {});
    expect(res.status()).toBe(404);
  });
});

// ── POST /:id/duplicate ────────────────────────────────────────────

test.describe('Landing pages API — POST /:id/duplicate', () => {
  test('201 new id; status=DRAFT; publishedAt=null; slug suffixed -copy-...', async ({ request }) => {
    const { token } = await getGeneric(request);
    // Source = published page so we can prove duplicate inherits DRAFT defaults.
    const source = await createPage(request, 'generic', { title: `${RUN_TAG} dup-source-${Date.now()}` });
    const pub = await post(request, token, `/api/landing-pages/${source.id}/publish`, {});
    expect(pub.status()).toBe(200);

    const res = await post(request, token, `/api/landing-pages/${source.id}/duplicate`, {});
    expect(res.status()).toBe(201);
    const copy = await res.json();
    createdPagesByTenant.generic.add(copy.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe(`Copy of ${source.title}`);
    expect(copy.slug).toMatch(new RegExp(`^${source.slug}-copy-[a-z0-9]+$`));
    // Schema-default inheritance, asserted explicitly per the doc card's AC.
    expect(copy.status).toBe('DRAFT');
    expect(copy.publishedAt).toBeNull();
    // Slug uniqueness — copy slug differs from source.
    expect(copy.slug).not.toBe(source.slug);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await post(request, token, '/api/landing-pages/99999999/duplicate', {});
    expect(res.status()).toBe(404);
  });
});

// ── GET /:id/analytics ─────────────────────────────────────────────

test.describe('Landing pages API — GET /:id/analytics', () => {
  test('200 fresh page returns empty events + zero counts + numeric conversionRate', async ({ request }) => {
    const { token } = await getGeneric(request);
    const created = await createPage(request, 'generic', { title: `${RUN_TAG} analytics-fresh-${Date.now()}` });
    const res = await get(request, token, `/api/landing-pages/${created.id}/analytics`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(0);
    expect(body.visits).toBe(0);
    expect(body.submissions).toBe(0);
    // Route returns the literal number 0 (NOT the string "0.0") when visits=0.
    expect(body.conversionRate).toBe(0);
  });

  test('404 on unknown id', async ({ request }) => {
    const { token } = await getGeneric(request);
    const res = await get(request, token, '/api/landing-pages/99999999/analytics');
    expect(res.status()).toBe(404);
  });
});

// ── Tenant isolation — single wellness page, 7x 404 from generic ───

test.describe('Landing pages API — tenant isolation', () => {
  test('generic admin gets 404 on every read/write/delete operation against a wellness page', async ({ request }) => {
    const { token: genTok } = await getGeneric(request);
    // Make a wellness-tenant page and assert generic never sees it across
    // every user-facing surface on this route.
    const wellnessPage = await createPage(request, 'wellness', { title: `${RUN_TAG} cross-tenant-iso-${Date.now()}` });

    const checks = [
      ['GET',    `/api/landing-pages/${wellnessPage.id}`,             () => get(request, genTok, `/api/landing-pages/${wellnessPage.id}`)],
      ['PUT',    `/api/landing-pages/${wellnessPage.id}`,             () => put(request, genTok, `/api/landing-pages/${wellnessPage.id}`, { metaTitle: 'should not happen' })],
      ['DELETE', `/api/landing-pages/${wellnessPage.id}`,             () => del(request, genTok, `/api/landing-pages/${wellnessPage.id}`)],
      ['POST',   `/api/landing-pages/${wellnessPage.id}/publish`,     () => post(request, genTok, `/api/landing-pages/${wellnessPage.id}/publish`, {})],
      ['POST',   `/api/landing-pages/${wellnessPage.id}/unpublish`,   () => post(request, genTok, `/api/landing-pages/${wellnessPage.id}/unpublish`, {})],
      ['POST',   `/api/landing-pages/${wellnessPage.id}/duplicate`,   () => post(request, genTok, `/api/landing-pages/${wellnessPage.id}/duplicate`, {})],
      ['GET',    `/api/landing-pages/${wellnessPage.id}/analytics`,   () => get(request, genTok, `/api/landing-pages/${wellnessPage.id}/analytics`)],
    ];

    for (const [method, path, fn] of checks) {
      const res = await fn();
      expect(res.status(), `${method} ${path} should 404 cross-tenant`).toBe(404);
    }
  });
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('Landing pages API — auth gate', () => {
  test('GET / without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/landing-pages`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /templates/list without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/landing-pages/templates/list`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/landing-pages/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST / without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/landing-pages`, {
      data: { title: 'no auth' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /:id without token → 401/403', async ({ request }) => {
    const res = await request.put(`${BASE_URL}/api/landing-pages/1`, {
      data: { title: 'no auth' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/landing-pages/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/publish without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/landing-pages/1/publish`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/unpublish without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/landing-pages/1/unpublish`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /:id/duplicate without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/landing-pages/1/duplicate`, {
      data: {}, headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /:id/analytics without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/landing-pages/1/analytics`);
    expect([401, 403]).toContain(res.status());
  });
});
