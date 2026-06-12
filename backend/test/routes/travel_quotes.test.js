// @ts-check
/**
 * PRD_TRAVEL_QUOTE_BUILDER DD-5.1 — TravelQuote CRUD scaffold tests.
 *
 * Pins the contract for the operator-facing quote surface added to
 * backend/routes/travel_quotes.js (sibling to travel_suppliers.js
 * shipped at commit 192b8c1; both share the /api/travel mount).
 *
 * What's pinned
 * -------------
 *   - POST   /api/travel/quotes        201 on happy path; 400 on missing
 *           contactId/totalAmount/currency; 400 on invalid status with
 *           allowed-values list; 400 on past validUntil.
 *   - GET    /api/travel/quotes        tenant-scoped list.
 *   - GET    /api/travel/quotes/:id    404 on cross-tenant.
 *   - DELETE /api/travel/quotes/:id    204 + audit row written before
 *           prisma.delete fires (hard-delete; differs from
 *           TravelSupplier's soft-delete because quote rows are
 *           draft-shaped artifacts, not referenced by FK chains).
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed with the
 * same fallback secret the middleware uses in dev. verifyToken stays
 * in the chain (we don't bypass it) so the auth-gate is exercised
 * end-to-end.
 *
 * Date-boundary note (per CLAUDE.md standing rule): all happy-path
 * validUntil values use `tomorrow = new Date(Date.now() + 86400000)`
 * to dodge the TZ-midnight overlap window.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
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
// PRD §4.1 diagnostic-first guard (gap A6/A9): POST /quotes calls
// assertCompletedDiagnostic → prisma.travelDiagnostic.count. Default to 1
// (diagnostic exists) so the pre-guard contract tests stay green; the
// guard-specific test below overrides to 0.
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  count: vi.fn().mockResolvedValue(1),
};
// Visa Sure complexity gate — only fires for subBrand visasure; stub so
// non-tmc probes can't 500.
prisma.visaApplication = {
  ...(prisma.visaApplication || {}),
  findFirst: vi.fn().mockResolvedValue(null),
};

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

// Tomorrow in ISO form — unambiguously-future in any TZ window
// (per CLAUDE.md standing rule on date-boundary assertions).
const tomorrow = new Date(Date.now() + 86_400_000);
const tomorrowIso = tomorrow.toISOString();

// Yesterday — used for the past-validUntil rejection probe.
const yesterday = new Date(Date.now() - 86_400_000);
const yesterdayIso = yesterday.toISOString();

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelQuote.findMany.mockReset();
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.count.mockReset();
  prisma.travelQuote.create.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.travelQuote.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelDiagnostic.count.mockReset().mockResolvedValue(1);
  prisma.visaApplication.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/quotes', () => {
  test('happy path returns 201 with the created quote', async () => {
    prisma.travelQuote.create.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Draft', totalAmount: '45000.00', currency: 'INR',
      validUntil: tomorrow, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        totalAmount: '45000.00',
        currency: 'INR',
        subBrand: 'tmc',
        validUntil: tomorrowIso,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42, contactId: 99, currency: 'INR', subBrand: 'tmc', status: 'Draft',
    });
    // Verify tenantId came from req.user, not body.
    expect(prisma.travelQuote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          contactId: 99,
          status: 'Draft',
          currency: 'INR',
        }),
      }),
    );
    // Audit row must be written on create.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('rejects 422 DIAGNOSTIC_REQUIRED when contact has no completed diagnostic (PRD §4.1 gap A6/A9)', async () => {
    prisma.travelDiagnostic.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .post('/api/travel/quotes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        totalAmount: '45000.00',
        currency: 'INR',
        subBrand: 'tmc',
        validUntil: tomorrowIso,
      });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'DIAGNOSTIC_REQUIRED' });
    expect(prisma.travelDiagnostic.count).toHaveBeenCalledWith({
      where: { tenantId: 1, contactId: 99, subBrand: 'tmc' },
    });
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
  });

  test('rejects missing contactId with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ totalAmount: '100.00', currency: 'INR', subBrand: 'tmc' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/contactId/i);
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
  });

  test('rejects invalid status=Garbage with 400 + allowed values', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 1, totalAmount: '100.00', currency: 'INR',
        subBrand: 'tmc', status: 'Garbage',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/Draft/);
    expect(res.body.error).toMatch(/Sent/);
    expect(res.body.error).toMatch(/Accepted/);
    expect(res.body.error).toMatch(/Rejected/);
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
  });

  test('rejects past validUntil with 400 INVALID_VALID_UNTIL', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 1, totalAmount: '100.00', currency: 'INR',
        subBrand: 'tmc', validUntil: yesterdayIso,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_VALID_UNTIL' });
    expect(res.body.error).toMatch(/future|today/i);
    expect(prisma.travelQuote.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/quotes', () => {
  test('returns tenant-scoped list', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, subBrand: 'tmc', contactId: 5, status: 'Draft',
        totalAmount: '100.00', currency: 'INR', validUntil: null },
    ]);
    prisma.travelQuote.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/quotes')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.quotes).toHaveLength(1);
    // The where clause MUST include tenantId from req.user.tenantId.
    expect(prisma.travelQuote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('?status filter narrows the where clause', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    prisma.travelQuote.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/quotes?status=Sent&subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelQuote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, status: 'Sent', subBrand: 'rfu' }),
      }),
    );
  });
});

describe('GET /api/travel/quotes/:id', () => {
  test('cross-tenant returns 404', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/quotes/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // Confirm the lookup scoped to req.user.tenantId.
    expect(prisma.travelQuote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});

describe('DELETE /api/travel/quotes/:id (hard-delete)', () => {
  test('returns 204 and writes audit row before prisma.delete fires', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Draft', totalAmount: '100.00', currency: 'INR',
    });
    prisma.travelQuote.delete.mockResolvedValue({ id: 5 });

    // Track call order: auditLog.create MUST be called before travelQuote.delete.
    const callOrder = [];
    prisma.auditLog.create.mockImplementation(async (args) => {
      callOrder.push('audit');
      return { id: 1, ...args };
    });
    prisma.travelQuote.delete.mockImplementation(async () => {
      callOrder.push('delete');
      return { id: 5 };
    });

    const res = await request(makeApp())
      .delete('/api/travel/quotes/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    // Audit row exists + was written BEFORE the prisma.delete call.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(prisma.travelQuote.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(callOrder).toEqual(['audit', 'delete']);

    // Audit payload sanity-check — entity/action/entityId reach the row.
    // writeAudit writes the canonical schema columns: entity, action,
    // entityId (number), userId (number), tenantId (number).
    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data).toMatchObject({
      entity: 'TravelQuote',
      action: 'DELETE',
      entityId: 5,
      userId: 7,
      tenantId: 1,
    });
  });

  test('cross-tenant returns 404 (no delete or audit fire)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/quotes/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(prisma.travelQuote.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
