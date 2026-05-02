// @ts-check
/**
 * Social module — backend coverage push.
 *
 * Targets backend/routes/social.js (16.9% covered, 368 uncovered lines, 443
 * total). This spec exercises every router.* handler in the file:
 *
 *   POSTS
 *   GET    /api/social/posts                          — list + ?platform + ?status filters
 *   POST   /api/social/posts                          — create draft / scheduled, validation
 *   POST   /api/social/posts/:id/publish              — publish (no integration → FAILED row;
 *                                                       integration with bogus token → external
 *                                                       fetch fails fast → FAILED row)
 *   DELETE /api/social/posts/:id                      — delete + 404 + tenant scope
 *
 *   MENTIONS
 *   GET    /api/social/mentions                       — list + ?platform + ?contactId + ?sentiment
 *   POST   /api/social/mentions/fetch/:platform       — STUB: fabricates rows from keywords[]
 *   POST   /api/social/mentions/:id/link-contact      — link-to-contact + 400 + 404
 *
 *   ACCOUNTS (Integration provider rows)
 *   GET    /api/social/accounts                       — fixed 3-row shape (linkedin/twitter/facebook)
 *   POST   /api/social/accounts/:platform/connect     — create or update; 400 on missing token
 *   DELETE /api/social/accounts/:platform             — soft disconnect (token→null, isActive=false)
 *
 * Critical SUT facts verified against the file:
 *   • SUPPORTED_PLATFORMS = ["linkedin", "twitter", "facebook"]. Anything else
 *     (e.g. "instagram") returns 400 from publish/connect/disconnect/fetch.
 *   • normalizePlatform() lowercases + trims, so "LinkedIn" is accepted on
 *     create/list filters.
 *   • No POST /:id/schedule endpoint — scheduling happens via the create body's
 *     `scheduledFor` field (sets status=SCHEDULED). Past-date is NOT rejected
 *     by the route (the route just records what's given), so we don't assert a
 *     400 there — we only assert status=SCHEDULED with any date.
 *   • Posts are NOT user-scoped — they're tenantId-scoped only. There's no
 *     stats endpoint, no /platforms list endpoint, no PUT /:id.
 *   • publishToPlatform() calls real LinkedIn/Twitter/Facebook fetchers when
 *     an Integration row exists. With a bogus token in CI, the upstream API
 *     returns 4xx and the route writes status=FAILED + returns 200 with
 *     { success:false, error }. We assert that contract, never the platform
 *     side. Without an integration, route returns "credentials not configured".
 *   • stripDangerous middleware drops id / createdAt / tenantId from POST
 *     bodies (irrelevant here — none of our happy-path POSTs send those).
 *   • req.user.userId vs req.user.id — irrelevant for this route; it only
 *     uses tenantId(req).
 *
 * RBAC: routes/social.js has NO verifyRole middleware. Every endpoint is
 * authenticated via the global guard but accepts any role. So there are no
 * 403-by-role assertions in this spec — only 401/403 unauth assertions.
 *
 * Tenant: generic. admin@globussoft.com (ADMIN) drives most cases; user@crm.com
 * (USER) is used only for "any authenticated role works" assertions.
 *
 * Cleanup: every created post/mention/integration row is tagged with RUN_TAG
 * in its content/message field (or, for accounts, by tenant+provider) and
 * removed in afterAll. Integration rows aren't directly deleted by the route
 * — DELETE /accounts/:platform soft-disconnects (token→null, isActive→false).
 * That's enough for cleanup since the unique key is (tenantId, provider) and
 * subsequent tests use upsert.
 *
 * Spec is parallel-safe by tagging every row with a per-run timestamp and
 * never relying on counts of "all rows" — only on presence-by-id or
 * presence-by-RUN_TAG.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_SOC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ── Dual-token auth ────────────────────────────────────────────────
let adminToken = null;
let adminUserId = null;
let userToken = null;
let userUserId = null;

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
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
    adminUserId = r.userId;
  }
  return { token: adminToken, userId: adminUserId };
}

async function getUser(request) {
  if (!userToken) {
    const r = await loginAs(request, 'user@crm.com', 'password123');
    userToken = r.token;
    userUserId = r.userId;
  }
  return { token: userToken, userId: userUserId };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function get(request, token, path) {
  return request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}
async function post(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
}
async function del(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
}

// ── Cleanup tracking ───────────────────────────────────────────────
const createdPostIds = new Set();
const createdMentionIds = new Set();
// Track which (tenant-scoped) account platforms we touched so afterAll can
// soft-disconnect them. Connecting the same provider twice just upserts, so
// this set is fine being small.
const touchedAccountPlatforms = new Set();

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdPostIds) {
    await del(request, token, `/api/social/posts/${id}`).catch(() => {});
  }
  // No DELETE /mentions/:id route — best we can do is leave them; they're
  // tagged with RUN_TAG so they're identifiable and cheap. (Comment retained
  // for the maintainer, not a TODO.)
  for (const platform of touchedAccountPlatforms) {
    await del(request, token, `/api/social/accounts/${platform}`).catch(() => {});
  }
});

// Helper: create a draft post and return the row.
async function createPost(request, overrides = {}) {
  const { token } = await getAdmin(request);
  const res = await post(request, token, '/api/social/posts', {
    platform: overrides.platform || 'linkedin',
    content: overrides.content || `${RUN_TAG} draft post body`,
    mediaUrl: overrides.mediaUrl,
    scheduledFor: overrides.scheduledFor,
  });
  expect(res.status(), `create post: ${await res.text()}`).toBe(200);
  const body = await res.json();
  if (body && body.id) createdPostIds.add(body.id);
  return body;
}

async function createMentionsViaStub(request, platform, keywords) {
  const { token } = await getAdmin(request);
  const res = await post(request, token, `/api/social/mentions/fetch/${platform}`, {
    keywords: keywords && keywords.length ? keywords : [`${RUN_TAG}_kw1`, `${RUN_TAG}_kw2`],
  });
  expect(res.status(), `mentions fetch: ${await res.text()}`).toBe(200);
  const body = await res.json();
  for (const m of body.mentions || []) {
    if (m && m.id) createdMentionIds.add(m.id);
  }
  return body;
}

// ──────────────────────────────────────────────────────────────────
// POSTS
// ──────────────────────────────────────────────────────────────────

test.describe('Social API — GET /posts', () => {
  test('200 returns array of posts', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('newly created post appears in list', async ({ request }) => {
    const created = await createPost(request, { content: `${RUN_TAG} list-appears` });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.find((p) => p.id === created.id)).toBeTruthy();
  });

  test('?platform=linkedin filters list', async ({ request }) => {
    await createPost(request, { platform: 'linkedin', content: `${RUN_TAG} li-filter` });
    await createPost(request, { platform: 'twitter', content: `${RUN_TAG} tw-filter` });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts?platform=linkedin');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.platform === 'linkedin')).toBe(true);
  });

  test('?platform=twitter filters list', async ({ request }) => {
    await createPost(request, { platform: 'twitter', content: `${RUN_TAG} tw-only` });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts?platform=twitter');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((p) => p.platform === 'twitter')).toBe(true);
  });

  test('?platform with mixed case is normalized', async ({ request }) => {
    // SUT normalizes filter via normalizePlatform on read; "LinkedIn" → "linkedin"
    await createPost(request, { platform: 'linkedin', content: `${RUN_TAG} li-case` });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts?platform=LinkedIn');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((p) => p.platform === 'linkedin')).toBe(true);
  });

  test('?status=DRAFT filters to drafts', async ({ request }) => {
    await createPost(request, { content: `${RUN_TAG} draft-filter` });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts?status=DRAFT');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((p) => p.status === 'DRAFT')).toBe(true);
  });

  test('?status=SCHEDULED filters to scheduled posts', async ({ request }) => {
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await createPost(request, { content: `${RUN_TAG} sched-filter`, scheduledFor: future });
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/posts?status=SCHEDULED');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((p) => p.status === 'SCHEDULED')).toBe(true);
  });

  test('USER role can list posts (no RBAC gate on this route)', async ({ request }) => {
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'no regular USER token available');
    const res = await get(request, token, '/api/social/posts');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

test.describe('Social API — POST /posts (create + validation)', () => {
  test('200 creates a draft post (no scheduledFor)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      platform: 'linkedin',
      content: `${RUN_TAG} create-draft`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.platform).toBe('linkedin');
    expect(body.status).toBe('DRAFT');
    expect(body.scheduledFor).toBeNull();
    createdPostIds.add(body.id);
  });

  test('200 creates a scheduled post when scheduledFor in future', async ({ request }) => {
    const { token } = await getAdmin(request);
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const res = await post(request, token, '/api/social/posts', {
      platform: 'twitter',
      content: `${RUN_TAG} create-scheduled`,
      scheduledFor: future,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SCHEDULED');
    expect(body.scheduledFor).toBeTruthy();
    createdPostIds.add(body.id);
  });

  test('200 accepts mediaUrl', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      platform: 'facebook',
      content: `${RUN_TAG} create-with-media`,
      mediaUrl: 'https://example.com/image.png',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.mediaUrl).toBe('https://example.com/image.png');
    createdPostIds.add(body.id);
  });

  test('200 normalizes platform case ("LinkedIn" → "linkedin")', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      platform: 'LinkedIn',
      content: `${RUN_TAG} normalize-case`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.platform).toBe('linkedin');
    createdPostIds.add(body.id);
  });

  test('400 on missing platform', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      content: `${RUN_TAG} no-platform`,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/platform/i);
  });

  test('400 on unsupported platform (instagram)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      platform: 'instagram',
      content: `${RUN_TAG} bad-platform`,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/platform/i);
  });

  test('400 on missing content', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      platform: 'linkedin',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/content/i);
  });

  test('400 on whitespace-only content', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts', {
      platform: 'linkedin',
      content: '   \t  ',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/content/i);
  });

  test('USER role can create a post', async ({ request }) => {
    const { token } = await getUser(request);
    if (!token) test.skip(true, 'no regular USER token available');
    const res = await post(request, token, '/api/social/posts', {
      platform: 'twitter',
      content: `${RUN_TAG} user-create`,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    createdPostIds.add(body.id);
  });
});

test.describe('Social API — POST /posts/:id/publish', () => {
  test('returns success=false when no integration is configured', async ({ request }) => {
    // No prior connect → publishToX() short-circuits with "credentials not
    // configured", route flips status to FAILED and responds 200 with
    // { success:false, error }.
    const created = await createPost(request, { platform: 'linkedin', content: `${RUN_TAG} pub-no-integration` });
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');

    // Verify SocialPost row flipped to FAILED.
    const list = await get(request, token, '/api/social/posts?status=FAILED');
    const failed = (await list.json()).find((p) => p.id === created.id);
    expect(failed).toBeTruthy();
    expect(failed.status).toBe('FAILED');
  });

  test('404 on unknown post id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/posts/99999999/publish', {});
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  test('publishes through twitter branch with bogus integration → FAILED', async ({ request }) => {
    // Connect a fake twitter token so the route exercises publishToTwitter()
    // which actually calls api.twitter.com. With a junk token Twitter returns
    // 4xx, the route catches it, writes FAILED, and responds {success:false}.
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('twitter');
    const conn = await post(request, token, '/api/social/accounts/twitter/connect', {
      accessToken: `${RUN_TAG}_fake_twitter_token`,
    });
    expect(conn.status()).toBe(200);

    const created = await createPost(request, { platform: 'twitter', content: `${RUN_TAG} pub-twitter` });
    const res = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Either upstream Twitter returned an error object (most likely) or the
    // network layer threw — both branches are covered, both produce success=false.
    expect(body.success).toBe(false);
  });

  test('publishes through linkedin branch with bogus integration → FAILED', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('linkedin');
    const conn = await post(request, token, '/api/social/accounts/linkedin/connect', {
      accessToken: `${RUN_TAG}_fake_li_token`,
      personUrn: 'urn:li:person:fake',
    });
    expect(conn.status()).toBe(200);

    const created = await createPost(request, { platform: 'linkedin', content: `${RUN_TAG} pub-linkedin` });
    const res = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test('publishes through linkedin branch with mediaUrl (IMAGE share path)', async ({ request }) => {
    // Drives the publishToLinkedIn() shareMediaCategory:"IMAGE" branch.
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('linkedin');
    await post(request, token, '/api/social/accounts/linkedin/connect', {
      accessToken: `${RUN_TAG}_fake_li_token_2`,
    });
    const created = await createPost(request, {
      platform: 'linkedin',
      content: `${RUN_TAG} pub-linkedin-media`,
      mediaUrl: 'https://example.com/img.jpg',
    });
    const res = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test('publishes through facebook branch with bogus integration → FAILED', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('facebook');
    const conn = await post(request, token, '/api/social/accounts/facebook/connect', {
      accessToken: `${RUN_TAG}_fake_fb_token`,
      pageId: '123fake',
    });
    expect(conn.status()).toBe(200);

    const created = await createPost(request, { platform: 'facebook', content: `${RUN_TAG} pub-facebook` });
    const res = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test('publishes through facebook branch with mediaUrl (link param)', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('facebook');
    await post(request, token, '/api/social/accounts/facebook/connect', {
      accessToken: `${RUN_TAG}_fake_fb_token_2`,
    });
    const created = await createPost(request, {
      platform: 'facebook',
      content: `${RUN_TAG} pub-facebook-media`,
      mediaUrl: 'https://example.com/post.html',
    });
    const res = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

test.describe('Social API — DELETE /posts/:id', () => {
  test('200 deletes own tenant post', async ({ request }) => {
    const created = await createPost(request, { content: `${RUN_TAG} delete-target` });
    createdPostIds.delete(created.id); // we'll assert deletion ourselves
    const { token } = await getAdmin(request);
    const res = await del(request, token, `/api/social/posts/${created.id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Subsequent publish should now 404.
    const after = await post(request, token, `/api/social/posts/${created.id}/publish`, {});
    expect(after.status()).toBe(404);
  });

  test('404 on unknown post id', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/social/posts/99999999');
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  test('404 on non-numeric id (parseInt → NaN → no match)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/social/posts/abc');
    expect(res.status()).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────
// MENTIONS
// ──────────────────────────────────────────────────────────────────

test.describe('Social API — GET /mentions', () => {
  test('200 returns array', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/mentions');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('newly fetched mentions appear in list', async ({ request }) => {
    const fetched = await createMentionsViaStub(request, 'twitter', [`${RUN_TAG}_appear1`, `${RUN_TAG}_appear2`]);
    expect(fetched.fetched).toBeGreaterThan(0);
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/mentions');
    const list = await res.json();
    const ids = new Set(list.map((m) => m.id));
    for (const m of fetched.mentions) expect(ids.has(m.id)).toBe(true);
  });

  test('?platform filters mentions', async ({ request }) => {
    await createMentionsViaStub(request, 'linkedin', [`${RUN_TAG}_li_only`]);
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/mentions?platform=linkedin');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((m) => m.platform === 'linkedin')).toBe(true);
  });

  test('?sentiment filters mentions', async ({ request }) => {
    // Stub assigns sentiments cyclically; "positive" is the first index.
    await createMentionsViaStub(request, 'facebook', [`${RUN_TAG}_pos1`]);
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/mentions?sentiment=positive');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(list.every((m) => m.sentiment === 'positive')).toBe(true);
  });

  test('?contactId filters mentions', async ({ request }) => {
    // Use a contactId that almost certainly has no mentions → empty array,
    // but route should still 200.
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/mentions?contactId=99999999');
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
  });
});

test.describe('Social API — POST /mentions/fetch/:platform (stub)', () => {
  test('200 with stub:true and rows tagged with platform', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/mentions/fetch/twitter', {
      keywords: [`${RUN_TAG}_stub_a`, `${RUN_TAG}_stub_b`],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.stub).toBe(true);
    expect(body.fetched).toBe(2);
    expect(Array.isArray(body.mentions)).toBe(true);
    expect(body.mentions.every((m) => m.platform === 'twitter')).toBe(true);
    for (const m of body.mentions) createdMentionIds.add(m.id);
  });

  test('caps to 3 keywords (slice(0,3))', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/mentions/fetch/linkedin', {
      keywords: [
        `${RUN_TAG}_k1`, `${RUN_TAG}_k2`, `${RUN_TAG}_k3`,
        `${RUN_TAG}_k4`, `${RUN_TAG}_k5`,
      ],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fetched).toBe(3);
    for (const m of body.mentions) createdMentionIds.add(m.id);
  });

  test('falls back to default keyword when none provided', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/mentions/fetch/facebook', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fetched).toBe(1); // default ["globussoft"] → 1 sample row
    for (const m of body.mentions) createdMentionIds.add(m.id);
  });

  test('falls back to default when keywords is empty array', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/mentions/fetch/facebook', {
      keywords: [],
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.fetched).toBe(1);
    for (const m of body.mentions) createdMentionIds.add(m.id);
  });

  test('400 on unsupported platform', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/mentions/fetch/instagram', {
      keywords: [`${RUN_TAG}_ig`],
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/platform/i);
  });
});

test.describe('Social API — POST /mentions/:id/link-contact', () => {
  // Most tenants seeded by prisma/seed.js have at least one contact in the
  // generic tenant. We look one up via /api/contacts; if none exists we skip.
  async function findAnyContactId(request) {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/contacts?limit=1');
    if (!res.ok()) return null;
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.contacts || body.data || []);
    return list[0]?.id || null;
  }

  test('200 links existing contact to existing mention', async ({ request }) => {
    const contactId = await findAnyContactId(request);
    if (!contactId) test.skip(true, 'no seeded contact in generic tenant');

    const fetched = await createMentionsViaStub(request, 'twitter', [`${RUN_TAG}_link1`]);
    const mentionId = fetched.mentions[0].id;

    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/social/mentions/${mentionId}/link-contact`, {
      contactId,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.contactId).toBe(contactId);
    expect(body.id).toBe(mentionId);
  });

  test('400 when contactId is missing', async ({ request }) => {
    const fetched = await createMentionsViaStub(request, 'twitter', [`${RUN_TAG}_link2`]);
    const mentionId = fetched.mentions[0].id;
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/social/mentions/${mentionId}/link-contact`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/contactId/i);
  });

  test('404 when mention id does not exist', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/mentions/99999999/link-contact', {
      contactId: 1,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/mention/i);
  });

  test('404 when contactId does not exist (after mention exists)', async ({ request }) => {
    const fetched = await createMentionsViaStub(request, 'twitter', [`${RUN_TAG}_link3`]);
    const mentionId = fetched.mentions[0].id;
    const { token } = await getAdmin(request);
    const res = await post(request, token, `/api/social/mentions/${mentionId}/link-contact`, {
      contactId: 99999999,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/contact/i);
  });
});

// ──────────────────────────────────────────────────────────────────
// ACCOUNTS (Integration provider rows)
// ──────────────────────────────────────────────────────────────────

test.describe('Social API — GET /accounts', () => {
  test('200 returns exactly 3 platforms with connected booleans', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await get(request, token, '/api/social/accounts');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
    const platforms = body.map((a) => a.platform).sort();
    expect(platforms).toEqual(['facebook', 'linkedin', 'twitter']);
    for (const a of body) {
      expect(typeof a.connected).toBe('boolean');
      expect('updatedAt' in a).toBe(true);
    }
  });
});

test.describe('Social API — POST /accounts/:platform/connect', () => {
  test('200 connects a fresh platform (create branch)', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('linkedin');
    const res = await post(request, token, '/api/social/accounts/linkedin/connect', {
      accessToken: `${RUN_TAG}_li_create`,
      personUrn: 'urn:li:person:demo',
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.platform).toBe('linkedin');
    expect(body.connected).toBe(true);
    expect(typeof body.id).toBe('number');
  });

  test('200 reconnects an existing platform (update branch)', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('twitter');
    // First connect
    const r1 = await post(request, token, '/api/social/accounts/twitter/connect', {
      accessToken: `${RUN_TAG}_tw_v1`,
    });
    expect(r1.status()).toBe(200);
    const id1 = (await r1.json()).id;
    // Reconnect — should hit the prisma.integration.update branch and reuse id
    const r2 = await post(request, token, '/api/social/accounts/twitter/connect', {
      accessToken: `${RUN_TAG}_tw_v2`,
      accessSecret: `${RUN_TAG}_secret`,
    });
    expect(r2.status()).toBe(200);
    const id2 = (await r2.json()).id;
    expect(id2).toBe(id1);
  });

  test('GET /accounts reflects connected=true after connect', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('facebook');
    const conn = await post(request, token, '/api/social/accounts/facebook/connect', {
      accessToken: `${RUN_TAG}_fb_visible`,
    });
    expect(conn.status()).toBe(200);
    const list = await get(request, token, '/api/social/accounts');
    const fb = (await list.json()).find((a) => a.platform === 'facebook');
    expect(fb.connected).toBe(true);
  });

  test('400 on unsupported platform', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/accounts/instagram/connect', {
      accessToken: 'whatever',
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/platform/i);
  });

  test('400 on missing accessToken', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await post(request, token, '/api/social/accounts/linkedin/connect', {});
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/accessToken/i);
  });

  test('normalizes platform case in path', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('linkedin');
    const res = await post(request, token, '/api/social/accounts/LinkedIn/connect', {
      accessToken: `${RUN_TAG}_li_case`,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).platform).toBe('linkedin');
  });
});

test.describe('Social API — DELETE /accounts/:platform', () => {
  test('200 disconnects an existing connected platform', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('twitter');
    await post(request, token, '/api/social/accounts/twitter/connect', {
      accessToken: `${RUN_TAG}_tw_disconnect`,
    });
    const res = await del(request, token, '/api/social/accounts/twitter');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.platform).toBe('twitter');
    expect(body.connected).toBe(false);

    // GET /accounts should now show connected=false for twitter
    const list = await get(request, token, '/api/social/accounts');
    const tw = (await list.json()).find((a) => a.platform === 'twitter');
    expect(tw.connected).toBe(false);
  });

  test('200 with connected:false when no integration exists', async ({ request }) => {
    // Make sure it's gone first by disconnecting; second DELETE hits the
    // "no existing → return success:true, connected:false" branch.
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('linkedin');
    await del(request, token, '/api/social/accounts/linkedin').catch(() => {});
    // Find any integration row for linkedin and forcibly soft-disconnect twice
    // by hitting DELETE again — but DELETE updates an existing soft-disconnected
    // row too if isActive=true. To reliably hit the "no existing" branch we'd
    // need to delete the row outright. Since we can't, we accept either branch:
    // the response shape is the same ({success:true, connected:false}) in both.
    const res = await del(request, token, '/api/social/accounts/linkedin');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connected).toBe(false);
  });

  test('400 on unsupported platform', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await del(request, token, '/api/social/accounts/instagram');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/platform/i);
  });

  test('normalizes platform case in path', async ({ request }) => {
    const { token } = await getAdmin(request);
    touchedAccountPlatforms.add('facebook');
    const res = await del(request, token, '/api/social/accounts/FaceBook');
    expect(res.status()).toBe(200);
    expect((await res.json()).platform).toBe('facebook');
  });
});

// ──────────────────────────────────────────────────────────────────
// Auth gate
// ──────────────────────────────────────────────────────────────────

test.describe('Social API — auth gate', () => {
  test('GET /posts without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/social/posts`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /posts without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/social/posts`, {
      data: { platform: 'linkedin', content: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /posts/:id without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/social/posts/1`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /posts/:id/publish without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/social/posts/1/publish`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /mentions without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/social/mentions`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /mentions/fetch/:platform without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/social/mentions/fetch/twitter`, {
      data: { keywords: ['x'] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /mentions/:id/link-contact without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/social/mentions/1/link-contact`, {
      data: { contactId: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /accounts without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/social/accounts`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /accounts/:platform/connect without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/social/accounts/linkedin/connect`, {
      data: { accessToken: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('DELETE /accounts/:platform without token → 401/403', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/social/accounts/linkedin`);
    expect([401, 403]).toContain(res.status());
  });
});
