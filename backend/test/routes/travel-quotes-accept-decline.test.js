// @ts-check
/**
 * Arc 2 #900 slice 11 — POST /api/travel/quotes/:id/accept + /decline contract.
 *
 * Pins the dedicated accept/decline workflow endpoints added to
 * backend/routes/travel_quotes.js on top of the existing duplicate +
 * PDF + pricing-preview + tax-preview + convert-to-invoice surfaces.
 *
 * What's pinned
 * -------------
 *   POST /api/travel/quotes/:id/accept
 *     - ADMIN+MANAGER gate, USER role → 403.
 *     - Malformed :id (non-numeric) → 400 INVALID_ID.
 *     - Cross-tenant source → 404 QUOTE_NOT_FOUND.
 *     - Sub-brand isolation: caller without source's sub-brand → 403
 *       SUB_BRAND_DENIED.
 *     - Idempotency: already-Accepted → 200 + alreadyAccepted=true + no
 *       prisma.update call.
 *     - Transition guard (FR-3.1.3): Rejected → Accepted blocked with
 *       409 INVALID_TRANSITION; only Draft/Sent permitted.
 *     - Happy path: 200 + { quote: {..., status: 'Accepted'} }; audit
 *       row writes TRAVEL_QUOTE_ACCEPTED with previousStatus + acceptedAt
 *       in details.
 *
 *   POST /api/travel/quotes/:id/decline
 *     - Same RBAC / id-shape / tenant / sub-brand guards as /accept.
 *     - Idempotency: already-Rejected → 200 + alreadyRejected=true.
 *     - Transition guard: Accepted → Rejected blocked with 409
 *       INVALID_TRANSITION; only Draft/Sent permitted.
 *     - reason: optional string body field; non-string → 400
 *       INVALID_REASON; empty trim → null; >1000 chars truncated.
 *     - Happy path: 200 + { quote: {..., status: 'Rejected'}, reason };
 *       audit row writes TRAVEL_QUOTE_DECLINED with previousStatus +
 *       declinedAt + reason in details.
 *
 * Pattern mirrors travel-quotes-convert-to-invoice.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with real HS256 JWTs signed with the dev fallback secret.
 * verifyToken stays in the chain (no bypass).
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
  prisma.travelQuote.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/quotes/:id/accept', () => {
  test('USER role → 403 (RBAC)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/accept')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('malformed :id (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/notanumber/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('cross-tenant source → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/quotes/99/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'rfu', contactId: 100,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
    });
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/accept')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('happy path Draft → Accepted: 200 + audit row + no prisma.update bypass', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Draft', totalAmount: '1000.00', currency: 'INR',
    });
    prisma.travelQuote.update.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '1000.00', currency: 'INR',
    });

    const res = await request(makeApp())
      .post('/api/travel/quotes/42/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.quote.status).toBe('Accepted');
    expect(res.body.quote.id).toBe(42);

    // prisma.update fired with status: Accepted.
    expect(prisma.travelQuote.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.travelQuote.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('Accepted');
    expect(updateArgs.where.id).toBe(42);

    // Audit row records the transition.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe('TRAVEL_QUOTE_ACCEPTED');
    // Audit details payload (stored as string in audit chain).
    const details = typeof auditCall.data.details === 'string'
      ? JSON.parse(auditCall.data.details)
      : auditCall.data.details;
    expect(details.previousStatus).toBe('Draft');
    expect(typeof details.acceptedAt).toBe('string');
  });

  test('happy path Sent → Accepted: 200', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 43, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Sent', totalAmount: '2000.00', currency: 'INR',
    });
    prisma.travelQuote.update.mockResolvedValue({
      id: 43, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '2000.00', currency: 'INR',
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/43/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.quote.status).toBe('Accepted');
  });

  test('idempotency: already-Accepted → 200 + alreadyAccepted=true + no update', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '1000.00', currency: 'INR',
    });

    const res = await request(makeApp())
      .post('/api/travel/quotes/50/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadyAccepted).toBe(true);
    expect(res.body.code).toBe('ALREADY_ACCEPTED');
    // CRITICAL: second click never fires update / audit.
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('transition guard: Rejected → Accepted blocked with 409 INVALID_TRANSITION', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 60, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Rejected', totalAmount: '1000.00', currency: 'INR',
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/60/accept')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/quotes/:id/decline', () => {
  test('USER role → 403 (RBAC)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/decline')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('malformed :id (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/notanumber/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('non-string reason → 400 INVALID_REASON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
  });

  test('cross-tenant source → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/quotes/99/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'rfu', contactId: 100,
      status: 'Sent', totalAmount: '1000.00', currency: 'INR',
    });
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/decline')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('happy path Sent → Rejected with reason: 200 + audit captures reason', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 70, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Sent', totalAmount: '5000.00', currency: 'INR',
    });
    prisma.travelQuote.update.mockResolvedValue({
      id: 70, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Rejected', totalAmount: '5000.00', currency: 'INR',
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/70/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Budget too high — can you do 95k per student instead?' });

    expect(res.status).toBe(200);
    expect(res.body.quote.status).toBe('Rejected');
    expect(res.body.reason).toBe('Budget too high — can you do 95k per student instead?');

    expect(prisma.travelQuote.update).toHaveBeenCalledTimes(1);
    expect(prisma.travelQuote.update.mock.calls[0][0].data.status).toBe('Rejected');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe('TRAVEL_QUOTE_DECLINED');
    const details = typeof auditCall.data.details === 'string'
      ? JSON.parse(auditCall.data.details)
      : auditCall.data.details;
    expect(details.previousStatus).toBe('Sent');
    expect(details.reason).toContain('Budget too high');
    expect(typeof details.declinedAt).toBe('string');
  });

  test('happy path without reason: 200 + null reason in audit', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 71, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Draft', totalAmount: '5000.00', currency: 'INR',
    });
    prisma.travelQuote.update.mockResolvedValue({
      id: 71, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Rejected', totalAmount: '5000.00', currency: 'INR',
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/71/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.reason).toBeNull();
    const auditCall = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditCall.data.details === 'string'
      ? JSON.parse(auditCall.data.details)
      : auditCall.data.details;
    expect(details.reason).toBeNull();
  });

  test('long reason >1000 chars: truncated to 1000', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 72, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Sent', totalAmount: '5000.00', currency: 'INR',
    });
    prisma.travelQuote.update.mockResolvedValue({
      id: 72, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Rejected', totalAmount: '5000.00', currency: 'INR',
    });
    const longReason = 'x'.repeat(2500);
    const res = await request(makeApp())
      .post('/api/travel/quotes/72/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: longReason });
    expect(res.status).toBe(200);
    expect(res.body.reason.length).toBe(1000);
  });

  test('idempotency: already-Rejected → 200 + alreadyRejected=true + no update', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 80, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Rejected', totalAmount: '5000.00', currency: 'INR',
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/80/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'irrelevant' });
    expect(res.status).toBe(200);
    expect(res.body.alreadyRejected).toBe(true);
    expect(res.body.code).toBe('ALREADY_REJECTED');
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('transition guard: Accepted → Rejected blocked with 409 INVALID_TRANSITION', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 90, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '5000.00', currency: 'INR',
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/90/decline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'changed my mind' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(prisma.travelQuote.update).not.toHaveBeenCalled();
  });
});
