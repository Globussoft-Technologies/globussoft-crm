// @ts-check
/**
 * Slice C5 — POST /api/travel/quote/unified-search
 * (PRD_RATEHAWK_INTEGRATION FR-5 + FR-6 + DC-6).
 *
 * Pins the unified-search route's fan-out + rank contract.
 *
 * What's pinned
 * -------------
 *   - auth: verifyToken + verifyRole(['ADMIN', 'MANAGER']) → USER 403.
 *   - missing required fields → 400 with structured code.
 *   - both providers ok → ranked envelope, providers.{name}.status='ok'.
 *   - ratehawk stub throws RATEHAWK_NOT_YET_ENABLED → ratehawk marked
 *     `disabled`; bookingExpedia results still returned + ranked.
 *   - both providers throw cred-blocked errors → empty results, both
 *     marked disabled.
 *   - one provider throws non-disable error → status: 'error' +
 *     errorMessage on the envelope.
 *   - markup pass: rule active for the sub-brand → returned `price` is
 *     marked-up; netPrice + markupAmount + markupRuleId surface.
 *   - sub-brand access: MANAGER with subBrandAccess=['tmc'] trying
 *     subBrand='rfu' → 403 SUB_BRAND_DENIED.
 *
 * Test pattern mirrors backend/test/routes/ratehawk.test.js (commit
 * b9... ratehawk operator wrapper) — patch the client modules via
 * createRequire(import.meta.url) so the route's closure sees our
 * mutations to the SAME require-cache. Direct vi.mock() would miss
 * under vitest's inline transform of CJS service modules.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Patch the service clients BEFORE requiring the route so route's
// closure sees our vi.fn() stubs.
const ratehawkClient = requireCJS('../../services/ratehawkClient');
ratehawkClient.searchHotels = vi.fn();
const bookingExpediaClient = requireCJS('../../services/bookingExpediaClient');
bookingExpediaClient.searchHotels = vi.fn();

// Prisma stubs for auth path + travelMarkupRule.findMany + tenant + audit.
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  id: 7, role: 'ADMIN', tenantId: 1, isActive: true, subBrandAccess: null,
});
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.travelMarkupRule = prisma.travelMarkupRule || {};
prisma.travelMarkupRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

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

function rhEnvelope(hotels) {
  return { stub: true, tenantId: 1, hotels, currency: 'USD' };
}

function beEnvelope(hotels) {
  return { stub: true, tenantId: 1, provider: 'booking', hotels, currency: 'USD' };
}

beforeAll(() => {
  // No-op: stubs already installed above.
});

beforeEach(() => {
  ratehawkClient.searchHotels.mockReset();
  bookingExpediaClient.searchHotels.mockReset();
  prisma.user.findUnique.mockReset().mockResolvedValue({
    id: 7, role: 'ADMIN', tenantId: 1, isActive: true, subBrandAccess: null,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.travelMarkupRule.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

const VALID_BODY = {
  subBrand: 'rfu',
  destination: 'Mecca',
  checkIn: '2026-07-15',
  checkOut: '2026-07-22',
  rooms: [{ adults: 2, children: 0 }],
};

describe('POST /api/travel/quote/unified-search — auth', () => {
  test('USER role → 403', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'USER', tenantId: 1, isActive: true, subBrandAccess: null,
    });

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(ratehawkClient.searchHotels).not.toHaveBeenCalled();
  });

  test('No auth header → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/travel/quote/unified-search — input validation', () => {
  test('missing subBrand → 400 MISSING_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, subBrand: undefined })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_SUB_BRAND' });
  });

  test('invalid subBrand → 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, subBrand: 'not-a-real-brand' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
  });

  test('missing destination → 400 MISSING_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, destination: undefined })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_DESTINATION' });
  });

  test('missing dates → 400 MISSING_DATES', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, checkIn: undefined })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_DATES' });
  });

  test('invalid providers list → 400 INVALID_PROVIDERS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, providers: ['not-a-provider'] })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PROVIDERS' });
  });
});

describe('POST /api/travel/quote/unified-search — happy paths', () => {
  test('both providers ok → ranked unified envelope with ok status', async () => {
    ratehawkClient.searchHotels.mockResolvedValue(
      rhEnvelope([
        {
          propertyName: 'Hilton Makkah',
          propertyCity: 'Mecca',
          totalRate: 15000,
          currency: 'USD',
          supplierRating: 4.0,
          cancellationPolicy: 'NON_REFUNDABLE',
          sourceRef: 'rh-1',
        },
      ]),
    );
    bookingExpediaClient.searchHotels.mockResolvedValue(
      beEnvelope([
        {
          propertyName: 'Marriott Makkah',
          propertyCity: 'Mecca',
          totalRate: 10000,
          currency: 'USD',
          supplierRating: 4.5,
          cancellationPolicy: 'FREE_CANCEL',
          sourceRef: 'be-1',
        },
      ]),
    );

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.results).toHaveLength(2);
    // Marriott dominates on every axis (lower price, higher rating,
    // more-flexible cancellation) → unambiguous rank 1.
    expect(res.body.results[0].propertyName).toBe('Marriott Makkah');
    expect(res.body.results[0].rank).toBe(1);
    expect(res.body.results[1].rank).toBe(2);
    expect(res.body.providers).toEqual({
      ratehawk: { status: 'ok', count: 1 },
      bookingExpedia: { status: 'ok', count: 1 },
    });
    expect(res.body.subBrand).toBe('rfu');
    expect(res.body.rankedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('empty providers list defaults to all known providers', async () => {
    ratehawkClient.searchHotels.mockResolvedValue(rhEnvelope([]));
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.providers.ratehawk.status).toBe('ok');
    expect(res.body.providers.bookingExpedia.status).toBe('ok');
    expect(ratehawkClient.searchHotels).toHaveBeenCalled();
    expect(bookingExpediaClient.searchHotels).toHaveBeenCalled();
  });

  test('explicit providers list filters down (only ratehawk requested)', async () => {
    ratehawkClient.searchHotels.mockResolvedValue(rhEnvelope([]));
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, providers: ['ratehawk'] })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.providers.ratehawk).toBeDefined();
    expect(res.body.providers.bookingExpedia).toBeUndefined();
    expect(bookingExpediaClient.searchHotels).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/quote/unified-search — provider failure modes', () => {
  test('ratehawk throws RATEHAWK_NOT_YET_ENABLED → marked disabled; bookingExpedia results still returned', async () => {
    const err = new Error('RateHawk not yet enabled — pending Q19.');
    // @ts-expect-error attach code
    err.code = 'RATEHAWK_NOT_YET_ENABLED';
    ratehawkClient.searchHotels.mockRejectedValue(err);
    bookingExpediaClient.searchHotels.mockResolvedValue(
      beEnvelope([
        {
          propertyName: 'Marriott',
          totalRate: 8000,
          currency: 'USD',
          supplierRating: 4.2,
          cancellationPolicy: 'FREE_CANCEL',
          sourceRef: 'be-1',
        },
      ]),
    );

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.providers.ratehawk.status).toBe('disabled');
    expect(res.body.providers.ratehawk.errorCode).toBe('RATEHAWK_NOT_YET_ENABLED');
    expect(res.body.providers.bookingExpedia.status).toBe('ok');
    expect(res.body.totalCount).toBe(1);
    expect(res.body.results[0].propertyName).toBe('Marriott');
  });

  test('ratehawk throws RATEHAWK_BUDGET_EXCEEDED → marked disabled (cap-blocked)', async () => {
    const err = new Error('Monthly cap reached.');
    // @ts-expect-error
    err.code = 'RATEHAWK_BUDGET_EXCEEDED';
    ratehawkClient.searchHotels.mockRejectedValue(err);
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.providers.ratehawk.status).toBe('disabled');
    expect(res.body.providers.ratehawk.errorCode).toBe('RATEHAWK_BUDGET_EXCEEDED');
  });

  test('both providers throw cred-blocked → empty results, both marked disabled', async () => {
    const rhErr = new Error('RateHawk not yet enabled.');
    // @ts-expect-error
    rhErr.code = 'RATEHAWK_NOT_YET_ENABLED';
    const beErr = new Error('Booking not yet enabled.');
    // @ts-expect-error
    beErr.code = 'BOOKING_EXPEDIA_NOT_YET_ENABLED';
    ratehawkClient.searchHotels.mockRejectedValue(rhErr);
    bookingExpediaClient.searchHotels.mockRejectedValue(beErr);

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.results).toEqual([]);
    expect(res.body.providers.ratehawk.status).toBe('disabled');
    expect(res.body.providers.bookingExpedia.status).toBe('disabled');
  });

  test('provider throws non-disable error → marked status:error with errorMessage', async () => {
    const err = new Error('Provider network timeout');
    // No `code` → not a known cred-blocked / cap-blocked error.
    ratehawkClient.searchHotels.mockRejectedValue(err);
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.providers.ratehawk.status).toBe('error');
    expect(res.body.providers.ratehawk.errorMessage).toMatch(/timeout/);
    expect(res.body.providers.bookingExpedia.status).toBe('ok');
  });
});

describe('POST /api/travel/quote/unified-search — markup pass', () => {
  test('active markup rule for sub-brand → returned price includes markup; netPrice + markupAmount + markupRuleId surface', async () => {
    ratehawkClient.searchHotels.mockResolvedValue(
      rhEnvelope([
        {
          propertyName: 'Stub Hotel',
          totalRate: 10000,
          currency: 'USD',
          supplierRating: 4.0,
          cancellationPolicy: 'FREE_CANCEL',
          sourceRef: 'rh-1',
        },
      ]),
    );
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));
    // 15% markup rule for the rfu sub-brand, hotel scope.
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      {
        id: 77,
        tenantId: 1,
        subBrand: 'rfu',
        scope: 'hotel',
        matchKeyJson: 'hotel-default',
        markupPct: 15,
        markupFlat: null,
        ownerUserId: null,
        priority: 100,
        isActive: true,
      },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send(VALID_BODY)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const row = res.body.results[0];
    // 15% of 10000 = 1500; customer-facing price = 11500.
    expect(row.netPrice).toBe(10000);
    expect(row.markupAmount).toBe(1500);
    expect(row.markupRuleId).toBe(77);
    expect(row.price).toBe(11500);
  });

  test('markup pass requests the rule scoped to the requested sub-brand', async () => {
    ratehawkClient.searchHotels.mockResolvedValue(rhEnvelope([]));
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));

    await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, subBrand: 'tmc' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.travelMarkupRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          isActive: true,
        }),
      }),
    );
  });
});

describe('POST /api/travel/quote/unified-search — sub-brand access', () => {
  test('MANAGER with subBrandAccess=[tmc] trying subBrand=rfu → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      role: 'MANAGER',
      tenantId: 1,
      isActive: true,
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, subBrand: 'rfu' })
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(ratehawkClient.searchHotels).not.toHaveBeenCalled();
  });

  test('MANAGER with subBrandAccess=[rfu, tmc] reaching subBrand=rfu → 200', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      role: 'MANAGER',
      tenantId: 1,
      isActive: true,
      subBrandAccess: JSON.stringify(['rfu', 'tmc']),
    });
    ratehawkClient.searchHotels.mockResolvedValue(rhEnvelope([]));
    bookingExpediaClient.searchHotels.mockResolvedValue(beEnvelope([]));

    const res = await request(makeApp())
      .post('/api/travel/quote/unified-search')
      .send({ ...VALID_BODY, subBrand: 'rfu' })
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe('rfu');
  });
});
