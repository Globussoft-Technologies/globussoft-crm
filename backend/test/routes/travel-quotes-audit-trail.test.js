// @ts-check
/**
 * Arc 2 #900 slice 15 — GET /:id/audit-trail contract.
 *
 * Pins GET /api/travel/quotes/:id/audit-trail (PRD_TRAVEL_QUOTE_BUILDER
 * §3.8.1 audit + §3.8.3 send-history). Read-only chronological audit log
 * for a single quote — joins TravelQuote-entity rows (entityId match)
 * with TravelQuoteLine-entity rows whose details JSON references the
 * quoteId.
 *
 * Contract surfaces this spec pins:
 *
 *   - Auth: 401 anon. No RBAC tier required (read-only).
 *   - Param validation: 400 INVALID_ID on non-numeric :id.
 *   - Not-found: 404 QUOTE_NOT_FOUND when no quote row.
 *   - Sub-brand isolation: 403 SUB_BRAND_DENIED when caller lacks access
 *     to the quote's sub-brand (mirrors loadParentQuote).
 *   - Tenant isolation: both audit queries scope by req.travelTenant.id.
 *   - Merge + sort: TravelQuote rows + TravelQuoteLine rows merged into a
 *     single createdAt-asc timeline (oldest first), tie-break by id.
 *   - Line-row filter: prisma `details: { contains: '"quoteId":<id>' }`
 *     surfaces line-CRUD rows that reference this quote in their
 *     JSON payload.
 *   - Details parsing: details JSON re-parsed into a structured object on
 *     output so the consumer never sees a stringified blob. Malformed
 *     JSON degrades gracefully to `{_raw: <string>}` rather than 500.
 *   - Pagination: optional ?limit (1..500, default 100); truncated flag
 *     true when more rows exist beyond the limit.
 *   - Response shape: { quoteId, subBrand, count, truncated, entries[] }
 *     where each entry = {id, action, entity, entityId, userId,
 *     createdAt, details}.
 *
 * Pattern mirrors travel-quotes-analytics.test.js — patch prisma
 * singleton BEFORE requiring the router, supertest with HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = prisma.travelQuoteLine || {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoice = prisma.travelInvoice || {
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.travelMarkupRule = prisma.travelMarkupRule || {
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const QUOTE_ID = 4242;
const SUB_BRAND = 'tmc';

function quoteRow() {
  return {
    id: QUOTE_ID,
    tenantId: 1,
    subBrand: SUB_BRAND,
    contactId: 9001,
    status: 'Sent',
    totalAmount: '50000.00',
    currency: 'INR',
    validUntil: null,
    createdAt: new Date('2026-05-01T10:00:00Z'),
    updatedAt: new Date('2026-05-01T10:00:00Z'),
  };
}

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset().mockResolvedValue(quoteRow());
  prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/:id/audit-trail', () => {
  test('401 without a token', async () => {
    const app = makeApp();
    const res = await request(app).get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`);
    expect(res.status).toBe(401);
  });

  test('400 INVALID_ID on non-numeric :id', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/quotes/not-a-num/audit-trail')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('404 QUOTE_NOT_FOUND when no quote row', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('403 SUB_BRAND_DENIED when caller lacks sub-brand access', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']), // not tmc
    });
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('happy path — merges quote-rows + line-rows, sorts createdAt asc, parses details', async () => {
    // Quote-entity rows: CREATE, then ACCEPTED later.
    // Line-entity rows: a line CREATE in between.
    prisma.auditLog.findMany.mockImplementation(async (args) => {
      if (args.where.entity === 'TravelQuote') {
        return [
          {
            id: 100,
            action: 'CREATE',
            entity: 'TravelQuote',
            entityId: QUOTE_ID,
            details: JSON.stringify({ contactId: 9001, subBrand: SUB_BRAND }),
            userId: 7,
            createdAt: new Date('2026-05-01T10:00:00Z'),
          },
          {
            id: 102,
            action: 'TRAVEL_QUOTE_ACCEPTED',
            entity: 'TravelQuote',
            entityId: QUOTE_ID,
            details: JSON.stringify({ quoteId: QUOTE_ID, previousStatus: 'Sent' }),
            userId: 7,
            createdAt: new Date('2026-05-03T15:00:00Z'),
          },
        ];
      }
      if (args.where.entity === 'TravelQuoteLine') {
        return [
          {
            id: 101,
            action: 'CREATE',
            entity: 'TravelQuoteLine',
            entityId: 555,
            details: JSON.stringify({ quoteId: QUOTE_ID, lineType: 'hotel', amount: '25000.00' }),
            userId: 7,
            createdAt: new Date('2026-05-02T12:00:00Z'),
          },
        ];
      }
      return [];
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.quoteId).toBe(QUOTE_ID);
    expect(res.body.subBrand).toBe(SUB_BRAND);
    expect(res.body.count).toBe(3);
    expect(res.body.truncated).toBe(false);

    const entries = res.body.entries;
    expect(entries).toHaveLength(3);

    // Chronological order: CREATE quote (id=100, 05-01) → CREATE line
    // (id=101, 05-02) → ACCEPTED quote (id=102, 05-03).
    expect(entries[0].id).toBe(100);
    expect(entries[0].action).toBe('CREATE');
    expect(entries[0].entity).toBe('TravelQuote');
    expect(entries[1].id).toBe(101);
    expect(entries[1].action).toBe('CREATE');
    expect(entries[1].entity).toBe('TravelQuoteLine');
    expect(entries[1].entityId).toBe(555);
    expect(entries[2].id).toBe(102);
    expect(entries[2].action).toBe('TRAVEL_QUOTE_ACCEPTED');

    // Details parsed back into an object, not a JSON string.
    expect(entries[0].details).toEqual({ contactId: 9001, subBrand: SUB_BRAND });
    expect(entries[1].details).toEqual({ quoteId: QUOTE_ID, lineType: 'hotel', amount: '25000.00' });
    expect(entries[2].details).toEqual({ quoteId: QUOTE_ID, previousStatus: 'Sent' });
  });

  test('queries scope by tenant + use correct entity filters', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);

    // Two findMany calls: one for TravelQuote, one for TravelQuoteLine.
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(2);
    const calls = prisma.auditLog.findMany.mock.calls.map((c) => c[0]);

    const quoteCall = calls.find((a) => a.where.entity === 'TravelQuote');
    expect(quoteCall).toBeDefined();
    expect(quoteCall.where.tenantId).toBe(1);
    expect(quoteCall.where.entityId).toBe(QUOTE_ID);

    const lineCall = calls.find((a) => a.where.entity === 'TravelQuoteLine');
    expect(lineCall).toBeDefined();
    expect(lineCall.where.tenantId).toBe(1);
    expect(lineCall.where.details).toEqual({ contains: `"quoteId":${QUOTE_ID}` });
  });

  test('empty audit history — count: 0, entries: []', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.entries).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  test('?limit caps result + sets truncated true when more rows exist', async () => {
    // 6 quote-entity rows; ?limit=3 → 3 entries returned, truncated true.
    const rows = Array.from({ length: 6 }).map((_, i) => ({
      id: 200 + i,
      action: 'UPDATE',
      entity: 'TravelQuote',
      entityId: QUOTE_ID,
      details: JSON.stringify({ step: i }),
      userId: 7,
      createdAt: new Date(`2026-05-${String(10 + i).padStart(2, '0')}T08:00:00Z`),
    }));
    prisma.auditLog.findMany.mockImplementation(async (args) => {
      return args.where.entity === 'TravelQuote' ? rows : [];
    });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail?limit=3`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.truncated).toBe(true);
    // Sorted asc + capped → first 3 are step 0, 1, 2.
    expect(res.body.entries.map((e) => e.details.step)).toEqual([0, 1, 2]);
  });

  test('malformed details JSON degrades to {_raw} rather than 500', async () => {
    prisma.auditLog.findMany.mockImplementation(async (args) => {
      if (args.where.entity === 'TravelQuote') {
        return [
          {
            id: 300,
            action: 'UPDATE',
            entity: 'TravelQuote',
            entityId: QUOTE_ID,
            details: '{not valid json',
            userId: 7,
            createdAt: new Date('2026-05-01T10:00:00Z'),
          },
        ];
      }
      return [];
    });
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].details).toEqual({ _raw: '{not valid json' });
  });

  test('tie-break on id when createdAt is identical (deterministic order)', async () => {
    const sameTs = new Date('2026-05-01T10:00:00Z');
    prisma.auditLog.findMany.mockImplementation(async (args) => {
      if (args.where.entity === 'TravelQuote') {
        return [
          { id: 50, action: 'CREATE', entity: 'TravelQuote', entityId: QUOTE_ID, details: null, userId: 7, createdAt: sameTs },
          { id: 10, action: 'UPDATE', entity: 'TravelQuote', entityId: QUOTE_ID, details: null, userId: 7, createdAt: sameTs },
        ];
      }
      return [];
    });
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Ascending id tie-break: 10 before 50.
    expect(res.body.entries.map((e) => e.id)).toEqual([10, 50]);
  });

  test('null details survives parsing (no crash)', async () => {
    prisma.auditLog.findMany.mockImplementation(async (args) => {
      if (args.where.entity === 'TravelQuote') {
        return [
          { id: 400, action: 'CREATE', entity: 'TravelQuote', entityId: QUOTE_ID, details: null, userId: null, createdAt: new Date('2026-05-01T10:00:00Z') },
        ];
      }
      return [];
    });
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/quotes/${QUOTE_ID}/audit-trail`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].details).toBeNull();
    expect(res.body.entries[0].userId).toBeNull();
  });
});
