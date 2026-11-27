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
prisma.tripParticipant = { ...(prisma.tripParticipant || {}), findMany: vi.fn(), count: vi.fn() };
prisma.tripPaymentPlan = { ...(prisma.tripPaymentPlan || {}), findUnique: vi.fn() };
prisma.tripInstalmentPayment = { ...(prisma.tripInstalmentPayment || {}), findMany: vi.fn() };
prisma.roomingAssignment = { ...(prisma.roomingAssignment || {}), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), createMany: vi.fn() };
prisma.pendingTripRegistration = { ...(prisma.pendingTripRegistration || {}), findMany: vi.fn() };
prisma.tmcParentTrip = { ...(prisma.tmcParentTrip || {}), findMany: vi.fn() };
prisma.visaApplication = { ...(prisma.visaApplication || {}), findMany: vi.fn() };
prisma.visaLetterDocument = { ...(prisma.visaLetterDocument || {}), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() };
prisma.visaLetterGeneration = { ...(prisma.visaLetterGeneration || {}), update: vi.fn() };
prisma.user = { ...(prisma.user || {}), findMany: vi.fn() };
prisma.tenantSetting = { ...(prisma.tenantSetting || {}), findUnique: vi.fn() };
prisma.brandKit = { findFirst: vi.fn() };
prisma.travelKnowledgeBaseFile = { ...(prisma.travelKnowledgeBaseFile || {}), findMany: vi.fn() };
prisma.itinerary = { ...(prisma.itinerary || {}), findMany: vi.fn() };
prisma.tmcTeacherCatalogueResponse = {
  ...(prisma.tmcTeacherCatalogueResponse || {}),
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

const { JWT_SECRET } = requireCJS('../../config/secrets');
const visaLetterStore = requireCJS('../../lib/visaLetterStore');
const audit = requireCJS('../../lib/audit');
const notificationService = requireCJS('../../lib/notificationService');
const travelKnowledgeBaseSync = requireCJS('../../lib/travelKnowledgeBaseSync');
const driveOAuth = requireCJS('../../lib/googleDriveOAuth');
const eventBus = requireCJS('../../lib/eventBus');
const originalVisaLetterStore = {
  readLetterBuffer: visaLetterStore.readLetterBuffer,
  storeLetterPdf: visaLetterStore.storeLetterPdf,
  removeLetter: visaLetterStore.removeLetter,
};
const originalTmcCatalogueDeps = {
  listFolderChildren: travelKnowledgeBaseSync.listFolderChildren,
  getDriveClient: driveOAuth.getDriveClient,
};
audit.writeAudit = vi.fn().mockResolvedValue(undefined);
notificationService.notifyMany = vi.fn().mockResolvedValue(undefined);
const router = requireCJS('../../routes/tmc_portal');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

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
  eventBus.emitEvent.mockClear();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 7, vertical: 'travel', slug: 'tmc' });
  prisma.brandKit.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findFirst.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.tripParticipant.count.mockReset().mockResolvedValue(0);
  prisma.tripPaymentPlan.findUnique.mockReset();
  prisma.tripInstalmentPayment.findMany.mockReset().mockResolvedValue([]);
  prisma.roomingAssignment.findMany.mockReset().mockResolvedValue([]);
  prisma.roomingAssignment.findFirst.mockReset().mockResolvedValue(null);
  prisma.roomingAssignment.create.mockReset();
  prisma.roomingAssignment.update.mockReset();
  prisma.roomingAssignment.delete.mockReset();
  prisma.roomingAssignment.createMany.mockReset();
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
  travelKnowledgeBaseSync.listFolderChildren = originalTmcCatalogueDeps.listFolderChildren;
  driveOAuth.getDriveClient = originalTmcCatalogueDeps.getDriveClient;
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
      where: {
        tenantId: 7,
        OR: [
          { teacherContactId: 41 },
          { teacherAssignments: { some: { tenantId: 7, teacherContactId: 41 } } },
        ],
      },
    }));
  });
});

