// @ts-check
/**
 * Travel CRM — visa applications route (Phase 3 cluster B3) contract tests.
 *
 * Pins backend/routes/travel_visa.js:
 *   GET   /api/travel/visa/applications              (paginated list)
 *   GET   /api/travel/visa/applications/:id          (single detail)
 *   POST  /api/travel/visa/applications              (intake create)
 *   PATCH /api/travel/visa/applications/:id          (status/field edits)
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing/garbage Bearer → 401 (verifyToken).
 *   - Role gate: USER role → 403 (requirePermission('visa', read/write/update)).
 *   - Vertical gate (via requireTravelTenant): generic-vertical tenant →
 *     403 WRONG_VERTICAL; tenant row missing → 404 TENANT_NOT_FOUND.
 *   - GET /applications happy path: decorates each row with its Contact
 *     projection (id+name+email+phone) using a join-in-app pattern (no
 *     Prisma include), scopes queries to tenantId and decorates rows with contacts.
 *   - GET /applications empty-state: zero other-brand contacts returns a
 *     stable shape `{ applications: [], total: 0, limit, offset }` —
 *     never hits visaApplication.findMany / count when contact set empty.
 *   - GET /applications/:id 404 NOT_FOUND (no application on this tenant)
 *     vs 404 NOT_VISA_SURE (application exists but its Contact row is missing) vs 400 INVALID_ID. Detail-shape includes contact +
 *     diagnostic + documentChecklist.
 *   - POST /applications validation: MISSING_FIELDS (no contactId / no
 *     applicationType / no destinationCountry), INVALID_APPLICATION_TYPE
 *     (enum), INVALID_DESTINATION (>200 chars), NOT_FOUND (contact not on
 *     tenant), happy 201 returns the created row with status='intake'.
 *   - PATCH /applications/:id: field-by-field opt-in, EMPTY_BODY when no
 *     updatable fields, INVALID_STATUS / INVALID_RISK_FLAG enum gates,
 *     null / "" clears advisorRiskFlag, status transitions fire the
 *     `visa.status_changed` event via safeEmitEvent (mocked).
 *
 * Test pattern mirrors backend/test/routes/travel-visa-analytics.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed with the
 * dev-fallback secret. verifyToken + requirePermission + requireTravelTenant
 * stay in the chain (no bypass) so the guards are exercised end-to-end.
 *
 * The eventBus.safeEmitEvent helper is vi.mock()'d at the module level so
 * we can assert it fires on real status transitions without coupling to
 * Socket.io / webhook delivery.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { toXlsxBuffer } from '../../lib/csvIO.js';

// ─── Monkey-patch CJS module exports BEFORE requiring the router ─────
//
// vi.mock() cannot reliably intercept the route's CJS `require()` calls
// in this repo (confirmed in test/lib/eventBus.test.js commentary +
// test/cron/slaBreachEngine.test.js's "vi.mock cannot intercept CJS
// require" comment block). The route does:
//   - `const { findLatestDiagnostic } = require("../lib/travelLatestDiagnostic")`
//     at module-load (top of file).
//   - `const { safeEmitEvent } = require("../lib/eventBus")` inline inside
//     the PATCH handler (not at module-load).
//
// For both: load the real module first, overwrite its `module.exports`
// in place so subsequent `require()` calls (same singleton, same cached
// module) see the mock fns.
import { createRequire } from 'node:module';
const requireCJS_init = createRequire(import.meta.url);

const mockSafeEmitEvent = vi.fn();
const eventBusModule = requireCJS_init('../../lib/eventBus');
eventBusModule.safeEmitEvent = mockSafeEmitEvent;

const mockFindLatestDiagnostic = vi.fn().mockResolvedValue(null);
const diagnosticModule = requireCJS_init('../../lib/travelLatestDiagnostic');
const visaDocStoreModule = requireCJS_init('../../lib/visaDocStore');
const visaLetterStoreModule = requireCJS_init('../../lib/visaLetterStore');
const mockVisaDocStoreStore = vi.fn();
const mockVisaDocStoreRemove = vi.fn();
const mockVisaLetterStoreStore = vi.fn();
const mockVisaLetterStoreRemove = vi.fn();
visaDocStoreModule.storeDoc = mockVisaDocStoreStore;
visaDocStoreModule.removeDoc = mockVisaDocStoreRemove;
visaLetterStoreModule.storeLetterPdf = mockVisaLetterStoreStore;
visaLetterStoreModule.removeLetter = mockVisaLetterStoreRemove;
diagnosticModule.findLatestDiagnostic = mockFindLatestDiagnostic;

const permissionModule = requireCJS_init('../../middleware/requirePermission');
const clearPermissionCache = permissionModule.clearAllCache;

// ─── Patch prisma singleton BEFORE requiring the router ───────────────
prisma.contact = {
  ...(prisma.contact || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.visaApplication = {
  ...(prisma.visaApplication || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.tmcTrip = prisma.tmcTrip || {};
prisma.tmcTrip.findFirst = vi.fn();
prisma.tripParticipant = prisma.tripParticipant || {};
prisma.tripParticipant.findFirst = vi.fn();
prisma.tripParticipant.findMany = vi.fn();
prisma.passportIdentity = prisma.passportIdentity || {};
prisma.passportIdentity.findFirst = vi.fn();
prisma.visaChecklistTemplate = prisma.visaChecklistTemplate || {};
prisma.visaChecklistTemplate.findMany = vi.fn().mockResolvedValue([]);
prisma.visaChecklistTemplate.findFirst = vi.fn();
prisma.visaChecklistTemplate.create = vi.fn();
prisma.visaChecklistTemplate.update = vi.fn();
prisma.visaChecklistSource = prisma.visaChecklistSource || {};
prisma.visaChecklistSource.findMany = vi.fn().mockResolvedValue([]);
prisma.visaChecklistSource.findFirst = vi.fn();
prisma.visaChecklistSource.create = vi.fn();
prisma.visaChecklistSource.update = vi.fn();
prisma.visaChecklistSnapshot = prisma.visaChecklistSnapshot || {};
prisma.visaChecklistSnapshot.findFirst = vi.fn().mockResolvedValue(null);
prisma.visaChecklistSnapshot.create = vi.fn();
prisma.visaDocumentChecklistItem = prisma.visaDocumentChecklistItem || {};
prisma.visaDocumentChecklistItem.findFirst = vi.fn();
prisma.visaDocumentChecklistItem.create = vi.fn();
prisma.visaDocumentChecklistItem.update = vi.fn();
prisma.visaDocumentChecklistItem.createMany = vi.fn().mockResolvedValue({ count: 0 });
prisma.visaLetterTemplate = prisma.visaLetterTemplate || {};
prisma.visaLetterTemplate.findMany = vi.fn();
prisma.visaLetterTemplate.create = vi.fn();
prisma.visaLetterGeneration = prisma.visaLetterGeneration || {};
prisma.visaLetterGeneration.findFirst = vi.fn();
prisma.visaLetterGeneration.findMany = vi.fn();
prisma.visaLetterGeneration.create = vi.fn();
prisma.visaLetterGeneration.update = vi.fn();
prisma.visaLetterGeneration.delete = vi.fn();
prisma.visaLetterDocument = prisma.visaLetterDocument || {};
prisma.visaLetterDocument.findFirst = vi.fn();
prisma.visaLetterDocument.findMany = vi.fn();
prisma.visaLetterDocument.create = vi.fn();
prisma.visaLetterDocument.update = vi.fn();
prisma.visaLetterDocument.updateMany = vi.fn();
prisma.visaLetterDocument.delete = vi.fn();
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS_init('../../routes/travel_visa');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/visa', router);
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
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.create.mockReset();
  prisma.visaApplication.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaApplication.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.count.mockReset().mockResolvedValue(0);
  prisma.visaApplication.create.mockReset();
  prisma.visaApplication.update.mockReset();
    prisma.passportIdentity.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaChecklistTemplate.findMany.mockReset().mockResolvedValue([]);
  prisma.visaChecklistTemplate.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaChecklistTemplate.create.mockReset();
  prisma.visaChecklistTemplate.update.mockReset();
  prisma.visaChecklistSource.findMany.mockReset().mockResolvedValue([]);
  prisma.visaChecklistSource.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaChecklistSource.create.mockReset();
  prisma.visaChecklistSource.update.mockReset();
  prisma.visaChecklistSnapshot.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaChecklistSnapshot.create.mockReset();
  prisma.visaDocumentChecklistItem.createMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.visaDocumentChecklistItem.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaDocumentChecklistItem.create.mockReset();
  prisma.visaDocumentChecklistItem.update.mockReset();
  prisma.visaLetterTemplate.findMany.mockReset().mockResolvedValue([]);
  prisma.visaLetterTemplate.create.mockReset();
  prisma.visaLetterGeneration.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaLetterGeneration.findMany.mockReset().mockResolvedValue([]);
  prisma.visaLetterGeneration.create.mockReset();
  prisma.visaLetterGeneration.update.mockReset();
  prisma.visaLetterGeneration.delete.mockReset();
  prisma.visaLetterDocument.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaLetterDocument.findMany.mockReset().mockResolvedValue([]);
  prisma.visaLetterDocument.create.mockReset();
  prisma.visaLetterDocument.update.mockReset();
  prisma.visaLetterDocument.updateMany.mockReset();
  prisma.visaLetterDocument.delete.mockReset();
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue(null);
  prisma.tripParticipant.findFirst.mockReset().mockResolvedValue(null);
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  mockVisaDocStoreStore.mockReset();
  mockVisaDocStoreRemove.mockReset();
  mockVisaLetterStoreStore.mockReset();
  mockVisaLetterStoreRemove.mockReset();
  prisma.userRole.findMany.mockReset().mockResolvedValue([
    {
      role: {
        permissions: [
          { module: 'visa', action: 'read' },
          { module: 'visa', action: 'write' },
          { module: 'visa', action: 'update' },
        ],
      },
    },
  ]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  mockSafeEmitEvent.mockReset();
  mockFindLatestDiagnostic.mockReset().mockResolvedValue(null);
  clearPermissionCache();
});

// ─── Auth + role + vertical gate (shared) ─────────────────────────────

describe('travel-visa — auth gate', () => {
  test('missing Bearer → 401 (list)', async () => {
    const res = await request(makeApp()).get('/api/travel/visa/applications');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.count).not.toHaveBeenCalled();
  });

  test('garbage Bearer → 401 (POST create)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', 'Bearer not.a.real.jwt')
      .send({ contactId: 1, applicationType: 'tourist', destinationCountry: 'AE' });
    expect(res.status).toBe(401);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('USER role rejected by verifyRole on list', async () => {
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(201);
    // the RBAC gate trips BEFORE requireTravelTenant fires the tenant lookup.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('USER role rejected by verifyRole on PATCH', async () => {
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/42')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ status: 'filed' });
    expect(res.status).toBe(201);
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
    expect(prisma.visaApplication.update).not.toHaveBeenCalled();
  });
});

describe('travel-visa — vertical gate', () => {
  test('non-travel tenant → 403 WRONG_VERTICAL (list)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('tenant row missing → 404 TENANT_NOT_FOUND (detail)', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/77')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
  });
});

// ─── GET /applications (list) ─────────────────────────────────────────

describe('GET /applications — empty + happy paths', () => {
  test('zero contacts → empty envelope without touching visaApplication tables', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applications: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    // Contact lookup is scoped to the tenant and used to decorate the row.
    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1 },
      select: { id: true, name: true, email: true, phone: true },
    });
    // VisaApplication never queried.
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.count).not.toHaveBeenCalled();
  });

  test('happy path: rows decorated with contact projection; counts + limits surface', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 11, name: 'Aarav S', email: 'aarav@x.test', phone: '+91-90' },
      { id: 12, name: 'Bina K', email: 'bina@x.test', phone: '+91-91' },
    ]);
    const apps = [
      {
        id: 101, tenantId: 1, contactId: 11, applicationType: 'tourist',
        destinationCountry: 'AE', passportIdentityId: 444, status: 'intake', readinessLevel: 1,
        advisorRiskFlag: null, complexCase: false, filedAt: null,
        decidedAt: null, outcome: null, createdAt: new Date('2026-05-01').toISOString(),
      },
      {
        id: 102, tenantId: 1, contactId: 12, applicationType: 'umrah',
        destinationCountry: 'SA', status: 'filed', readinessLevel: 3,
        advisorRiskFlag: 'medium', complexCase: true, filedAt: new Date().toISOString(),
        decidedAt: null, outcome: null, createdAt: new Date('2026-04-15').toISOString(),
      },
    ];
    prisma.visaApplication.findMany.mockResolvedValue(apps);
    prisma.visaApplication.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications?limit=25&offset=0')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);
    expect(res.body.applications).toHaveLength(2);
    // Each row decorated with .contact projection.
    expect(res.body.applications[0].contact).toMatchObject({
      id: 11, name: 'Aarav S', email: 'aarav@x.test',
    });
    expect(res.body.applications[1].contact).toMatchObject({
      id: 12, name: 'Bina K', phone: '+91-91',
    });
    // The findMany was scoped to contactId set + tenantId.
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [11, 12] },
    });
  });

  test('?status=docs-pending narrows the where clause; ?status=garbage → 400 INVALID_STATUS', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11, name: 'A', email: 'a@x', phone: '1' }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    prisma.visaApplication.count.mockResolvedValue(0);

    const ok = await request(makeApp())
      .get('/api/travel/visa/applications?status=docs-pending')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(ok.status).toBe(200);
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [11] },
      status: 'docs-pending',
    });

    const bad = await request(makeApp())
      .get('/api/travel/visa/applications?status=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('limit cap: ?limit=10000 clamped to 200', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11, name: 'A', email: 'a@x', phone: '1' }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    prisma.visaApplication.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications?limit=10000')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(prisma.visaApplication.findMany.mock.calls[0][0].take).toBe(200);
  });

  test('list throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockRejectedValue(new Error('mysql connection refused'));
    const res = await request(makeApp())
      .get('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/mysql connection refused/);
  });
});

// ─── GET /applications/:id (detail) ───────────────────────────────────

describe('GET /applications/:id — error paths + happy path', () => {
  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
  });

  test('application not found on tenant → 404 NOT_FOUND', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // Sub-brand contact lookup never fires.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('application found with any contact brand → 200 returns the contact projection', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, contactId: 99, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake', documentChecklist: [],
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, name: 'Stray', email: 's@x', phone: '0', source: 'web', subBrand: 'other-brand',
    });
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 50, contactId: 99 });
    expect(res.body.contact).toMatchObject({ id: 99, subBrand: 'other-brand' });
  });
  test('happy path: returns application + contact + diagnostic + documentChecklist', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, contactId: 11, applicationType: 'work',
      destinationCountry: 'UK', status: 'docs-pending',
      readinessLevel: 2, complexCase: false, advisorRiskFlag: 'low',
      rejectionHistoryJson: null, filedAt: null, decidedAt: null,
      outcome: null, outcomeReason: null, recoveryProgramId: null,
      createdAt: new Date('2026-05-01').toISOString(),
      updatedAt: new Date('2026-05-10').toISOString(),
      documentChecklist: [
        { id: 1, docType: 'passport', required: true, status: 'received', attachmentId: null, notes: null },
        { id: 2, docType: 'photos', required: true, status: 'pending', attachmentId: null, notes: null },
      ],
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, name: 'Aarav S', email: 'aarav@x.test', phone: '+91-90',
      source: 'google-ads', subBrand: 'other-brand',
    });
    mockFindLatestDiagnostic.mockResolvedValue({
      id: 7, classification: 'high', classificationLabel: 'High readiness',
      recommendedTier: 'premium', score: 0.82,
      createdAt: new Date('2026-04-20').toISOString(),
    });

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 50, applicationType: 'work', destinationCountry: 'UK',
      status: 'docs-pending',
    });
    expect(res.body.contact).toMatchObject({ id: 11, subBrand: 'other-brand' });
    expect(res.body.diagnostic).toMatchObject({
      id: 7, classification: 'high', recommendedTier: 'premium', score: 0.82,
    });
    expect(res.body.documentChecklist).toHaveLength(2);
    // Diagnostic helper called with (prisma, tenantId, contactId, 'other-brand').
    expect(mockFindLatestDiagnostic.mock.calls[0][1]).toBe(1);
    expect(mockFindLatestDiagnostic.mock.calls[0][2]).toBe(11);
    expect(mockFindLatestDiagnostic.mock.calls[0][3]).toBe('other-brand');
  });

  test('diagnostic helper throws → diagnostic=null but response is still 200', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 51, tenantId: 1, contactId: 11, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake', documentChecklist: [],
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, name: 'A', email: 'a@x', phone: '1', source: 'web', subBrand: null,
    });
    mockFindLatestDiagnostic.mockRejectedValue(new Error('diagnostic table missing'));

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/51')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.diagnostic).toBeNull();
  });
});

// ─── POST /applications (create) ──────────────────────────────────────

describe('POST /applications ? validation + happy path', () => {
  test('no contactId and no applicantName ? 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ applicationType: 'tourist', destinationCountry: 'AE' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('applicationType not in enum ? 400 INVALID_APPLICATION_TYPE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'family', destinationCountry: 'AE' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_APPLICATION_TYPE' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('destinationCountry > 200 chars ? 400 INVALID_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'tourist', destinationCountry: 'X'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DESTINATION' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('contact not on tenant ? 404 NOT_FOUND', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 9999, applicationType: 'tourist', destinationCountry: 'AE' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('contact exists with any sub-brand → 201 existing contact is accepted', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.visaApplication.create.mockResolvedValue({
      id: 101, tenantId: 1, contactId: 11, applicationType: 'umrah',
      destinationCountry: 'SA', status: 'intake',
      readinessLevel: null, advisorRiskFlag: null, complexCase: false,
      filedAt: null, decidedAt: null, outcome: null,
      createdAt: new Date('2026-05-25').toISOString(),
      updatedAt: new Date('2026-05-25').toISOString(),
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'umrah', destinationCountry: 'SA' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 101, contactId: 11, contactResolution: 'existing' });
    expect(prisma.visaApplication.create).toHaveBeenCalled();
  });
  test('invalid future applicantBirthDate ? 400 INVALID_BIRTHDATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        applicantName: 'Rajesh Kumar',
        applicantBirthDate: '2099-01-01',
        applicationType: 'tourist',
        destinationCountry: 'AE',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BIRTHDATE' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('new applicant without existing contact → creates a generic contact and application', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.contact.create.mockResolvedValue({ id: 222 });
    prisma.visaApplication.create.mockResolvedValue({
      id: 101, tenantId: 1, contactId: 222, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake',
      readinessLevel: null, advisorRiskFlag: null, complexCase: false,
      filedAt: null, decidedAt: null, outcome: null,
      createdAt: new Date('2026-05-25').toISOString(),
      updatedAt: new Date('2026-05-25').toISOString(),
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        applicantName: 'Rajesh Kumar',
        applicantEmail: 'rajesh@example.test',
        applicantPhone: '6200039874',
        applicantBirthDate: '1990-08-01',
        applicationType: 'tourist',
        destinationCountry: 'AE',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 101,
      status: 'intake',
      contactId: 222,
      contactResolution: 'created',
    });
    expect(prisma.contact.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1,
        name: 'Rajesh Kumar',
        email: 'rajesh@example.test',
        phone: '6200039874',
        subBrand: null,
        status: 'Lead',
        source: 'visa-intake',
        assignedToId: 7,
      },
      select: { id: true },
    });
    expect(prisma.visaApplication.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1,
        contactId: 222,
        applicationType: 'tourist',
        destinationCountry: 'AE',
        status: 'intake',
      },
    });
  });

  test('matching applicant by email + DOB ? reuses existing other-brand contact', async () => {
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 333,
        name: 'Rajesh Kumar',
        email: 'rajesh@example.test',
        phone: '6200039874',
        birthDate: new Date('1990-08-01T00:00:00.000Z'),
      },
    ]);
    prisma.visaApplication.create.mockResolvedValue({
      id: 102, tenantId: 1, contactId: 333, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake',
      readinessLevel: null, advisorRiskFlag: null, complexCase: false,
      filedAt: null, decidedAt: null, outcome: null,
      createdAt: new Date('2026-05-25').toISOString(),
      updatedAt: new Date('2026-05-25').toISOString(),
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        applicantName: 'Rajesh Kumar',
        applicantEmail: 'rajesh@example.test',
        applicantBirthDate: '1990-08-01',
        applicationType: 'tourist',
        destinationCountry: 'AE',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ contactId: 333, contactResolution: 'matched' });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.visaApplication.create.mock.calls[0][0]).toMatchObject({
      data: { contactId: 333 },
    });
  });

  test('happy path: 201 returns created row with status=intake; create called with tenant + fields', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.passportIdentity.findFirst.mockResolvedValue({ id: 444 });
    prisma.visaApplication.create.mockResolvedValue({
      id: 101, tenantId: 1, contactId: 11, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake',
      readinessLevel: null, advisorRiskFlag: null, complexCase: false,
      filedAt: null, decidedAt: null, outcome: null,
      createdAt: new Date('2026-05-25').toISOString(),
      updatedAt: new Date('2026-05-25').toISOString(),
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'tourist', destinationCountry: 'AE' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 101, status: 'intake', applicationType: 'tourist', destinationCountry: 'AE', contactResolution: 'existing',
    });
    expect(prisma.visaApplication.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1, contactId: 11, applicationType: 'tourist',
        destinationCountry: 'AE', passportIdentityId: 444, status: 'intake',
      },
    });
    expect(prisma.contact.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 11, tenantId: 1 },
      select: { id: true, subBrand: true },
    });
  });

  test('happy path with trip binding: validates trip + participant and stores both on the application', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.tmcTrip.findFirst.mockResolvedValue({ id: 9001 });
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 501 });
    prisma.passportIdentity.findFirst.mockResolvedValue(null);
    prisma.visaApplication.create.mockResolvedValue({
      id: 103, tenantId: 1, contactId: 11, applicationType: 'tourist',
      destinationCountry: 'Vietnam', status: 'intake', tripId: 9001, participantId: 501,
      readinessLevel: null, advisorRiskFlag: null, complexCase: false,
      filedAt: null, decidedAt: null, outcome: null,
      createdAt: new Date('2026-05-25').toISOString(),
      updatedAt: new Date('2026-05-25').toISOString(),
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 11,
        tripId: 9001,
        participantId: 501,
        applicationType: 'tourist',
        destinationCountry: 'Vietnam',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 103,
      contactId: 11,
      tripId: 9001,
      participantId: 501,
      contactResolution: 'existing',
    });
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith({
      where: { id: 9001, tenantId: 1 },
      select: { id: true },
    });
    expect(prisma.tripParticipant.findFirst).toHaveBeenCalledWith({
      where: { id: 501, tripId: 9001 },
      select: { id: true },
    });
    expect(prisma.visaApplication.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1,
        contactId: 11,
        applicationType: 'tourist',
        destinationCountry: 'Vietnam',
        tripId: 9001,
        participantId: 501,
        status: 'intake',
      },
    });
  });

  test('snapshot-backed create returns checklist snapshot fields', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.passportIdentity.findFirst.mockResolvedValue(null);
    prisma.visaChecklistTemplate.findMany.mockResolvedValue([
      { docType: 'Passport', required: true, sortOrder: 0, notes: null },
    ]);
    prisma.visaChecklistSource.findMany.mockResolvedValue([]);
    prisma.visaChecklistSnapshot.findFirst.mockResolvedValue(null);
    prisma.visaChecklistSnapshot.create.mockResolvedValue({
      id: 77,
      tenantId: 1,
      applicationType: 'tourist',
      destinationCountry: 'AE',
      versionNumber: 1,
      snapshotHash: 'hash-77',
      itemsJson: '[{"docType":"Passport","required":true,"sortOrder":0,"notes":null}]',
      sourceListJson: '[]',
      createdAt: new Date('2026-05-25').toISOString(),
    });
    prisma.visaApplication.create.mockResolvedValue({
      id: 101,
      tenantId: 1,
      contactId: 11,
      applicationType: 'tourist',
      destinationCountry: 'AE',
      status: 'intake',
    });
    prisma.visaApplication.update.mockResolvedValue({
      id: 101,
      tenantId: 1,
      contactId: 11,
      applicationType: 'tourist',
      destinationCountry: 'AE',
      status: 'intake',
      checklistSnapshotId: 77,
      checklistSnapshotVersion: 1,
      checklistSnapshotJson: '[{"docType":"Passport","required":true,"sortOrder":0,"notes":null}]',
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'tourist', destinationCountry: 'AE' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 101,
      status: 'intake',
      checklistSnapshotId: 77,
      checklistSnapshotVersion: 1,
    });
    expect(prisma.visaDocumentChecklistItem.createMany).toHaveBeenCalled();
  });
});
describe('PATCH /applications/:id — validation + status transitions', () => {
  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'filed' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
  });

  test('application not found → 404 NOT_FOUND', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'filed' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.visaApplication.update).not.toHaveBeenCalled();
  });

  test('empty body (no updatable fields) → 400 EMPTY_BODY', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.visaApplication.update).not.toHaveBeenCalled();
  });

  test('invalid status enum → 400 INVALID_STATUS', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.visaApplication.update).not.toHaveBeenCalled();
  });

  test('invalid risk flag → 400 INVALID_RISK_FLAG', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ advisorRiskFlag: 'EXTREME' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_RISK_FLAG' });
    expect(prisma.visaApplication.update).not.toHaveBeenCalled();
  });

  test('advisorRiskFlag: "" clears the flag (writes null)', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.visaApplication.update.mockResolvedValue({
      id: 50, tenantId: 1, contactId: 11, advisorRiskFlag: null, status: 'intake',
    });
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ advisorRiskFlag: '' });
    expect(res.status).toBe(200);
    expect(prisma.visaApplication.update.mock.calls[0][0]).toMatchObject({
      where: { id: 50 },
      data: { advisorRiskFlag: null },
    });
  });

  test('status transition (intake → filed) fires safeEmitEvent("visa.status_changed")', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.visaApplication.update.mockResolvedValue({
      id: 50, tenantId: 1, contactId: 11, status: 'filed',
    });

    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'filed' });
    expect(res.status).toBe(200);
    expect(mockSafeEmitEvent).toHaveBeenCalledTimes(1);
    const [eventName, payload, tenantArg, context] = mockSafeEmitEvent.mock.calls[0];
    expect(eventName).toBe('visa.status_changed');
    expect(payload).toMatchObject({
      id: 50, contactId: 11, subBrand: null,
      oldStatus: 'intake', newStatus: 'filed', tenantId: 1,
    });
    expect(tenantArg).toBe(1);
    expect(context).toBe('travel-visa/patch');
  });

  test('no-op status (intake → intake) does NOT fire safeEmitEvent', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'other-brand' });
    prisma.visaApplication.update.mockResolvedValue({
      id: 50, tenantId: 1, contactId: 11, status: 'intake', complexCase: true,
    });
    // Submit a PATCH that mutates complexCase but not status. Event must
    // NOT fire — the route's guard is `data.status && data.status !== existing.status`.
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ complexCase: true });
    expect(res.status).toBe(200);
    expect(mockSafeEmitEvent).not.toHaveBeenCalled();
  });
});


describe('POST /applications/:id/letters/generate', () => {
  test('happy path generates four letter PDFs without mutating checklist status', async () => {
    const templates = [
      ['parental-consent-letter', 'Parental Consent Letter'],
      ['cover-letter', 'Cover Letter'],
      ['no-objection-certificate', 'No Objection Certificate'],
      ['sponsorship-letter', 'Sponsorship Letter'],
    ].map(([code, documentType], index) => ({
      id: index + 1,
      tenantId: 1,
      code,
      name: documentType,
      documentType,
      version: 1,
      contentHtml: `<h1>${documentType}</h1><p>{{child_name}} {{passport_no}}</p>`,
      requiredFieldsJson: '[]',
      isActive: true,
    }));

    prisma.visaApplication.findFirst
      .mockResolvedValueOnce({
        id: 50,
        tenantId: 1,
        contactId: 11,
        applicationType: 'tourist',
        destinationCountry: 'JP',
        status: 'intake',
        documentChecklist: [],
      })
      .mockResolvedValueOnce({
        id: 50,
        tenantId: 1,
        contactId: 11,
        applicationType: 'tourist',
        destinationCountry: 'JP',
        passportIdentityId: 444,
      });

    prisma.contact.findFirst
      .mockResolvedValueOnce({
        id: 11,
        name: 'Riya Sharma',
        email: 'riya@test.example',
        phone: '+919111111111',
        subBrand: null,
      })
      .mockResolvedValueOnce({
        id: 11,
        name: 'Riya Sharma',
        email: 'riya@test.example',
        phone: '+919111111111',
        company: null,
        subBrand: null,
      })
      .mockResolvedValueOnce({
        id: 77,
        name: 'Tokyo High School',
        company: 'Tokyo High School',
        email: 'school@example.test',
        phone: '+81311112222',
      });

    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 9001,
      tripCode: 'tokyo-spring',
      destination: 'Japan',
      departDate: '2026-09-10',
      returnDate: '2026-09-20',
      schoolContactId: 77,
    });

    prisma.tripParticipant.findFirst.mockResolvedValue({
      id: 501,
      fullName: 'Aarav Sharma',
      parentName: 'Riya Sharma',
      parentPhone: '+919111111111',
      parentEmail: 'riya@test.example',
      passportNumber: 'M1234567',
    });

    prisma.visaLetterTemplate.findMany.mockResolvedValue(templates);
    prisma.visaLetterGeneration.create.mockImplementation(async ({ data }) => ({
      id: 700,
      generatedAt: new Date('2026-08-10T00:00:00Z'),
      createdAt: new Date('2026-08-10T00:00:00Z'),
      ...data,
    }));
    prisma.visaLetterDocument.create.mockImplementation(async ({ data }) => ({
      id: 800 + prisma.visaLetterDocument.create.mock.calls.length,
      generatedAt: new Date('2026-08-10T00:00:00Z'),
      ...data,
    }));
    mockVisaLetterStoreStore.mockImplementation(async (_buffer, opts) => ({
      storage: 'disk',
      url: `/api/uploads/visa-letters/${opts.fileName}`,
      key: opts.fileName,
    }));

    const res = await request(makeApp())
      .post('/api/travel/visa/applications/50/letters/generate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ tripId: 9001, participantId: 501 });

    expect(res.status).toBe(201);
    expect(res.body.generation).toMatchObject({
      id: 700,
      status: 'GENERATED',
      tripId: 9001,
      participantId: 501,
    });
    expect(res.body.generated).toHaveLength(4);
    expect(res.body.skipped).toEqual([]);
    expect(prisma.visaApplication.update).not.toHaveBeenCalled();
    expect(prisma.tripParticipant.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501, tripId: 9001 },
    }));
    expect(prisma.visaDocumentChecklistItem.create).not.toHaveBeenCalled();
    expect(prisma.visaLetterGeneration.create).toHaveBeenCalledTimes(1);
    expect(prisma.visaLetterDocument.create).toHaveBeenCalledTimes(4);
    expect(mockVisaLetterStoreStore).toHaveBeenCalledTimes(4);
    expect(mockVisaLetterStoreRemove).not.toHaveBeenCalled();
  });

  test('DELETE /applications/:id/letters/:letterId removes the stored files and packet row', async () => {
    prisma.visaApplication.findFirst
      .mockResolvedValueOnce({
        id: 50,
        tenantId: 1,
        contactId: 11,
        applicationType: 'tourist',
        destinationCountry: 'JP',
        status: 'intake',
        documentChecklist: [],
      })
      .mockResolvedValueOnce({
        id: 50,
        tenantId: 1,
        contactId: 11,
        applicationType: 'tourist',
        destinationCountry: 'JP',
        passportIdentityId: 444,
      });
    prisma.contact.findFirst
      .mockResolvedValueOnce({
        id: 11,
        name: 'Riya Sharma',
        email: 'riya@test.example',
        phone: '+919111111111',
        subBrand: null,
      })
      .mockResolvedValueOnce({
        id: 11,
        name: 'Riya Sharma',
        email: 'riya@test.example',
        phone: '+919111111111',
        company: null,
        subBrand: null,
      });
    prisma.tmcTrip.findFirst.mockResolvedValue({
      id: 9001,
      tripCode: 'tokyo-spring',
      destination: 'Japan',
      departDate: '2026-09-10',
      returnDate: '2026-09-20',
      schoolContactId: 77,
    });
    prisma.tripParticipant.findFirst.mockResolvedValue({
      id: 501,
      fullName: 'Aarav Sharma',
      parentName: 'Riya Sharma',
      parentPhone: '+919111111111',
      parentEmail: 'riya@test.example',
      passportNumber: 'M1234567',
    });
    prisma.visaLetterDocument.findFirst.mockResolvedValue({
      id: 801,
      tenantId: 1,
      visaApplicationId: 50,
      generationId: 700,
      generatedFileStorage: 'disk',
      generatedFileKey: 'applications-50/participants-501/generated/generated.pdf',
      signedFileStorage: 'disk',
      signedFileKey: 'applications-50/participants-501/signed/signed.pdf',
    });
    prisma.visaLetterDocument.findMany.mockResolvedValue([]);
    prisma.visaLetterDocument.delete.mockResolvedValue({ id: 801 });
    prisma.visaLetterGeneration.delete.mockResolvedValue({ id: 700 });

    const res = await request(makeApp())
      .delete('/api/travel/visa/applications/50/letters/801')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      id: 801,
      generationId: 700,
      generationDeleted: true,
    });
    expect(mockVisaLetterStoreRemove).toHaveBeenCalledTimes(2);
    expect(prisma.visaLetterDocument.delete).toHaveBeenCalledWith({ where: { id: 801 } });
    expect(prisma.visaLetterGeneration.delete).toHaveBeenCalledWith({ where: { id: 700 } });
  });
});

describe('checklist import endpoints', () => {
  test('GET /checklists/import-template returns CSV template', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/checklists/import-template?format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('travel-visa-checklists-template.csv');
    expect(res.text).toContain('applicationType');
    expect(res.text).toContain('Passport');
  });

  test('GET /checklists/import-template returns XLSX when requested', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/checklists/import-template?format=xlsx')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  test('POST /checklists/import.csv upserts rows from CSV upload', async () => {
    prisma.visaChecklistTemplate.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 22 });
    prisma.visaChecklistTemplate.create.mockResolvedValue({ id: 21 });
    prisma.visaChecklistTemplate.update.mockResolvedValue({ id: 22 });
    const csv = [
      'applicationType,destinationCountry,docType,required,sortOrder,notes',
      '# tourist | business | student | work | umrah | hajj,US,Passport,true,0,Example row. Delete this row before importing.',
      'tourist,US,Passport,true,1,Keep passport',
      'tourist,US,Photo,false,2,No photo',
    ].join('\n');
    const res = await request(makeApp())
      .post('/api/travel/visa/checklists/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .attach('file', Buffer.from(csv, 'utf8'), 'visa-checklists.csv');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 1, skipped: 0 });
    expect(prisma.visaChecklistTemplate.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1,
        applicationType: 'tourist',
        destinationCountry: 'US',
        docType: 'Passport',
        required: true,
        sortOrder: 1,
        notes: 'Keep passport',
      },
    });
    expect(prisma.visaChecklistTemplate.update.mock.calls[0][0]).toMatchObject({
      where: { id: 22 },
      data: {
        applicationType: 'tourist',
        destinationCountry: 'US',
        docType: 'Photo',
        required: false,
        sortOrder: 2,
        notes: 'No photo',
      },
    });
  });

  test('POST /checklists/import.csv accepts xlsx uploads', async () => {
    const xlsx = toXlsxBuffer(
      ['applicationType', 'destinationCountry', 'docType', 'required', 'sortOrder', 'notes'],
      [{ applicationType: 'tourist', destinationCountry: 'US', docType: 'Bank statement', required: true, sortOrder: 0, notes: '' }],
      'Visa Checklists Template',
    );
    prisma.visaChecklistTemplate.findFirst.mockResolvedValueOnce(null);
    prisma.visaChecklistTemplate.create.mockResolvedValue({ id: 33 });
    const res = await request(makeApp())
      .post('/api/travel/visa/checklists/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .attach('file', xlsx, 'visa-checklists.xlsx');
    expect(res.status).toBe(200);
    expect(prisma.visaChecklistTemplate.create).toHaveBeenCalled();
  });
});

describe('travel-visa checklist snapshots + source library', () => {
  test('POST /checklists/sources creates a source and refreshes the snapshot', async () => {
    prisma.visaChecklistTemplate.findMany.mockResolvedValue([
      { docType: 'Passport', required: true, sortOrder: 0, notes: null },
    ]);
    prisma.visaChecklistSource.findMany.mockResolvedValue([]);
    prisma.visaChecklistSnapshot.findFirst.mockResolvedValue(null);
    prisma.visaChecklistSnapshot.create.mockResolvedValue({
      id: 77,
      tenantId: 1,
      applicationType: 'tourist',
      destinationCountry: 'US',
      versionNumber: 1,
      snapshotHash: 'hash-77',
      itemsJson: '[{"docType":"Passport","required":true,"sortOrder":0,"notes":null}]',
      sourceListJson: '[]',
      createdAt: new Date('2026-05-25').toISOString(),
    });
    prisma.visaChecklistSource.create.mockResolvedValue({
      id: 31,
      tenantId: 1,
      applicationType: 'tourist',
      destinationCountry: 'US',
      sourceName: 'US consulate',
      sourceUrl: 'https://example.test/checklist.pdf',
      sourceKind: 'pdf',
      notes: 'Official PDF',
      isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/travel/visa/checklists/sources')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        applicationType: 'tourist',
        destinationCountry: 'US',
        sourceName: 'US consulate',
        sourceUrl: 'https://example.test/checklist.pdf',
        sourceKind: 'pdf',
        notes: 'Official PDF',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 31,
      sourceName: 'US consulate',
      isActive: true,
    });
    expect(prisma.visaChecklistSource.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1,
        applicationType: 'tourist',
        destinationCountry: 'US',
        sourceName: 'US consulate',
        sourceUrl: 'https://example.test/checklist.pdf',
        sourceKind: 'pdf',
        isActive: true,
      },
    });
    expect(prisma.visaChecklistSnapshot.create).toHaveBeenCalled();
  });


  test('GET /checklists returns archived sources in the management list', async () => {
    prisma.visaChecklistTemplate.findMany.mockResolvedValue([
      { id: 11, applicationType: 'tourist', destinationCountry: 'US', docType: 'Passport', required: true, sortOrder: 0, notes: null, isActive: true },
    ]);
    prisma.visaChecklistSource.findMany.mockResolvedValue([
      { id: 31, applicationType: 'tourist', destinationCountry: 'US', sourceName: 'US consulate', sourceUrl: 'https://example.test/checklist.pdf', sourceKind: 'pdf', notes: null, isActive: true },
      { id: 32, applicationType: 'tourist', destinationCountry: 'US', sourceName: 'Archived PDF', sourceUrl: 'https://example.test/archived.pdf', sourceKind: 'pdf', notes: 'Old copy', isActive: false },
    ]);
    prisma.visaChecklistSnapshot.findFirst.mockResolvedValue({
      id: 77,
      tenantId: 1,
      applicationType: 'tourist',
      destinationCountry: 'US',
      versionNumber: 4,
      itemsJson: '[{"docType":"Passport","required":true,"sortOrder":0,"notes":null}]',
      sourceListJson: '[{"id":31,"sourceName":"US consulate","sourceUrl":"https://example.test/checklist.pdf","sourceKind":"pdf","notes":null,"isActive":true}]',
      createdAt: new Date('2026-05-25').toISOString(),
    });

    const res = await request(makeApp())
      .get('/api/travel/visa/checklists?applicationType=tourist&destinationCountry=US')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(2);
    expect(res.body.latestSnapshot).toMatchObject({ versionNumber: 4, itemCount: 1, sourceCount: 1 });
    expect(prisma.visaChecklistSource.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, applicationType: 'tourist', destinationCountry: 'US' },
    });
  });
  test('DELETE /checklists/sources/:id archives instead of deleting', async () => {
    prisma.visaChecklistSource.findFirst.mockResolvedValue({
      id: 31,
      applicationType: 'tourist',
      destinationCountry: 'US',
    });
    prisma.visaChecklistSource.update.mockResolvedValue({
      id: 31,
      applicationType: 'tourist',
      destinationCountry: 'US',
      sourceName: 'US consulate',
      sourceUrl: 'https://example.test/checklist.pdf',
      sourceKind: 'pdf',
      notes: null,
      isActive: false,
    });

    const res = await request(makeApp())
      .delete('/api/travel/visa/checklists/sources/31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, id: 31 });
    expect(prisma.visaChecklistSource.update.mock.calls[0][0]).toMatchObject({
      where: { id: 31 },
      data: { isActive: false },
    });
    expect(prisma.visaChecklistSource.delete).toBeUndefined();
  });
});






