// @ts-check
/**
 * Landing-pages version-history API — admin surface.
 *
 * Pins the lightweight versioning surface added for UAT / client demos /
 * AI experimentation. Snapshots are captured server-side on:
 *   - CREATE         (POST /api/landing-pages)
 *   - MANUAL_SAVE    (PUT  /api/landing-pages/:id — content/title/slug change)
 *   - PUBLISH        (POST /api/landing-pages/:id/publish)
 *   - AI_GENERATION  (POST /api/landing-pages/generate-from-destination ?autoCreate)
 *   - RESTORE        (POST /api/landing-pages/:id/versions/:vId/restore)
 *
 * Endpoints covered:
 *   GET  /api/landing-pages/:id/versions
 *   POST /api/landing-pages/:id/versions/:versionId/restore
 *
 * What's pinned
 * ─────────────
 *   - Auth gate: missing Bearer → 401.
 *   - Tenant isolation: cross-tenant version list → 404 (page not found);
 *     cross-tenant restore → 404.
 *   - CREATE writes v1.
 *   - MANUAL_SAVE with a content change writes v(N+1); a metaTitle-only
 *     save does NOT.
 *   - PUBLISH writes a snapshot.
 *   - Restore reads a prior version → writes a NEW snapshot (source=RESTORE,
 *     restoredFromVersionId=N) → page row's title/content match the
 *     restored version. Prior versions remain in the list.
 *   - versionNumber is monotonically increasing per page.
 *
 * Pattern: landing-pages-api.spec.js (dual-tenant tokens; serial mode;
 * RUN_TAG-scoped cleanup). global-teardown doesn't sweep LandingPage,
 * so afterAll deletes everything this run created — which cascades to
 * LandingPageVersion via onDelete: Cascade.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_LPV_${Date.now()}`;

let genericToken = null;
let wellnessToken = null;

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
        return j.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getGeneric(request) {
  if (!genericToken) genericToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  return genericToken;
}
async function getWellness(request) {
  if (!wellnessToken) wellnessToken = await loginAs(request, 'admin@wellness.demo', 'password123');
  return wellnessToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const get = (request, token, path) =>
  request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
const post = (request, token, path, body) =>
  request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const put = (request, token, path, body) =>
  request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const del = (request, token, path) =>
  request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

const createdPagesByTenant = { generic: new Set(), wellness: new Set() };

let titleCounter = 0;
async function createPage(request, tenant, contentBlocks = []) {
  const tok = tenant === 'generic' ? await getGeneric(request) : await getWellness(request);
  if (!tok) throw new Error(`createPage: no ${tenant} token`);
  titleCounter += 1;
  const res = await post(request, tok, '/api/landing-pages', {
    title: `${RUN_TAG} page-${titleCounter}-${Date.now()}`,
    content: JSON.stringify(contentBlocks),
  });
  expect(res.status(), `createPage(${tenant}): ${await res.text()}`).toBe(201);
  const page = await res.json();
  createdPagesByTenant[tenant].add(page.id);
  return page;
}

test.beforeAll(async ({ request }) => {
  await getGeneric(request);
  await getWellness(request);
});

test.afterAll(async ({ request }) => {
  for (const [tenant, ids] of Object.entries(createdPagesByTenant)) {
    const tok = tenant === 'generic' ? await getGeneric(request) : await getWellness(request);
    if (!tok) continue;
    for (const id of ids) {
      await del(request, tok, `/api/landing-pages/${id}`).catch(() => {});
    }
  }
});

// ── Auth gate ──────────────────────────────────────────────────────

test.describe('versions API — auth gate', () => {
  test('GET /:id/versions without Bearer → 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/landing-pages/1/versions`, { timeout: REQUEST_TIMEOUT });
    expect(res.status()).toBe(401);
  });
  test('POST /:id/versions/:v/restore without Bearer → 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/landing-pages/1/versions/1/restore`, {
      data: {}, timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
  });
});

// ── GET /:id/versions ──────────────────────────────────────────────

test.describe('versions API — list', () => {
  test('CREATE writes v1; list returns it', async ({ request }) => {
    const token = await getGeneric(request);
    const page = await createPage(request, 'generic');
    const res = await get(request, token, `/api/landing-pages/${page.id}/versions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions.length).toBeGreaterThanOrEqual(1);
    const v1 = body.versions[body.versions.length - 1];
    expect(v1.versionNumber).toBe(1);
    expect(v1.source).toBe('CREATE');
    expect(v1.title).toBe(page.title);
    expect(v1.slug).toBe(page.slug);
    // content @db.LongText is NOT returned in list responses (only on restore).
    expect(v1.content).toBeUndefined();
  });

  test('list ordered newest-first by versionNumber', async ({ request }) => {
    const token = await getGeneric(request);
    const page = await createPage(request, 'generic');
    // Drive a content change so MANUAL_SAVE writes v2.
    const editRes = await put(request, token, `/api/landing-pages/${page.id}`, {
      content: JSON.stringify([{ id: 'a', type: 'heading', props: { text: 'hi' } }]),
    });
    expect(editRes.status()).toBe(200);
    const res = await get(request, token, `/api/landing-pages/${page.id}/versions`);
    const body = await res.json();
    expect(body.versions.length).toBeGreaterThanOrEqual(2);
    // Newest first: versionNumber strictly decreasing across the list.
    for (let i = 1; i < body.versions.length; i++) {
      expect(body.versions[i - 1].versionNumber).toBeGreaterThan(body.versions[i].versionNumber);
    }
    expect(body.versions[0].source).toBe('MANUAL_SAVE');
  });

  test('metaTitle-only PUT does NOT add a new version', async ({ request }) => {
    const token = await getGeneric(request);
    const page = await createPage(request, 'generic');
    const before = await get(request, token, `/api/landing-pages/${page.id}/versions`).then((r) => r.json());
    const beforeCount = before.versions.length;
    const editRes = await put(request, token, `/api/landing-pages/${page.id}`, {
      metaTitle: 'just-meta-' + Date.now(),
    });
    expect(editRes.status()).toBe(200);
    const after = await get(request, token, `/api/landing-pages/${page.id}/versions`).then((r) => r.json());
    expect(after.versions.length).toBe(beforeCount);
  });

  test('PUBLISH writes a PUBLISH-source snapshot', async ({ request }) => {
    const token = await getGeneric(request);
    // Need a publishable page — generic (non-travel) page passes the gate.
    const page = await createPage(request, 'generic', [
      { id: 'h', type: 'heading', props: { text: 'Hello' } },
    ]);
    const pubRes = await post(request, token, `/api/landing-pages/${page.id}/publish`);
    expect(pubRes.status()).toBe(200);
    const list = await get(request, token, `/api/landing-pages/${page.id}/versions`).then((r) => r.json());
    expect(list.versions.some((v) => v.source === 'PUBLISH')).toBe(true);
  });

  test('cross-tenant version list → 404', async ({ request }) => {
    const wellnessTok = await getWellness(request);
    const wellnessPage = await createPage(request, 'wellness');
    const genericTok = await getGeneric(request);
    const res = await get(request, genericTok, `/api/landing-pages/${wellnessPage.id}/versions`);
    expect(res.status()).toBe(404);
    void wellnessTok;
  });

  test('400 on non-numeric id', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await get(request, token, '/api/landing-pages/not-a-number/versions');
    expect(res.status()).toBe(400);
  });
});

// ── POST /:id/versions/:versionId/restore ─────────────────────────

test.describe('versions API — restore', () => {
  test('restores title + content from a prior version and appends a RESTORE snapshot', async ({ request }) => {
    const token = await getGeneric(request);
    const initialBlocks = [{ id: 'a', type: 'heading', props: { text: 'ORIGINAL' } }];
    const page = await createPage(request, 'generic', initialBlocks);
    // Save v2 with a different content body.
    await put(request, token, `/api/landing-pages/${page.id}`, {
      title: page.title + ' edited',
      content: JSON.stringify([{ id: 'b', type: 'heading', props: { text: 'EDITED' } }]),
    });
    const list1 = await get(request, token, `/api/landing-pages/${page.id}/versions`).then((r) => r.json());
    expect(list1.versions.length).toBe(2);
    const v1 = list1.versions.find((v) => v.versionNumber === 1);
    expect(v1).toBeTruthy();

    // Restore v1.
    const restRes = await post(request, token, `/api/landing-pages/${page.id}/versions/${v1.id}/restore`);
    expect(restRes.status(), await restRes.text()).toBe(200);
    const restBody = await restRes.json();
    expect(restBody.page.title).toBe(page.title);
    expect(JSON.parse(restBody.page.content)[0].props.text).toBe('ORIGINAL');
    expect(restBody.restoredFromVersion.versionNumber).toBe(1);
    expect(restBody.newVersion.versionNumber).toBe(3);

    // List now has v1, v2, v3 — history preserved.
    const list2 = await get(request, token, `/api/landing-pages/${page.id}/versions`).then((r) => r.json());
    expect(list2.versions.length).toBe(3);
    const v3 = list2.versions.find((v) => v.versionNumber === 3);
    expect(v3.source).toBe('RESTORE');
    expect(v3.restoredFromVersionId).toBe(v1.id);
    // v1 still present.
    expect(list2.versions.some((v) => v.versionNumber === 1)).toBe(true);
  });

  test('404 on unknown version id', async ({ request }) => {
    const token = await getGeneric(request);
    const page = await createPage(request, 'generic');
    const res = await post(request, token, `/api/landing-pages/${page.id}/versions/99999999/restore`);
    expect(res.status()).toBe(404);
  });

  test('404 on unknown page id', async ({ request }) => {
    const token = await getGeneric(request);
    const res = await post(request, token, `/api/landing-pages/99999999/versions/1/restore`);
    expect(res.status()).toBe(404);
  });

  test('cross-tenant restore → 404', async ({ request }) => {
    const wellnessTok = await getWellness(request);
    const wellnessPage = await createPage(request, 'wellness');
    const wellnessList = await get(request, wellnessTok, `/api/landing-pages/${wellnessPage.id}/versions`).then((r) => r.json());
    const wellnessV1 = wellnessList.versions[0];
    expect(wellnessV1).toBeTruthy();

    const genericTok = await getGeneric(request);
    const res = await post(request, genericTok, `/api/landing-pages/${wellnessPage.id}/versions/${wellnessV1.id}/restore`);
    expect(res.status()).toBe(404);
  });

  test('400 on non-numeric ids', async ({ request }) => {
    const token = await getGeneric(request);
    const r1 = await post(request, token, '/api/landing-pages/abc/versions/1/restore');
    expect(r1.status()).toBe(400);
    const page = await createPage(request, 'generic');
    const r2 = await post(request, token, `/api/landing-pages/${page.id}/versions/abc/restore`);
    expect(r2.status()).toBe(400);
  });
});
