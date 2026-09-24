// @ts-check
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

vi.hoisted(() => {
  const { createRequire } = require('node:module');
  const hoistedRequire = createRequire(__filename || process.cwd() + '/');

  const auth = hoistedRequire('../../middleware/auth');
  auth.verifyToken = (req, res, next) => {
    if (req.headers['x-test-staff-auth'] !== 'yes') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = { userId: 9, tenantId: 7, role: 'USER' };
    next();
  };

  const travelGuards = hoistedRequire('../../middleware/travelGuards');
  travelGuards.requireTravelTenant = (req, _res, next) => {
    req.travelTenant = { id: req.user.tenantId, vertical: 'travel' };
    next();
  };

  const permissions = hoistedRequire('../../middleware/requirePermission');
  permissions.requireAnyPermission = () => (req, res, next) => {
    if (req.headers['x-test-permission'] !== 'trips.update') {
      return res.status(403).json({ error: 'Forbidden', code: 'PERMISSION_DENIED' });
    }
    next();
  };
});

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn(), findMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.tripParticipant = { ...(prisma.tripParticipant || {}), findMany: vi.fn() };
prisma.pendingTripRegistration = { ...(prisma.pendingTripRegistration || {}), findMany: vi.fn() };
prisma.tmcParentTrip = { ...(prisma.tmcParentTrip || {}), findMany: vi.fn() };
prisma.visaApplication = { ...(prisma.visaApplication || {}), findMany: vi.fn() };
prisma.visaLetterDocument = { ...(prisma.visaLetterDocument || {}), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() };
prisma.visaLetterGeneration = { ...(prisma.visaLetterGeneration || {}), update: vi.fn() };
prisma.user = { ...(prisma.user || {}), findMany: vi.fn() };

const { JWT_SECRET } = requireCJS('../../config/secrets');
const visaLetterStore = requireCJS('../../lib/visaLetterStore');
const audit = requireCJS('../../lib/audit');
const notificationService = requireCJS('../../lib/notificationService');
const originalVisaLetterStore = {
  readLetterBuffer: visaLetterStore.readLetterBuffer,
  storeLetterPdf: visaLetterStore.storeLetterPdf,
  removeLetter: visaLetterStore.removeLetter,
};
audit.writeAudit = vi.fn().mockResolvedValue(undefined);
notificationService.notifyMany = vi.fn().mockResolvedValue(undefined);
const router = requireCJS('../../routes/tmc_portal');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/tmc', router);
  return app;
}

function portalToken(overrides = {}) {
  return jwt.sign({
    type: 'PORTAL',
    contactId: 41,
    tenantId: 7,
    ...overrides,
  }, JWT_SECRET, { expiresIn: '10m' });
}

function bearer(token = portalToken()) {
  return { Authorization: `Bearer ${token}` };
}

function contact(persona, overrides = {}) {
  return {
    id: 41,
    name: `${persona} Contact`,
    email: `${persona.toLowerCase()}@example.test`,
    phone: null,
    subBrand: 'tmc',
    portalRole: persona,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 7, vertical: 'travel', slug: 'tmc' });
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findFirst.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.pendingTripRegistration.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcParentTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.findMany.mockReset().mockResolvedValue([]);
  prisma.visaLetterDocument.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaLetterDocument.update.mockReset();
  prisma.visaLetterDocument.findMany.mockReset().mockResolvedValue([]);
  prisma.visaLetterGeneration.update.mockReset().mockResolvedValue({});
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  visaLetterStore.readLetterBuffer = vi.fn().mockResolvedValue(Buffer.from('%PDF-parent-letter'));
  visaLetterStore.storeLetterPdf = vi.fn().mockResolvedValue({
    url: '/api/uploads/visa-letters/signed.pdf',
    key: 'signed.pdf',
    storage: 'disk',
  });
  visaLetterStore.removeLetter = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  visaLetterStore.readLetterBuffer = originalVisaLetterStore.readLetterBuffer;
  visaLetterStore.storeLetterPdf = originalVisaLetterStore.storeLetterPdf;
  visaLetterStore.removeLetter = originalVisaLetterStore.removeLetter;
});

describe('TMC portal authentication and tenant isolation', () => {
  test('teacher routes reject missing portal JWTs before querying tenant data', async () => {
    const res = await request(makeApp()).get('/api/portal/tmc/teacher/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PORTAL_TOKEN_REQUIRED');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('teacher identity lookup requires both contact id and token tenant id', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/me')
      .set(bearer());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PORTAL_CONTACT_NOT_FOUND');
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 41, tenantId: 7, deletedAt: null },
    }));
  });

  test('teacher trip listing is scoped to the authenticated tenant and teacher', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('TEACHER'));
    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/trips')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, teacherContactId: 41 },
    }));
  });
});

