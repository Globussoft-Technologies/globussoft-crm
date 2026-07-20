// @ts-check
/**
 * backend/routes/travel_trips.js — TMC trip route contract pin.
 *
 * What's pinned
 * -------------
 *   - Trip CRUD (5 routes):
 *       GET    /trips                                       all-roles + TMC
 *                                                           ?status validates against enum
 *                                                           ?schoolContactId is numeric-coerced
 *       POST   /trips                                       all-roles + TMC
 *                                                           MISSING_FIELDS / INVALID_CONTACT_ID /
 *                                                           INVALID_STATUS / INVALID_DATE /
 *                                                           INVERTED_DATES / DUPLICATE_TRIP_CODE
 *                                                           default status="confirmed" triggers
 *                                                           best-effort Drive folder auto-create;
 *                                                           explicit driveFolderId override wins;
 *                                                           stub failure logs but does NOT block
 *                                                           the create (folder stays NULL)
 *       GET    /trips/:id                                   404 NOT_FOUND on cross-tenant
 *       PATCH  /trips/:id                                   INVALID_ID / EMPTY_BODY /
 *                                                           INVALID_DATE / INVALID_STATUS /
 *                                                           INVERTED_DATES; flip-to-confirmed
 *                                                           triggers Drive folder auto-create
 *                                                           when both (a) existing.driveFolderId
 *                                                           is null AND (b) body did not
 *                                                           supply driveFolderId
 *       DELETE /trips/:id                                   ADMIN only — requirePermission('trips','delete')
 *
 *   - Ops-dashboard rollup (1 route, PRD §4.9):
 *       GET    /trips/:id/ops-dashboard                     ADMIN+MANAGER only — requirePermission('trips','read')
 *                                                           score=null when participantsCount=0
 *                                                           OR expectedTotalRupees=0; over-roomed
 *                                                           participantsRoomed is clamped to
 *                                                           participantsCount; rounding to 2dp
 *                                                           on rupee aggregates; status buckets
 *                                                           default to "pending"
 *
 *   - Participant CRUD (4 routes):
 *       GET    /trips/:id/participants                      cross-tenant trip returns 404
 *       POST   /trips/:id/participants                      MISSING_FIELDS / INVALID_AADHAAR_LAST4
 *                                                           passport+consent date coercion
 *       PATCH  /trips/:id/participants/:pid                 EMPTY_BODY / PARTICIPANT_NOT_FOUND /
 *                                                           INVALID_PARTICIPANT_ID /
 *                                                           INVALID_AADHAAR_LAST4
 *       DELETE /trips/:id/participants/:pid                 PARTICIPANT_NOT_FOUND on cross-trip
 *
 *   - DigiLocker (2 routes — stub-mode):
 *       POST   /trips/:tripId/participants/:participantId/digilocker/initiate
 *                                                           MISSING_FIELDS w/o redirectUri;
 *                                                           persists session row with state +
 *                                                           returns oauthUrl (token NEVER leaked)
 *       POST   /trips/:tripId/participants/:participantId/digilocker/callback
 *                                                           404 SESSION_NOT_FOUND on tenant /
 *                                                           participant mismatch (replay-protection);
 *                                                           409 INVALID_STATE on already-verified;
 *                                                           410 SESSION_GONE on expired/failed;
 *                                                           tokenId NEVER appears in response
 *
 *   - Document requirements (3 routes):
 *       GET    /trips/:id/documents                         cross-tenant trip returns 404
 *       POST   /trips/:id/documents                         MISSING_FIELDS w/o docType;
 *                                                           required:false honoured
 *       DELETE /trips/:id/documents/:docId                  DOC_NOT_FOUND on cross-trip
 *
 * Pinned guards (all routes go through these in order):
 *   verifyToken → [requirePermission?] → requireTravelTenant → requireTmcAccess → handler
 *
 * Failure-path codes pinned by the route source as of this commit:
 *   400 INVALID_ID / INVALID_CONTACT_ID / INVALID_STATUS / INVALID_DATE /
 *       INVERTED_DATES / MISSING_FIELDS / EMPTY_BODY / INVALID_PARTICIPANT_ID /
 *       INVALID_AADHAAR_LAST4 / INVALID_DOC_ID
 *   401 — verifyToken (missing Authorization)
 *   403 SUB_BRAND_DENIED / WRONG_VERTICAL / RBAC_DENIED — guard stack
 *   404 NOT_FOUND / PARTICIPANT_NOT_FOUND / DOC_NOT_FOUND / SESSION_NOT_FOUND
 *   409 DUPLICATE_TRIP_CODE / INVALID_STATE (digilocker replay)
 *   410 SESSION_GONE (digilocker expired/failed)
 *
 * Test pattern mirrors backend/test/routes/travel-trip-billing.test.js (commit
 * 1160dc3a) — patch the prisma singleton with vi.fn() shapes BEFORE requiring
 * the router, then drive supertest with real HS256 JWTs signed with the same
 * fallback secret the middleware uses in dev. The full guard chain
 * (verifyToken + requirePermission + requireTravelTenant + requireTmcAccess) is
 * exercised end-to-end; we don't bypass middleware.
 *
 * The googleDriveClient + digilockerClient services are stub-mode (Q1 + Q3
 * cred-blocked). The route source imports them via CJS require() at module
 * load; we don't mock them — the stubs return deterministic synthetic values
 * that the assertions accommodate (folderId starts with "stub-folder-",
 * aadhaarLast4 = "9999"). For the failure-path tests where we need
 * createTripFolder to throw, we monkey-patch the loaded stub before
 * requiring the router.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tmcTrip = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tripParticipant = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tripDocumentRequirement = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};
prisma.tripInstalmentPayment = {
  findMany: vi.fn(),
};
prisma.roomingAssignment = {
  findMany: vi.fn(),
};
prisma.digilockerSession = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.landingPage = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
// Phase 5 — pending-registration admin endpoints
prisma.pendingTripRegistration = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
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
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.$transaction = vi.fn().mockImplementation(async (ops) => {
  // Route uses $transaction([promise, promise]) — resolve each.
  if (Array.isArray(ops)) {
    return Promise.all(ops);
  }
  if (typeof ops === 'function') {
    return ops(prisma);
  }
  return ops;
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Load + patch the Drive stub BEFORE the router so the route's CJS require
// resolves to our spy-able instance. Test-by-test we override createTripFolder
// to either return a synthetic folder or throw (best-effort failure path).
const googleDriveClient = requireCJS('../../services/googleDriveClient');
const digilockerClient = requireCJS('../../services/digilockerClient');

const tripsRouter = requireCJS('../../routes/travel_trips');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', tripsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

let driveCreateSpy;
let digilockerInitiateSpy;
let digilockerExchangeSpy;

beforeEach(() => {
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue({ id: 100 });
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.count.mockReset().mockResolvedValue(0);
  prisma.tmcTrip.create.mockReset();
  prisma.tmcTrip.update.mockReset();
  prisma.tmcTrip.delete.mockReset();
  prisma.tripParticipant.findFirst.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.tripParticipant.create.mockReset();
  prisma.tripParticipant.update.mockReset();
  prisma.tripParticipant.delete.mockReset();
  prisma.tripDocumentRequirement.findFirst.mockReset();
  prisma.tripDocumentRequirement.findMany.mockReset().mockResolvedValue([]);
  prisma.tripDocumentRequirement.create.mockReset();
  prisma.tripDocumentRequirement.delete.mockReset();
  prisma.tripInstalmentPayment.findMany.mockReset().mockResolvedValue([]);
  prisma.roomingAssignment.findMany.mockReset().mockResolvedValue([]);
  prisma.digilockerSession.findFirst.mockReset();
  prisma.digilockerSession.create.mockReset();
  prisma.digilockerSession.update.mockReset();
  prisma.landingPage.findUnique.mockReset();
  prisma.landingPage.create.mockReset();
  prisma.landingPage.update.mockReset();
  prisma.pendingTripRegistration.findFirst.mockReset();
  prisma.pendingTripRegistration.findMany.mockReset();
  prisma.pendingTripRegistration.update.mockReset();
  // Don't reset $transaction's IMPLEMENTATION (the resolver is needed
  // by every test that drives the route layer); just clear call
  // history so per-test toHaveBeenCalledTimes assertions don't see
  // cumulative counts from prior tests in the file.
  prisma.$transaction.mockClear();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);

  // Default the Drive + DigiLocker stubs to their real synthetic behaviour;
  // individual tests override (e.g. createTripFolder throws for one path).
  // vi.spyOn wraps the original — call mockRestore in afterEach so the
  // next test re-spies cleanly. Otherwise repeated spyOn calls stack and
  // the "not.toHaveBeenCalled" assertion sees count from the prior test's
  // wrapper.
  driveCreateSpy = vi.spyOn(googleDriveClient, 'createTripFolder');
  digilockerInitiateSpy = vi.spyOn(digilockerClient, 'initiateSession');
  digilockerExchangeSpy = vi.spyOn(digilockerClient, 'exchangeCallback');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips — list
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips', () => {
  test('returns trip list scoped to tenant with limit/offset envelope', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, tripCode: 'bali2026', destination: 'Bali', tenantId: 1 },
    ]);
    prisma.tmcTrip.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      trips: expect.any(Array),
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1 },
        orderBy: { departDate: 'asc' },
        take: 50,
        skip: 0,
      }),
    );
  });

  test('?status=invalidValue returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips?status=disputed')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('?status and ?schoolContactId are folded into where clause', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([]);
    prisma.tmcTrip.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/trips?status=confirmed&schoolContactId=42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.tmcTrip.findMany.mock.calls[0][0].where;
    expect(calledWhere).toMatchObject({
      tenantId: 1,
      status: 'confirmed',
      schoolContactId: 42,
    });
  });

  test('caller without TMC sub-brand access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .get('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// POST /api/travel/trips — create
// -----------------------------------------------------------------------------

describe('POST /api/travel/trips', () => {
  const validBody = () => ({
    tripCode: 'bali2026',
    schoolContactId: 42,
    destination: 'Bali, Indonesia',
    departDate: '2026-09-15',
    returnDate: '2026-09-22',
  });

  test('happy path returns 201 + drive folder auto-created when status defaults to confirmed', async () => {
    driveCreateSpy.mockResolvedValue({
      folderId: 'stub-folder-test123',
      folderUrl: 'https://drive.google.com/drive/folders/stub-folder-test123',
      folderName: 'TMC Trip — bali2026 — Bali, Indonesia — 2026-09',
    });
    prisma.tmcTrip.create.mockResolvedValue({
      id: 200,
      tenantId: 1,
      tripCode: 'bali2026',
      status: 'confirmed',
      driveFolderId: 'stub-folder-test123',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 200, status: 'confirmed' });
    expect(driveCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tripCode: 'bali2026',
        destination: 'Bali, Indonesia',
      }),
    );
    expect(prisma.tmcTrip.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          tripCode: 'bali2026',
          schoolContactId: 42,
          destination: 'Bali, Indonesia',
          status: 'confirmed',
          driveFolderId: 'stub-folder-test123',
          legalEntity: 'tmc_nexus', // default
        }),
      }),
    );
  });

  test('missing required fields returns 400 MISSING_FIELDS', async () => {
    const body = validBody();
    delete body.tripCode;
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tmcTrip.create).not.toHaveBeenCalled();
  });

  test('non-numeric schoolContactId returns 400 INVALID_CONTACT_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), schoolContactId: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_ID' });
    expect(prisma.tmcTrip.create).not.toHaveBeenCalled();
  });

  test('returnDate before departDate returns 400 INVERTED_DATES', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), departDate: '2026-09-22', returnDate: '2026-09-15' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVERTED_DATES' });
    expect(prisma.tmcTrip.create).not.toHaveBeenCalled();
  });

  test('unparseable departDate returns 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), departDate: 'garbage-date' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.tmcTrip.create).not.toHaveBeenCalled();
  });

  test('invalid status returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), status: 'archived' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.tmcTrip.create).not.toHaveBeenCalled();
  });

  test('explicit driveFolderId in body OVERRIDES Drive auto-create (no spy call)', async () => {
    prisma.tmcTrip.create.mockResolvedValue({
      id: 201, driveFolderId: 'manual-folder-abc', status: 'confirmed',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), driveFolderId: 'manual-folder-abc' });
    expect(res.status).toBe(201);
    expect(driveCreateSpy).not.toHaveBeenCalled();
    expect(prisma.tmcTrip.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ driveFolderId: 'manual-folder-abc' }),
      }),
    );
  });

  test('Drive auto-create stub failure does NOT block trip creation (folder=null)', async () => {
    driveCreateSpy.mockRejectedValue(new Error('Drive stub blew up'));
    prisma.tmcTrip.create.mockResolvedValue({
      id: 202, driveFolderId: null, status: 'confirmed',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(prisma.tmcTrip.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ driveFolderId: null }),
      }),
    );
  });

  test('non-confirmed status does NOT trigger Drive auto-create', async () => {
    prisma.tmcTrip.create.mockResolvedValue({
      id: 203, status: 'cancelled', driveFolderId: null,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), status: 'cancelled' });
    expect(res.status).toBe(201);
    expect(driveCreateSpy).not.toHaveBeenCalled();
  });

  test('Prisma P2002 unique violation returns 409 DUPLICATE_TRIP_CODE', async () => {
    prisma.tmcTrip.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await request(makeApp())
      .post('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DUPLICATE_TRIP_CODE' });
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/:id — single
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:id', () => {
  test('returns trip with children when found in tenant', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', tenantId: 1, participants: [], documentRequirements: [],
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 100, tripCode: 'bali2026' });
    // Cross-tenant scope: where MUST include tenantId.
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 100, tenantId: 1 } }),
    );
  });

  test('cross-tenant trip lookup returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// PATCH /api/travel/trips/:id — amend
// -----------------------------------------------------------------------------

describe('PATCH /api/travel/trips/:id', () => {
  test('happy partial-update returns 200 with updated row', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, status: 'confirmed', driveFolderId: 'stub-folder-x', tripCode: 'bali2026',
      destination: 'Bali', departDate: new Date('2026-09-15'),
    });
    prisma.tmcTrip.update.mockResolvedValue({
      id: 100, destination: 'Bali Updated', status: 'confirmed',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ destination: 'Bali Updated' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 100, destination: 'Bali Updated' });
    expect(prisma.tmcTrip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: expect.objectContaining({ destination: 'Bali Updated' }),
      }),
    );
  });

  test('empty body returns 400 EMPTY_BODY (no update)', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, status: 'confirmed', driveFolderId: null, tripCode: 'x', destination: 'y',
      departDate: new Date(),
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.tmcTrip.update).not.toHaveBeenCalled();
  });

  test('inverted departDate/returnDate returns 400 INVERTED_DATES', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, status: 'confirmed', driveFolderId: 'x', tripCode: 'x', destination: 'y',
      departDate: new Date(),
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ departDate: '2026-09-22', returnDate: '2026-09-15' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVERTED_DATES' });
    expect(prisma.tmcTrip.update).not.toHaveBeenCalled();
  });

  test('flip non-confirmed → confirmed auto-creates Drive folder when existing has none', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, status: 'cancelled', driveFolderId: null,
      tripCode: 'auto1', destination: 'Bali', departDate: new Date('2026-09-15'),
    });
    driveCreateSpy.mockResolvedValue({
      folderId: 'stub-folder-auto1', folderUrl: 'u', folderName: 'n',
    });
    prisma.tmcTrip.update.mockResolvedValue({
      id: 100, status: 'confirmed', driveFolderId: 'stub-folder-auto1',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'confirmed' });
    expect(res.status).toBe(200);
    expect(driveCreateSpy).toHaveBeenCalled();
    expect(prisma.tmcTrip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'confirmed',
          driveFolderId: 'stub-folder-auto1',
        }),
      }),
    );
  });

  test('cross-tenant PATCH returns 404 NOT_FOUND (no update)', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/trips/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ destination: 'X' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tmcTrip.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/travel/trips/:id — ADMIN only
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/trips/:id', () => {
  test('happy delete returns 200 + { deleted: true, id }', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100, tenantId: 1 });
    prisma.tmcTrip.delete.mockResolvedValue({ id: 100 });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 100 });
    expect(prisma.tmcTrip.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });

  test('MANAGER role is rejected with 403 (ADMIN-only gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(prisma.tmcTrip.delete).not.toHaveBeenCalled();
  });

  test('cross-tenant DELETE returns 404 NOT_FOUND (no delete)', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tmcTrip.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/:id/ops-dashboard — PRD §4.9 operational rollup
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:id/ops-dashboard', () => {
  test('zero-participants trip returns score=null + zeroed component pcts', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'x', destination: 'D', departDate: new Date(),
      returnDate: new Date(), status: 'confirmed', legalEntity: 'tmc_nexus',
      pricePerStudent: null,
    });
    prisma.tripParticipant.findMany.mockResolvedValue([]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    prisma.tripDocumentRequirement.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/ops-dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      participants: { count: 0, target: null, capturedConsent: 0 },
      departureReadiness: {
        score: null,
        components: {
          consentPct: null, docsPct: null, paymentPct: null, roomingPct: null,
        },
      },
    });
  });

  test('full-data trip computes weighted readiness score + clamps over-roomed', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'x', destination: 'D', departDate: new Date(),
      returnDate: new Date(), status: 'confirmed', legalEntity: 'tmc_nexus',
      pricePerStudent: 50000,
    });
    // 4 participants, all consent-captured → consentPct=100
    prisma.tripParticipant.findMany.mockResolvedValue([
      { id: 1, consentCapturedAt: new Date() },
      { id: 2, consentCapturedAt: new Date() },
      { id: 3, consentCapturedAt: new Date() },
      { id: 4, consentCapturedAt: new Date() },
    ]);
    // 10k expected, 5k received → paymentPct=50
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { amount: 10000, paidAmount: 5000, status: 'partial' },
    ]);
    // submittedCount is HARD-CODED to 0 today (no submission-tracking
    // column) → docsPct=0 when requirementCount>0.
    prisma.tripDocumentRequirement.findMany.mockResolvedValue([
      { required: true }, { required: true },
    ]);
    // Over-assigned room (5 ids for 4 participants) — clamp to 4 →
    // roomingPct=100.
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { participantIds: JSON.stringify([1, 2, 3, 4, 99]) },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/ops-dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Weighted: 0.3*1 + 0.3*0 + 0.3*0.5 + 0.1*1 = 0.55 → score=55.
    expect(res.body.departureReadiness).toMatchObject({
      score: 55,
      components: {
        consentPct: 100, docsPct: 0, paymentPct: 50, roomingPct: 100,
      },
    });
    // Over-roomed is clamped, not allowed to push roomed>count.
    expect(res.body.rooming).toMatchObject({
      participantsRoomed: 4, participantsUnroomed: 0,
    });
  });

  test('USER role rejected with 403 (ops-dashboard is ADMIN+MANAGER only)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/100/ops-dashboard')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant ops-dashboard returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/9999/ops-dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('tolerates malformed rooming participantIds JSON (counts as 0 for that row)', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'x', destination: 'D', departDate: new Date(),
      returnDate: new Date(), status: 'confirmed', legalEntity: 'tmc_nexus', pricePerStudent: null,
    });
    prisma.tripParticipant.findMany.mockResolvedValue([
      { id: 1, consentCapturedAt: null },
    ]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { amount: 100, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripDocumentRequirement.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { participantIds: 'NOT_JSON' }, // malformed
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/ops-dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.rooming).toMatchObject({
      assignmentCount: 1, participantsRoomed: 0, participantsUnroomed: 1,
    });
  });

  test('zero doc requirements → docsPct=0 (not penalised, but shows 0%)', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'x', destination: 'D', departDate: new Date(),
      returnDate: new Date(), status: 'confirmed', legalEntity: 'tmc_nexus',
      pricePerStudent: 50000,
    });
    // 1 participant, all consent → consentPct=100
    prisma.tripParticipant.findMany.mockResolvedValue([
      { id: 1, consentCapturedAt: new Date() },
    ]);
    // 50k expected, 50k received → paymentPct=100
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { amount: 50000, paidAmount: 50000, status: 'paid' },
    ]);
    // Zero doc requirements
    prisma.tripDocumentRequirement.findMany.mockResolvedValue([]);
    // 1 participant roomed → roomingPct=100
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { participantIds: JSON.stringify([1]) },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/ops-dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Weighted: 0.3*1 + 0.3*0 + 0.3*1 + 0.1*1 = 0.3 + 0 + 0.3 + 0.1 = 0.7 → score=70
    expect(res.body.departureReadiness).toMatchObject({
      score: 70,
      components: {
        consentPct: 100, docsPct: 0, paymentPct: 100, roomingPct: 100,
      },
    });
  });
});

// -----------------------------------------------------------------------------
// Participant CRUD
// -----------------------------------------------------------------------------

describe('Participants', () => {
  test('GET participants returns list scoped to trip', async () => {
    prisma.tripParticipant.findMany.mockResolvedValue([
      { id: 1, tripId: 100, fullName: 'Alice Sharma' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/participants')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ participants: expect.any(Array) });
    expect(prisma.tripParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tripId: 100 } }),
    );
  });

  test('POST participant returns 201 + persisted row', async () => {
    prisma.tripParticipant.create.mockResolvedValue({
      id: 50, tripId: 100, fullName: 'Bob Patel', aadhaarLast4: '1234',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ fullName: 'Bob Patel', aadhaarLast4: '1234' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 50, fullName: 'Bob Patel' });
    expect(prisma.tripParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 100, fullName: 'Bob Patel', aadhaarLast4: '1234',
        }),
      }),
    );
  });

  test('POST participant without fullName returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ parentName: 'Mom' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tripParticipant.create).not.toHaveBeenCalled();
  });

  test('POST participant with non-4-digit aadhaarLast4 returns 400 INVALID_AADHAAR_LAST4', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ fullName: 'Bob', aadhaarLast4: '123456789012' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AADHAAR_LAST4' });
    expect(prisma.tripParticipant.create).not.toHaveBeenCalled();
  });

  test('PATCH participant happy partial-update returns 200', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.tripParticipant.update.mockResolvedValue({
      id: 50, tripId: 100, parentPhone: '+919876543210',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/participants/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ parentPhone: '+919876543210' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 50, parentPhone: '+919876543210' });
  });

  test('PATCH participant with bare 10-digit Indian mobile auto-prepends +91', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.tripParticipant.update.mockResolvedValue({
      id: 50, tripId: 100, parentPhone: '+919876543210',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/participants/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ parentPhone: '9876543210' });
    expect(res.status).toBe(200);
    expect(prisma.tripParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentPhone: '+919876543210' }),
      }),
    );
  });

  test('PATCH participant with non-numeric parentPhone returns 400 INVALID_PHONE', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/participants/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ parentPhone: 'abcde-not-a-phone' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PHONE' });
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('PATCH participant with empty body returns 400 EMPTY_BODY', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/participants/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('PATCH participant cross-trip returns 404 PARTICIPANT_NOT_FOUND', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/participants/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ parentPhone: '+919876543210' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PARTICIPANT_NOT_FOUND' });
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('DELETE participant returns 200 + { deleted: true, id }', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.tripParticipant.delete.mockResolvedValue({ id: 50 });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/participants/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 50 });
  });

  test('DELETE participant cross-trip returns 404 PARTICIPANT_NOT_FOUND', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/participants/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PARTICIPANT_NOT_FOUND' });
    expect(prisma.tripParticipant.delete).not.toHaveBeenCalled();
  });

  test('POST reject requires a non-empty reason', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, applicationStatus: 'pending' });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reviewNotes: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'REJECTION_REASON_REQUIRED' });
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('POST reject persists the required reason in reviewNotes', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, applicationStatus: 'pending' });
    prisma.tripParticipant.update.mockResolvedValue({
      id: 50, applicationStatus: 'rejected', reviewNotes: 'Missing consent form',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reviewNotes: 'Missing consent form' });
    expect(res.status).toBe(200);
    expect(prisma.tripParticipant.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({
        applicationStatus: 'rejected',
        reviewNotes: 'Missing consent form',
      }),
    });
  });
});

// -----------------------------------------------------------------------------
// DigiLocker (stub-mode)
// -----------------------------------------------------------------------------

describe('DigiLocker', () => {
  test('POST /initiate requires redirectUri (400 MISSING_FIELDS)', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/digilocker/initiate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('POST /initiate happy path returns sessionId + oauthUrl + state', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    digilockerInitiateSpy.mockResolvedValue({
      state: 'deadbeef',
      oauthUrl: 'https://digilocker-stub.invalid/oauth/authorize?state=deadbeef',
    });
    prisma.digilockerSession.create.mockResolvedValue({
      id: 77, state: 'deadbeef',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/digilocker/initiate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ redirectUri: 'https://crm.example/callback' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'deadbeef',
      sessionId: 77,
      oauthUrl: expect.stringContaining('digilocker'),
    });
    // The persisted session row MUST be tenant-scoped to prevent the
    // cross-tenant state-replay class — pin it.
    expect(prisma.digilockerSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1, participantId: 50, state: 'deadbeef', status: 'initiated',
        }),
      }),
    );
  });

  test('POST /callback with unknown state returns 404 SESSION_NOT_FOUND', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.digilockerSession.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/digilocker/callback')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ state: 'unknown', code: 'auth-code' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  test('POST /callback replay (already verified) returns 409 INVALID_STATE', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.digilockerSession.findFirst.mockResolvedValue({
      id: 77, state: 'deadbeef', status: 'verified', tenantId: 1, participantId: 50,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/digilocker/callback')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ state: 'deadbeef', code: 'replay' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE' });
  });

  test('POST /callback on expired session returns 410 SESSION_GONE', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.digilockerSession.findFirst.mockResolvedValue({
      id: 77, state: 'deadbeef', status: 'expired', tenantId: 1, participantId: 50,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/digilocker/callback')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ state: 'deadbeef', code: 'x' });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'SESSION_GONE' });
  });

  test('POST /callback happy path writes last4 to participant + NEVER leaks tokenId in response', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 50, tripId: 100 });
    prisma.digilockerSession.findFirst.mockResolvedValue({
      id: 77, state: 'deadbeef', status: 'initiated', tenantId: 1, participantId: 50,
    });
    digilockerExchangeSpy.mockResolvedValue({
      aadhaarLast4: '9999',
      aadhaarTokenId: 'opaque-token-id-NEVER-LEAKED',
    });
    prisma.digilockerSession.update.mockResolvedValue({});
    prisma.tripParticipant.update.mockResolvedValue({});
    const res = await request(makeApp())
      .post('/api/travel/trips/100/participants/50/digilocker/callback')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ state: 'deadbeef', code: 'authcode' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, aadhaarLast4: '9999' });
    // Token MUST NOT appear in the response body — PII guard.
    expect(JSON.stringify(res.body)).not.toContain('opaque-token-id-NEVER-LEAKED');
  });
});

// -----------------------------------------------------------------------------
// Document requirements
// -----------------------------------------------------------------------------

describe('Document requirements', () => {
  test('GET documents returns list scoped to trip', async () => {
    prisma.tripDocumentRequirement.findMany.mockResolvedValue([
      { id: 1, tripId: 100, docType: 'passport', required: true },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/documents')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ documents: expect.any(Array) });
    expect(prisma.tripDocumentRequirement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tripId: 100 } }),
    );
  });

  test('POST document without docType returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/documents')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ required: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tripDocumentRequirement.create).not.toHaveBeenCalled();
  });

  test('POST document defaults required to true (required:false is honoured)', async () => {
    prisma.tripDocumentRequirement.create.mockResolvedValue({
      id: 9, tripId: 100, docType: 'aadhaar', required: false,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/documents')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ docType: 'aadhaar', required: false });
    expect(res.status).toBe(201);
    expect(prisma.tripDocumentRequirement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 100, docType: 'aadhaar', required: false,
        }),
      }),
    );
  });

  test('DELETE document cross-trip returns 404 DOC_NOT_FOUND', async () => {
    prisma.tripDocumentRequirement.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/documents/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DOC_NOT_FOUND' });
    expect(prisma.tripDocumentRequirement.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Auth gate + vertical guard
// -----------------------------------------------------------------------------

describe('auth + vertical guard', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/trips');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('non-travel-vertical tenant returns 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/trips')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Trip-owned LandingPage lifecycle (Phase 2 hybrid architecture)
//   GET    /trips/:id/landing-page  → 200 page | 404 NOT_LINKED
//   POST   /trips/:id/landing-page  → 200 existing (idempotent) | 201 lazy-created
//   DELETE /trips/:id/landing-page  → unlinks; row survives as generic page
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:id/landing-page', () => {
  test('returns linked landing page when one exists', async () => {
    const existingPage = {
      id: 55,
      title: 'Bali Trip — bali2026',
      slug: 'trip-bali2026',
      status: 'DRAFT',
      templateType: 'wanderlux-v1',
      tripId: 100,
      tenantId: 1,
    };
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100,
      tripCode: 'bali2026',
      destination: 'Bali',
      departDate: new Date('2026-09-15'),
      returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus',
      landingPage: existingPage,
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 55, slug: 'trip-bali2026', tripId: 100 });
  });

  test('returns 404 NOT_LINKED when no landing page is linked', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: null,
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_LINKED' });
  });

  test('cross-tenant trip returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/abc/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });
});

describe('POST /api/travel/trips/:id/landing-page', () => {
  test('lazy-creates a Wanderlux DRAFT page when none is linked, returns 201', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali, Indonesia',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: null,
    });
    prisma.landingPage.create.mockResolvedValue({
      id: 77, slug: 'trip-bali2026', status: 'DRAFT', tripId: 100,
      templateType: 'wanderlux-v1', tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 77, slug: 'trip-bali2026', tripId: 100 });
    expect(prisma.landingPage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateType: 'wanderlux-v1',
          status: 'DRAFT',
          subBrand: 'tmc',
          tripId: 100,
          tenantId: 1,
          userId: 7,
          destination: 'Bali, Indonesia',
          slug: 'trip-bali2026',
        }),
      }),
    );
    // Verify content has registration-draft default mode baked in
    const createData = prisma.landingPage.create.mock.calls[0][0].data;
    const config = JSON.parse(createData.content);
    expect(config.register.mode).toBe('registration-draft');
    expect(config.register.steps).toEqual([
      expect.objectContaining({ id: 'student' }),
      expect.objectContaining({ id: 'parent' }),
      expect.objectContaining({ id: 'passport' }),
    ]);
  });

  test('idempotent — returns existing page (200) when already linked, does not create', async () => {
    const existingPage = {
      id: 55, slug: 'trip-bali2026', tripId: 100, status: 'PUBLISHED',
    };
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: existingPage,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 55, status: 'PUBLISHED' });
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('slug-collision (P2002 on tenantId+slug) retries with a fresh suffix', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: null,
    });
    const collision = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002', meta: { target: ['tenantId', 'slug'] },
    });
    prisma.landingPage.create
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({ id: 78, slug: 'trip-bali2026-xy12', tripId: 100, status: 'DRAFT' });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(201);
    expect(prisma.landingPage.create).toHaveBeenCalledTimes(2);
    expect(prisma.landingPage.create.mock.calls[1][0].data.slug).toMatch(/^trip-bali2026-[a-z0-9]{4}$/);
  });

  test('race on tripId @unique (P2002 with tripId target) returns the racing page', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: null,
    });
    const tripIdRace = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002', meta: { target: ['tripId'] },
    });
    prisma.landingPage.create.mockRejectedValueOnce(tripIdRace);
    prisma.landingPage.findUnique.mockResolvedValueOnce({
      id: 79, slug: 'trip-bali2026', tripId: 100, status: 'DRAFT',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 79, tripId: 100 });
    expect(prisma.landingPage.findUnique).toHaveBeenCalledWith({ where: { tripId: 100 } });
  });

  test('cross-tenant trip returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/trips/:id/landing-page', () => {
  test('unlinks the page (sets tripId=null), row survives', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: { id: 55, slug: 'trip-bali2026', tripId: 100 },
    });
    prisma.landingPage.update.mockResolvedValue({ id: 55, slug: 'trip-bali2026', tripId: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unlinked: true, id: 55 });
    expect(prisma.landingPage.update).toHaveBeenCalledWith({
      where: { id: 55 },
      data: { tripId: null },
    });
  });

  test('returns 404 NOT_LINKED when no page is linked', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100, tripCode: 'bali2026', destination: 'Bali',
      departDate: new Date('2026-09-15'), returnDate: new Date('2026-09-22'),
      legalEntity: 'tmc_nexus', landingPage: null,
    });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_LINKED' });
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('USER role lacking trips:update permission returns 403', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });

  test('cross-tenant trip returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/landing-page')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

// -----------------------------------------------------------------------------
// Pending registrations (Phase 5 hybrid architecture)
//   GET  /trips/:id/registrations            — list (with ?status filter)
//   POST /trips/:id/registrations/:rid/approve — transactional conversion
//   POST /trips/:id/registrations/:rid/reject  — soft reject
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:id/registrations', () => {
  test('returns drafts scoped to (tripId, tenantId), most recent first', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findMany.mockResolvedValue([
      { id: 9001, status: 'OTP_VERIFIED', studentName: 'Aarav', createdAt: new Date('2026-05-10') },
      { id: 9002, status: 'DRAFT', studentName: 'Priya', createdAt: new Date('2026-05-08') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/registrations')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.pendingTripRegistration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tripId: 100, tenantId: 1 },
        orderBy: { createdAt: 'desc' },
      }),
    );
    // draftToken + draftTokenExpiresAt MUST NOT be in the select shape
    const args = prisma.pendingTripRegistration.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select.draftToken).toBeUndefined();
    expect(args.select.draftTokenExpiresAt).toBeUndefined();
  });

  test('?status=OTP_VERIFIED filters down to single status', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/trips/100/registrations?status=OTP_VERIFIED')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.pendingTripRegistration.findMany.mock.calls[0][0].where;
    expect(calledWhere).toMatchObject({ tripId: 100, tenantId: 1, status: 'OTP_VERIFIED' });
  });

  test('?status=DRAFT,OTP_VERIFIED (comma-separated multi-select) becomes {in: [...]}', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/trips/100/registrations?status=DRAFT,OTP_VERIFIED')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.pendingTripRegistration.findMany.mock.calls[0][0].where;
    expect(calledWhere.status).toEqual({ in: ['DRAFT', 'OTP_VERIFIED'] });
  });

  test('?status=bogus returns 400 INVALID_STATUS', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/registrations?status=NOT_A_STATUS')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.pendingTripRegistration.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant trip returns 404 NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/registrations')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('POST /api/travel/trips/:id/registrations/:rid/approve', () => {
  test('OTP_VERIFIED draft converts: creates TripParticipant{applicationStatus="approved"} + draft → CONVERTED, transactionally', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue({
      id: 9001, tripId: 100, tenantId: 1, status: 'OTP_VERIFIED',
      studentName: 'Aarav Iyer', parentName: 'Rohan Iyer',
      parentEmail: 'rohan@example.com', parentPhone: '+919876543210',
      passportNumber: 'M1234567', passportExpiry: new Date('2031-09-01'),
      otpVerifiedAt: new Date(),
    });
    prisma.tripParticipant.create.mockResolvedValue({
      id: 4242, tripId: 100, fullName: 'Aarav Iyer',
      applicationStatus: 'approved',
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({
      id: 9001, status: 'CONVERTED', convertedToParticipantId: 4242,
    });

    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9001/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reviewNotes: 'Looks good — approved.' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      approved: true,
      participant: { id: 4242, applicationStatus: 'approved' },
      registration: { id: 9001, status: 'CONVERTED', convertedToParticipantId: 4242 },
    });

    // Participant created with approved status + reviewer + draft data
    expect(prisma.tripParticipant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tripId: 100,
        fullName: 'Aarav Iyer',
        parentName: 'Rohan Iyer',
        parentEmail: 'rohan@example.com',
        parentPhone: '+919876543210',
        passportNumber: 'M1234567',
        applicationStatus: 'approved',
        reviewedById: 7,
        reviewNotes: 'Looks good — approved.',
        consentCapturedAt: expect.any(Date),
      }),
    });
    // Draft updated to CONVERTED + pointer back to participant
    expect(prisma.pendingTripRegistration.update).toHaveBeenCalledWith({
      where: { id: 9001 },
      data: expect.objectContaining({
        status: 'CONVERTED',
        convertedToParticipantId: 4242,
        approvedById: 7,
      }),
    });
    // Both writes went through $transaction (participant) +
    // sequential update for the back-reference. The participant create
    // happens inside $transaction; verify it was invoked.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('DRAFT (no OTP yet) can be approved — OTP gate relaxed for operator approvals', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue({
      id: 9001, tripId: 100, tenantId: 1, status: 'DRAFT',
      studentName: 'Sara No-Otp', parentName: 'Meera No-Otp',
      parentEmail: 'meera@example.com', parentPhone: '+919876543210',
    });
    prisma.tripParticipant.create.mockResolvedValue({
      id: 4243, tripId: 100, fullName: 'Sara No-Otp',
      applicationStatus: 'approved',
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({
      id: 9001, status: 'CONVERTED', convertedToParticipantId: 4243,
    });

    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9001/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      approved: true,
      participant: { id: 4243, applicationStatus: 'approved' },
      registration: { id: 9001, status: 'CONVERTED', convertedToParticipantId: 4243 },
    });
    expect(prisma.tripParticipant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tripId: 100,
        fullName: 'Sara No-Otp',
        applicationStatus: 'approved',
      }),
    });
    expect(prisma.pendingTripRegistration.update).toHaveBeenCalledWith({
      where: { id: 9001 },
      data: expect.objectContaining({ status: 'CONVERTED', convertedToParticipantId: 4243 }),
    });
  });

  test('CONVERTED draft cannot be re-approved → 409 INVALID_STATE', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue({
      id: 9001, tripId: 100, tenantId: 1, status: 'CONVERTED',
      convertedToParticipantId: 4242,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9001/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE', currentStatus: 'CONVERTED' });
    expect(prisma.tripParticipant.create).not.toHaveBeenCalled();
  });

  test('cross-trip registration id returns 404 REGISTRATION_NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9999/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'REGISTRATION_NOT_FOUND' });
  });

  test('non-numeric rid returns 400 INVALID_REGISTRATION_ID', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/notanumber/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_REGISTRATION_ID' });
  });
});

describe('POST /api/travel/trips/:id/registrations/:rid/reject', () => {
  test('marks draft as REJECTED with reviewer + notes; does NOT create participant', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue({
      id: 9001, tripId: 100, tenantId: 1, status: 'OTP_VERIFIED',
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({
      id: 9001, status: 'REJECTED',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9001/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reviewNotes: 'Trip is full' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rejected: true, registration: { id: 9001, status: 'REJECTED' } });
    expect(prisma.pendingTripRegistration.update).toHaveBeenCalledWith({
      where: { id: 9001 },
      data: expect.objectContaining({
        status: 'REJECTED',
        rejectedById: 7,
        reviewNotes: 'Trip is full',
        rejectedAt: expect.any(Date),
      }),
    });
    expect(prisma.tripParticipant.create).not.toHaveBeenCalled();
  });

  test('reject from DRAFT state still requires a reason', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue({
      id: 9002, tripId: 100, tenantId: 1, status: 'DRAFT',
    });
    prisma.pendingTripRegistration.update.mockResolvedValue({ id: 9002, status: 'REJECTED' });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9002/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'REJECTION_REASON_REQUIRED' });
    expect(prisma.pendingTripRegistration.update).not.toHaveBeenCalled();
  });

  test('CONVERTED draft cannot be rejected → 409 INVALID_STATE', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue({
      id: 9003, tripId: 100, tenantId: 1, status: 'CONVERTED', convertedToParticipantId: 4242,
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9003/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE', currentStatus: 'CONVERTED' });
    expect(prisma.pendingTripRegistration.update).not.toHaveBeenCalled();
  });

  test('cross-trip registration id returns 404 REGISTRATION_NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 100 });
    prisma.pendingTripRegistration.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/trips/100/registrations/9999/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'REGISTRATION_NOT_FOUND' });
  });
});
