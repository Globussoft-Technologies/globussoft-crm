// @ts-check
/**
 * Travel CRM — TmcTrip microsite + OTP-reveal route (PRD §4.5) contract tests.
 *
 * Pins backend/routes/travel_microsites.js (8 endpoints):
 *   - POST   /trips/:tripId/microsite               (ADMIN+MGR, create)
 *   - GET    /trips/:tripId/microsite               (ADMIN+MGR, admin fetch)
 *   - PATCH  /trips/:tripId/microsite               (ADMIN+MGR, amend)
 *   - DELETE /trips/:tripId/microsite               (ADMIN-only, unpublish)
 *   - POST   /trips/:tripId/microsite/upload        (ADMIN+MGR, image)
 *   - GET    /microsites/public/:publicUuid         (PUBLIC, no auth)
 *   - POST   /microsites/public/:publicUuid/request-otp (PUBLIC, OTP issue)
 *   - POST   /microsites/public/:publicUuid/verify-otp  (PUBLIC, OTP verify)
 *   - GET    /microsites/public/:publicUuid/full        (PUBLIC + token)
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401 on operator endpoints (verifyToken).
 *   - Vertical gate: non-travel tenant → 403 WRONG_VERTICAL.
 *   - RBAC: USER → 403 RBAC_DENIED on POST; MANAGER → 403 on DELETE
 *     (DELETE is ADMIN-only).
 *   - Sub-brand: caller with subBrandAccess that excludes "tmc" → 403
 *     SUB_BRAND_DENIED (microsites are TMC-only per Q21).
 *   - Tenant scoping: loadTrip uses findFirst with tenantId from
 *     req.travelTenant.id — cross-tenant trip → 404 TRIP_NOT_FOUND.
 *   - POST happy path: 201 + publicUuid generated + default subdomain
 *     "trip-<tripCode>"; itineraryHtml required → 400 MISSING_FIELDS.
 *   - POST existing microsite → 409 MICROSITE_EXISTS.
 *   - PATCH: empty body → 400 EMPTY_BODY; happy path 200.
 *   - DELETE: ADMIN 200 with { deleted, id }; missing → 404 NOT_FOUND.
 *   - PUBLIC GET: NO auth needed; bad UUID shape → 400 INVALID_UUID;
 *     missing → 404 NOT_FOUND; expired → 410 GONE; happy path returns
 *     ONLY the PUBLIC_SELECT projection (no participants/rooming/PII).
 *   - OTP request: missing fields → 400 MISSING_FIELDS; invalid purpose
 *     → 400 INVALID_PURPOSE; cool-down hit → 429 OTP_COOLDOWN; happy
 *     path → 201 with sent:true + bcrypt-hashed otp persisted; code
 *     intentionally NOT returned in response (stub-mode contract).
 *   - OTP verify: invalid/expired OTP → 400 OTP_INVALID; happy path
 *     returns a JWT with kind:"microsite-otp" claim; usedAt is set.
 *   - /full endpoint: missing token → 401 TOKEN_REQUIRED; invalid token
 *     → 401 TOKEN_INVALID; token scoped to wrong micrositeId → 403
 *     TOKEN_SCOPE; purpose-narrowed reveal (registration sees
 *     participants but not paymentPlan; payment-plan sees instalments
 *     but not rooming).
 *
 * Test pattern mirrors backend/test/routes/travel-webcheckin.test.js +
 * travel_quotes.test.js — patch the prisma singleton with vi.fn() shapes
 * BEFORE requiring the router, drive supertest with real HS256 JWTs
 * signed with the dev-fallback secret. verifyToken + requirePermission +
 * requireTravelTenant + requireTmcAccess all stay in the chain so the
 * guards are exercised end-to-end (no bypass).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tripMicrosite = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tripMicrositeOtp = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.tmcTrip = {
  ...(prisma.tmcTrip || {}),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
};
prisma.tripParticipant = {
  ...(prisma.tripParticipant || {}),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.roomingAssignment = {
  ...(prisma.roomingAssignment || {}),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.tripPaymentPlan = {
  ...(prisma.tripPaymentPlan || {}),
  findUnique: vi.fn().mockResolvedValue(null),
};
prisma.tripInstalmentPayment = {
  ...(prisma.tripInstalmentPayment || {}),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.tripDocumentRequirement = {
  ...(prisma.tripDocumentRequirement || {}),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// Phase 4 — PendingTripRegistration mocks for the /verify-otp + /full
// draft-binding extensions.
prisma.pendingTripRegistration = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
// $transaction is used by verify-otp to atomically mark OTP usedAt +
// update the draft. Mock just resolves the supplied promise array.
prisma.$transaction = vi.fn(async (ops) => Promise.all(Array.isArray(ops) ? ops : []));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const micrositesRouter = requireCJS('../../routes/travel_microsites');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', micrositesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Fixed UUID for deterministic public-endpoint testing.
const TEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  prisma.tripMicrosite.findUnique.mockReset();
  prisma.tripMicrosite.create.mockReset();
  prisma.tripMicrosite.update.mockReset();
  prisma.tripMicrosite.delete.mockReset();
  prisma.tripMicrositeOtp.findFirst.mockReset();
  prisma.tripMicrositeOtp.create.mockReset();
  prisma.tripMicrositeOtp.update.mockReset();
  prisma.tmcTrip.findFirst.mockReset();
  prisma.tmcTrip.findUnique.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.roomingAssignment.findMany.mockReset().mockResolvedValue([]);
  prisma.tripPaymentPlan.findUnique.mockReset().mockResolvedValue(null);
  prisma.tripInstalmentPayment.findMany.mockReset().mockResolvedValue([]);
  prisma.tripDocumentRequirement.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.pendingTripRegistration.findUnique.mockReset();
  prisma.pendingTripRegistration.update.mockReset();
  prisma.$transaction.mockClear();
});

// ─── Operator CRUD endpoints ─────────────────────────────────────────

describe('POST /api/travel/trips/:tripId/microsite (create)', () => {
  test('happy path: 201, generates publicUuid + default subdomain "trip-<tripCode>"', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null); // no existing
    prisma.tripMicrosite.create.mockImplementation(async (args) => ({
      id: 42, ...args.data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>Day 1: Arrival</p>' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      tenantId: 1,
      tripId: 100,
      subdomain: 'trip-TMC-001',
      itineraryHtml: '<p>Day 1: Arrival</p>',
    });
    // publicUuid must be a UUID
    expect(res.body.publicUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // tenantId came from req.travelTenant, NOT from body
    expect(prisma.tripMicrosite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 1, tripId: 100 }),
      }),
    );
  });

  test('missing itineraryHtml returns 400 MISSING_FIELDS', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({}); // no itineraryHtml
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tripMicrosite.create).not.toHaveBeenCalled();
  });

  test('existing microsite returns 409 MICROSITE_EXISTS', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({ id: 7, tripId: 100 });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'MICROSITE_EXISTS', micrositeId: 7 });
    expect(prisma.tripMicrosite.create).not.toHaveBeenCalled();
  });

  test('missing Bearer returns 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(401);
    expect(prisma.tripMicrosite.create).not.toHaveBeenCalled();
  });

  test('USER role returns 403 RBAC_DENIED (POST is ADMIN+MGR only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tripMicrosite.create).not.toHaveBeenCalled();
  });

  test('non-travel tenant returns 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.tripMicrosite.create).not.toHaveBeenCalled();
  });

  test('caller without "tmc" sub-brand access returns 403 SUB_BRAND_DENIED', async () => {
    // Non-admin with subBrandAccess that excludes tmc.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu', 'travelstall']),
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.tripMicrosite.create).not.toHaveBeenCalled();
  });

  test('non-numeric tripId returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/notanumber/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });

  test('cross-tenant trip returns 404 TRIP_NOT_FOUND', async () => {
    // The findFirst is scoped by tenantId — null result means the trip
    // exists but in a different tenant (or doesn't exist at all).
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/trips/9999/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>foo</p>' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TRIP_NOT_FOUND' });
    // Tenant scoping check on the lookup.
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});

describe('GET /api/travel/trips/:tripId/microsite (admin read)', () => {
  test('happy path returns the microsite row', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, tripId: 100, publicUuid: TEST_UUID, subdomain: 'trip-TMC-001',
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, tripId: 100, publicUuid: TEST_UUID });
  });

  test('returns 404 NOT_FOUND when no microsite exists for the trip', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PATCH /api/travel/trips/:tripId/microsite', () => {
  test('happy path updates itineraryHtml and returns 200', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({ id: 7, tripId: 100 });
    prisma.tripMicrosite.update.mockResolvedValue({
      id: 7, tripId: 100, itineraryHtml: '<p>updated</p>',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>updated</p>' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, itineraryHtml: '<p>updated</p>' });
    expect(prisma.tripMicrosite.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { itineraryHtml: '<p>updated</p>' },
    });
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({ id: 7, tripId: 100 });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.tripMicrosite.update).not.toHaveBeenCalled();
  });

  test('no existing microsite returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ itineraryHtml: '<p>x</p>' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tripMicrosite.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/trips/:tripId/microsite (ADMIN-only)', () => {
  test('ADMIN happy path returns { deleted: true, id }', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue({ id: 7, tripId: 100 });
    prisma.tripMicrosite.delete.mockResolvedValue({ id: 7 });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, id: 7 });
    expect(prisma.tripMicrosite.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('MANAGER returns 403 RBAC_DENIED (DELETE is ADMIN-only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tripMicrosite.delete).not.toHaveBeenCalled();
  });

  test('no existing microsite returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tripCode: 'TMC-001' });
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/microsite')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tripMicrosite.delete).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC endpoints (no auth) ──────────────────────────────────────

describe('GET /api/travel/microsites/public/:publicUuid (no auth)', () => {
  test('happy path returns PUBLIC_SELECT projection WITHOUT auth', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      publicUuid: TEST_UUID,
      subdomain: 'trip-TMC-001',
      itineraryHtml: '<p>Day 1</p>',
      faqJson: null,
      publishedAt: new Date('2026-05-01'),
      expiresAt: null,
      trip: {
        destination: 'Goa',
        departDate: new Date('2026-06-01'),
        returnDate: new Date('2026-06-07'),
        tripCode: 'TMC-001',
        legalEntity: 'Test Travels Pvt Ltd',
        pricePerStudent: 24999,
        status: 'confirmed',
        documentRequirements: [
          { docType: 'passport', required: true },
          { docType: 'aadhaar', required: true },
        ],
        paymentPlan: {
          instalmentsJson: JSON.stringify([
            { dueDate: '2026-05-01', amount: 10000 },
            { dueDate: '2026-05-15', amount: 14999 },
          ]),
          graceDays: 3,
        },
        _count: { participants: 12 },
      },
    });
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}`);
    // NO Authorization header at all — must still succeed.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      publicUuid: TEST_UUID,
      subdomain: 'trip-TMC-001',
    });
    // Public-safe package fields are now surfaced for the microsite UI.
    expect(res.body.trip).toMatchObject({
      destination: 'Goa',
      pricePerStudent: 24999,
      status: 'confirmed',
      documentRequirements: [
        { docType: 'passport', required: true },
        { docType: 'aadhaar', required: true },
      ],
      paymentPlan: {
        instalmentsJson: expect.any(String),
        graceDays: 3,
      },
      _count: { participants: 12 },
    });
    // PUBLIC_SELECT must NOT leak PII fields.
    expect(res.body.participants).toBeUndefined();
    expect(res.body.rooming).toBeUndefined();
    expect(res.body.tenantId).toBeUndefined();
    // Verify the prisma lookup used the PUBLIC_SELECT shape.
    expect(prisma.tripMicrosite.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicUuid: TEST_UUID },
        select: expect.objectContaining({
          publicUuid: true,
          subdomain: true,
          itineraryHtml: true,
          faqJson: true,
          trip: expect.any(Object),
        }),
      }),
    );
  });

  test('malformed UUID returns 400 INVALID_UUID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/microsites/public/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_UUID' });
    expect(prisma.tripMicrosite.findUnique).not.toHaveBeenCalled();
  });

  test('unknown UUID returns 404 NOT_FOUND', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('expired microsite returns 410 GONE', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      publicUuid: TEST_UUID,
      subdomain: 'trip-TMC-001',
      itineraryHtml: '<p>foo</p>',
      faqJson: null,
      publishedAt: new Date('2024-01-01'),
      expiresAt: new Date(Date.now() - 86400_000), // yesterday
      trip: { destination: 'Goa', tripCode: 'TMC-001' },
    });
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'GONE' });
  });
});

// ─── PUBLIC OTP flow (STUB-mode — Wati cred-blocked per Q9) ──────────

describe('POST /api/travel/microsites/public/:publicUuid/request-otp', () => {
  test('happy path: 201 sent:true + persists bcrypt-hashed OTP; code NOT in response', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, expiresAt: null, tenantId: 1,
    });
    prisma.tripMicrositeOtp.findFirst.mockResolvedValue(null); // no cooldown row
    prisma.tripMicrositeOtp.create.mockImplementation(async (args) => ({
      id: 1, ...args.data,
    }));
    // Tenant lookup happens AFTER OTP create (for the wabaId observability).
    prisma.tenant.findUnique
      .mockResolvedValueOnce({ id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel' }) // requireTravelTenant
      .mockResolvedValueOnce({ subBrandConfigJson: null }); // resolve TMC wabaId

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/request-otp`)
      .send({ phone: '+919876543210', purpose: 'registration' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sent: true });
    expect(res.body.expiresAt).toBeTruthy();
    // PRD §4.5: the OTP code is intentionally NOT returned in the response —
    // it's only delivered through the SMS/WhatsApp side-channel (stubbed today).
    expect(res.body.code).toBeUndefined();
    expect(res.body.otp).toBeUndefined();
    // bcrypt-hashed otp persisted (hash, never raw)
    const createArgs = prisma.tripMicrositeOtp.create.mock.calls[0][0];
    expect(createArgs.data.otpHash).toBeTruthy();
    expect(createArgs.data.otpHash).not.toMatch(/^\d{4}$/); // not a raw 4-digit
    expect(createArgs.data.micrositeId).toBe(7);
    expect(createArgs.data.phone).toBe('+919876543210');
    expect(createArgs.data.purpose).toBe('registration');
  });

  test('missing phone+purpose returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/request-otp`)
      .send({ phone: '+919876543210' }); // purpose missing
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tripMicrositeOtp.create).not.toHaveBeenCalled();
  });

  test('invalid purpose returns 400 INVALID_PURPOSE', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/request-otp`)
      .send({ phone: '+919876543210', purpose: 'evil-data-grab' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PURPOSE' });
    expect(prisma.tripMicrositeOtp.create).not.toHaveBeenCalled();
  });

  test('cool-down hit within 60s returns 429 OTP_COOLDOWN', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, expiresAt: null, tenantId: 1,
    });
    // findFirst returns a row → "recent" → cool-down active.
    prisma.tripMicrositeOtp.findFirst.mockResolvedValue({ id: 99 });
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/request-otp`)
      .send({ phone: '+919876543210', purpose: 'registration' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'OTP_COOLDOWN' });
    expect(prisma.tripMicrositeOtp.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/microsites/public/:publicUuid/verify-otp', () => {
  test('happy path verifies and returns a JWT access token with kind=microsite-otp', async () => {
    const bcrypt = requireCJS('bcryptjs');
    const rawCode = '1234';
    const otpHash = await bcrypt.hash(rawCode, 10);
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, expiresAt: null,
    });
    prisma.tripMicrositeOtp.findFirst.mockResolvedValue({
      id: 50,
      micrositeId: 7,
      phone: '+919876543210',
      purpose: 'registration',
      otpHash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    prisma.tripMicrositeOtp.update.mockResolvedValue({ id: 50, usedAt: new Date() });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({ phone: '+919876543210', purpose: 'registration', code: rawCode });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: true });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.expiresIn).toBe('30m');
    // The JWT must carry kind=microsite-otp + micrositeId + phone + purpose.
    const decoded = jwt.verify(res.body.accessToken, JWT_SECRET);
    expect(decoded).toMatchObject({
      kind: 'microsite-otp',
      micrositeId: 7,
      phone: '+919876543210',
      purpose: 'registration',
    });
    // usedAt must be set on the OTP row.
    expect(prisma.tripMicrositeOtp.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 50 },
        data: expect.objectContaining({ usedAt: expect.any(Date) }),
      }),
    );
  });

  test('no matching OTP returns 400 OTP_INVALID', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({ id: 7, expiresAt: null });
    prisma.tripMicrositeOtp.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({ phone: '+919876543210', purpose: 'registration', code: '1234' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'OTP_INVALID' });
    expect(prisma.tripMicrositeOtp.update).not.toHaveBeenCalled();
  });

  test('wrong code (bcrypt mismatch) returns 400 OTP_INVALID', async () => {
    const bcrypt = requireCJS('bcryptjs');
    const otpHash = await bcrypt.hash('1234', 10);
    prisma.tripMicrosite.findUnique.mockResolvedValue({ id: 7, expiresAt: null });
    prisma.tripMicrositeOtp.findFirst.mockResolvedValue({
      id: 50, micrositeId: 7, phone: '+919876543210',
      purpose: 'registration', otpHash,
      expiresAt: new Date(Date.now() + 60_000), usedAt: null,
    });
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({ phone: '+919876543210', purpose: 'registration', code: '9999' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'OTP_INVALID' });
    expect(prisma.tripMicrositeOtp.update).not.toHaveBeenCalled();
  });
});

// ─── Phase 4 — /verify-otp draftToken binding ────────────────────────

describe('POST /api/travel/microsites/public/:publicUuid/verify-otp (draftToken binding)', () => {
  // Common OTP + microsite setup helper — code "1234" hashed, microsite
  // id=7 tripId=100, OTP record matches purpose=registration.
  async function setupHappyOtp({ otpPurpose = 'registration', otpPhone = '+919876543210' } = {}) {
    const bcrypt = requireCJS('bcryptjs');
    const otpHash = await bcrypt.hash('1234', 10);
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, tripId: 100, expiresAt: null,
    });
    prisma.tripMicrositeOtp.findFirst.mockResolvedValue({
      id: 50, micrositeId: 7, phone: otpPhone, purpose: otpPurpose,
      otpHash, expiresAt: new Date(Date.now() + 60_000), usedAt: null,
    });
    prisma.tripMicrositeOtp.update.mockResolvedValue({ id: 50, usedAt: new Date() });
  }

  test('happy path: OTP verified + draft marked OTP_VERIFIED + response includes draftBound', async () => {
    await setupHappyOtp();
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 7001, tripId: 100, status: 'DRAFT', otpVerified: false,
      draftTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({
      id: 7001, status: 'OTP_VERIFIED', otpVerified: true,
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({
        phone: '+919876543210', purpose: 'registration', code: '1234',
        draftToken: 'token-abc-123',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verified: true,
      draftBound: { id: 7001, status: 'OTP_VERIFIED', alreadyVerified: false },
    });
    // Draft was updated transactionally
    expect(prisma.pendingTripRegistration.update).toHaveBeenCalledWith({
      where: { id: 7001 },
      data: expect.objectContaining({
        status: 'OTP_VERIFIED',
        otpVerified: true,
        otpVerifiedAt: expect.any(Date),
        otpPhone: '+919876543210',
      }),
    });
    // Both updates went through $transaction
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txArr = prisma.$transaction.mock.calls[0][0];
    expect(Array.isArray(txArr)).toBe(true);
    expect(txArr).toHaveLength(2);
  });

  test('already-verified draft → idempotent: draft NOT re-updated, response flags alreadyVerified', async () => {
    await setupHappyOtp();
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 7001, tripId: 100, status: 'OTP_VERIFIED', otpVerified: true,
      draftTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({
        phone: '+919876543210', purpose: 'registration', code: '1234',
        draftToken: 'token-abc-123',
      });

    expect(res.status).toBe(200);
    expect(res.body.draftBound).toMatchObject({
      id: 7001, status: 'OTP_VERIFIED', alreadyVerified: true,
    });
    // No second update — only the OTP usedAt was committed
    expect(prisma.pendingTripRegistration.update).not.toHaveBeenCalled();
    const txArr = prisma.$transaction.mock.calls[0][0];
    expect(txArr).toHaveLength(1);
  });

  test('unknown draftToken returns 404 DRAFT_NOT_FOUND; OTP NOT marked used', async () => {
    await setupHappyOtp();
    prisma.pendingTripRegistration.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({
        phone: '+919876543210', purpose: 'registration', code: '1234',
        draftToken: 'no-such-token',
      });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tripMicrositeOtp.update).not.toHaveBeenCalled();
    expect(prisma.pendingTripRegistration.update).not.toHaveBeenCalled();
  });

  test('draftToken from a different trip returns 403 DRAFT_WRONG_TRIP', async () => {
    await setupHappyOtp();
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 8002, tripId: 999, // microsite is tripId=100; draft is for tripId=999
      status: 'DRAFT', otpVerified: false,
      draftTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({
        phone: '+919876543210', purpose: 'registration', code: '1234',
        draftToken: 'token-other-trip',
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'DRAFT_WRONG_TRIP' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tripMicrositeOtp.update).not.toHaveBeenCalled();
  });

  test('expired draftToken returns 400 DRAFT_EXPIRED', async () => {
    await setupHappyOtp();
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 7001, tripId: 100, status: 'DRAFT', otpVerified: false,
      draftTokenExpiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({
        phone: '+919876543210', purpose: 'registration', code: '1234',
        draftToken: 'token-expired',
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'DRAFT_EXPIRED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('purpose=payment-plan ignores draftToken (no binding attempted)', async () => {
    await setupHappyOtp({ otpPurpose: 'payment-plan' });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({
        phone: '+919876543210', purpose: 'payment-plan', code: '1234',
        draftToken: 'token-ignored',
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.draftBound).toBeUndefined();
    expect(prisma.pendingTripRegistration.findUnique).not.toHaveBeenCalled();
  });

  test('verify-otp without draftToken still works (back-compat)', async () => {
    await setupHappyOtp();
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/verify-otp`)
      .send({ phone: '+919876543210', purpose: 'registration', code: '1234' });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.draftBound).toBeUndefined();
    expect(prisma.pendingTripRegistration.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Phase 4 — /full draft inclusion ─────────────────────────────────

describe('GET /api/travel/microsites/public/:publicUuid/full (draft inclusion)', () => {
  function micrositeToken(purpose = 'registration', micrositeId = 7) {
    return jwt.sign(
      { kind: 'microsite-otp', micrositeId, phone: '+919876543210', purpose },
      JWT_SECRET,
      { expiresIn: '30m' },
    );
  }

  test('purpose=registration + valid draftToken returns reveal with draft details', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 'trip-bali2026', tripId: 100, publicUuid: TEST_UUID,
      itineraryHtml: '<p>Day 1</p>', faqJson: null,
      publishedAt: new Date(), expiresAt: null,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      status: 'confirmed',
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 7001, tripId: 100, status: 'OTP_VERIFIED', otpVerified: true,
      otpVerifiedAt: new Date(), draftTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      studentName: 'Aarav Iyer', studentSchool: 'DPS North', studentClass: '10A',
      parentName: 'Rohan Iyer', parentEmail: 'rohan@example.com', parentPhone: '+919876543210',
      passportNumber: 'M1234567', passportExpiry: new Date('2031-09-01'),
      createdAt: new Date(),
    });

    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${micrositeToken('registration')}&draftToken=token-abc-123`);

    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({
      id: 7001,
      status: 'OTP_VERIFIED',
      studentName: 'Aarav Iyer',
      parentName: 'Rohan Iyer',
      passportNumber: 'M1234567',
    });
  });

  test('purpose=registration without draftToken returns reveal without draft (no error)', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 'trip-bali2026', tripId: 100, publicUuid: TEST_UUID,
      itineraryHtml: '<p>Day 1</p>', faqJson: null,
      publishedAt: new Date(), expiresAt: null,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({ id: 100, tripCode: 'bali2026', destination: 'Bali', departDate: new Date(), returnDate: new Date(), status: 'confirmed' });

    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${micrositeToken('registration')}`);

    expect(res.status).toBe(200);
    expect(res.body.draft).toBeUndefined();
    expect(prisma.pendingTripRegistration.findUnique).not.toHaveBeenCalled();
  });

  test('purpose=registration with unknown draftToken returns 404 DRAFT_NOT_FOUND', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 'trip-bali2026', tripId: 100, publicUuid: TEST_UUID,
      itineraryHtml: '', faqJson: null, publishedAt: new Date(), expiresAt: null,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({ id: 100, tripCode: 'bali2026', destination: 'Bali', departDate: new Date(), returnDate: new Date(), status: 'confirmed' });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${micrositeToken('registration')}&draftToken=ghost`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  test('draftToken from a different trip returns 403 DRAFT_WRONG_TRIP', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 't', tripId: 100, publicUuid: TEST_UUID,
      itineraryHtml: '', faqJson: null, publishedAt: new Date(), expiresAt: null,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({ id: 100, tripCode: 't', destination: 'D', departDate: new Date(), returnDate: new Date(), status: 'confirmed' });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 9, tripId: 999, // wrong trip
      status: 'OTP_VERIFIED', otpVerified: true,
      draftTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${micrositeToken('registration')}&draftToken=t`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'DRAFT_WRONG_TRIP' });
  });

  test('expired draftToken returns 400 DRAFT_EXPIRED', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 't', tripId: 100, publicUuid: TEST_UUID,
      itineraryHtml: '', faqJson: null, publishedAt: new Date(), expiresAt: null,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({ id: 100, tripCode: 't', destination: 'D', departDate: new Date(), returnDate: new Date(), status: 'confirmed' });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 9, tripId: 100, status: 'OTP_VERIFIED', otpVerified: true,
      draftTokenExpiresAt: new Date(Date.now() - 60_000),
    });
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${micrositeToken('registration')}&draftToken=t`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'DRAFT_EXPIRED' });
  });

  test('non-registration purpose ignores draftToken query param', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 't', tripId: 100, publicUuid: TEST_UUID,
      itineraryHtml: '', faqJson: null, publishedAt: new Date(), expiresAt: null,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({ id: 100, tripCode: 't', destination: 'D', departDate: new Date(), returnDate: new Date(), status: 'confirmed' });
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${micrositeToken('teacher-access')}&draftToken=should-be-ignored`);
    expect(res.status).toBe(200);
    expect(res.body.draft).toBeUndefined();
    expect(prisma.pendingTripRegistration.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/microsites/public/:publicUuid/full (token-gated PII)', () => {
  test('missing token returns 401 TOKEN_REQUIRED', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_REQUIRED' });
    expect(prisma.tripMicrosite.findUnique).not.toHaveBeenCalled();
  });

  test('garbage token returns 401 TOKEN_INVALID', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=not-a-jwt`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_INVALID' });
    expect(prisma.tripMicrosite.findUnique).not.toHaveBeenCalled();
  });

  test('wrong-scope token (different micrositeId) returns 403 TOKEN_SCOPE', async () => {
    const wrongToken = jwt.sign(
      { kind: 'microsite-otp', micrositeId: 999, phone: '+919876543210', purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '30m' },
    );
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, // real microsite — but token's micrositeId=999 doesn't match.
      subdomain: 'trip-TMC-001',
      itineraryHtml: '<p>x</p>',
      faqJson: null,
      publishedAt: new Date(),
      expiresAt: null,
      publicUuid: TEST_UUID,
      tripId: 100,
    });
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${wrongToken}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TOKEN_SCOPE' });
  });

  test('non-microsite-kind token returns 401 TOKEN_INVALID', async () => {
    // A regular staff token shouldn't unlock the /full PII reveal.
    const wrongKindToken = jwt.sign(
      { kind: 'session', userId: 1, tenantId: 1, role: 'ADMIN' },
      JWT_SECRET,
      { expiresIn: '30m' },
    );
    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${wrongKindToken}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  test('purpose=registration reveals participants but NOT paymentPlan/rooming', async () => {
    const okToken = jwt.sign(
      { kind: 'microsite-otp', micrositeId: 7, phone: '+919876543210', purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '30m' },
    );
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7,
      subdomain: 'trip-TMC-001',
      itineraryHtml: '<p>x</p>',
      faqJson: null,
      publishedAt: new Date(),
      expiresAt: null,
      publicUuid: TEST_UUID,
      tripId: 100,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({
      id: 100, tripCode: 'TMC-001', destination: 'Goa',
      departDate: new Date('2026-06-01'), returnDate: new Date('2026-06-07'),
      status: 'active',
    });
    prisma.tripParticipant.findMany.mockResolvedValue([
      { id: 1, fullName: 'Asha Iyer', passportNumber: 'P1234' },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${okToken}`);

    expect(res.status).toBe(200);
    expect(res.body.microsite).toMatchObject({ id: 7 });
    expect(res.body.trip).toMatchObject({ tripCode: 'TMC-001' });
    // Purpose=registration => participants reveal.
    expect(res.body.participants).toHaveLength(1);
    expect(res.body.participants[0]).toMatchObject({ fullName: 'Asha Iyer' });
    // But NOT rooming / paymentPlan / instalments / documentRequirements.
    expect(res.body.rooming).toBeUndefined();
    expect(res.body.paymentPlan).toBeUndefined();
    expect(res.body.instalments).toBeUndefined();
    expect(res.body.documentRequirements).toBeUndefined();
    // Validate the prisma calls — rooming/paymentPlan/instalments should NOT have been queried.
    expect(prisma.roomingAssignment.findMany).not.toHaveBeenCalled();
    expect(prisma.tripPaymentPlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.tripInstalmentPayment.findMany).not.toHaveBeenCalled();
  });

  test('purpose=payment-plan reveals instalments but NOT participants/rooming', async () => {
    const okToken = jwt.sign(
      { kind: 'microsite-otp', micrositeId: 7, phone: '+919876543210', purpose: 'payment-plan' },
      JWT_SECRET,
      { expiresIn: '30m' },
    );
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, subdomain: 'trip-TMC-001', itineraryHtml: '<p>x</p>',
      faqJson: null, publishedAt: new Date(), expiresAt: null,
      publicUuid: TEST_UUID, tripId: 100,
    });
    prisma.tmcTrip.findUnique.mockResolvedValue({
      id: 100, tripCode: 'TMC-001', destination: 'Goa',
      departDate: new Date(), returnDate: new Date(), status: 'active',
    });
    prisma.tripPaymentPlan.findUnique.mockResolvedValue({ id: 1, tripId: 100 });
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 1, instalmentIndex: 0, participantId: 1 },
    ]);

    const res = await request(makeApp())
      .get(`/api/travel/microsites/public/${TEST_UUID}/full?token=${okToken}`);

    expect(res.status).toBe(200);
    // Purpose=payment-plan => paymentPlan + instalments reveal.
    expect(res.body.paymentPlan).toMatchObject({ id: 1, tripId: 100 });
    expect(res.body.instalments).toHaveLength(1);
    // But NOT participants / rooming / documentRequirements.
    expect(res.body.participants).toBeUndefined();
    expect(res.body.rooming).toBeUndefined();
    expect(res.body.documentRequirements).toBeUndefined();
    // Cross-purpose query isolation: participants must not have been fetched.
    expect(prisma.tripParticipant.findMany).not.toHaveBeenCalled();
  });
});

// ─── Document upload (PUBLIC, draftToken-scoped) ─────────────────────
//
// POST /microsites/public/:publicUuid/documents
// Parent-facing document capture (Passport + Aadhaar + Parent consent letter + consent checkbox).
// The uploader is identified ONLY by draftToken; no participant list shown.
// Files stored via visaDocStore (S3 when configured, gated disk fallback).
describe('Travel microsites API — document upload (public)', () => {
  test('missing draftToken → 400 MISSING_TOKEN', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('consent', 'true')
      .expect(400);

    expect(res.body.code).toBe('MISSING_TOKEN');
  });

  test('bogus draftToken → 404 DRAFT_NOT_FOUND', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'bogus-token')
      .field('consent', 'true')
      .expect(404);

    expect(res.body.code).toBe('DRAFT_NOT_FOUND');
  });

  test('draft for wrong trip → 403 DRAFT_WRONG_TRIP', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 999, // Wrong trip!
      draftTokenExpiresAt: new Date(Date.now() + 3600_000),
      extrasJson: null,
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'token-for-trip-999')
      .field('consent', 'true')
      .expect(403);

    expect(res.body.code).toBe('DRAFT_WRONG_TRIP');
  });

  test('expired draft → 400 DRAFT_EXPIRED', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 100,
      draftTokenExpiresAt: new Date(Date.now() - 1000), // Expired!
      extrasJson: null,
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'expired-token')
      .field('consent', 'true')
      .expect(400);

    expect(res.body.code).toBe('DRAFT_EXPIRED');
  });

  test('missing consent → 400 CONSENT_REQUIRED', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 100,
      draftTokenExpiresAt: new Date(Date.now() + 3600_000),
      extrasJson: null,
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'false') // Explicit false
      .expect(400);

    expect(res.body.code).toBe('CONSENT_REQUIRED');
  });

  test('missing both files → 400 MISSING_FILES', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 100,
      draftTokenExpiresAt: new Date(Date.now() + 3600_000),
      extrasJson: null, // No prior docs
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      // No files attached
      .expect(400);

    expect(res.body.code).toBe('MISSING_FILES');
  });

  test('passport + aadhaar present but no consent letter → 400 MISSING_CONSENT_LETTER', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 100,
      draftTokenExpiresAt: new Date(Date.now() + 3600_000),
      extrasJson: null, // No prior docs
    });

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .attach('passport', Buffer.from('PDF%PDF-1.4...'), 'passport.pdf')
      .attach('aadhaar', Buffer.from('PNG\x89PNG\r\n...'), 'aadhaar.png')
      // No consentLetter attached
      .expect(400);

    expect(res.body.code).toBe('MISSING_CONSENT_LETTER');
  });

  test('invalid file type → 400 INVALID_FILE (multer rejection)', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .attach('passport', Buffer.from('not pdf'), 'test.exe') // Invalid type
      .expect(400);

    expect(res.body.code).toBe('INVALID_FILE');
  });

  test('file too large → 400 INVALID_FILE (size limit)', async () => {
    // Create a buffer > 8MB
    const hugeBuffer = Buffer.alloc(9 * 1024 * 1024);

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .attach('passport', hugeBuffer, 'huge.pdf')
      .expect(400);

    expect(res.body.code).toBe('INVALID_FILE');
  });

  test('garbage UUID → 400 INVALID_UUID', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/not-a-uuid/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .expect(400);

    expect(res.body.code).toBe('INVALID_UUID');
  });

  test('unknown microsite → 404 NOT_FOUND', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('happy path: all three files + consent → 200 with doc status booleans', async () => {
    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 100,
      draftTokenExpiresAt: new Date(Date.now() + 3600_000),
      extrasJson: null, // No prior docs
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({
      id: 10, extrasJson: '{"documents":{"passport":{"storage":"s3","url":"..."},"aadhaar":{"storage":"s3","url":"..."},"consentLetter":{"storage":"s3","url":"..."},"consentCapturedAt":"2026-07-01T..."}}',
    });

    const passportBuffer = Buffer.from('PDF%PDF-1.4...');
    const aadhaarBuffer = Buffer.from('PNG\x89PNG\r\n...');
    const consentLetterBuffer = Buffer.from('PDF%PDF-1.4 consent...');

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .attach('passport', passportBuffer, 'passport.pdf')
      .attach('aadhaar', aadhaarBuffer, 'aadhaar.png')
      .attach('consentLetter', consentLetterBuffer, 'consent.pdf')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.documents).toMatchObject({
      passport: true,
      aadhaar: true,
      consentLetter: true,
      consentCapturedAt: expect.any(String),
    });
    // Verify the draft was updated with the new docs
    expect(prisma.pendingTripRegistration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: expect.objectContaining({
          extrasJson: expect.stringContaining('"documents"'),
        }),
      }),
    );
  });

  test('re-upload one file while others exist → happy path, all three present', async () => {
    // Simulate a draft that already has passport + consentLetter but not aadhaar
    const existingExtras = JSON.stringify({
      documents: {
        passport: { storage: 's3', url: 'https://...', key: 'visa-docs/passport.pdf' },
        consentLetter: { storage: 's3', url: 'https://...', key: 'visa-docs/consent.pdf' },
        consentCapturedAt: '2026-07-01T00:00:00.000Z',
      },
    });

    prisma.tripMicrosite.findUnique.mockResolvedValue({
      id: 7, publicUuid: TEST_UUID, tripId: 100, expiresAt: null,
    });
    prisma.pendingTripRegistration.findUnique.mockResolvedValue({
      id: 10, tripId: 100,
      draftTokenExpiresAt: new Date(Date.now() + 3600_000),
      extrasJson: existingExtras,
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({
      id: 10, extrasJson: JSON.stringify({
        documents: {
          passport: { storage: 's3', url: 'https://...' },
          aadhaar: { storage: 's3', url: 'https://...', uploadedAt: '2026-07-01T...' },
          consentLetter: { storage: 's3', url: 'https://...' },
          consentCapturedAt: '2026-07-01T...',
        },
      }),
    });

    const aadhaarBuffer = Buffer.from('PNG\x89PNG\r\n...');

    const res = await request(makeApp())
      .post(`/api/travel/microsites/public/${TEST_UUID}/documents`)
      .field('draftToken', 'ok-token')
      .field('consent', 'true')
      .attach('aadhaar', aadhaarBuffer, 'aadhaar.png')
      // No passport or consentLetter file — both already on record
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.documents).toMatchObject({
      passport: true,       // Carried over from prior upload
      aadhaar: true,        // Newly uploaded
      consentLetter: true,  // Carried over from prior upload
      consentCapturedAt: expect.any(String),
    });
  });
});