describe('TMC parent trip isolation', () => {
  test('an existing parent sees new trips assigned to a linked teacher, but not other teachers\' trips', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('PARENT'));
    prisma.tmcParentTrip.findMany.mockResolvedValue([
      { id: 1, tripId: 501, createdAt: new Date(), teacher: { id: 70 }, trip: { id: 501, landingPage: null } },
    ]);
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 501, tripCode: 'TMC-501', landingPage: null },
      { id: 502, tripCode: 'TMC-502', landingPage: null },
    ]);

    const res = await request(makeApp())
      .get('/api/portal/tmc/parent/trips')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body.trips.map((trip) => trip.id)).toEqual([501, 502]);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 7,
        status: { not: 'cancelled' },
        OR: [
          { id: { in: [501] } },
          { teacherContactId: { in: [70] } },
        ],
      },
    }));
  });

  test('parent visa-letter listing is limited to linked trips and sent letters', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('PARENT'));
    prisma.tmcParentTrip.findMany.mockResolvedValue([{ tripId: 501 }]);
    prisma.visaApplication.findMany.mockResolvedValue([{
      id: 901,
      applicationType: 'student',
      destinationCountry: 'Vietnam',
      status: 'intake',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      trip: { id: 501, tripCode: 'VIET-2026', destination: 'Vietnam', departDate: new Date(), returnDate: new Date() },
      participant: { id: 701, fullName: 'Rishav Kapoor' },
      visaLetterDocuments: [{
        id: 3001,
        generationId: 2001,
        documentType: 'Cover Letter',
        status: 'SENT',
        generatedFileName: 'cover-letter.pdf',
      }],
    }]);

    const res = await request(makeApp())
      .get('/api/portal/tmc/parent/visa-letters')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body.applications[0]).toMatchObject({
      id: 901,
      destinationCountry: 'Vietnam',
      participant: { fullName: 'Rishav Kapoor' },
      visaLetters: [{ id: 3001, status: 'SENT' }],
    });
    expect(prisma.visaApplication.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 7,
        tripId: { in: [501] },
        visaLetterDocuments: {
          some: { tenantId: 7, status: { in: ['SENT', 'SIGNED_UPLOADED'] } },
        },
      },
    }));
  });

  test('parent can download and upload a sent letter only for an accessible trip', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('PARENT'));
    prisma.tmcParentTrip.findMany.mockResolvedValue([{ tripId: 501 }]);
    const document = {
      id: 3001,
      generationId: 2001,
      visaApplicationId: 901,
      participantId: 701,
      documentType: 'Cover Letter',
      status: 'SENT',
      generatedFileStorage: 'disk',
      generatedFileKey: 'generated.pdf',
      generatedFileName: 'cover-letter.pdf',
      signedFileKey: null,
      signedFileStorage: null,
    };
    prisma.visaLetterDocument.findFirst.mockResolvedValue(document);
    prisma.visaLetterDocument.update.mockResolvedValue({
      ...document,
      status: 'SIGNED_UPLOADED',
      signedFileName: 'signed-cover-letter.pdf',
      signedUploadedAt: new Date('2026-09-02T00:00:00Z'),
    });
    prisma.visaLetterDocument.findMany.mockResolvedValue([
      { status: 'SIGNED_UPLOADED' },
      { status: 'SENT' },
    ]);

    const download = await request(makeApp())
      .get('/api/portal/tmc/parent/visa-letters/3001/generated?download=1')
      .set(bearer());
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/application\/pdf/);
    expect(download.headers['content-disposition']).toMatch(/attachment/);
    expect(download.body.toString()).toBe('%PDF-parent-letter');

    const upload = await request(makeApp())
      .post('/api/portal/tmc/parent/visa-letters/3001/signed-upload')
      .set(bearer())
      .attach('file', Buffer.from('%PDF-signed'), {
        filename: 'signed-cover-letter.pdf',
        contentType: 'application/pdf',
      });
    expect(upload.status).toBe(201);
    expect(upload.body.letter).toMatchObject({ id: 3001, status: 'SIGNED_UPLOADED' });
    expect(visaLetterStore.storeLetterPdf).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({
      applicationId: 901,
      participantId: 701,
      kind: 'signed',
    }));
    expect(prisma.visaLetterDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 7, tripId: { in: [501] } }),
    }));
  });
});

describe('TMC staff permission enforcement', () => {
  test('staff teacher directory rejects authenticated users without an allowed permission', async () => {
    const res = await request(makeApp())
      .get('/api/portal/tmc/staff/teachers')
      .set('x-test-staff-auth', 'yes');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('authorized staff query remains tenant scoped', async () => {
    const res = await request(makeApp())
      .get('/api/portal/tmc/staff/teachers')
      .set('x-test-staff-auth', 'yes')
      .set('x-test-permission', 'trips.update');
    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, subBrand: 'tmc', portalRole: 'TEACHER', deletedAt: null },
    }));
  });
});