describe('TMC teacher catalogue selection', () => {
  const brochure = {
    id: 'tmc-pdf-1',
    name: 'Nepal School Trip.pdf',
    mimeType: 'application/pdf',
    webViewLink: 'https://drive.google.com/file/d/tmc-pdf-1/view',
    thumbnailLink: 'https://drive.google.com/thumbnail/tmc-pdf-1',
  };
  const drive = { files: { get: vi.fn() } };

  beforeEach(() => {
    notificationService.notifyMany.mockReset().mockResolvedValue(undefined);
    prisma.contact.findFirst.mockResolvedValue(contact('TEACHER'));
    prisma.tenantSetting.findUnique.mockReset().mockResolvedValue({ value: 'root-folder' });
    prisma.travelKnowledgeBaseFile.findMany.mockReset().mockResolvedValue([{
      driveFileId: 'tmc-pdf-1',
      fileName: 'Nepal School Trip.pdf',
      folderPath: 'TMC/CRM Itineraries',
      driveViewLink: brochure.webViewLink,
    }]);
    prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
    prisma.tmcTeacherCatalogueResponse.findUnique.mockReset().mockResolvedValue(null);
    prisma.tmcTeacherCatalogueResponse.upsert.mockReset().mockImplementation(async ({ create, update }) => ({
      selectedFilesJson: create?.selectedFilesJson || update.selectedFilesJson,
      submittedAt: create?.submittedAt || update.submittedAt,
    }));
    travelKnowledgeBaseSync.listFolderChildren = vi.fn(async (_drive, folderId) => (
      folderId === 'root-folder'
        ? [{ id: 'tmc-folder', name: 'TMC', mimeType: 'application/vnd.google-apps.folder' }]
        : [brochure]
    ));
    driveOAuth.getDriveClient = vi.fn().mockResolvedValue(drive);
    drive.files.get.mockReset();
  });

  test('lists tenant TMC brochures and the teacher saved selection', async () => {
    prisma.tmcTeacherCatalogueResponse.findUnique.mockResolvedValue({
      selectedFilesJson: JSON.stringify([{ driveFileId: 'tmc-pdf-1', fileName: 'Nepal School Trip.pdf' }]),
      submittedAt: new Date('2026-11-10T10:00:00.000Z'),
    });

    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/catalogues')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      catalogues: [expect.objectContaining({
        driveFileId: 'tmc-pdf-1',
        fileName: 'Nepal School Trip.pdf',
        folderPath: 'TMC',
        indexed: true,
      })],
      response: { selectedCatalogues: [{ driveFileId: 'tmc-pdf-1', fileName: 'Nepal School Trip.pdf' }] },
    });
    expect(prisma.travelKnowledgeBaseFile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, subBrand: 'tmc' },
    }));
    expect(prisma.tmcTeacherCatalogueResponse.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_teacherContactId: { tenantId: 7, teacherContactId: 41 } },
    }));

    const driveScanCallCount = travelKnowledgeBaseSync.listFolderChildren.mock.calls.length;
    const cachedRes = await request(makeApp())
      .get('/api/portal/tmc/teacher/catalogues')
      .set(bearer());
    expect(cachedRes.status).toBe(200);
    expect(cachedRes.body.catalogues).toEqual(res.body.catalogues);
    expect(travelKnowledgeBaseSync.listFolderChildren).toHaveBeenCalledTimes(driveScanCallCount);
  });

  test('keeps the brochure library available when the response table is not synced yet', async () => {
    prisma.tmcTeacherCatalogueResponse.findUnique.mockRejectedValue(Object.assign(
      new Error('The table `TmcTeacherCatalogueResponse` does not exist'),
      { code: 'P2021' },
    ));

    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/catalogues')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      responseStorageAvailable: false,
      catalogues: [expect.objectContaining({ driveFileId: 'tmc-pdf-1' })],
      response: null,
    });
  });

  test('lists sibling Drive folders concurrently on a cold catalogue load', async () => {
    let activeFolderReads = 0;
    let maxConcurrentFolderReads = 0;
    travelKnowledgeBaseSync.listFolderChildren = vi.fn(async (_drive, folderId) => {
      if (folderId === 'root-folder') {
        return [{ id: 'tmc-folder', name: 'TMC', mimeType: 'application/vnd.google-apps.folder' }];
      }
      if (folderId === 'tmc-folder') {
        return Array.from({ length: 6 }, (_, index) => ({
          id: `folder-${index + 1}`,
          name: `Folder ${index + 1}`,
          mimeType: 'application/vnd.google-apps.folder',
        }));
      }
      activeFolderReads += 1;
      maxConcurrentFolderReads = Math.max(maxConcurrentFolderReads, activeFolderReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeFolderReads -= 1;
      return [{
        id: `pdf-${folderId}`,
        name: `${folderId}.pdf`,
        mimeType: 'application/pdf',
      }];
    });

    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/catalogues')
      .set(bearer(portalToken({ tenantId: 72 })));

    expect(res.status).toBe(200);
    expect(res.body.catalogues).toHaveLength(6);
    expect(maxConcurrentFolderReads).toBeGreaterThan(1);
  });

  test('rejects an empty catalogue selection without writing a response', async () => {
    const res = await request(makeApp())
      .post('/api/portal/tmc/teacher/catalogues/response')
      .set(bearer())
      .send({ selectedFileIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CATALOGUE_SELECTION');
    expect(prisma.tmcTeacherCatalogueResponse.upsert).not.toHaveBeenCalled();
  });

  test('submits canonical selected brochure snapshots for the authenticated teacher', async () => {
    const res = await request(makeApp())
      .post('/api/portal/tmc/teacher/catalogues/response')
      .set(bearer())
      .send({ selectedFileIds: ['tmc-pdf-1'] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, response: { selectedCatalogues: [expect.objectContaining({ driveFileId: 'tmc-pdf-1' })] } });
    const [write] = prisma.tmcTeacherCatalogueResponse.upsert.mock.calls[0];
    expect(write.where).toEqual({ tenantId_teacherContactId: { tenantId: 7, teacherContactId: 41 } });
    expect(JSON.parse(write.create.selectedFilesJson)).toEqual([expect.objectContaining({
      driveFileId: 'tmc-pdf-1',
      fileName: 'Nepal School Trip.pdf',
      folderPath: 'TMC',
    })]);
    expect(eventBus.emitEvent).toHaveBeenCalledWith('catalogue.request_submitted', expect.objectContaining({
      contactId: 41,
      recipientEmail: 'teacher@example.test',
      recipientName: 'TEACHER Contact',
      catalogue: { name: 'Nepal School Trip.pdf' },
      subBrand: 'tmc',
    }), 7, undefined);
  });

  test('notifies tenant admins after a teacher submits or updates their catalogue selection', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 12 }, { id: 13 }]);

    const submit = () => request(makeApp())
      .post('/api/portal/tmc/teacher/catalogues/response')
      .set(bearer())
      .send({ selectedFileIds: ['tmc-pdf-1'] });

    const firstSubmission = await submit();
    const updatedSubmission = await submit();

    expect(firstSubmission.status).toBe(201);
    expect(updatedSubmission.status).toBe(201);
    expect(prisma.tmcTeacherCatalogueResponse.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7, role: 'ADMIN' },
      select: { id: true },
    });
    expect(notificationService.notifyMany).toHaveBeenCalledTimes(2);
    expect(notificationService.notifyMany).toHaveBeenCalledWith(expect.objectContaining({
      userIds: [12, 13],
      tenantId: 7,
      title: 'TMC catalogue selection received',
      message: expect.stringContaining('TEACHER Contact submitted a selection of 1 catalogue for review'),
      emailHtml: expect.stringContaining('Open TMC Catalogue Responses'),
      category: 'tmc_catalogue',
      type: 'info',
      priority: 'high',
      link: '/travel/diagnostics?tab=catalogues&teacherId=41',
      channels: ['db', 'socket'],
    }));
    const notification = notificationService.notifyMany.mock.calls[0][0];
    const { emailHtml } = notification;
    expect(notification.message).not.toContain('<table');
    expect(notification.message).not.toContain('Open TMC Catalogue Responses');
    expect(emailHtml).toContain('teacher@example.test');
    expect(emailHtml).toContain('Nepal School Trip.pdf');
    expect(emailHtml).toContain('Teacher contact ID');
    expect(emailHtml).toContain('Submitted (UTC)');
  });

  test('keeps a successful catalogue submission when admin notification delivery fails', async () => {
    prisma.user.findMany.mockRejectedValueOnce(new Error('notification lookup unavailable'));

    const res = await request(makeApp())
      .post('/api/portal/tmc/teacher/catalogues/response')
      .set(bearer())
      .send({ selectedFileIds: ['tmc-pdf-1'] });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(prisma.tmcTeacherCatalogueResponse.upsert).toHaveBeenCalledTimes(1);
    expect(notificationService.notifyMany).not.toHaveBeenCalled();
  });

  test('reports a database sync requirement when saving catalogue responses is unavailable', async () => {
    prisma.tmcTeacherCatalogueResponse.upsert.mockRejectedValue(Object.assign(
      new Error('The table `TmcTeacherCatalogueResponse` does not exist'),
      { code: 'P2021' },
    ));

    const res = await request(makeApp())
      .post('/api/portal/tmc/teacher/catalogues/response')
      .set(bearer())
      .send({ selectedFileIds: ['tmc-pdf-1'] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('TMC_CATALOGUE_RESPONSE_STORAGE_NOT_READY');
  });

  test('streams previews only for PDFs inside the configured TMC Drive folder', async () => {
    drive.files.get
      .mockResolvedValueOnce({ data: { id: 'tmc-pdf-1', name: 'Nepal School Trip.pdf', mimeType: 'application/pdf', parents: ['tmc-folder'] } })
      .mockResolvedValueOnce({ data: { id: 'tmc-folder', name: 'TMC', mimeType: 'application/vnd.google-apps.folder', parents: ['root-folder'] } })
      .mockResolvedValueOnce({ data: Buffer.from('%PDF-test') });

    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/catalogues/tmc-pdf-1/file')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(drive.files.get).toHaveBeenLastCalledWith({ fileId: 'tmc-pdf-1', alt: 'media' }, { responseType: 'arraybuffer' });
  });
});

