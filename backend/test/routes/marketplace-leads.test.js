// @ts-check
/**
 * Unit tests for backend/routes/marketplace_leads.js — pins the IndiaMART /
 * JustDial / TradeIndia webhook ingest + dedup + import-to-Contact+Deal +
 * config management + tenant-scoped read surface that powers the Marketing →
 * Marketplace Leads admin page.
 *
 * Why this file exists (regression class)
 * ────────────────────────────────────────
 *   Pre-author the route was a top-10 c8 under-covered file at 13.68% lines.
 *   The module is a 402-LOC two-tier surface:
 *     1. AUTHENTICATED (verifyToken) — GET / list, GET /stats, POST /import/:id,
 *        POST /import-bulk, PUT /dismiss/:id. ADMIN-only — GET /config,
 *        PUT /config/:provider, POST /sync/:provider.
 *     2. PUBLIC webhook endpoints — POST /webhook/indiamart, /webhook/justdial,
 *        /webhook/tradeindia (no auth — invoked by external marketplace
 *        provider callbacks). Each normalizes a vendor-specific payload shape
 *        into the canonical MarketplaceLead row + dedups via
 *        findDuplicateMarketplaceLead(provider, externalId).
 *
 * Tenant-isolation angle
 * ──────────────────────
 *   All authed reads/mutations pin `tenantId = req.user.tenantId` on the where
 *   clause. The list, stats, import, import-bulk, dismiss, config endpoints
 *   each scope by tenant. The PUBLIC webhook endpoints intentionally hardcode
 *   `tenantId: 1` (Default Org) per the source comment — production routing
 *   by provider config is a TODO. Tests pin the current behaviour so a future
 *   refactor that drops the tenant filter on read-paths reds the spec
 *   instead of silently leaking cross-tenant data.
 *
 * Config-masking contract
 * ───────────────────────
 *   GET /config returns api keys/secrets masked as `••••<last4>`. PUT /config
 *   rejects updates that come in pre-masked (starts with `••••`) so the SPA
 *   re-displaying the masked value and clicking Save can't blank out the
 *   stored credential. Test pins both.
 *
 * What this file pins (15 cases)
 * ──────────────────────────────
 *   GET /
 *   1. list scopes by tenantId + applies provider/status/date filters
 *   2. pagination skip/take + envelope `{leads,total,page,pages}`
 *
 *   GET /stats
 *   3. groups by provider + status + computes conversionRate from "Imported"
 *
 *   POST /import/:id
 *   4. 404 when lead is in another tenant (tenant filter pinned)
 *   5. 400 when lead.status === "Imported" (idempotency)
 *   6. duplicate path — links to existing contact, marks lead Duplicate
 *   7. happy path — creates Contact + Deal + auditLog, marks lead Imported
 *
 *   POST /import-bulk
 *   8. 400 when leadIds missing/empty
 *   9. counts imported / duplicates / failed across mixed batch
 *
 *   PUT /dismiss/:id
 *  10. 404 when lead is in another tenant
 *
 *   GET /config (ADMIN)
 *  11. masks apiKey/apiSecret/glueCrmKey as ••••<last4>
 *
 *   PUT /config/:provider (ADMIN)
 *  12. ignores pre-masked apiKey on update (••••xxxx is preserved server-side)
 *
 *   POST /webhook/indiamart
 *  13. normalizes IndiaMART UNIQUE_QUERY_ID + SENDER_* fields into a row
 *  14. dedups on (provider, externalId) — duplicate query_id skipped
 *
 *   POST /webhook/justdial
 *  15. normalizes JustDial leadid + name/email/phone fields into a row
 *
 *   POST /webhook/tradeindia
 *  16. normalizes TradeIndia inquiry_id + sender_email/sender_mobile into a row
 *
 *   Webhook ingest skips records without an external id (no crash).
 *  17. POST /webhook/indiamart with no UNIQUE_QUERY_ID returns created:0
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/chatbots.test.js — prisma singleton
 *   monkey-patch BEFORE the router is required, replace verifyToken with a
 *   pass-through so verifyRole stays REAL (we exercise the ADMIN gate), then
 *   mount the router into a bare express app with a fake req.user injector.
 *   Drive via supertest. No real DB.
 *
 *   The `deduplication` util is patched in the require cache so the SUT's
 *   top-level `require('../utils/deduplication')` destructure binds to our
 *   mock — same pattern as backend/test/cron/marketplaceEngine.test.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

// ── Fake deduplication module in require cache (BEFORE SUT require) ────
const findDuplicateContactMock = vi.fn();
const findDuplicateMarketplaceLeadMock = vi.fn();
const Module = requireCJS('node:module');
const dedupPath = requireCJS.resolve('../../utils/deduplication.js');
Module._cache[dedupPath] = {
  id: dedupPath,
  filename: dedupPath,
  loaded: true,
  exports: {
    findDuplicateContact: findDuplicateContactMock,
    findDuplicateMarketplaceLead: findDuplicateMarketplaceLeadMock,
  },
};

// ── Auth bypass — pass through verifyToken so verifyRole stays REAL ────
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// ── Prisma singleton patching — BEFORE the router is required ──────────
prisma.marketplaceLead = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
};
prisma.marketplaceConfig = {
  findMany: vi.fn(),
  upsert: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.create = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.create = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();

import express from 'express';
import request from 'supertest';

const mlRouter = requireCJS('../../routes/marketplace_leads');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/marketplace-leads', mlRouter);
  return app;
}

beforeEach(() => {
  prisma.marketplaceLead.findMany.mockReset();
  prisma.marketplaceLead.findFirst.mockReset();
  prisma.marketplaceLead.findUnique.mockReset();
  prisma.marketplaceLead.create.mockReset();
  prisma.marketplaceLead.update.mockReset();
  prisma.marketplaceLead.count.mockReset();
  prisma.marketplaceLead.groupBy.mockReset();
  prisma.marketplaceConfig.findMany.mockReset();
  prisma.marketplaceConfig.upsert.mockReset();
  prisma.contact.create.mockReset();
  prisma.deal.create.mockReset();
  prisma.auditLog.create.mockReset();
  findDuplicateContactMock.mockReset();
  findDuplicateMarketplaceLeadMock.mockReset();

  // Sensible defaults — empty results / no duplicates
  prisma.marketplaceLead.findMany.mockResolvedValue([]);
  prisma.marketplaceLead.count.mockResolvedValue(0);
  prisma.marketplaceLead.groupBy.mockResolvedValue([]);
  prisma.marketplaceConfig.findMany.mockResolvedValue([]);
  findDuplicateContactMock.mockResolvedValue(null);
  findDuplicateMarketplaceLeadMock.mockResolvedValue(null);
});

// ─── GET / — list marketplace leads ─────────────────────────────────

describe('GET /api/marketplace-leads', () => {
  test('scopes findMany by tenantId + applies provider/status/date filters', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.marketplaceLead.findMany.mockResolvedValue([
      { id: 1, provider: 'indiamart', status: 'New', tenantId: 42, contact: null },
    ]);
    prisma.marketplaceLead.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/marketplace-leads')
      .query({ provider: 'indiamart', status: 'New', from: '2026-01-01', to: '2026-12-31' });

    expect(res.status).toBe(200);
    const args = prisma.marketplaceLead.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.provider).toBe('indiamart');
    expect(args.where.status).toBe('New');
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
    expect(args.where.createdAt.lte).toBeInstanceOf(Date);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('applies pagination (skip/take) and returns envelope {leads,total,page,pages}', async () => {
    const app = makeApp({ tenantId: 7 });
    prisma.marketplaceLead.findMany.mockResolvedValue([]);
    prisma.marketplaceLead.count.mockResolvedValue(150);

    const res = await request(app)
      .get('/api/marketplace-leads')
      .query({ page: '3', limit: '50' });

    expect(res.status).toBe(200);
    const args = prisma.marketplaceLead.findMany.mock.calls[0][0];
    expect(args.skip).toBe(100); // (3-1)*50
    expect(args.take).toBe(50);
    expect(res.body).toEqual({
      leads: [],
      total: 150,
      page: 3,
      pages: 3, // ceil(150/50)
    });
  });
});

// ─── GET /stats — dashboard aggregates ──────────────────────────────

describe('GET /api/marketplace-leads/stats', () => {
  test('groups by provider + status + computes conversionRate from Imported count', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.marketplaceLead.groupBy
      .mockResolvedValueOnce([
        { provider: 'indiamart', _count: 7 },
        { provider: 'justdial', _count: 3 },
      ])
      .mockResolvedValueOnce([
        { status: 'New', _count: 6 },
        { status: 'Imported', _count: 4 },
      ]);
    prisma.marketplaceLead.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(2); // thisWeek

    const res = await request(app).get('/api/marketplace-leads/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 10,
      thisWeek: 2,
      conversionRate: 40.0, // 4/10 * 100
      byProvider: [
        { provider: 'indiamart', count: 7 },
        { provider: 'justdial', count: 3 },
      ],
      byStatus: [
        { status: 'New', count: 6 },
        { status: 'Imported', count: 4 },
      ],
    });

    // Tenant pinned on each call
    const groupByProviderArgs = prisma.marketplaceLead.groupBy.mock.calls[0][0];
    const groupByStatusArgs = prisma.marketplaceLead.groupBy.mock.calls[1][0];
    expect(groupByProviderArgs.where.tenantId).toBe(42);
    expect(groupByStatusArgs.where.tenantId).toBe(42);
  });
});

// ─── POST /import/:id — single lead import ──────────────────────────

describe('POST /api/marketplace-leads/import/:id', () => {
  test('404 when the lead is in another tenant (tenant filter pinned)', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.marketplaceLead.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/marketplace-leads/import/99');

    expect(res.status).toBe(404);
    const args = prisma.marketplaceLead.findFirst.mock.calls[0][0];
    expect(args.where.id).toBe(99);
    expect(args.where.tenantId).toBe(42);
  });

  test('400 when the lead is already Imported (idempotency guard)', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.marketplaceLead.findFirst.mockResolvedValue({
      id: 1, status: 'Imported', tenantId: 42, provider: 'indiamart',
    });

    const res = await request(app).post('/api/marketplace-leads/import/1');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already imported/i);
  });

  test('duplicate branch — links existing contact, marks lead Duplicate, skips Contact/Deal create', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.marketplaceLead.findFirst.mockResolvedValue({
      id: 5, status: 'New', tenantId: 42, provider: 'indiamart',
      email: 'rishu@enhancedwellness.in', phone: '9876543210',
    });
    findDuplicateContactMock.mockResolvedValue({ id: 88, name: 'Rishu' });

    const res = await request(app).post('/api/marketplace-leads/import/5');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      imported: false,
      duplicate: true,
      contactId: 88,
      message: expect.stringMatching(/duplicate/i),
    });

    // findDuplicateContact called with (email, phone, tenantId)
    expect(findDuplicateContactMock).toHaveBeenCalledWith(
      'rishu@enhancedwellness.in',
      '9876543210',
      42
    );

    // lead.update marked Duplicate with contactId pinned
    const updateArgs = prisma.marketplaceLead.update.mock.calls[0][0];
    expect(updateArgs.data).toEqual({ status: 'Duplicate', contactId: 88 });

    // No Contact or Deal created in the duplicate branch
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  test('happy path — creates Contact + Deal + auditLog, marks lead Imported, capitalizes provider as source', async () => {
    const app = makeApp({ tenantId: 42, userId: 11 });
    prisma.marketplaceLead.findFirst.mockResolvedValue({
      id: 5, status: 'New', tenantId: 42, provider: 'indiamart',
      name: 'Asha Verma', email: 'asha@example.com', phone: '9988776655',
      company: 'Verma Enterprises', product: 'Aesthetic Equipment',
    });
    findDuplicateContactMock.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 200, name: 'Asha Verma' });
    prisma.deal.create.mockResolvedValue({ id: 300 });
    prisma.marketplaceLead.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});

    const res = await request(app).post('/api/marketplace-leads/import/5');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: true, contactId: 200 });

    // Contact created with tenant + capitalized provider as source + default aiScore 25
    const contactArgs = prisma.contact.create.mock.calls[0][0].data;
    expect(contactArgs.tenantId).toBe(42);
    expect(contactArgs.source).toBe('Indiamart'); // capitalized first letter
    expect(contactArgs.aiScore).toBe(25);
    expect(contactArgs.status).toBe('Lead');
    expect(contactArgs.email).toBe('asha@example.com');

    // Deal created with tenant + contactId + product-derived title
    const dealArgs = prisma.deal.create.mock.calls[0][0].data;
    expect(dealArgs.tenantId).toBe(42);
    expect(dealArgs.contactId).toBe(200);
    expect(dealArgs.stage).toBe('lead');
    expect(dealArgs.title).toContain('Aesthetic Equipment');

    // Lead marked Imported with contactId pinned
    const leadUpdateArgs = prisma.marketplaceLead.update.mock.calls[0][0];
    expect(leadUpdateArgs.data).toEqual({ status: 'Imported', contactId: 200 });

    // AuditLog written with userId from req.user
    const auditArgs = prisma.auditLog.create.mock.calls[0][0].data;
    expect(auditArgs.action).toBe('CREATE');
    expect(auditArgs.entity).toBe('Contact');
    expect(auditArgs.userId).toBe(11);
    expect(auditArgs.tenantId).toBe(42);
  });
});

// ─── POST /import-bulk — batch import ────────────────────────────────

describe('POST /api/marketplace-leads/import-bulk', () => {
  test('400 when leadIds missing or empty', async () => {
    const app = makeApp();

    const res1 = await request(app).post('/api/marketplace-leads/import-bulk').send({});
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/no lead ids/i);

    const res2 = await request(app).post('/api/marketplace-leads/import-bulk').send({ leadIds: [] });
    expect(res2.status).toBe(400);
  });

  test('counts imported / duplicates / failed across a mixed batch', async () => {
    const app = makeApp({ tenantId: 42 });

    // Lead 1 — happy path (create); Lead 2 — duplicate; Lead 3 — already-Imported (failed)
    prisma.marketplaceLead.findFirst
      .mockResolvedValueOnce({
        id: 1, status: 'New', tenantId: 42, provider: 'indiamart',
        email: 'one@example.com', phone: '111',
      })
      .mockResolvedValueOnce({
        id: 2, status: 'New', tenantId: 42, provider: 'justdial',
        email: 'two@example.com', phone: '222',
      })
      .mockResolvedValueOnce({
        id: 3, status: 'Imported', tenantId: 42, provider: 'tradeindia',
      });

    findDuplicateContactMock
      .mockResolvedValueOnce(null) // lead 1 — no dup
      .mockResolvedValueOnce({ id: 99, name: 'Dup' }); // lead 2 — dup

    prisma.contact.create.mockResolvedValue({ id: 200 });
    prisma.deal.create.mockResolvedValue({ id: 300 });
    prisma.marketplaceLead.update.mockResolvedValue({});

    const res = await request(app)
      .post('/api/marketplace-leads/import-bulk')
      .send({ leadIds: [1, 2, 3] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 1, duplicates: 1, failed: 1 });
  });
});

// ─── PUT /dismiss/:id ────────────────────────────────────────────────

describe('PUT /api/marketplace-leads/dismiss/:id', () => {
  test('404 when the lead is in another tenant', async () => {
    const app = makeApp({ tenantId: 42 });
    prisma.marketplaceLead.findFirst.mockResolvedValue(null);

    const res = await request(app).put('/api/marketplace-leads/dismiss/99');

    expect(res.status).toBe(404);
    const args = prisma.marketplaceLead.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
  });
});

// ─── GET /config (ADMIN) ─────────────────────────────────────────────

describe('GET /api/marketplace-leads/config', () => {
  test('returns api keys masked as ••••<last4> for apiKey/apiSecret/glueCrmKey', async () => {
    const app = makeApp({ tenantId: 42, role: 'ADMIN' });
    prisma.marketplaceConfig.findMany.mockResolvedValue([
      {
        provider: 'indiamart',
        apiKey: 'live_secret_key_ABCD1234',
        apiSecret: 'super_secret_XY99',
        glueCrmKey: 'glue_QWER',
        isActive: true,
        tenantId: 42,
      },
      {
        provider: 'justdial',
        apiKey: null,
        apiSecret: null,
        glueCrmKey: null,
        isActive: false,
        tenantId: 42,
      },
    ]);

    const res = await request(app).get('/api/marketplace-leads/config');

    expect(res.status).toBe(200);
    expect(res.body[0].apiKey).toBe('••••1234');
    expect(res.body[0].apiSecret).toBe('••••XY99');
    expect(res.body[0].glueCrmKey).toBe('••••QWER');
    expect(res.body[1].apiKey).toBeNull();
    expect(res.body[1].apiSecret).toBeNull();

    // Tenant pinned
    const args = prisma.marketplaceConfig.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
  });
});

// ─── PUT /config/:provider (ADMIN) ───────────────────────────────────

describe('PUT /api/marketplace-leads/config/:provider', () => {
  test('ignores pre-masked apiKey on update (•••• prefix preserves stored credential)', async () => {
    const app = makeApp({ tenantId: 42, role: 'ADMIN' });
    prisma.marketplaceConfig.upsert.mockResolvedValue({
      provider: 'indiamart', isActive: true,
    });

    const res = await request(app)
      .put('/api/marketplace-leads/config/indiamart')
      .send({
        apiKey: '••••1234', // masked-display value from SPA round-trip
        apiSecret: 'rotated_new_secret', // genuine update
        isActive: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, provider: 'indiamart', isActive: true });

    const upsertArgs = prisma.marketplaceConfig.upsert.mock.calls[0][0];
    // Masked apiKey was NOT included in the update payload
    expect(upsertArgs.update).not.toHaveProperty('apiKey');
    // Genuine new apiSecret WAS included
    expect(upsertArgs.update.apiSecret).toBe('rotated_new_secret');
    expect(upsertArgs.update.isActive).toBe(true);
    // Tenant pinned in the compound where
    expect(upsertArgs.where.tenantId_provider.tenantId).toBe(42);
    expect(upsertArgs.where.tenantId_provider.provider).toBe('indiamart');
  });
});

// ─── POST /webhook/indiamart (public, no auth) ───────────────────────

describe('POST /api/marketplace-leads/webhook/indiamart', () => {
  test('normalizes IndiaMART UNIQUE_QUERY_ID + SENDER_* fields into a MarketplaceLead row', async () => {
    const app = makeApp();
    findDuplicateMarketplaceLeadMock.mockResolvedValue(null);
    prisma.marketplaceLead.create.mockResolvedValue({ id: 1 });

    const res = await request(app)
      .post('/api/marketplace-leads/webhook/indiamart')
      .send({
        UNIQUE_QUERY_ID: 'QID-12345',
        SENDER_NAME: 'Priya Sharma',
        SENDER_EMAIL: 'priya@example.com',
        SENDER_MOBILE: '+91-9876543210',
        SENDER_COMPANY: 'Sharma Aesthetics',
        QUERY_PRODUCT_NAME: 'Hydra Facial Machine',
        QUERY_MESSAGE: 'Need a quote please.',
        SENDER_CITY: 'Mumbai',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, created: 1 });

    const createArgs = prisma.marketplaceLead.create.mock.calls[0][0].data;
    expect(createArgs.provider).toBe('indiamart');
    expect(createArgs.externalLeadId).toBe('QID-12345');
    expect(createArgs.name).toBe('Priya Sharma');
    expect(createArgs.email).toBe('priya@example.com');
    expect(createArgs.phone).toBe('+91-9876543210');
    expect(createArgs.company).toBe('Sharma Aesthetics');
    expect(createArgs.product).toBe('Hydra Facial Machine');
    expect(createArgs.city).toBe('Mumbai');
    expect(createArgs.status).toBe('New');
    // Public webhook hardcodes Default Org tenant per source comment
    expect(createArgs.tenantId).toBe(1);
    // rawPayload is JSON-stringified
    expect(typeof createArgs.rawPayload).toBe('string');
    expect(JSON.parse(createArgs.rawPayload).UNIQUE_QUERY_ID).toBe('QID-12345');
  });

  test('skips duplicate (provider, externalId) — findDuplicateMarketplaceLead returns existing, no create', async () => {
    const app = makeApp();
    findDuplicateMarketplaceLeadMock.mockResolvedValue({ id: 99, provider: 'indiamart' });

    const res = await request(app)
      .post('/api/marketplace-leads/webhook/indiamart')
      .send({ UNIQUE_QUERY_ID: 'QID-12345', SENDER_NAME: 'Dup' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, created: 0 });
    expect(prisma.marketplaceLead.create).not.toHaveBeenCalled();
    expect(findDuplicateMarketplaceLeadMock).toHaveBeenCalledWith('indiamart', 'QID-12345');
  });

  test('skips records without UNIQUE_QUERY_ID / QUERY_ID — returns created:0, no crash', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/marketplace-leads/webhook/indiamart')
      .send({ SENDER_NAME: 'Anon', SENDER_EMAIL: 'anon@x.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, created: 0 });
    expect(prisma.marketplaceLead.create).not.toHaveBeenCalled();
  });
});

// ─── POST /webhook/justdial (public, no auth) ────────────────────────

describe('POST /api/marketplace-leads/webhook/justdial', () => {
  test('normalizes JustDial leadid + name/email/phone fields into a MarketplaceLead row', async () => {
    const app = makeApp();
    findDuplicateMarketplaceLeadMock.mockResolvedValue(null);
    prisma.marketplaceLead.create.mockResolvedValue({ id: 2 });

    const res = await request(app)
      .post('/api/marketplace-leads/webhook/justdial')
      .send({
        leadid: 'JD-9988',
        name: 'Asha Verma',
        email: 'asha@example.com',
        mobile: '9988776655',
        companyname: 'Verma Salon',
        category: 'Salon Equipment',
        description: 'Looking for hair-spa chairs',
        area: 'Pune',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, created: 1 });

    const createArgs = prisma.marketplaceLead.create.mock.calls[0][0].data;
    expect(createArgs.provider).toBe('justdial');
    expect(createArgs.externalLeadId).toBe('JD-9988');
    expect(createArgs.name).toBe('Asha Verma');
    expect(createArgs.phone).toBe('9988776655');
    expect(createArgs.company).toBe('Verma Salon');
    expect(createArgs.product).toBe('Salon Equipment');
    expect(createArgs.message).toBe('Looking for hair-spa chairs');
    expect(createArgs.city).toBe('Pune');
    expect(createArgs.tenantId).toBe(1);
    expect(createArgs.status).toBe('New');
  });
});

// ─── POST /webhook/tradeindia (public, no auth) ──────────────────────

describe('POST /api/marketplace-leads/webhook/tradeindia', () => {
  test('normalizes TradeIndia inquiry_id + sender_* fields into a MarketplaceLead row', async () => {
    const app = makeApp();
    findDuplicateMarketplaceLeadMock.mockResolvedValue(null);
    prisma.marketplaceLead.create.mockResolvedValue({ id: 3 });

    const res = await request(app)
      .post('/api/marketplace-leads/webhook/tradeindia')
      .send({
        inquiry_id: 'TI-44552',
        sender_name: 'Karan Patel',
        sender_email: 'karan@patel.com',
        sender_mobile: '9001122334',
        sender_company: 'Patel Wellness',
        product_name: 'Spa Beds',
        message: 'Need 4 units, ship to Ahmedabad.',
        sender_city: 'Ahmedabad',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, created: 1 });

    const createArgs = prisma.marketplaceLead.create.mock.calls[0][0].data;
    expect(createArgs.provider).toBe('tradeindia');
    expect(createArgs.externalLeadId).toBe('TI-44552');
    expect(createArgs.name).toBe('Karan Patel');
    expect(createArgs.email).toBe('karan@patel.com');
    expect(createArgs.phone).toBe('9001122334');
    expect(createArgs.company).toBe('Patel Wellness');
    expect(createArgs.product).toBe('Spa Beds');
    expect(createArgs.city).toBe('Ahmedabad');
    expect(createArgs.tenantId).toBe(1);
    expect(createArgs.status).toBe('New');
  });
});
