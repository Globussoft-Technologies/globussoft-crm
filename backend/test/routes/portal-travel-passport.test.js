// @ts-check
/**
 * backend/routes/portal.js — unified travel customer-portal travellers +
 * passport upload (PRD_PASSPORT_OCR, all 4 sub-brands). Customers register
 * travellers keyed to their Contact (contactId) and upload each passport;
 * uploads feed the same staff verification queue as the TMC flow.
 *
 * What's pinned
 * -------------
 *   - GET  /api/portal/travel/travellers          contactId + tenant scoped,
 *                                                 STATUS timestamps only (no
 *                                                 passportNumber / extraction)
 *   - POST /api/portal/travel/travellers          creates a CustomerTraveller
 *                                                 tagged with the contact's
 *                                                 sub-brand; 400 on missing
 *                                                 name; 429 at the cap
 *   - POST /api/portal/travel/travellers/:id/passport-upload
 *                                                 201 + pending-verification,
 *                                                 NO extraction values echoed,
 *                                                 mimetype-derived extension
 *                                                 (stored-XSS guard),
 *                                                 404 foreign traveller,
 *                                                 409 ALREADY_VERIFIED (incl.
 *                                                 race via updateMany count 0),
 *                                                 503 PASSPORT_OCR_NOT_YET_ENABLED,
 *                                                 413 FILE_TOO_LARGE,
 *                                                 415 UNSUPPORTED_MIME
 *   - All endpoints 401 without a PORTAL-type JWT; 403 for non-travel tenant.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.customerTraveller = prisma.customerTraveller || {};
prisma.customerTraveller.findMany = vi.fn();
prisma.customerTraveller.findFirst = vi.fn();
prisma.customerTraveller.count = vi.fn();
prisma.customerTraveller.create = vi.fn();
prisma.customerTraveller.updateMany = vi.fn();

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Load OCR client + audit BEFORE the router so the route's CJS require()
// resolves to spy-able instances. The audit spy must be installed before the
// router require (portal.js destructures writeAudit at load — CJS self-mock
// seam, CLAUDE.md cron-learning 2026-05-24).
const passportOcrClient = requireCJS('../../services/passportOcrClient');
const auditLib = requireCJS('../../lib/audit');
const writeAudit = vi.spyOn(auditLib, 'writeAudit').mockResolvedValue(undefined);
// s3Service must be stubbed so tests never touch a real bucket. Patch the
// module object (createRequire bypasses vi.mock). Force BUCKET_NAME truthy
// here: passportFileStore.storeScan reads `s3Service.BUCKET_NAME` at call
// time to choose S3 vs disk fallback. Locally dev's .env sets it, but CI's
// unit_tests gate has no AWS_S3_BUCKET_NAME, so without this override the
// route silently takes the disk path and the spies on uploadFile/deleteFile
// never fire (CLAUDE.md "CI env-block parity" standing rule).
const s3Service = requireCJS('../../services/s3Service');
s3Service.BUCKET_NAME = 'test-bucket';
s3Service.S3_BASE_URL = 'https://s3.test';
const portalRouter = requireCJS('../../routes/portal');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal', portalRouter);
  return app;
}

function portalToken({ contactId = 3140, tenantId = 1 } = {}) {
  return jwt.sign({ type: 'PORTAL', contactId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}
function staffToken() {
  return jwt.sign({ userId: 7, tenantId: 1, role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
}

const PILGRIM = { id: 3140, name: 'Ahmed Khan', email: 'ahmed.pilgrim@demo.test', phone: '+911234567890', subBrand: 'rfu' };

const STUB_ENVELOPE = {
  extraction: { passportNumber: 'M1234567', surname: 'DOE', givenNames: 'JOHN' },
  confidence: 0.95,
  provider: 'stub-mode-v1',
  extractedAt: '2026-06-12T10:00:00.000Z',
};

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let extractSpy;

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'travel' });
  prisma.contact.findUnique.mockReset().mockResolvedValue(PILGRIM);
  prisma.customerTraveller.findMany.mockReset().mockResolvedValue([]);
  prisma.customerTraveller.findFirst.mockReset();
  prisma.customerTraveller.count.mockReset().mockResolvedValue(0);
  prisma.customerTraveller.create.mockReset();
  prisma.customerTraveller.updateMany.mockReset().mockResolvedValue({ count: 1 });
  writeAudit.mockClear();
  extractSpy = vi.spyOn(passportOcrClient, 'extractPassport').mockResolvedValue(STUB_ENVELOPE);
  // Stub S3 so tests never touch the live bucket. uploadFile echoes a fake URL
  // derived from the (mimetype-pinned) name so we can assert the extension.
  vi.spyOn(s3Service, 'uploadFile').mockImplementation(async (buf, name) => `https://s3.test/passport-ocr/${name}`);
  vi.spyOn(s3Service, 'deleteFile').mockResolvedValue(undefined);
  vi.spyOn(s3Service, 'extractKeyFromUrl').mockImplementation((url) => (url ? url.replace('https://s3.test/', '') : null));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('portal travel travellers — auth gate', () => {
  test.each([
    ['GET', '/api/portal/travel/travellers'],
    ['POST', '/api/portal/travel/travellers'],
    ['POST', '/api/portal/travel/travellers/1/passport-upload'],
  ])('%s %s → 401 without a token', async (method, url) => {
    const res = await request(makeApp())[method.toLowerCase()](url);
    expect(res.status).toBe(401);
  });

  test('staff (non-PORTAL) JWT is rejected with 401', async () => {
    const res = await request(makeApp())
      .get('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${staffToken()}`);
    expect(res.status).toBe(401);
  });

  test('non-travel tenant → 403 NOT_TRAVEL_TENANT', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
    const res = await request(makeApp())
      .get('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${portalToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_TRAVEL_TENANT');
  });
});

describe('GET /api/portal/travel/travellers', () => {
  test('filters by contactId + tenantId; returns status fields only', async () => {
    prisma.customerTraveller.findMany.mockResolvedValue([
      {
        id: 901, fullName: 'Fatima Khan', relationship: 'spouse', subBrand: 'rfu',
        passportExtractedAt: null, passportVerifiedAt: null, passportRejectedAt: null,
      },
    ]);
    const res = await request(makeApp())
      .get('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${portalToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.travellers).toHaveLength(1);
    const args = prisma.customerTraveller.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ contactId: 3140, tenantId: 1 });
    // PII boundary: select must NOT expose passportNumber / extraction.
    expect(args.select.passportNumber).toBeUndefined();
    expect(args.select.passportExtractionJson).toBeUndefined();
  });
});

describe('POST /api/portal/travel/travellers', () => {
  test('creates a traveller tagged with the contact sub-brand + parent fields from contact', async () => {
    prisma.customerTraveller.create.mockResolvedValue({ id: 905, fullName: 'Fatima Khan', relationship: 'spouse', subBrand: 'rfu' });
    const res = await request(makeApp())
      .post('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${portalToken()}`)
      .send({ fullName: '  Fatima Khan  ', relationship: 'spouse' });
    expect(res.status).toBe(201);
    expect(res.body.traveller.id).toBe(905);
    const data = prisma.customerTraveller.create.mock.calls[0][0].data;
    expect(data.fullName).toBe('Fatima Khan'); // trimmed
    expect(data.contactId).toBe(3140);
    expect(data.tenantId).toBe(1);
    expect(data.subBrand).toBe('rfu');
    expect(data.relationship).toBe('spouse');
    expect(writeAudit).toHaveBeenCalledWith(
      'CustomerTraveller', 'traveller.portal_added', 905, null, 1,
      expect.objectContaining({ portalContactId: 3140, subBrand: 'rfu' }),
      expect.objectContaining({ actorType: 'portal' }),
    );
  });

  test('falls back to rfu sub-brand when the contact has no sub-brand', async () => {
    prisma.contact.findUnique.mockResolvedValue({ ...PILGRIM, subBrand: null });
    prisma.customerTraveller.create.mockResolvedValue({ id: 906, fullName: 'X' });
    const res = await request(makeApp())
      .post('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${portalToken()}`)
      .send({ fullName: 'X' });
    expect(res.status).toBe(201);
    expect(prisma.customerTraveller.create.mock.calls[0][0].data.subBrand).toBe('rfu');
  });

  test('400 MISSING_FIELDS when fullName is blank', async () => {
    const res = await request(makeApp())
      .post('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${portalToken()}`)
      .send({ fullName: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
    expect(prisma.customerTraveller.create).not.toHaveBeenCalled();
  });

  test('429 TRAVELLER_LIMIT_REACHED at the per-customer cap', async () => {
    prisma.customerTraveller.count.mockResolvedValue(20);
    const res = await request(makeApp())
      .post('/api/portal/travel/travellers')
      .set('Authorization', `Bearer ${portalToken()}`)
      .send({ fullName: 'One Too Many' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('TRAVELLER_LIMIT_REACHED');
    expect(prisma.customerTraveller.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/portal/travel/travellers/:id/passport-upload', () => {
  function upload(id, token, { filename = 'passport.png', contentType = 'image/png', bytes = PNG_BYTES } = {}) {
    return request(makeApp())
      .post(`/api/portal/travel/travellers/${id}/passport-upload`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', bytes, { filename, contentType });
  }

  test('201 happy path — pending-verification, NO extraction values echoed', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, fullName: 'Fatima Khan', passportVerifiedAt: null, passportExtractionJson: null });
    prisma.customerTraveller.updateMany.mockResolvedValue({ count: 1 });
    const res = await upload(901, portalToken());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending-verification');
    expect(res.body.travellerId).toBe(901);
    expect(res.body.extraction).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('M1234567');
    // Ownership scoping.
    expect(prisma.customerTraveller.findFirst.mock.calls[0][0].where).toEqual({ id: 901, contactId: 3140, tenantId: 1 });
    // Stored to S3 via the shared service.
    expect(s3Service.uploadFile).toHaveBeenCalled();
    // Conditional updateMany guarded on verifiedAt:null; envelope carries the S3 URL.
    const call = prisma.customerTraveller.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 901, passportVerifiedAt: null });
    const envelope = JSON.parse(call.data.passportExtractionJson);
    expect(envelope.uploadedVia).toBe('portal');
    expect(envelope.storage).toBe('s3');
    expect(envelope.imageUrl).toMatch(/^https:\/\/s3\.test\/passport-ocr\//);
    expect(call.data.passportRejectedAt).toBeNull();
    // Audit: names only, never values.
    const details = writeAudit.mock.calls.find((c) => c[1] === 'passport.uploaded')[5];
    expect(details.extractedFieldNames).toContain('passportNumber');
    expect(JSON.stringify(details)).not.toContain('M1234567');
  });

  test('saved filename extension comes from the mimetype, not the client filename (stored-XSS guard)', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    prisma.customerTraveller.updateMany.mockResolvedValue({ count: 1 });
    // Spoof: image/png mimetype + a .html filename.
    const res = await upload(901, portalToken(), { filename: 'evil.html', contentType: 'image/png' });
    expect(res.status).toBe(201);
    // The S3 object name is derived from the mimetype (.png), never the .html
    // client filename. uploadFile(buffer, name, mimeType, subfolder).
    const nameArg = s3Service.uploadFile.mock.calls[0][1];
    expect(nameArg).toMatch(/\.png$/);
    expect(nameArg).not.toContain('.html');
    expect(s3Service.uploadFile.mock.calls[0][2]).toBe('image/png');
  });

  test('404 TRAVELLER_NOT_FOUND for a traveller not owned by this contact', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue(null);
    const res = await upload(902, portalToken());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TRAVELLER_NOT_FOUND');
    expect(extractSpy).not.toHaveBeenCalled();
  });

  test('re-upload deletes the previous S3 object (supersede)', async () => {
    // The traveller already has a stored S3 scan from a prior upload.
    prisma.customerTraveller.findFirst.mockResolvedValue({
      id: 901,
      passportVerifiedAt: null,
      passportExtractionJson: JSON.stringify({ storage: 's3', imageKey: 'passport-ocr/OLD.png' }),
    });
    prisma.customerTraveller.updateMany.mockResolvedValue({ count: 1 });
    const res = await upload(901, portalToken());
    expect(res.status).toBe(201);
    // The new scan was uploaded AND the old one removed from S3.
    expect(s3Service.uploadFile).toHaveBeenCalled();
    expect(s3Service.deleteFile).toHaveBeenCalledWith('passport-ocr/OLD.png');
  });

  test('lost race (updateMany 0) removes the just-uploaded S3 object', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    prisma.customerTraveller.updateMany.mockResolvedValue({ count: 0 });
    const res = await upload(901, portalToken());
    expect(res.status).toBe(409);
    expect(s3Service.deleteFile).toHaveBeenCalled(); // cleaned up what we stored
  });

  test('409 ALREADY_VERIFIED when the passport is already verified', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: new Date('2026-06-01T00:00:00.000Z'), passportExtractionJson: null });
    const res = await upload(901, portalToken());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_VERIFIED');
    expect(prisma.customerTraveller.updateMany).not.toHaveBeenCalled();
  });

  test('409 ALREADY_VERIFIED when a staff verify wins the race (updateMany matches 0 rows)', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    prisma.customerTraveller.updateMany.mockResolvedValue({ count: 0 });
    const res = await upload(901, portalToken());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_VERIFIED');
  });

  test('503 PASSPORT_OCR_NOT_YET_ENABLED when the vendor is disabled', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    const err = new Error('not enabled');
    err.code = 'PASSPORT_OCR_NOT_YET_ENABLED';
    extractSpy.mockRejectedValue(err);
    const res = await upload(901, portalToken());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PASSPORT_OCR_NOT_YET_ENABLED');
    expect(prisma.customerTraveller.updateMany).not.toHaveBeenCalled();
  });

  test('400 NO_FILE when the multipart field is missing', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    const res = await request(makeApp())
      .post('/api/portal/travel/travellers/901/passport-upload')
      .set('Authorization', `Bearer ${portalToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FILE');
  });

  test('415 UNSUPPORTED_MIME for a text file', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    const res = await upload(901, portalToken(), { filename: 'notes.txt', contentType: 'text/plain', bytes: Buffer.from('hello') });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MIME');
  });

  test('413 FILE_TOO_LARGE when the upload exceeds the 5 MB cap', async () => {
    prisma.customerTraveller.findFirst.mockResolvedValue({ id: 901, passportVerifiedAt: null, passportExtractionJson: null });
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await upload(901, portalToken(), { bytes: big });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });
});
