// @ts-check
/**
 * Arc 2 #900 slice 12 — quote expiry workflow contract.
 *
 * Pins the two new endpoints added to backend/routes/travel_quotes.js for
 * the expiry workflow (PRD_TRAVEL_QUOTE_BUILDER OQ-9.7):
 *
 *   GET  /api/travel/quotes/expired
 *     Derived-list surface: returns quotes whose validUntil is in the past
 *     AND status ∈ {Draft, Sent}. Used by operator dashboards to surface
 *     quotes that need attention. Read-only — no audit row.
 *     - Route ordering: declared BEFORE /:id so Express doesn't match
 *       "expired" as a numeric :id parse failure.
 *     - Sub-brand isolation: results scoped to caller's subBrandAccess
 *       set (empty set → empty list, not 403).
 *     - Status filter: only Draft+Sent (Accepted/Rejected are terminal).
 *     - validUntil filter: lt: now() (server-side; clients can't override).
 *     - Pagination: ?limit=N (default 50, max 200).
 *
 *   POST /api/travel/quotes/:id/extend
 *     Manual rescue: pushes a quote's validUntil forward without touching
 *     status / lines / totals.
 *     - Body shape: exactly one of { days: 1..365 } or { newValidUntil: ISO }.
 *     - days mode: base = max(existing validUntil, now); add N days.
 *     - absolute mode: verbatim newValidUntil (must parse + must be future).
 *     - 400 EXTEND_PARAMS when zero or both supplied.
 *     - 400 INVALID_DAYS for non-int, < 1, > 365.
 *     - 400 INVALID_VALID_UNTIL for unparseable or past dates.
 *     - 409 INVALID_TRANSITION for Accepted/Rejected source.
 *     - Standard tenant + sub-brand + RBAC guards.
 *     - Audit: TRAVEL_QUOTE_EXTENDED with previousValidUntil + newValidUntil
 *       + extensionMode + days in details.
 *
 * Pattern mirrors travel-quotes-accept-decline.test.js — patch prisma
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

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.findMany.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/expired', () => {
  test('happy path — ADMIN sees expired quotes from all sub-brands', async () => {
    const expiredQuotes = [
      {
        id: 100, tenantId: 1, subBrand: 'tmc', contactId: 5001,
        status: 'Sent', validUntil: new Date('2020-01-01'), currency: 'INR',
      },
      {
        id: 101, tenantId: 1, subBrand: 'rfu', contactId: 5002,
        status: 'Draft', validUntil: new Date('2020-06-01'), currency: 'INR',
      },
    ];
    prisma.travelQuote.findMany.mockResolvedValue(expiredQuotes);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.quotes)).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.quotes[0].id).toBe(100);

    // Where clause: status filter + validUntil < now.
    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.where.tenantId).toBe(1);
    expect(findManyArgs.where.status).toEqual({ in: ['Draft', 'Sent'] });
    expect(findManyArgs.where.validUntil.lt).toBeInstanceOf(Date);
    // ADMIN (allowed === null) → no subBrand filter in the where clause.
    expect(findManyArgs.where.subBrand).toBeUndefined();
  });

  test('orders by validUntil ASC (oldest first)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/quotes/expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.orderBy).toEqual([
      { validUntil: 'asc' },
      { id: 'asc' },
    ]);
  });

  test('?limit=10 honored, ?limit=999 clamped to 200', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/quotes/expired?limit=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelQuote.findMany.mock.calls[0][0].take).toBe(10);

    prisma.travelQuote.findMany.mockClear();
    await request(makeApp())
      .get('/api/travel/quotes/expired?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelQuote.findMany.mock.calls[0][0].take).toBe(200);

    prisma.travelQuote.findMany.mockClear();
    await request(makeApp())
      .get('/api/travel/quotes/expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelQuote.findMany.mock.calls[0][0].take).toBe(50);
  });

  test('MANAGER with subBrandAccess=["tmc"] sees only tmc quotes', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelQuote.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/quotes/expired')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.where.subBrand).toEqual({ in: ['tmc'] });
  });

  test('caller with empty access set → empty list (not 403)', async () => {
    // Empty array in subBrandAccess → getSubBrandAccessSet returns null
    // (treated as ADMIN-style full access by the helper). To force the
    // empty-Set branch we need a parse-fail OR a Set-with-zero-valid-entries.
    // Simulate parse-fail: malformed JSON string.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: 'not-json',
    });
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quotes).toEqual([]);
    expect(res.body.count).toBe(0);
    // Short-circuit: never hits prisma.travelQuote.findMany.
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('route ordering: "expired" matches the list endpoint, not GET /:id', async () => {
    // If route ordering is wrong, "expired" would be parsed as :id and
    // either 400 INVALID_ID or 404. The fact that findMany (not findFirst)
    // gets called confirms /expired hit the list endpoint.
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.travelQuote.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/quotes/:id/extend', () => {
  test('USER role → 403 (RBAC)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ days: 7 });
    expect(res.status).toBe(403);
  });

  test('malformed :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/notanumber/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('empty body → 400 EXTEND_PARAMS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXTEND_PARAMS');
  });

  test('both days AND newValidUntil → 400 EXTEND_PARAMS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7, newValidUntil: '2099-12-31' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXTEND_PARAMS');
  });

  test('days=0 → 400 INVALID_DAYS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAYS');
  });

  test('days=400 → 400 INVALID_DAYS (over cap)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 400 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAYS');
  });

  test('days="not a number" → 400 INVALID_DAYS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 'banana' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAYS');
  });

  test('days=2.5 (non-integer) → 400 INVALID_DAYS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 2.5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DAYS');
  });

  test('newValidUntil="2020-01-01" (past) → 400 INVALID_VALID_UNTIL', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ newValidUntil: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALID_UNTIL');
  });

  test('newValidUntil="not-a-date" → 400 INVALID_VALID_UNTIL', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ newValidUntil: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALID_UNTIL');
  });

  test('cross-tenant source → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/quotes/99/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'rfu', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: new Date('2026-01-01'),
    });
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ days: 7 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('transition guard: Accepted → 409 INVALID_TRANSITION', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Accepted', totalAmount: '1000.00', currency: 'INR',
      validUntil: new Date('2026-01-01'),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
  });

  test('transition guard: Rejected → 409 INVALID_TRANSITION', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Rejected', totalAmount: '1000.00', currency: 'INR',
      validUntil: new Date('2026-01-01'),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  test('happy path days mode: Draft, validUntil=past → extends from now + N days', async () => {
    const pastDate = new Date('2020-01-01');
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: pastDate,
    });
    prisma.travelQuote.update.mockImplementation(async (args) => ({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: args.data.validUntil,
    }));

    const before = Date.now();
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7 });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.extensionMode).toBe('days');
    expect(res.body.days).toBe(7);

    // newValidUntil should be ~now + 7d (because past < now, so base = now).
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const updateArgs = prisma.travelQuote.update.mock.calls[0][0];
    const newMs = new Date(updateArgs.data.validUntil).getTime();
    expect(newMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(newMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });

  test('happy path days mode: validUntil=future → extends from existing + N days', async () => {
    // existing validUntil is well in the future (year 2099); base should be
    // that future date, not now.
    const futureDate = new Date('2099-01-01T00:00:00.000Z');
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Sent', totalAmount: '1000.00', currency: 'INR',
      validUntil: futureDate,
    });
    prisma.travelQuote.update.mockImplementation(async (args) => ({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Sent', totalAmount: '1000.00', currency: 'INR',
      validUntil: args.data.validUntil,
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 10 });

    expect(res.status).toBe(200);
    const updateArgs = prisma.travelQuote.update.mock.calls[0][0];
    const expected = new Date(futureDate.getTime() + 10 * 86400000).getTime();
    expect(new Date(updateArgs.data.validUntil).getTime()).toBe(expected);
  });

  test('happy path absolute mode: validUntil set verbatim', async () => {
    const futureIso = new Date(Date.now() + 30 * 86400000).toISOString();
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: new Date('2020-01-01'),
    });
    prisma.travelQuote.update.mockImplementation(async (args) => ({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: args.data.validUntil,
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ newValidUntil: futureIso });

    expect(res.status).toBe(200);
    expect(res.body.extensionMode).toBe('absolute');
    expect(res.body.days).toBeNull();
    const updateArgs = prisma.travelQuote.update.mock.calls[0][0];
    expect(new Date(updateArgs.data.validUntil).getTime()).toBe(new Date(futureIso).getTime());
  });

  test('audit row captures previousValidUntil + newValidUntil + extensionMode', async () => {
    const pastDate = new Date('2020-01-01');
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: pastDate,
    });
    prisma.travelQuote.update.mockImplementation(async (args) => ({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: args.data.validUntil,
    }));

    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 14 });

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe('TRAVEL_QUOTE_EXTENDED');
    const details = typeof auditCall.data.details === 'string'
      ? JSON.parse(auditCall.data.details)
      : auditCall.data.details;
    expect(details.quoteId).toBe(42);
    expect(details.subBrand).toBe('tmc');
    expect(details.previousValidUntil).toBe(pastDate.toISOString());
    expect(typeof details.newValidUntil).toBe('string');
    expect(details.extensionMode).toBe('days');
    expect(details.days).toBe(14);
  });

  test('null source validUntil + days mode → extension from now', async () => {
    // Some quotes have validUntil=null (operator never set one). Extending
    // should still work: base = now, newValidUntil = now + N days.
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: null,
    });
    prisma.travelQuote.update.mockImplementation(async (args) => ({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
      validUntil: args.data.validUntil,
    }));

    const before = Date.now();
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/extend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ days: 7 });

    expect(res.status).toBe(200);
    const updateArgs = prisma.travelQuote.update.mock.calls[0][0];
    const newMs = new Date(updateArgs.data.validUntil).getTime();
    expect(newMs).toBeGreaterThanOrEqual(before + 7 * 86400000);

    // Audit should still record (with null previousValidUntil).
    const auditCall = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditCall.data.details === 'string'
      ? JSON.parse(auditCall.data.details)
      : auditCall.data.details;
    expect(details.previousValidUntil).toBeNull();
  });
});
