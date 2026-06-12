// @ts-check
/**
 * backend/routes/travel_passport.js — slice C2 contract pin.
 *
 * What's pinned
 * -------------
 *   - POST /participants/:id/passport-upload         all-roles + TMC
 *                                                    happy path: returns 201
 *                                                    + extraction envelope + image URL
 *                                                    + persists extractedAt
 *                                                    NO_FILE on missing 'file' field
 *                                                    503 PASSPORT_OCR_NOT_YET_ENABLED
 *                                                    falls through to image-preserved error
 *                                                    cross-tenant 404 PARTICIPANT_NOT_FOUND
 *
 *   - GET  /verification-queue                       ADMIN+MANAGER only — RBAC_DENIED for USER
 *                                                    returns rows where extractedAt NOT NULL
 *                                                    AND verifiedAt NULL, tenant-scoped
 *
 *   - POST /participants/:id/passport-verify         ADMIN+MANAGER only — RBAC_DENIED for USER
 *                                                    approved=true: copies extraction (+ edits)
 *                                                    into canonical cols + sets verifiedAt/ById
 *                                                    approved=false: sets rejectedAt
 *                                                    409 NO_EXTRACTION when extractedAt null
 *                                                    409 ALREADY_VERIFIED when verifiedAt set
 *                                                    400 MISSING_FIELDS when approved missing
 *
 *   - DELETE /participants/:id/passport-extraction   ADMIN+MANAGER only — clears columns
 *
 * Pinned guards (in order):
 *   verifyToken → [verifyRole?] → requireTravelTenant → requireTmcAccess → handler
 *
 * Test pattern mirrors backend/test/routes/travel-trips.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * drive supertest with real HS256 JWTs signed with the dev fallback
 * secret. The OCR client is the stub-mode service; we spy on
 * extractPassport to control its output per test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tripParticipant = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};
// CustomerTraveller — the unified portal passport store the queue also reads.
prisma.customerTraveller = {
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

// Stub the audit lib so writeAudit doesn't try to hit the DB. The route
// wraps every writeAudit in .catch(() => {}), so even a thrown promise
// won't break the response; mocking keeps the test output clean.
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(() => Promise.resolve()),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Load the OCR client BEFORE the router so the route's CJS require()
// resolves to our spy-able instance.
const passportOcrClient = requireCJS('../../services/passportOcrClient');
const s3Service = requireCJS('../../services/s3Service');
const passportRouter = requireCJS('../../routes/travel_passport');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/passport', passportRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const SAMPLE_EXTRACTION = {
  passportNumber: 'M1234567',
  surname: 'DOE',
  givenNames: 'JOHN',
  dateOfBirth: '1990-01-15',
  sex: 'M',
  nationality: 'IND',
  placeOfBirth: 'MUMBAI',
  placeOfIssue: 'DELHI',
  dateOfIssue: '2020-05-10',
  dateOfExpiry: '2030-05-09',
  mrz: 'P<INDDOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\nM12345674IND9001154M3005099<<<<<<<<<<<<<<<06',
};

let extractSpy;

beforeEach(() => {
  prisma.tripParticipant.findFirst.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.tripParticipant.update.mockReset();
  prisma.customerTraveller.findFirst.mockReset();
  prisma.customerTraveller.findMany.mockReset().mockResolvedValue([]);
  prisma.customerTraveller.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);

  // Default the OCR stub to succeed; individual tests can override.
  extractSpy = vi.spyOn(passportOcrClient, 'extractPassport').mockResolvedValue({
    extraction: SAMPLE_EXTRACTION,
    confidence: 0.95,
    provider: 'stub-mode-v1',
    extractedAt: '2026-06-09T10:00:00.000Z',
  });
  // Stub S3 so "Clear" deletion never touches the live bucket.
  vi.spyOn(s3Service, 'deleteFile').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// POST /participants/:id/passport-upload
// -----------------------------------------------------------------------------

describe('POST /api/travel/passport/participants/:id/passport-upload', () => {
  const baseParticipant = {
    id: 55,
    fullName: 'Jane Doe',
    trip: { id: 100, tenantId: 1, tripCode: 'bali2026', destination: 'Bali' },
  };

  test('happy path: returns 201 with extraction envelope + persists extractedAt', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(baseParticipant);
    prisma.tripParticipant.update.mockResolvedValue({
      ...baseParticipant,
      passportExtractionJson: '{}',
      passportExtractedAt: new Date('2026-06-09T10:00:00.000Z'),
    });

    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-upload')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .attach('file', Buffer.from('synthetic-jpeg-bytes'), {
        filename: 'jane-doe-passport.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      participantId: 55,
      extraction: SAMPLE_EXTRACTION,
      confidence: 0.95,
      provider: 'stub-mode-v1',
    });
    expect(typeof res.body.imageUrl).toBe('string');
    expect(res.body.imageUrl).toMatch(/^\/api\/uploads\/passport-ocr\//);
    // extractedAt was persisted (route updates the row with new Date()).
    expect(prisma.tripParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: expect.objectContaining({
          passportExtractedAt: expect.any(Date),
          passportRejectedAt: null,
        }),
      }),
    );
    // Spy fired with the tenant scope + filename hints.
    expect(extractSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 1,
        fileName: 'jane-doe-passport.jpg',
      }),
    );
  });

  test('returns 400 NO_FILE when no file is attached', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(baseParticipant);
    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-upload')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_FILE' });
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('returns 503 PASSPORT_OCR_NOT_YET_ENABLED when OCR client throws cred-blocked error', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(baseParticipant);
    extractSpy.mockImplementation(() => {
      const e = new Error('Passport OCR vendor not yet enabled');
      e.code = 'PASSPORT_OCR_NOT_YET_ENABLED';
      throw e;
    });

    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-upload')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .attach('file', Buffer.from('synthetic-jpeg-bytes'), {
        filename: 'jane-doe-passport.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'PASSPORT_OCR_NOT_YET_ENABLED',
      participantId: 55,
    });
    // No DB update should have run when the cred-blocked path triggered.
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('cross-tenant returns 404 PARTICIPANT_NOT_FOUND', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/passport/participants/99999/passport-upload')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .attach('file', Buffer.from('bytes'), {
        filename: 'p.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PARTICIPANT_NOT_FOUND' });
  });
});

// -----------------------------------------------------------------------------
// GET /verification-queue
// -----------------------------------------------------------------------------

describe('GET /api/travel/passport/verification-queue', () => {
  test('USER role gets 403 RBAC_DENIED (queue is ADMIN+MANAGER only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/passport/verification-queue')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tripParticipant.findMany).not.toHaveBeenCalled();
  });

  test('returns pending list shaped per the queue contract', async () => {
    prisma.tripParticipant.findMany.mockResolvedValue([
      {
        id: 55,
        fullName: 'Jane Doe',
        passportExtractedAt: new Date('2026-06-09T10:00:00.000Z'),
        passportRejectedAt: null,
        passportExtractionJson: JSON.stringify({
          extraction: SAMPLE_EXTRACTION,
          confidence: 0.95,
          provider: 'stub-mode-v1',
          imageUrl: '/uploads/passport-ocr/abc.jpg',
        }),
        trip: { id: 100, tripCode: 'bali2026', destination: 'Bali' },
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/passport/verification-queue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0]).toMatchObject({
      participantId: 55,
      fullName: 'Jane Doe',
      extraction: SAMPLE_EXTRACTION,
      confidence: 0.95,
      provider: 'stub-mode-v1',
      imageUrl: '/uploads/passport-ocr/abc.jpg',
      trip: { id: 100, tripCode: 'bali2026', destination: 'Bali' },
    });

    // Pin the where clause — pending = extractedAt NOT NULL AND verifiedAt NULL,
    // tenant-scoped via trip.tenantId.
    expect(prisma.tripParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          passportExtractedAt: { not: null },
          passportVerifiedAt: null,
          trip: { tenantId: 1 },
        },
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// POST /participants/:id/passport-verify
// -----------------------------------------------------------------------------

describe('POST /api/travel/passport/participants/:id/passport-verify', () => {
  const extractedParticipant = {
    id: 55,
    fullName: 'Jane Doe',
    passportExtractedAt: new Date('2026-06-09T10:00:00.000Z'),
    passportVerifiedAt: null,
    passportRejectedAt: null,
    passportExtractionJson: JSON.stringify({
      extraction: SAMPLE_EXTRACTION,
      confidence: 0.95,
      provider: 'stub-mode-v1',
    }),
    trip: { id: 100, tenantId: 1, tripCode: 'bali2026', destination: 'Bali' },
  };

  test('USER role gets 403 RBAC_DENIED (verify is ADMIN+MANAGER only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.tripParticipant.findFirst.mockResolvedValue(extractedParticipant);
    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ approved: true });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tripParticipant.update).not.toHaveBeenCalled();
  });

  test('approved=true: copies extraction + manual edits into canonical cols', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(extractedParticipant);
    prisma.tripParticipant.update.mockResolvedValue({
      id: 55,
      passportVerifiedAt: new Date('2026-06-09T11:00:00.000Z'),
      passportVerifiedById: 7,
    });

    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        approved: true,
        editedFields: { passportNumber: 'M9999999' }, // operator hand-corrected
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      participantId: 55,
      approved: true,
    });

    // Update call: edited passportNumber wins; expiry falls through from
    // extraction. verifiedById = 7 (the ADMIN's userId from the JWT).
    expect(prisma.tripParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: expect.objectContaining({
          passportNumber: 'M9999999',
          passportExpiry: expect.any(Date),
          passportVerifiedAt: expect.any(Date),
          passportVerifiedById: 7,
          passportRejectedAt: null,
        }),
      }),
    );
  });

  test('approved=false: sets passportRejectedAt and does NOT copy fields', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(extractedParticipant);
    prisma.tripParticipant.update.mockResolvedValue({
      id: 55,
      passportRejectedAt: new Date('2026-06-09T12:00:00.000Z'),
    });

    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: false, reason: 'blurry photo' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      participantId: 55,
      approved: false,
    });
    expect(prisma.tripParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: { passportRejectedAt: expect.any(Date) },
      }),
    );
    // Reject path MUST NOT touch passport number / expiry / verifiedById.
    const updateData = prisma.tripParticipant.update.mock.calls[0][0].data;
    expect(updateData.passportNumber).toBeUndefined();
    expect(updateData.passportVerifiedAt).toBeUndefined();
  });

  test('returns 409 NO_EXTRACTION when extractedAt is null', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({
      ...extractedParticipant,
      passportExtractedAt: null,
    });
    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NO_EXTRACTION' });
  });

  test('returns 409 ALREADY_VERIFIED when verifiedAt is set', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({
      ...extractedParticipant,
      passportVerifiedAt: new Date('2026-06-09T11:00:00.000Z'),
    });
    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_VERIFIED' });
  });

  test('returns 400 MISSING_FIELDS when body.approved is not a boolean', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(extractedParticipant);
    const res = await request(makeApp())
      .post('/api/travel/passport/participants/55/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });
});

// -----------------------------------------------------------------------------
// DELETE /participants/:id/passport-extraction
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/passport/participants/:id/passport-extraction', () => {
  test('clears extraction columns and audits', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({
      id: 55,
      fullName: 'Jane Doe',
      passportExtractedAt: new Date(),
      trip: { id: 100, tenantId: 1 },
    });
    prisma.tripParticipant.update.mockResolvedValue({ id: 55 });
    const res = await request(makeApp())
      .delete('/api/travel/passport/participants/55/passport-extraction')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ participantId: 55, cleared: true });
    expect(prisma.tripParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: {
          passportExtractionJson: null,
          passportExtractedAt: null,
          passportVerifiedAt: null,
          passportVerifiedById: null,
          passportRejectedAt: null,
        },
      }),
    );
  });

  test('USER role gets 403 RBAC_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/passport/participants/55/passport-extraction')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
  });
});

// -----------------------------------------------------------------------------
// Queue union — CustomerTraveller (portal) rows appear alongside TripParticipant
// -----------------------------------------------------------------------------

describe('GET /verification-queue — union with CustomerTraveller', () => {
  test('merges trip + customer rows, each tagged with its kind', async () => {
    prisma.tripParticipant.findMany.mockResolvedValue([
      {
        id: 55, fullName: 'Jane Doe',
        passportExtractedAt: new Date('2026-06-09T10:00:00.000Z'),
        passportRejectedAt: null,
        passportExtractionJson: JSON.stringify({ extraction: SAMPLE_EXTRACTION, confidence: 0.95, provider: 'stub-mode-v1', imageUrl: '/api/uploads/passport-ocr/a.jpg' }),
        trip: { id: 100, tripCode: 'bali2026', destination: 'Bali' },
      },
    ]);
    prisma.customerTraveller.findMany.mockResolvedValue([
      {
        id: 7, fullName: 'Ahmed Khan', subBrand: 'rfu', relationship: 'self',
        passportExtractedAt: new Date('2026-06-10T10:00:00.000Z'),
        passportRejectedAt: null,
        passportExtractionJson: JSON.stringify({ extraction: SAMPLE_EXTRACTION, confidence: 0.9, provider: 'stub-mode-v1', imageUrl: '/api/uploads/passport-ocr/b.jpg' }),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/passport/verification-queue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const trip = res.body.pending.find((r) => r.kind === 'trip');
    const customer = res.body.pending.find((r) => r.kind === 'customer');
    expect(trip).toMatchObject({ id: 55, participantId: 55, subBrand: 'tmc', fullName: 'Jane Doe' });
    expect(customer).toMatchObject({ id: 7, subBrand: 'rfu', relationship: 'self', fullName: 'Ahmed Khan' });
    // Customer rows must be tenant-scoped directly (no trip join).
    expect(prisma.customerTraveller.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { passportExtractedAt: { not: null }, passportVerifiedAt: null, tenantId: 1 },
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// Customer-traveller verify / clear
// -----------------------------------------------------------------------------

describe('POST /customer-travellers/:id/passport-verify', () => {
  test('approve copies extraction into canonical cols + sets verifiedAt', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, passportExtractedAt: new Date(), passportVerifiedAt: null,
      passportExtractionJson: JSON.stringify({ extraction: SAMPLE_EXTRACTION }),
    });
    prisma.customerTraveller.update.mockResolvedValue({ id: 7, passportVerifiedAt: new Date(), passportVerifiedById: 7 });
    const res = await request(makeApp())
      .post('/api/travel/passport/customer-travellers/7/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ travellerId: 7, approved: true });
    const data = prisma.customerTraveller.update.mock.calls[0][0].data;
    expect(data.passportNumber).toBe(SAMPLE_EXTRACTION.passportNumber);
    expect(data.passportVerifiedById).toBe(7);
  });

  test('reject sets rejectedAt', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, passportExtractedAt: new Date(), passportVerifiedAt: null, passportExtractionJson: null,
    });
    prisma.customerTraveller.update.mockResolvedValue({ id: 7, passportRejectedAt: new Date() });
    const res = await request(makeApp())
      .post('/api/travel/passport/customer-travellers/7/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: false, reason: 'blurry_photo' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ travellerId: 7, approved: false });
  });

  test('404 TRAVELLER_NOT_FOUND for a foreign tenant row', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/passport/customer-travellers/9999/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ approved: true });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TRAVELLER_NOT_FOUND' });
  });

  test('USER role gets 403 RBAC_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/passport/customer-travellers/7/passport-verify')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ approved: true });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
  });
});

describe('DELETE /customer-travellers/:id/passport-extraction', () => {
  test('clears extraction columns for a customer traveller', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 7, tenantId: 1 });
    prisma.customerTraveller.update.mockResolvedValue({ id: 7 });
    const res = await request(makeApp())
      .delete('/api/travel/passport/customer-travellers/7/passport-extraction')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ travellerId: 7, cleared: true });
  });

  test('also deletes the stored S3 scan so a re-upload does not orphan it', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({
      id: 7, tenantId: 1,
      passportExtractionJson: JSON.stringify({ storage: 's3', imageKey: 'passport-ocr/OLD.png' }),
    });
    prisma.customerTraveller.update.mockResolvedValue({ id: 7 });
    const res = await request(makeApp())
      .delete('/api/travel/passport/customer-travellers/7/passport-extraction')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(s3Service.deleteFile).toHaveBeenCalledWith('passport-ocr/OLD.png');
  });
});