describe('TMC teacher trip management', () => {
  beforeEach(() => {
    prisma.contact.findFirst.mockResolvedValue(contact('TEACHER'));
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 100,
      tripCode: 'TMC-100',
      destination: 'Singapore',
      tripType: 'international',
      departDate: new Date('2026-12-01T00:00:00Z'),
      returnDate: new Date('2026-12-08T00:00:00Z'),
      status: 'confirmed',
      teacherContactId: 99,
      _count: { participants: 2, pendingRegistrations: 0 },
    });
  });

  test('co-teachers share every parent registration recorded for their trip', async () => {
    prisma.pendingTripRegistration.findMany.mockResolvedValue([]);
    prisma.tmcParentTrip.findMany.mockResolvedValue([{
      id: 8,
      tripId: 100,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      parent: { id: 201, name: 'Riya Sharma', email: 'riya@example.test', phone: null },
    }]);

    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/trips/100/registrations')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body.parentLinks).toMatchObject([{ id: 8, tripId: 100, parent: { name: 'Riya Sharma' } }]);
    expect(prisma.tmcParentTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, tripId: 100 },
    }));
  });

  test('teacher can read the assigned trip payment and rooming ledgers', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue({
      id: 1,
      tripId: 100,
      instalmentsJson: '[{"dueDate":"2026-11-20","amount":100000}]',
      graceDays: 0,
    });
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 9, tripId: 100, participantId: 501, instalmentIndex: 0, amount: 100000, paidAmount: 100000, status: 'paid' },
    ]);
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { id: 12, tripId: 100, roomNumber: '101', roomType: 'twin', sharingCapacity: 2, participantIds: '[501,502]' },
    ]);

    const [paymentPlan, instalments, rooming] = await Promise.all([
      request(makeApp()).get('/api/portal/tmc/teacher/trips/100/payment-plan').set(bearer()),
      request(makeApp()).get('/api/portal/tmc/teacher/trips/100/instalments').set(bearer()),
      request(makeApp()).get('/api/portal/tmc/teacher/trips/100/rooming').set(bearer()),
    ]);

    expect(paymentPlan.status).toBe(200);
    expect(paymentPlan.body.tripId).toBe(100);
    expect(instalments.status).toBe(200);
    expect(instalments.body.instalments).toHaveLength(1);
    expect(rooming.status).toBe(200);
    expect(rooming.body.rooming[0].roomNumber).toBe('101');
    expect(rooming.body.rooming[0].sharingCapacity).toBe(2);
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 100,
        tenantId: 7,
        OR: [
          { teacherContactId: 41 },
          { teacherAssignments: { some: { tenantId: 7, teacherContactId: 41 } } },
        ],
      },
    }));
  });

  test('teacher assigns participants to an admin-configured room', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 22,
      tripId: 100,
      roomNumber: '201',
      roomType: 'twin',
      participantIds: '[]',
    });
    prisma.tripParticipant.count.mockResolvedValue(1);
    prisma.roomingAssignment.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.update.mockResolvedValue({
      id: 22,
      tripId: 100,
      roomNumber: '201',
      roomType: 'twin',
      participantIds: '[501]',
    });

    const res = await request(makeApp())
      .patch('/api/portal/tmc/teacher/trips/100/rooming/22')
      .set(bearer())
      .send({ participantIds: [501] });

    expect(res.status).toBe(200);
    expect(prisma.tripParticipant.count).toHaveBeenCalledWith({
      where: { id: { in: [501] }, tripId: 100 },
    });
    expect(prisma.roomingAssignment.update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { participantIds: '[501]' },
    });
  });

  test('teacher cannot create, edit room configuration, delete, or auto-create rooms', async () => {
    const create = await request(makeApp())
      .post('/api/portal/tmc/teacher/trips/100/rooming')
      .set(bearer())
      .send({ roomNumber: '201', roomType: 'twin' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('ROOM_CONFIGURATION_ADMIN_ONLY');

    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 22, tripId: 100, roomNumber: '201', roomType: 'twin', participantIds: '[]',
    });
    const editConfiguration = await request(makeApp())
      .patch('/api/portal/tmc/teacher/trips/100/rooming/22')
      .set(bearer())
      .send({ roomNumber: '202', roomType: 'quad' });
    expect(editConfiguration.status).toBe(403);
    expect(editConfiguration.body.code).toBe('ROOM_CONFIGURATION_ADMIN_ONLY');

    const remove = await request(makeApp())
      .delete('/api/portal/tmc/teacher/trips/100/rooming/22')
      .set(bearer());
    expect(remove.status).toBe(403);
    expect(remove.body.code).toBe('ROOM_CONFIGURATION_ADMIN_ONLY');

    const auto = await request(makeApp())
      .post('/api/portal/tmc/teacher/trips/100/rooming/auto')
      .set(bearer());
    expect(auto.status).toBe(403);
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
    expect(prisma.roomingAssignment.delete).not.toHaveBeenCalled();
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });

  test('teacher assignments respect a custom sharing capacity configured by the admin', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 22, tripId: 100, roomNumber: '201', roomType: 'custom', sharingCapacity: 5, participantIds: '[]',
    });
    const res = await request(makeApp())
      .patch('/api/portal/tmc/teacher/trips/100/rooming/22')
      .set(bearer())
      .send({ participantIds: [501, 502, 503, 504, 505, 506] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ROOM_CAPACITY_EXCEEDED');
    expect(prisma.tripParticipant.count).not.toHaveBeenCalled();
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });

  test('teacher cannot assign a participant outside the assigned trip', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 22, tripId: 100, roomNumber: '201', roomType: 'twin', participantIds: '[]',
    });
    prisma.tripParticipant.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .patch('/api/portal/tmc/teacher/trips/100/rooming/22')
      .set(bearer())
      .send({ participantIds: [999] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PARTICIPANTS_OFF_TRIP');
    expect(prisma.tripParticipant.count).toHaveBeenCalledWith({
      where: { id: { in: [999] }, tripId: 100 },
    });
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });

  test('teacher cannot assign the same participant to two rooms', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 22, tripId: 100, roomNumber: '201', roomType: 'twin', participantIds: '[]',
    });
    prisma.tripParticipant.count.mockResolvedValue(1);
    prisma.roomingAssignment.findMany.mockResolvedValue([{ participantIds: '[501]' }]);
    const res = await request(makeApp())
      .patch('/api/portal/tmc/teacher/trips/100/rooming/22')
      .set(bearer())
      .send({ participantIds: [501] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_ASSIGNMENT');
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });
});

