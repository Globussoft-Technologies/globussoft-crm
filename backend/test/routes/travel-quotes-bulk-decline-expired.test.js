// @ts-check
/**
 * Arc 2 #900 slice 14 — bulk-decline-expired contract.
 *
 * Pins POST /api/travel/quotes/bulk-decline-expired (PRD_TRAVEL_QUOTE_BUILDER
 * §3 bulk operations on expired quotes). The endpoint sweeps every
 * Draft|Sent quote whose validUntil < now within the caller's sub-brand
 * scope and flips them to Rejected in one round-trip, emitting one
 * TRAVEL_QUOTE_DECLINED audit row per affected quote with bulk: true.
 *
 * Contract surfaces this spec pins:
 *
 *   - Auth + RBAC: 401 anon, 403 USER role.
 *   - Idempotency: empty doomed-list returns 200 with declinedCount: 0,
 *     never 404 / never error. Re-running after a cleanup is a no-op.
 *   - Sub-brand scoping:
 *       - ADMIN (allowed === null) → all sub-brands swept by default.
 *       - Operator with grants (Set) → only those sub-brands swept.
 *       - Operator with empty grants (Set size 0) → short-circuit 200
 *         with zero results, NOT 403 (mirrors expired-list behaviour).
 *       - Optional body.subBrand restricts to ONE sub-brand; caller must
 *         have access (else 403 SUB_BRAND_DENIED).
 *       - Invalid body.subBrand → 400 INVALID_SUB_BRAND.
 *   - Reason handling: optional, ≤1000 chars, silently truncated (not
 *     400'd), blank string → null. Non-string → 400 INVALID_REASON.
 *   - Tenant isolation: where-clause carries req.travelTenant.id; the
 *     updateMany scopes by tenantId too as a defense-in-depth pin.
 *   - Status filter: only Draft + Sent are doomed; Accepted + Rejected
 *     rows MUST NOT be touched.
 *   - validUntil filter: server-side lt: new Date(); clients can't
 *     override the cutoff timestamp.
 *   - Audit: one TRAVEL_QUOTE_DECLINED row per declined quote, with
 *     bulk: true + previousStatus + reason in details.
 *
 * Pattern mirrors travel-quotes-expiry.test.js (slice 12) + travel-quotes-
 * accept-decline.test.js (slice 11) — patch prisma singleton BEFORE
 * requiring the router, supertest with HS256 JWTs.
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
  prisma.travelQuote.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/quotes/bulk-decline-expired', () => {
  test('401 without a token', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/travel/quotes/bulk-decline-expired').send({});
    expect(res.status).toBe(401);
  });

  test('403 for USER role (only ADMIN + MANAGER may bulk-decline)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('happy path — ADMIN sweeps all expired across every sub-brand', async () => {
    const doomed = [
      { id: 100, subBrand: 'tmc', contactId: 5001, status: 'Sent' },
      { id: 101, subBrand: 'rfu', contactId: 5002, status: 'Draft' },
      { id: 102, subBrand: 'travelstall', contactId: 5003, status: 'Sent' },
    ];
    prisma.travelQuote.findMany.mockResolvedValue(doomed);
    prisma.travelQuote.updateMany.mockResolvedValue({ count: 3 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'quarterly cleanup' });

    expect(res.status).toBe(200);
    expect(res.body.declinedCount).toBe(3);
    expect(res.body.declinedIds).toEqual([100, 101, 102]);
    expect(res.body.reason).toBe('quarterly cleanup');
    expect(res.body.subBrand).toBe(null);

    // findMany: status ∈ {Draft, Sent} + validUntil lt now + tenant scope.
    const findArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(1);
    expect(findArgs.where.status).toEqual({ in: ['Draft', 'Sent'] });
    expect(findArgs.where.validUntil).toHaveProperty('lt');
    expect(findArgs.where.validUntil.lt).toBeInstanceOf(Date);
    // ADMIN: no subBrand filter.
    expect(findArgs.where.subBrand).toBeUndefined();

    // updateMany: defense-in-depth tenant scope + id-in-list.
    const updateArgs = prisma.travelQuote.updateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toEqual({ in: [100, 101, 102] });
    expect(updateArgs.where.tenantId).toBe(1);
    expect(updateArgs.data.status).toBe('Rejected');

    // One audit per declined row, all TRAVEL_QUOTE_DECLINED with bulk: true.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(3);
    const auditCalls = prisma.auditLog.create.mock.calls.map((c) => c[0].data);
    for (const a of auditCalls) {
      expect(a.action).toBe('TRAVEL_QUOTE_DECLINED');
      expect(a.entity).toBe('TravelQuote');
    }
    // Audit details should round-trip bulk: true + reason + previousStatus.
    const details0 = JSON.parse(auditCalls[0].details);
    expect(details0.bulk).toBe(true);
    expect(details0.reason).toBe('quarterly cleanup');
    expect(details0.previousStatus).toBe('Sent');
    expect(details0.quoteId).toBe(100);
  });

  test('idempotent — empty doomed-list returns 200 with declinedCount: 0', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.declinedCount).toBe(0);
    expect(res.body.declinedIds).toEqual([]);
    // No updateMany / no audit when nothing to do.
    expect(prisma.travelQuote.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('operator with sub-brand grants — sweep filtered to access set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc', 'rfu']),
    });
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 200, subBrand: 'tmc', contactId: 6001, status: 'Sent' },
    ]);
    prisma.travelQuote.updateMany.mockResolvedValue({ count: 1 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.declinedCount).toBe(1);

    // findMany subBrand filter restricted to caller's access set.
    const findArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findArgs.where.subBrand).toBeDefined();
    expect(findArgs.where.subBrand.in).toEqual(expect.arrayContaining(['tmc', 'rfu']));
    expect(findArgs.where.subBrand.in).toHaveLength(2);
  });

  test('operator with truly-empty grants (invalid JSON) — short-circuit 200 zero-result (not 403)', async () => {
    // getSubBrandAccessSet returns a Set of size 0 ONLY for invalid JSON in
    // subBrandAccess (the [] case collapses to null = admin-like). Pin the
    // empty-Set branch via the invalid-JSON shape.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: '{not-valid-json',
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.declinedCount).toBe(0);
    expect(res.body.declinedIds).toEqual([]);
    // No DB work done — empty access set short-circuits before findMany.
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
    expect(prisma.travelQuote.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('body.subBrand scope restricts the sweep to that sub-brand only', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 300, subBrand: 'rfu', contactId: 7001, status: 'Draft' },
    ]);
    prisma.travelQuote.updateMany.mockResolvedValue({ count: 1 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(200);
    expect(res.body.declinedCount).toBe(1);
    expect(res.body.subBrand).toBe('rfu');

    // Verify exact-match subBrand filter (not the {in: [...]} list form).
    const findArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findArgs.where.subBrand).toBe('rfu');
  });

  test('body.subBrand outside caller access set → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ subBrand: 'rfu' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // No DB work.
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('invalid body.subBrand → 400 INVALID_SUB_BRAND', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'not-a-sub-brand' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
  });

  test('non-string reason → 400 INVALID_REASON', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
  });

  test('reason >1000 chars silently truncated (not 400)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 400, subBrand: 'tmc', contactId: 8001, status: 'Sent' },
    ]);
    prisma.travelQuote.updateMany.mockResolvedValue({ count: 1 });

    const longReason = 'a'.repeat(2000);
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: longReason });

    expect(res.status).toBe(200);
    expect(res.body.reason).toHaveLength(1000);
    // Audit reason matches the truncated value.
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.reason).toHaveLength(1000);
  });

  test('blank reason normalises to null', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 500, subBrand: 'tmc', contactId: 9001, status: 'Draft' },
    ]);
    prisma.travelQuote.updateMany.mockResolvedValue({ count: 1 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/quotes/bulk-decline-expired')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: '   ' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe(null);
    const details = JSON.parse(prisma.auditLog.create.mock.calls[0][0].data.details);
    expect(details.reason).toBe(null);
  });
});
