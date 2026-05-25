// @ts-check
/**
 * Unit tests for backend/routes/data_enrichment.js — pin the
 * heuristic-enrichment surface (corporate-domain inference + persist) that
 * backs the Contacts page "Enrich" button + bulk + 24h-auto pipelines.
 *
 * Why this file exists
 * ────────────────────
 * data_enrichment.js is 207 LOC of provider-agnostic enrichment plumbing
 * with several easy-to-break contracts: the free-email-domain allow-list
 * (Gmail/Yahoo/etc. MUST NOT generate a fake corporate website), the
 * graceful schema fallback (industry/companySize may not exist on every
 * schema deploy), the bulk + auto-enrich-new tenant-scope, and the
 * provider-flag advertisement. None of this was tested.
 *
 * What this file pins (13 cases across 5 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET /providers — always advertises heuristic=true; gemini flag is
 *      true iff GEMINI_API_KEY env was set at module-load; clearbit/apollo
 *      pinned false (the route has no real provider keys wired today).
 *   2. POST /contact/:id — happy path: corporate email (acme.com) derives
 *      domain + isCorporate=true + guessed company + website + linkedin
 *      slug + lastEnrichedAt; persists via prisma.contact.update.
 *   3. POST /contact/:id — free-mail email (gmail.com): isCorporate=false,
 *      website/linkedin nulled; company NOT inferred (no fake "Gmail" company).
 *   4. POST /contact/:id — contact.company is preserved when already set
 *      (the inferred company MUST NOT clobber a real value the user typed).
 *   5. POST /contact/:id — 404 on cross-tenant id (findFirst scoped by
 *      req.user.tenantId returns null).
 *   6. POST /contact/:id — 400 on non-numeric id (parseInt → NaN).
 *   7. POST /contact/:id — graceful schema fallback: when prisma.update
 *      throws (missing optional columns like industry/companySize/website),
 *      retry with safe subset {company}; if that also throws, log-and-return
 *      the existing contact (never 500 to the caller).
 *   8. POST /bulk — 400 when contactIds is missing or empty.
 *   9. POST /bulk — happy path: enriches all 3, returns enrichedCount + per-
 *      contact results; tenant scope applied to findMany.
 *  10. POST /bulk — tenant isolation: contacts belonging to another tenant
 *      are filtered out at the findMany level (where.tenantId is set).
 *  11. POST /auto-enrich-new — happy path: scans last-24h candidates with
 *      OR:[{industry:null},{companySize:null}] filter, enriches each.
 *  12. POST /auto-enrich-new — graceful schema fallback: if the first
 *      findMany throws (industry/companySize columns missing), retries
 *      WITHOUT the OR clause and still enriches the candidates.
 *  13. Auth gate — verifyToken is router-level (line 11), so without a
 *      Bearer token the route returns 401 before any handler runs.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/payments.test.js — prisma singleton monkey-
 * patched BEFORE requiring the router (vi.mock does not reliably intercept
 * CJS require in this repo's vitest config), env set pre-import, supertest
 * with a fake auth middleware that sets req.user. No external provider
 * calls — the route is heuristic-only today, so the SDK self-mocking seam
 * isn't needed; the credential surface we exercise is GEMINI_API_KEY's
 * effect on /providers.
 *
 * Bug exposure: source bugs found → it.skip + GH issue (none found).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// ── env MUST be set before importing the route ─────────────────────────
// The route reads GEMINI_API_KEY at module-load to compute the
// /providers `gemini` flag (line 9). Set it so we exercise the truthy
// branch. JWT_SECRET likewise must be set BEFORE the auth middleware is
// loaded (config/secrets.js binds JWT_SECRET at module-load).
process.env.GEMINI_API_KEY = 'gem_test_data_enrichment_fixture';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// ── prisma singleton patching ──────────────────────────────────────────
import prisma from '../../lib/prisma.js';

prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.findUnique = vi.fn();
prisma.contact.update = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const enrichmentRouter = requireCJS('../../routes/data_enrichment');

const JWT_SECRET = process.env.JWT_SECRET;

function signFor({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  // The router mounts verifyToken at line 11 — every request needs a real
  // signed JWT carrying userId + tenantId. No jti, so the revokedToken
  // lookup is skipped.
  return jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '5m' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/data-enrichment', enrichmentRouter);
  return app;
}

function bearerFor(opts) {
  return `Bearer ${signFor(opts)}`;
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.findUnique.mockReset();
  prisma.contact.update.mockReset();

  // Sensible defaults — each test overrides what it cares about.
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.contact.findUnique.mockResolvedValue(null);
  prisma.contact.update.mockImplementation(async ({ where, data }) => ({
    id: where.id,
    tenantId: 1,
    ...data,
  }));
});

// ─────────────────────────────────────────────────────────────────────────
// GET /providers — feature-flag advertisement
// ─────────────────────────────────────────────────────────────────────────

describe('GET /providers — provider flag advertisement', () => {
  test('advertises heuristic=true always; gemini reflects GEMINI_API_KEY presence; clearbit/apollo pinned false', async () => {
    const res = await request(makeApp())
      .get('/api/data-enrichment/providers')
      .set('Authorization', bearerFor());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gemini: true, // env set above
      clearbit: false,
      apollo: false,
      heuristic: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /contact/:id — single-contact enrichment
// ─────────────────────────────────────────────────────────────────────────

describe('POST /contact/:id — single-contact heuristic enrichment', () => {
  test('corporate email → derives domain + company + website + linkedin slug + lastEnrichedAt', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 5,
      tenantId: 1,
      email: 'alice@acme-corp.com',
      company: null,
    });

    const res = await request(makeApp())
      .post('/api/data-enrichment/contact/5')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe(5);
    expect(res.body.domain).toBe('acme-corp.com');
    expect(res.body.isCorporate).toBe(true);
    // titleCase splits the registrable root ("acme-corp") on `[-_\s]+` →
    // ["Acme","Corp"] → joined with a space.
    expect(res.body.enriched.company).toBe('Acme Corp');
    expect(res.body.enriched.website).toBe('https://acme-corp.com');
    // slugify lowercases + normalises non-alphanumerics → "acme-corp".
    expect(res.body.enriched.linkedin).toBe('https://www.linkedin.com/company/acme-corp');
    expect(res.body.enriched.lastEnrichedAt).toBeTruthy();

    // Tenant scope enforced on the read.
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
    expect(prisma.contact.update).toHaveBeenCalled();
  });

  test('free-mail email (gmail.com) → isCorporate=false, website + linkedin nulled, NO fake company inferred', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 6,
      tenantId: 1,
      email: 'bob@gmail.com',
      company: null,
    });

    const res = await request(makeApp())
      .post('/api/data-enrichment/contact/6')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.domain).toBe('gmail.com');
    expect(res.body.isCorporate).toBe(false);
    // No fake "Gmail" company.
    expect(res.body.enriched.company).toBeUndefined();
    expect(res.body.enriched.website).toBeNull();
    expect(res.body.enriched.linkedin).toBeNull();
  });

  test('preserves existing contact.company — does NOT clobber a user-typed value with the inferred guess', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 7,
      tenantId: 1,
      email: 'carol@globussoft.com',
      company: 'Globussoft Technologies Pvt Ltd', // user-typed full name
    });

    const res = await request(makeApp())
      .post('/api/data-enrichment/contact/7')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.isCorporate).toBe(true);
    // The inferred "Globussoft" guess MUST NOT appear in the persisted fields
    // because the route's `if (!contact.company || !contact.company.trim())`
    // gate (line 53) skips the company-write when one is already set.
    expect(res.body.enriched.company).toBeUndefined();
    expect(res.body.enriched.website).toBe('https://globussoft.com');
  });

  test('404 when contact id belongs to a different tenant (cross-tenant isolation)', async () => {
    // Contact exists for tenant 99 but we're tenant 1 — findFirst returns null
    // because its where clause includes tenantId: 1.
    prisma.contact.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/data-enrichment/contact/777')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('400 on non-numeric id (parseInt → NaN)', async () => {
    const res = await request(makeApp())
      .post('/api/data-enrichment/contact/not-a-number')
      .set('Authorization', bearerFor())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('graceful schema fallback: full-update throws → retry with safe {company} subset; if THAT throws → return current contact (no 500)', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 8,
      tenantId: 1,
      email: 'dave@futurecorp.io',
      company: null,
    });
    // Simulate older schema deploy where `website`/`linkedin`/`lastEnrichedAt`
    // columns are missing. First update throws, second update (safe subset)
    // throws too, third falls back to findUnique.
    prisma.contact.update
      .mockRejectedValueOnce(new Error('Unknown arg `website`'))
      .mockRejectedValueOnce(new Error('Unknown arg `company`'));
    prisma.contact.findUnique.mockResolvedValue({
      id: 8,
      tenantId: 1,
      email: 'dave@futurecorp.io',
      company: null,
    });

    const res = await request(makeApp())
      .post('/api/data-enrichment/contact/8')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    // Critical: the route MUST NOT 500 in the column-missing fallback path.
    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe(8);
    expect(res.body.isCorporate).toBe(true);
    // The enriched envelope still reports the computed fields (the
    // persistence layer's failure is invisible to the caller).
    expect(res.body.enriched.company).toBe('Futurecorp');
    // Final fallback used findUnique to return the existing contact untouched.
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({ where: { id: 8 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /bulk — multi-contact enrichment
// ─────────────────────────────────────────────────────────────────────────

describe('POST /bulk — multi-contact enrichment', () => {
  test('400 when contactIds is missing or empty', async () => {
    const empty = await request(makeApp())
      .post('/api/data-enrichment/bulk')
      .set('Authorization', bearerFor())
      .send({ contactIds: [] });

    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/contactIds/i);

    const missing = await request(makeApp())
      .post('/api/data-enrichment/bulk')
      .set('Authorization', bearerFor())
      .send({});

    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/contactIds/i);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('happy path: enriches all 3 contacts, returns enrichedCount + per-contact results', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, email: 'a@acme.com', company: null },
      { id: 2, tenantId: 1, email: 'b@gmail.com', company: null },
      { id: 3, tenantId: 1, email: 'c@globussoft.com', company: 'Globussoft' },
    ]);

    const res = await request(makeApp())
      .post('/api/data-enrichment/bulk')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({ contactIds: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(res.body.enrichedCount).toBe(3);
    expect(res.body.results).toHaveLength(3);

    // Per-contact shape: contactId + domain + isCorporate + enriched
    expect(res.body.results[0]).toMatchObject({
      contactId: 1,
      domain: 'acme.com',
      isCorporate: true,
    });
    expect(res.body.results[1]).toMatchObject({
      contactId: 2,
      domain: 'gmail.com',
      isCorporate: false,
    });
    expect(res.body.results[2]).toMatchObject({
      contactId: 3,
      domain: 'globussoft.com',
      isCorporate: true,
    });
    expect(prisma.contact.update).toHaveBeenCalledTimes(3);
  });

  test('tenant isolation: findMany scoped by req.user.tenantId so cross-tenant ids are filtered at the DB layer', async () => {
    // Caller asks for ids [10, 20, 30] but only id 10 is in their tenant.
    prisma.contact.findMany.mockResolvedValue([
      { id: 10, tenantId: 9, email: 'mine@acme.com', company: null },
    ]);

    const res = await request(makeApp())
      .post('/api/data-enrichment/bulk')
      .set('Authorization', bearerFor({ tenantId: 9 }))
      .send({ contactIds: [10, 20, 30] });

    expect(res.status).toBe(200);
    expect(res.body.enrichedCount).toBe(1);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10, 20, 30] }, tenantId: 9 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /auto-enrich-new — last-24h sweep
// ─────────────────────────────────────────────────────────────────────────

describe('POST /auto-enrich-new — last-24h sweep', () => {
  test('happy path: filters by tenantId + createdAt>=24hAgo + OR:[industry=null, companySize=null]', async () => {
    const now = Date.now();
    prisma.contact.findMany.mockResolvedValue([
      { id: 100, tenantId: 1, email: 'fresh@newcorp.io', company: null },
      { id: 101, tenantId: 1, email: 'also@another.co', company: null },
    ]);

    const res = await request(makeApp())
      .post('/api/data-enrichment/auto-enrich-new')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(2);
    expect(res.body.enrichedCount).toBe(2);

    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    // 24h-ago boundary: should be within a few seconds of now-86400000.
    const gteMs = call.where.createdAt.gte.getTime();
    expect(gteMs).toBeGreaterThanOrEqual(now - 24 * 60 * 60 * 1000 - 5000);
    expect(gteMs).toBeLessThanOrEqual(now - 24 * 60 * 60 * 1000 + 5000);
    // OR clause exists in the primary query (the schema-aware branch).
    expect(call.where.OR).toEqual([
      { industry: null },
      { companySize: null },
    ]);
  });

  test('graceful schema fallback: first findMany throws (industry/companySize missing) → retries WITHOUT OR clause', async () => {
    // First call throws — simulating older schema without industry/companySize.
    prisma.contact.findMany
      .mockRejectedValueOnce(new Error("Unknown arg `industry`"))
      .mockResolvedValueOnce([
        { id: 200, tenantId: 1, email: 'foo@bar.com', company: null },
      ]);

    const res = await request(makeApp())
      .post('/api/data-enrichment/auto-enrich-new')
      .set('Authorization', bearerFor({ tenantId: 1 }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.enrichedCount).toBe(1);

    // Two calls — the second one MUST NOT include the OR clause.
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(2);
    const fallback = prisma.contact.findMany.mock.calls[1][0];
    expect(fallback.where.tenantId).toBe(1);
    expect(fallback.where.OR).toBeUndefined();
    expect(fallback.where.createdAt.gte).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Auth gate — verifyToken at router level (line 11)
// ─────────────────────────────────────────────────────────────────────────

describe('Auth gate — verifyToken router-level mount (line 11)', () => {
  test('without a Bearer token, every handler returns 401 before any prisma read', async () => {
    // No Authorization header at all — verifyToken's first guard
    // (line 22-23 of middleware/auth.js) returns 401 with
    // WWW-Authenticate: Bearer.
    const res = await request(makeApp()).get('/api/data-enrichment/providers');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('with an invalid/forged Bearer token, returns 401', async () => {
    const res = await request(makeApp())
      .get('/api/data-enrichment/providers')
      .set('Authorization', 'Bearer not.a.valid.jwt');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });
});
