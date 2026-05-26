// @ts-check
/**
 * Unit + integration tests for backend/routes/social.js — pins the social
 * publishing + monitoring + account-connect surface that powers the
 * Marketing → Social admin page (LinkedIn / Twitter / Facebook).
 *
 * Why this file exists
 * ────────────────────
 *   routes/social.js is a 443-LOC three-domain CRUD module:
 *     1. POSTS   — list / create / publish / delete SocialPost rows
 *     2. MENTIONS — list / stub-fetch / link-to-contact SocialMention rows
 *     3. ACCOUNTS — list / connect / disconnect Integration rows for the
 *                   three supported platforms
 *   Plus four platform-publish stubs (publishToLinkedIn / Twitter / Facebook
 *   / dispatcher) which sit behind `POST /posts/:id/publish` and gate the
 *   FAILED-vs-PUBLISHED state transition. The route was historically silent
 *   (zero vitest coverage) — this file is the safety net.
 *
 * Tenant-isolation angle
 * ──────────────────────
 *   Every read (posts, mentions, integrations) AND every mutation (create,
 *   update, delete, link-contact) scopes by `tenantId(req)` = `req.user.tenantId`.
 *   We pin the where-clause on each path so a future "let me drop the
 *   tenant filter for simplicity" refactor reds the test instead of
 *   silently leaking cross-tenant data — same protection class as the
 *   #646 stripDangerous + ESLint-rule story.
 *
 * What this file pins
 * ───────────────────
 *   POSTS
 *   1. GET /posts scopes findMany by tenantId + applies optional platform
 *      and status query filters with platform-normalization (lowercased).
 *   2. POST /posts requires a SUPPORTED_PLATFORMS entry → 400 otherwise.
 *   3. POST /posts requires non-empty content → 400 otherwise.
 *   4. POST /posts derives status=SCHEDULED when scheduledFor is present
 *      and status=DRAFT when absent.
 *   5. POST /posts/:id/publish 404s when the row is in another tenant.
 *   6. POST /posts/:id/publish without integration credentials flips the
 *      row to FAILED (does NOT crash).
 *   7. POST /posts/:id/publish with a successful publish flips the row to
 *      PUBLISHED + stamps publishedAt + externalId.
 *   8. DELETE /posts/:id 404s when the row is in another tenant.
 *   9. DELETE /posts/:id returns { success: true } on a tenant-owned row.
 *
 *   MENTIONS
 *  10. GET /mentions scopes findMany by tenantId + applies optional
 *      platform / contactId / sentiment query filters.
 *  11. POST /mentions/fetch/:platform 400s on an unsupported platform.
 *  12. POST /mentions/fetch/:platform with no body falls back to the
 *      default 'globussoft' keyword and creates 1 SocialMention row.
 *  13. POST /mentions/:id/link-contact requires contactId → 400 otherwise.
 *  14. POST /mentions/:id/link-contact 404s when the mention is in another
 *      tenant.
 *
 *   ACCOUNTS
 *  15. GET /accounts returns one entry per SUPPORTED_PLATFORM with the
 *      connected boolean derived from integration.isActive && token.
 *  16. POST /accounts/:platform/connect rejects unsupported platforms (400).
 *  17. POST /accounts/:platform/connect requires accessToken → 400 otherwise.
 *  18. POST /accounts/:platform/connect creates a new Integration row when
 *      none exists for the (tenant, platform) pair.
 *  19. POST /accounts/:platform/connect updates the existing Integration
 *      row when one is already present (no duplicate create).
 *  20. DELETE /accounts/:platform soft-disconnects by flipping isActive=false
 *      + token=null instead of deleting the row (audit-trail preservation).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/communications.test.js + ab-tests.test.js —
 *   prisma singleton monkey-patch BEFORE the router is required, then mount
 *   the router into a bare express app with a fake req.user injector and
 *   drive it via supertest. No real DB, no real network — the LinkedIn /
 *   Twitter / Facebook fetch calls are short-circuited by the route's own
 *   "no token configured" guard so we don't have to mock global.fetch for
 *   the FAILED path (the SUCCESS path uses a per-test global.fetch stub).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required,
// since the router's top-level `require('../lib/prisma')` resolves at
// import time and captures whatever shape these models point at then.
prisma.socialPost = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.socialMention = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.integration = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const socialRouter = requireCJS('../../routes/social');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/social', socialRouter);
  return app;
}

beforeEach(() => {
  prisma.socialPost.findMany.mockReset();
  prisma.socialPost.findFirst.mockReset();
  prisma.socialPost.create.mockReset();
  prisma.socialPost.update.mockReset();
  prisma.socialPost.delete.mockReset();

  prisma.socialMention.findMany.mockReset();
  prisma.socialMention.findFirst.mockReset();
  prisma.socialMention.create.mockReset();
  prisma.socialMention.update.mockReset();

  prisma.integration.findMany.mockReset();
  prisma.integration.findFirst.mockReset();
  prisma.integration.create.mockReset();
  prisma.integration.update.mockReset();

  prisma.contact.findFirst.mockReset();

  // Sensible defaults — every test that needs different behaviour overrides.
  prisma.socialPost.findMany.mockResolvedValue([]);
  prisma.socialMention.findMany.mockResolvedValue([]);
  prisma.integration.findMany.mockResolvedValue([]);
});

// ─── POSTS — list, create, publish, delete ──────────────────────────

describe('GET /posts — list', () => {
  test('scopes findMany by tenantId and respects platform + status filters', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.socialPost.findMany.mockResolvedValue([
      { id: 1, platform: 'linkedin', status: 'DRAFT', tenantId: 42 },
    ]);

    const res = await request(app)
      .get('/api/social/posts?platform=LinkedIn&status=DRAFT');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(prisma.socialPost.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.socialPost.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    // Platform query is lower-cased via normalizePlatform.
    expect(args.where.platform).toBe('linkedin');
    expect(args.where.status).toBe('DRAFT');
    expect(args.take).toBe(200);
  });

  test('returns 500 envelope when prisma throws', async () => {
    const app = makeApp();
    prisma.socialPost.findMany.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/social/posts');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to list posts' });
  });
});

describe('POST /posts — create', () => {
  test('400 when platform is missing or unsupported', async () => {
    const app = makeApp();

    const missing = await request(app)
      .post('/api/social/posts')
      .send({ content: 'hello' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/platform must be/);

    const unsupported = await request(app)
      .post('/api/social/posts')
      .send({ platform: 'myspace', content: 'hello' });
    expect(unsupported.status).toBe(400);

    expect(prisma.socialPost.create).not.toHaveBeenCalled();
  });

  test('400 when content is empty/whitespace', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/social/posts')
      .send({ platform: 'twitter', content: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/);
    expect(prisma.socialPost.create).not.toHaveBeenCalled();
  });

  test('status=DRAFT when scheduledFor is absent', async () => {
    const app = makeApp({ tenantId: 9 });
    prisma.socialPost.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 101, ...data, createdAt: new Date() })
    );

    const res = await request(app)
      .post('/api/social/posts')
      .send({ platform: 'linkedin', content: 'launch news', mediaUrl: 'https://x/y.png' });

    expect(res.status).toBe(200);
    expect(prisma.socialPost.create).toHaveBeenCalledTimes(1);
    const data = prisma.socialPost.create.mock.calls[0][0].data;
    expect(data.platform).toBe('linkedin');
    expect(data.content).toBe('launch news');
    expect(data.mediaUrl).toBe('https://x/y.png');
    expect(data.scheduledFor).toBeNull();
    expect(data.status).toBe('DRAFT');
    expect(data.tenantId).toBe(9);
  });

  test('status=SCHEDULED when scheduledFor is present', async () => {
    const app = makeApp();
    prisma.socialPost.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 102, ...data })
    );
    const future = '2030-01-01T12:00:00.000Z';

    const res = await request(app)
      .post('/api/social/posts')
      .send({ platform: 'facebook', content: 'queued', scheduledFor: future });

    expect(res.status).toBe(200);
    const data = prisma.socialPost.create.mock.calls[0][0].data;
    expect(data.status).toBe('SCHEDULED');
    expect(data.scheduledFor instanceof Date).toBe(true);
    expect(data.scheduledFor.toISOString()).toBe(future);
  });
});

describe('POST /posts/:id/publish — manual publish', () => {
  test('404 when the post belongs to a different tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.socialPost.findFirst.mockResolvedValue(null); // cross-tenant lookup fails

    const res = await request(app).post('/api/social/posts/55/publish');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Tenant filter pinned on the load:
    const where = prisma.socialPost.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: 55, tenantId: 1 });
    expect(prisma.socialPost.update).not.toHaveBeenCalled();
  });

  test('flips status=FAILED when no integration credentials are configured', async () => {
    const app = makeApp();
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 7, platform: 'linkedin', content: 'hi', tenantId: 1, status: 'DRAFT', mediaUrl: null,
    });
    prisma.integration.findFirst.mockResolvedValue(null); // no creds
    prisma.socialPost.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 7, ...data })
    );

    const res = await request(app).post('/api/social/posts/7/publish');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/LinkedIn credentials not configured/i);
    expect(prisma.socialPost.update).toHaveBeenCalledTimes(1);
    expect(prisma.socialPost.update.mock.calls[0][0].data.status).toBe('FAILED');
  });

  test('flips status=PUBLISHED + stamps publishedAt/externalId on success', async () => {
    const app = makeApp();
    prisma.socialPost.findFirst.mockResolvedValue({
      id: 8, platform: 'twitter', content: 'hello world', tenantId: 1, status: 'DRAFT', mediaUrl: null,
    });
    prisma.integration.findFirst.mockResolvedValue({
      id: 1, provider: 'twitter', token: 'xyz', isActive: true, tenantId: 1, settings: null,
    });
    // Stub the Twitter API call — Twitter v2 returns { data: { id } }.
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'tw-12345' } }),
    });
    const prevFetch = global.fetch;
    global.fetch = fetchStub;

    prisma.socialPost.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 8, ...data })
    );

    try {
      const res = await request(app).post('/api/social/posts/8/publish');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.post.status).toBe('PUBLISHED');
      expect(res.body.post.externalId).toBe('tw-12345');
      expect(res.body.post.publishedAt instanceof Date || typeof res.body.post.publishedAt === 'string').toBe(true);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0][0]).toMatch(/twitter\.com.*tweets/);
    } finally {
      global.fetch = prevFetch;
    }
  });
});

describe('DELETE /posts/:id', () => {
  test('404 when the row is in another tenant', async () => {
    const app = makeApp();
    prisma.socialPost.findFirst.mockResolvedValue(null);

    const res = await request(app).delete('/api/social/posts/99');

    expect(res.status).toBe(404);
    expect(prisma.socialPost.delete).not.toHaveBeenCalled();
  });

  test('returns {success:true} when the row is tenant-owned', async () => {
    const app = makeApp({ tenantId: 3 });
    prisma.socialPost.findFirst.mockResolvedValue({ id: 99, tenantId: 3 });
    prisma.socialPost.delete.mockResolvedValue({ id: 99 });

    const res = await request(app).delete('/api/social/posts/99');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // Tenant filter pinned on the existence check:
    expect(prisma.socialPost.findFirst.mock.calls[0][0].where).toEqual({ id: 99, tenantId: 3 });
    expect(prisma.socialPost.delete.mock.calls[0][0].where).toEqual({ id: 99 });
  });
});

// ─── MENTIONS — list, fetch (stub), link-contact ────────────────────

describe('GET /mentions — list', () => {
  test('scopes by tenantId + applies platform/contactId/sentiment filters', async () => {
    const app = makeApp({ tenantId: 5 });
    prisma.socialMention.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/social/mentions?platform=Twitter&contactId=77&sentiment=positive');

    expect(res.status).toBe(200);
    const args = prisma.socialMention.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(5);
    expect(args.where.platform).toBe('twitter');
    expect(args.where.contactId).toBe(77);
    expect(args.where.sentiment).toBe('positive');
    expect(args.orderBy).toEqual({ fetchedAt: 'desc' });
  });
});

describe('POST /mentions/fetch/:platform — stub fetcher', () => {
  test('400 on unsupported platform', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/social/mentions/fetch/myspace')
      .send({ keywords: ['foo'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported platform/i);
    expect(prisma.socialMention.create).not.toHaveBeenCalled();
  });

  test('defaults to "globussoft" keyword when none provided and creates one mention', async () => {
    const app = makeApp({ tenantId: 4 });
    prisma.socialMention.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1, ...data })
    );

    const res = await request(app)
      .post('/api/social/mentions/fetch/linkedin')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stub).toBe(true);
    expect(res.body.fetched).toBe(1);
    expect(prisma.socialMention.create).toHaveBeenCalledTimes(1);
    const data = prisma.socialMention.create.mock.calls[0][0].data;
    expect(data.platform).toBe('linkedin');
    expect(data.tenantId).toBe(4);
    expect(data.content).toMatch(/globussoft/i);
  });
});

describe('POST /mentions/:id/link-contact', () => {
  test('400 when contactId is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/social/mentions/12/link-contact')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactId is required/i);
  });

  test('404 when the mention is in another tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.socialMention.findFirst.mockResolvedValue(null); // cross-tenant

    const res = await request(app)
      .post('/api/social/mentions/12/link-contact')
      .send({ contactId: 999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Mention not found/i);
    // Tenant filter pinned:
    expect(prisma.socialMention.findFirst.mock.calls[0][0].where).toEqual({ id: 12, tenantId: 1 });
    expect(prisma.socialMention.update).not.toHaveBeenCalled();
  });

  test('404 when the contact is in another tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.socialMention.findFirst.mockResolvedValue({ id: 12, tenantId: 1 });
    prisma.contact.findFirst.mockResolvedValue(null); // cross-tenant contact

    const res = await request(app)
      .post('/api/social/mentions/12/link-contact')
      .send({ contactId: 999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Contact not found/i);
    expect(prisma.contact.findFirst.mock.calls[0][0].where).toEqual({ id: 999, tenantId: 1 });
    expect(prisma.socialMention.update).not.toHaveBeenCalled();
  });

  test('links the mention to the contact when both belong to the tenant', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.socialMention.findFirst.mockResolvedValue({ id: 12, tenantId: 1 });
    prisma.contact.findFirst.mockResolvedValue({ id: 999, tenantId: 1 });
    prisma.socialMention.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, ...data })
    );

    const res = await request(app)
      .post('/api/social/mentions/12/link-contact')
      .send({ contactId: 999 });

    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe(999);
    expect(prisma.socialMention.update).toHaveBeenCalledTimes(1);
    expect(prisma.socialMention.update.mock.calls[0][0]).toEqual({
      where: { id: 12 },
      data: { contactId: 999 },
    });
  });
});

// ─── ACCOUNTS — list, connect, disconnect ───────────────────────────

describe('GET /accounts — list per-platform connection state', () => {
  test('returns one entry per SUPPORTED_PLATFORM with connected boolean derived from isActive+token', async () => {
    const app = makeApp({ tenantId: 2 });
    prisma.integration.findMany.mockResolvedValue([
      { provider: 'linkedin', isActive: true, token: 'live-tok', updatedAt: new Date('2026-01-01') },
      { provider: 'twitter', isActive: false, token: 'stale-tok', updatedAt: null },
      // facebook absent — should still show up as a row with connected:false
    ]);

    const res = await request(app).get('/api/social/accounts');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);

    const map = Object.fromEntries(res.body.map((r) => [r.platform, r]));
    expect(map.linkedin.connected).toBe(true);
    expect(map.twitter.connected).toBe(false); // isActive=false → not connected
    expect(map.facebook.connected).toBe(false); // missing row → not connected

    // Tenant + provider-in-allowlist filter pinned on the read:
    const where = prisma.integration.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(2);
    expect(where.provider).toEqual({ in: ['linkedin', 'twitter', 'facebook'] });
  });
});

describe('POST /accounts/:platform/connect', () => {
  test('400 on unsupported platform', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/social/accounts/myspace/connect')
      .send({ accessToken: 'tok' });
    expect(res.status).toBe(400);
    expect(prisma.integration.create).not.toHaveBeenCalled();
    expect(prisma.integration.update).not.toHaveBeenCalled();
  });

  test('400 when accessToken is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/social/accounts/linkedin/connect')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accessToken is required/i);
    expect(prisma.integration.create).not.toHaveBeenCalled();
  });

  test('creates a new Integration row when none exists', async () => {
    const app = makeApp({ tenantId: 11 });
    prisma.integration.findFirst.mockResolvedValue(null); // no existing
    prisma.integration.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 555, ...data })
    );

    const res = await request(app)
      .post('/api/social/accounts/linkedin/connect')
      .send({ accessToken: 'fresh-tok', authorUrn: 'urn:li:person:rishu' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, platform: 'linkedin', connected: true, id: 555 });
    expect(prisma.integration.create).toHaveBeenCalledTimes(1);
    expect(prisma.integration.update).not.toHaveBeenCalled();
    const data = prisma.integration.create.mock.calls[0][0].data;
    expect(data.provider).toBe('linkedin');
    expect(data.token).toBe('fresh-tok');
    expect(data.isActive).toBe(true);
    expect(data.tenantId).toBe(11);
    // Settings round-trip the rest payload as JSON.
    expect(JSON.parse(data.settings)).toEqual({ authorUrn: 'urn:li:person:rishu' });
  });

  test('updates the existing Integration row instead of creating a duplicate', async () => {
    const app = makeApp({ tenantId: 11 });
    prisma.integration.findFirst.mockResolvedValue({
      id: 42, provider: 'twitter', token: 'old', isActive: false, tenantId: 11,
    });
    prisma.integration.update.mockImplementation(({ data, where }) =>
      Promise.resolve({ id: where.id, ...data })
    );

    const res = await request(app)
      .post('/api/social/accounts/twitter/connect')
      .send({ accessToken: 'new-tok', accessSecret: 'sec' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    expect(prisma.integration.create).not.toHaveBeenCalled();
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
    const args = prisma.integration.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 42 });
    expect(args.data.token).toBe('new-tok');
    expect(args.data.isActive).toBe(true);
    expect(JSON.parse(args.data.settings)).toEqual({ accessSecret: 'sec' });
  });
});

describe('DELETE /accounts/:platform — soft-disconnect', () => {
  test('400 on unsupported platform', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/social/accounts/myspace');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported platform/i);
  });

  test('no-op success envelope when no integration row exists for this tenant', async () => {
    const app = makeApp();
    prisma.integration.findFirst.mockResolvedValue(null);

    const res = await request(app).delete('/api/social/accounts/facebook');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, platform: 'facebook', connected: false });
    expect(prisma.integration.update).not.toHaveBeenCalled();
  });

  test('soft-disconnects by flipping isActive=false + token=null (does NOT delete the row)', async () => {
    const app = makeApp({ tenantId: 1 });
    prisma.integration.findFirst.mockResolvedValue({
      id: 88, provider: 'linkedin', token: 'live', isActive: true, tenantId: 1,
    });
    prisma.integration.update.mockResolvedValue({ id: 88, isActive: false, token: null });

    const res = await request(app).delete('/api/social/accounts/linkedin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, platform: 'linkedin', connected: false });
    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
    const args = prisma.integration.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 88 });
    expect(args.data).toEqual({ isActive: false, token: null });
  });
});