describe('TMC parent trip isolation', () => {
  test('a parent sees every non-cancelled trip assigned to their linked teacher', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('PARENT'));
    prisma.tmcParentTrip.findMany.mockResolvedValue([
      {
        id: 1,
        tripId: 501,
        createdAt: new Date(),
        teacher: { id: 70, name: 'Teacher One', email: 'teacher@example.test' },
        trip: { id: 501, landingPage: null },
      },
    ]);
    prisma.tmcTrip.findMany.mockResolvedValue([
      {
        id: 501,
        tripCode: 'TMC-501',
        teacher: { id: 70, name: 'Teacher One', email: 'teacher@example.test' },
        landingPage: null,
      },
      {
        id: 502,
        tripCode: 'TMC-502',
        teacher: { id: 70, name: 'Teacher One', email: 'teacher@example.test' },
        landingPage: { id: 88, slug: 'tmc-502', status: 'PUBLISHED' },
      },
    ]);

    const res = await request(makeApp())
      .get('/api/portal/tmc/parent/trips')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body.trips.map((trip) => trip.id)).toEqual([501, 502]);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 7,
        OR: [
          { teacherContactId: { in: [70] } },
          { teacherAssignments: { some: { tenantId: 7, teacherContactId: { in: [70] } } } },
        ],
        status: { not: 'cancelled' },
      },
    }));
    expect(res.body.trips[1]).toMatchObject({
      landingUrl: '/trips/88',
      teacher: { id: 70, name: 'Teacher One' },
    });
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
        participant: {
          parentEmail: 'parent@example.test',
          tripId: { in: [501] },
        },
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
      where: expect.objectContaining({
        tenantId: 7,
        tripId: { in: [501] },
        participant: {
          parentEmail: 'parent@example.test',
          tripId: { in: [501] },
        },
      }),
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
    prisma.contact.findMany.mockResolvedValueOnce([{
      id: 101,
      name: 'Asha Teacher',
      email: 'asha@example.test',
      phone: null,
      company: 'Riverside School',
      createdAt: new Date('2026-06-01T04:30:00.000Z'),
      _count: { tmcTripTeacherAssignments: 3 },
    }]);
    const res = await request(makeApp())
      .get('/api/portal/tmc/staff/teachers')
      .set('x-test-staff-auth', 'yes')
      .set('x-test-permission', 'trips.update');
    expect(res.status).toBe(200);
    expect(res.body.teachers).toEqual([{
      id: 101,
      name: 'Asha Teacher',
      email: 'asha@example.test',
      phone: null,
      company: 'Riverside School',
      createdAt: '2026-06-01T04:30:00.000Z',
      assignedTripCount: 3,
    }]);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, subBrand: 'tmc', portalRole: 'TEACHER', deletedAt: null },
      select: expect.objectContaining({
        _count: {
          select: { tmcTripTeacherAssignments: { where: { tenantId: 7 } } },
        },
      }),
    }));
  });

  test('teacher overview returns registration timestamp and school name for the detail page', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 101,
      name: 'Asha Teacher',
      email: 'asha@example.test',
      phone: '+91 90000 00000',
      company: 'Riverside School',
      createdAt: new Date('2026-06-01T04:30:00.000Z'),
    });

    const res = await request(makeApp())
      .get('/api/portal/tmc/staff/teachers/101/overview')
      .set('x-test-staff-auth', 'yes')
      .set('x-test-permission', 'trips.update');

    expect(res.status).toBe(200);
    expect(res.body.teacher).toEqual({
      id: 101,
      name: 'Asha Teacher',
      email: 'asha@example.test',
      phone: '+91 90000 00000',
      company: 'Riverside School',
      createdAt: '2026-06-01T04:30:00.000Z',
    });
    expect(res.body.trips).toEqual([]);
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 101, tenantId: 7, subBrand: 'tmc', portalRole: 'TEACHER', deletedAt: null },
      select: expect.objectContaining({ company: true, createdAt: true }),
    }));
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 7,
        OR: [
          { teacherContactId: 101 },
          { teacherAssignments: { some: { tenantId: 7, teacherContactId: 101 } } },
        ],
        status: { not: 'cancelled' },
      },
    }));
  });
});
