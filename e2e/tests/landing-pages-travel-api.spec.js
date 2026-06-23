// @ts-check
/**
 * Landing-pages travel-destination metadata + publish-gate API.
 *
 * Covers the additions in PR-A:
 *   - LandingPage.destination / subBrand / generatedByAi / generatedAt
 *     pass-through on POST + PUT, validation on bad values
 *   - GET /api/landing-pages?subBrand=<bucket> filter
 *   - GET /api/landing-pages?subBrand=none filter (null rows)
 *   - GET /api/landing-pages/templates/list includes "travel_destination"
 *   - GET /api/landing-pages/:id/publish-check returns { ok, issues }
 *   - POST /api/landing-pages/:id/publish blocks with 409
 *     PUBLISH_GATE_FAILED when travel_destination content is incomplete
 *   - POST /api/landing-pages/:id/publish?force=true bypasses the gate
 *   - Generic (non-travel) page is unaffected by the travel gate
 *
 * Pattern mirrors landing-pages-api.spec.js — single-tenant generic
 * admin token, RUN_TAG E2E_FLOW_LPTRAVEL_<ts> prefix on every created
 * row so afterAll cleanup catches everything. test.describe.configure
 * mode='serial' because the publish-check + publish tests mutate the
 * same row in order.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_LPTRAVEL_${Date.now()}`;

let token = null;

async function login(request) {
  if (token) return token;
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
  const j = await r.json();
  token = j.token;
  return token;
}

const headers = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const get = (request, path) => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
const post = (request, path, body) => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const put = (request, path, body) => request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const del = (request, path) => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

const createdIds = new Set();
let counter = 0;
async function createPage(request, body = {}) {
  counter += 1;
  const res = await post(request, '/api/landing-pages', {
    title: body.title || `${RUN_TAG} p-${counter}-${Date.now()}`,
    ...body,
  });
  expect(res.status(), `createPage: ${await res.text()}`).toBe(201);
  const p = await res.json();
  createdIds.add(p.id);
  return p;
}

// Pre-purge anything orphaned from prior aborted runs sharing our prefix.
async function purgeOrphans(request) {
  const res = await get(request, '/api/landing-pages');
  if (!res.ok()) return;
  const list = await res.json();
  if (!Array.isArray(list)) return;
  for (const p of list) {
    if (typeof p.title === 'string' && /^E2E_FLOW_LPTRAVEL_/.test(p.title)) {
      await del(request, `/api/landing-pages/${p.id}`).catch(() => {});
    }
  }
}

test.beforeAll(async ({ request }) => {
  await login(request);
  await purgeOrphans(request);
});

test.afterAll(async ({ request }) => {
  if (!token) return;
  for (const id of createdIds) {
    await del(request, `/api/landing-pages/${id}`).catch(() => {});
  }
});

// ─── Templates list ──────────────────────────────────────────────────

// ─── PR-B — AI generator endpoint ───────────────────────────────────

test.describe('AI generator — POST /generate-from-destination', () => {
  test('400 on missing destination', async ({ request }) => {
    const res = await post(request, '/api/landing-pages/generate-from-destination', {
      durationDays: 7, audience: 'travellers',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DESTINATION');
  });

  test('400 on durationDays out of range', async ({ request }) => {
    const res = await post(request, '/api/landing-pages/generate-from-destination', {
      destination: 'Bali', durationDays: 100, audience: 'travellers',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DURATION');
  });

  test('400 on bogus subBrand', async ({ request }) => {
    const res = await post(request, '/api/landing-pages/generate-from-destination', {
      destination: 'Bali', durationDays: 7, audience: 'travellers', subBrand: 'no-such-brand',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SUB_BRAND');
  });

  test('preview mode (autoCreate=false) returns blocks WITHOUT persisting a row', async ({ request }) => {
    const beforeRes = await get(request, '/api/landing-pages');
    const beforeList = await beforeRes.json();
    const beforeCount = Array.isArray(beforeList) ? beforeList.length : 0;

    const res = await post(request, '/api/landing-pages/generate-from-destination', {
      destination: `${RUN_TAG}-preview-${Date.now()}`,
      durationDays: 5, audience: 'travellers', subBrand: 'travelstall',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Response shape — preview mode.
    expect(Array.isArray(body.blocks)).toBe(true);
    // PR-C: 9 blocks — hero, highlights, cities, safety, inclusions,
    // itinerary, tierPricing shell, faq, contactFooter shell.
    expect(body.blocks.length).toBe(9);
    expect(typeof body.suggestedSlug).toBe('string');
    expect(typeof body.suggestedTitle).toBe('string');
    expect(body.seoMeta).toBeTruthy();
    expect(typeof body.source).toBe('string');
    expect(body.stub === true || body.stub === false).toBe(true);
    // No page persisted.
    const afterRes = await get(request, '/api/landing-pages');
    const afterList = await afterRes.json();
    const afterCount = Array.isArray(afterList) ? afterList.length : 0;
    expect(afterCount).toBe(beforeCount);
  });

  test('autoCreate=true persists a DRAFT row with generatedByAi=true, templateType=travel_destination', async ({ request }) => {
    const dest = `${RUN_TAG}-auto-${Date.now()}`;
    const res = await post(request, '/api/landing-pages/generate-from-destination', {
      destination: dest, durationDays: 7, audience: 'photographers', subBrand: 'travelstall',
      autoCreate: true,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.page).toBeTruthy();
    expect(body.page.id).toBeTruthy();
    expect(body.page.status).toBe('DRAFT');
    expect(body.page.templateType).toBe('travel_destination');
    expect(body.page.generatedByAi).toBe(true);
    expect(body.page.generatedAt).toBeTruthy();
    expect(body.page.destination).toBe(dest);
    expect(body.page.subBrand).toBe('travelstall');
    expect(body.generation).toBeTruthy();
    createdIds.add(body.page.id);
  });

  test('autoCreate=true output preserves tierPricing as a null-shell, drops reviewCarousel, nulls all image URLs', async ({ request }) => {
    const dest = `${RUN_TAG}-bans-${Date.now()}`;
    const res = await post(request, '/api/landing-pages/generate-from-destination', {
      destination: dest, durationDays: 4, audience: 'travellers', subBrand: 'travelstall',
      autoCreate: true,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdIds.add(body.page.id);

    // Parse the persisted blocks JSON.
    const blocks = JSON.parse(body.page.content || '[]');
    // tierPricing block is PRESERVED as a structural shell. Each tier
    // must have all 4 commercial fields (amount/dueDate/vendor/tag) as
    // literal null so the operator can fill them in the builder. The
    // publish gate enforces that every tier has a non-null amount before
    // the page can flip PUBLISHED.
    const pricing = blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(Array.isArray(pricing.props.tiers)).toBe(true);
    expect(pricing.props.tiers.length).toBeGreaterThan(0);
    pricing.props.tiers.forEach((t) => {
      expect(t.amount).toBeNull();
      expect(t.dueDate).toBeNull();
      expect(t.vendor).toBeNull();
      expect(t.tag).toBeNull();
    });
    // reviewCarousel still removed entirely (testimonials are operator-only).
    expect(blocks.find((b) => b.type === 'reviewCarousel')).toBeUndefined();
    // Every image / posterUrl is null.
    const hero = blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.posterUrl).toBeNull();
    const cities = blocks.find((b) => b.type === 'cityCards');
    expect(cities.props.cards.every((c) => c.img === null)).toBe(true);
  });

  test('autoCreate page is DRAFT and FAILS the publish gate without operator edits (missing hero image, pricing)', async ({ request }) => {
    const dest = `${RUN_TAG}-gate-${Date.now()}`;
    const created = await post(request, '/api/landing-pages/generate-from-destination', {
      destination: dest, durationDays: 3, audience: 'travellers', subBrand: 'travelstall',
      autoCreate: true,
    });
    const body = await created.json();
    createdIds.add(body.page.id);
    // Try to publish — should fail because the AI-generated draft is
    // missing hero image, pricing (no tierPricing block ever emitted),
    // form (none emitted), etc.
    const pubRes = await post(request, `/api/landing-pages/${body.page.id}/publish`);
    expect(pubRes.status()).toBe(409);
    const pubBody = await pubRes.json();
    expect(pubBody.code).toBe('PUBLISH_GATE_FAILED');
  });
});

test.describe('Templates list', () => {
  test('GET /templates/list includes the travel_destination preset', async ({ request }) => {
    const res = await get(request, '/api/landing-pages/templates/list');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const travel = list.find((t) => t.id === 'travel_destination');
    expect(travel, 'travel_destination preset should be available').toBeTruthy();
    expect(Array.isArray(travel.content)).toBe(true);
    const types = travel.content.map((c) => c.type);
    expect(types).toContain('destinationHero');
    expect(types).toContain('itineraryTimeline');
    expect(types).toContain('tierPricing');
    expect(types).toContain('faqAccordion');
  });
});

// ─── Metadata pass-through + validation ──────────────────────────────

test.describe('Travel metadata on POST + PUT', () => {
  test('POST accepts destination + subBrand + generatedByAi', async ({ request }) => {
    const page = await createPage(request, {
      title: `${RUN_TAG} create-meta-${Date.now()}`,
      destination: 'Bali',
      subBrand: 'travelstall',
      generatedByAi: true,
    });
    expect(page.destination).toBe('Bali');
    expect(page.subBrand).toBe('travelstall');
    expect(page.generatedByAi).toBe(true);
    expect(page.generatedAt).toBeTruthy();
  });

  test('POST 400 INVALID_SUB_BRAND on bogus sub-brand', async ({ request }) => {
    const res = await post(request, '/api/landing-pages', {
      title: `${RUN_TAG} bad-sb-${Date.now()}`,
      subBrand: 'not-a-real-brand',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SUB_BRAND');
  });

  test('POST 400 INVALID_DESTINATION when destination > 80 chars', async ({ request }) => {
    const res = await post(request, '/api/landing-pages', {
      title: `${RUN_TAG} bad-dest-${Date.now()}`,
      destination: 'x'.repeat(81),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DESTINATION');
  });

  test('PUT updates destination + subBrand', async ({ request }) => {
    const page = await createPage(request);
    const res = await put(request, `/api/landing-pages/${page.id}`, {
      destination: 'Umrah',
      subBrand: 'rfu',
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.destination).toBe('Umrah');
    expect(updated.subBrand).toBe('rfu');
  });

  test('GET list scopes by ?subBrand=tmc', async ({ request }) => {
    const tmc = await createPage(request, { subBrand: 'tmc', title: `${RUN_TAG} sb-tmc-${Date.now()}` });
    const rfu = await createPage(request, { subBrand: 'rfu', title: `${RUN_TAG} sb-rfu-${Date.now()}` });
    const res = await get(request, '/api/landing-pages?subBrand=tmc');
    expect(res.status()).toBe(200);
    const list = await res.json();
    const ids = list.map((p) => p.id);
    expect(ids).toContain(tmc.id);
    expect(ids).not.toContain(rfu.id);
  });

  test('GET list with ?subBrand=none returns rows where subBrand is null', async ({ request }) => {
    const generic = await createPage(request, { title: `${RUN_TAG} sb-none-${Date.now()}` });
    const tmc = await createPage(request, { subBrand: 'tmc', title: `${RUN_TAG} sb-none-skip-${Date.now()}` });
    const res = await get(request, '/api/landing-pages?subBrand=none');
    expect(res.status()).toBe(200);
    const list = await res.json();
    const ids = list.map((p) => p.id);
    expect(ids).toContain(generic.id);
    expect(ids).not.toContain(tmc.id);
  });
});

// ─── Publish-readiness check + gate ──────────────────────────────────

test.describe('Publish-readiness check + gate', () => {
  test('GET /:id/publish-check on generic page returns { ok: true, issues: [] }', async ({ request }) => {
    // Generic page (no travel template) skips travel checks. As long as
    // it has a title + valid slug + at least one block, it's ready.
    const page = await createPage(request, {
      title: `${RUN_TAG} generic-ok-${Date.now()}`,
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    const res = await get(request, `/api/landing-pages/${page.id}/publish-check`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBe(0);
  });

  test('GET /:id/publish-check on incomplete travel_destination returns issues array', async ({ request }) => {
    // Minimal travel page — missing posterUrl, missing FAQs/Pricing/etc.
    const page = await createPage(request, {
      title: `${RUN_TAG} travel-incomplete-${Date.now()}`,
      templateType: 'travel_destination',
      content: JSON.stringify([
        { type: 'destinationHero', props: { headline: 'Hi', posterUrl: null } },
      ]),
    });
    const res = await get(request, `/api/landing-pages/${page.id}/publish-check`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.issues)).toBe(true);
    const codes = body.issues.map((i) => i.code);
    // Expected gate codes for an almost-empty travel page.
    expect(codes).toContain('HERO_IMAGE_MISSING');
    expect(codes).toContain('MISSING_ITINERARY');
    expect(codes).toContain('MISSING_FAQ');
    expect(codes).toContain('MISSING_PRICING');
    expect(codes).toContain('MISSING_FORM');
  });

  test('POST /:id/publish on incomplete travel page returns 409 PUBLISH_GATE_FAILED', async ({ request }) => {
    const page = await createPage(request, {
      title: `${RUN_TAG} travel-block-${Date.now()}`,
      templateType: 'travel_destination',
      content: JSON.stringify([
        { type: 'destinationHero', props: { headline: 'Hi', posterUrl: null } },
      ]),
    });
    const res = await post(request, `/api/landing-pages/${page.id}/publish`);
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PUBLISH_GATE_FAILED');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('POST /:id/publish?force=true bypasses the gate', async ({ request }) => {
    const page = await createPage(request, {
      title: `${RUN_TAG} travel-force-${Date.now()}`,
      templateType: 'travel_destination',
      content: JSON.stringify([
        { type: 'destinationHero', props: { headline: 'Hi', posterUrl: null } },
      ]),
    });
    const res = await post(request, `/api/landing-pages/${page.id}/publish?force=true`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('PUBLISHED');
  });

  test('Featured page invariants — only one featured per (tenant, subBrand) scope; feature requires PUBLISHED; public resolver returns the row', async ({ request }) => {
    // Build a complete travel page so the publish gate clears.
    const completeBlocks = [
      { type: 'destinationHero', props: { destination: 'Bali', headline: 'h', subhead: 's', posterUrl: 'https://example.com/h.jpg', ctaText: 'Reserve' } },
      { type: 'highlightsGrid', props: { title: 'Why', items: [{ icon: '◈', title: 'A', body: '' }, { icon: '⊕', title: 'B', body: '' }, { icon: '⌂', title: 'C', body: '' }] } },
      { type: 'cityCards', props: { title: 'Where', cards: [{ tag: 'X', title: 'Ubud', img: 'https://example.com/u.jpg', body: 'b' }] } },
      { type: 'inclusionsGrid', props: { title: 'Included', items: ['Airfare', 'Hotels', 'Meals'] } },
      { type: 'itineraryTimeline', props: { title: 'Days', days: [{ day: 1, title: 'Arrival', bullets: ['Pickup'] }] } },
      { type: 'tierPricing', props: { title: 'Investment', tiers: [{ step: 1, label: 'Deposit', amount: '5000', dueDate: '1 July 2026', vendor: 'Op' }] } },
      { type: 'faqAccordion', props: { title: 'FAQ', faqs: [
        { cat: 'tour', q: 'q1', a: 'a1' }, { cat: 'tour', q: 'q2', a: 'a2' },
        { cat: 'tour', q: 'q3', a: 'a3' }, { cat: 'tour', q: 'q4', a: 'a4' },
      ] } },
      { type: 'form', props: { fields: [{ label: 'Name', name: 'name', type: 'text' }] } },
    ];

    // Three published pages in the same sub-brand scope (travelstall) so
    // we can verify the "only one featured per scope" invariant.
    const sb = 'travelstall';
    const pageA = await createPage(request, {
      title: `${RUN_TAG} feat-A-${Date.now()}`,
      templateType: 'travel_destination',
      subBrand: sb,
      content: JSON.stringify(completeBlocks),
    });
    const pageB = await createPage(request, {
      title: `${RUN_TAG} feat-B-${Date.now()}`,
      templateType: 'travel_destination',
      subBrand: sb,
      content: JSON.stringify(completeBlocks),
    });

    // Both published.
    expect((await post(request, `/api/landing-pages/${pageA.id}/publish`)).status()).toBe(200);
    expect((await post(request, `/api/landing-pages/${pageB.id}/publish`)).status()).toBe(200);

    // Feature A → should succeed and set isFeatured/featuredAt.
    const feat1 = await post(request, `/api/landing-pages/${pageA.id}/feature`);
    expect(feat1.status()).toBe(200);
    const featA = await feat1.json();
    expect(featA.isFeatured).toBe(true);
    expect(featA.featuredAt).toBeTruthy();

    // Public resolver scoped to this sub-brand returns A's slug.
    const pub1 = await request.get(`${BASE_URL}/api/landing-pages/public/featured?subBrand=${sb}`, { timeout: REQUEST_TIMEOUT });
    expect(pub1.status()).toBe(200);
    const pub1Body = await pub1.json();
    expect(pub1Body.slug).toBe(pageA.slug);
    expect(pub1Body.id).toBe(pageA.id);

    // Feature B → A should be auto-unfeatured (only one featured per scope).
    const feat2 = await post(request, `/api/landing-pages/${pageB.id}/feature`);
    expect(feat2.status()).toBe(200);
    const featB = await feat2.json();
    expect(featB.isFeatured).toBe(true);

    // Re-fetch A: isFeatured should be cleared.
    const reA = await get(request, `/api/landing-pages/${pageA.id}`);
    const reABody = await reA.json();
    expect(reABody.isFeatured).toBe(false);
    expect(reABody.featuredAt).toBeNull();

    // Public resolver now points at B.
    const pub2 = await request.get(`${BASE_URL}/api/landing-pages/public/featured?subBrand=${sb}`, { timeout: REQUEST_TIMEOUT });
    expect(pub2.status()).toBe(200);
    const pub2Body = await pub2.json();
    expect(pub2Body.slug).toBe(pageB.slug);

    // Unpublishing B should auto-clear its featured flag (invariant: a
    // featured page must be PUBLISHED).
    const unpub = await post(request, `/api/landing-pages/${pageB.id}/unpublish`);
    expect(unpub.status()).toBe(200);
    const unpubBody = await unpub.json();
    expect(unpubBody.status).toBe('DRAFT');
    expect(unpubBody.isFeatured).toBe(false);
    expect(unpubBody.featuredAt).toBeNull();

    // Public resolver now 404s for this scope.
    const pub3 = await request.get(`${BASE_URL}/api/landing-pages/public/featured?subBrand=${sb}`, { timeout: REQUEST_TIMEOUT });
    expect(pub3.status()).toBe(404);
    const pub3Body = await pub3.json();
    expect(pub3Body.code).toBe('NO_FEATURED_PAGE');
  });

  test('Feature endpoint rejects DRAFT pages with 409 PAGE_NOT_PUBLISHED', async ({ request }) => {
    const draft = await createPage(request, {
      title: `${RUN_TAG} feat-draft-${Date.now()}`,
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    const res = await post(request, `/api/landing-pages/${draft.id}/feature`);
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PAGE_NOT_PUBLISHED');
    expect(body.currentStatus).toBe('DRAFT');
  });

  test('Feature endpoint is idempotent — re-featuring an already-featured page returns the row unchanged', async ({ request }) => {
    const page = await createPage(request, {
      title: `${RUN_TAG} feat-idem-${Date.now()}`,
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    expect((await post(request, `/api/landing-pages/${page.id}/publish`)).status()).toBe(200);
    const first = await post(request, `/api/landing-pages/${page.id}/feature`);
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    const featuredAt1 = firstBody.featuredAt;
    const second = await post(request, `/api/landing-pages/${page.id}/feature`);
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    // Idempotent — featuredAt should NOT change on re-feature so the
    // admin retains the original activation timestamp.
    expect(secondBody.featuredAt).toBe(featuredAt1);
    expect(secondBody.isFeatured).toBe(true);
  });

  test('Public resolver with no subBrand param returns any featured page; ?subBrand=none filters to NULL bucket', async ({ request }) => {
    // Generic-scope page (subBrand omitted → null in DB).
    const genericPage = await createPage(request, {
      title: `${RUN_TAG} feat-generic-${Date.now()}`,
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    expect((await post(request, `/api/landing-pages/${genericPage.id}/publish`)).status()).toBe(200);
    expect((await post(request, `/api/landing-pages/${genericPage.id}/feature`)).status()).toBe(200);

    // subBrand=none returns the null-scope page.
    const r1 = await request.get(`${BASE_URL}/api/landing-pages/public/featured?subBrand=none`, { timeout: REQUEST_TIMEOUT });
    expect(r1.status()).toBe(200);
    const r1Body = await r1.json();
    expect(r1Body.id).toBe(genericPage.id);
    expect(r1Body.subBrand).toBeNull();

    // Bare resolver (no subBrand param) returns ANY featured page.
    // We just assert 200 + a valid slug — multiple sibling tests may have
    // featured pages concurrently.
    const r2 = await request.get(`${BASE_URL}/api/landing-pages/public/featured`, { timeout: REQUEST_TIMEOUT });
    expect(r2.status()).toBe(200);
    const r2Body = await r2.json();
    expect(typeof r2Body.slug).toBe('string');
  });

  test('Unfeature endpoint clears the flag; subsequent /trips resolver 404s if no other featured page in scope', async ({ request }) => {
    const sb = 'visasure';
    const page = await createPage(request, {
      title: `${RUN_TAG} feat-unfeat-${Date.now()}`,
      subBrand: sb,
      content: JSON.stringify([{ type: 'heading', props: { text: 'Hi' } }]),
    });
    expect((await post(request, `/api/landing-pages/${page.id}/publish`)).status()).toBe(200);
    expect((await post(request, `/api/landing-pages/${page.id}/feature`)).status()).toBe(200);

    const unfeat = await post(request, `/api/landing-pages/${page.id}/unfeature`);
    expect(unfeat.status()).toBe(200);
    const body = await unfeat.json();
    expect(body.isFeatured).toBe(false);
    expect(body.featuredAt).toBeNull();

    // Resolver scoped to visasure now 404s (no featured page in scope).
    const pub = await request.get(`${BASE_URL}/api/landing-pages/public/featured?subBrand=${sb}`, { timeout: REQUEST_TIMEOUT });
    expect(pub.status()).toBe(404);
  });

  test('POST /:id/publish on travel page with all required blocks succeeds', async ({ request }) => {
    // Build a complete travel_destination page that satisfies every
    // gate check: hero w/ image, ≥3 highlights, every city has an image,
    // ≥1 itinerary day, ≥3 inclusions, ≥4 FAQs, pricing tier amount set,
    // form block present.
    const completeBlocks = [
      {
        type: 'destinationHero',
        props: {
          destination: 'Bali',
          headline: 'A complete page',
          subhead: 'Subhead.',
          posterUrl: 'https://example.com/hero.jpg',
          ctaText: 'Reserve',
        },
      },
      {
        type: 'highlightsGrid',
        props: {
          title: 'Why',
          items: [
            { icon: '◈', title: 'A', body: '' },
            { icon: '⊕', title: 'B', body: '' },
            { icon: '⌂', title: 'C', body: '' },
          ],
        },
      },
      {
        type: 'cityCards',
        props: {
          title: 'Where',
          cards: [{ tag: 'X', title: 'Ubud', img: 'https://example.com/ubud.jpg', body: 'b' }],
        },
      },
      {
        type: 'inclusionsGrid',
        props: { title: 'Included', items: ['Airfare', 'Hotels', 'Meals'] },
      },
      {
        type: 'itineraryTimeline',
        props: { title: 'Days', days: [{ day: 1, title: 'Arrival', bullets: ['Pickup'] }] },
      },
      {
        type: 'tierPricing',
        props: {
          title: 'Investment',
          tiers: [{ step: 1, label: 'Deposit', amount: '5000', dueDate: '1 July 2026', vendor: 'Op' }],
        },
      },
      {
        type: 'faqAccordion',
        props: {
          title: 'FAQ',
          faqs: [
            { cat: 'tour', q: 'q1', a: 'a1' },
            { cat: 'tour', q: 'q2', a: 'a2' },
            { cat: 'tour', q: 'q3', a: 'a3' },
            { cat: 'tour', q: 'q4', a: 'a4' },
          ],
        },
      },
      { type: 'form', props: { fields: [{ label: 'Name', name: 'name', type: 'text' }] } },
    ];

    const page = await createPage(request, {
      title: `${RUN_TAG} travel-complete-${Date.now()}`,
      templateType: 'travel_destination',
      content: JSON.stringify(completeBlocks),
    });

    // Confirm readiness first.
    const check = await get(request, `/api/landing-pages/${page.id}/publish-check`);
    expect(check.status()).toBe(200);
    const verdict = await check.json();
    expect(verdict.ok, JSON.stringify(verdict.issues)).toBe(true);

    // Publish should now succeed without ?force.
    const pub = await post(request, `/api/landing-pages/${page.id}/publish`);
    expect(pub.status()).toBe(200);
    const updated = await pub.json();
    expect(updated.status).toBe('PUBLISHED');
  });
});
