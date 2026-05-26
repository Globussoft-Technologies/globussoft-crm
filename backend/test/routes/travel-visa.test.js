// @ts-check
/**
 * Travel CRM — Visa Sure applications route (Phase 3 cluster B3) contract tests.
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
 *   - Role gate: USER role → 403 (verifyRole(['ADMIN','MANAGER'])).
 *   - Vertical gate (via requireTravelTenant): generic-vertical tenant →
 *     403 WRONG_VERTICAL; tenant row missing → 404 TENANT_NOT_FOUND.
 *   - GET /applications happy path: decorates each row with its Contact
 *     projection (id+name+email+phone) using a join-in-app pattern (no
 *     Prisma include), narrows queries to (tenantId, subBrand=visasure).
 *   - GET /applications empty-state: zero visasure contacts returns a
 *     stable shape `{ applications: [], total: 0, limit, offset }` —
 *     never hits visaApplication.findMany / count when contact set empty.
 *   - GET /applications/:id 404 NOT_FOUND (no application on this tenant)
 *     vs 404 NOT_VISA_SURE (application exists but Contact.subBrand !=
 *     'visasure') vs 400 INVALID_ID. Detail-shape includes contact +
 *     diagnostic + documentChecklist.
 *   - POST /applications validation: MISSING_FIELDS (no contactId / no
 *     applicationType / no destinationCountry), INVALID_APPLICATION_TYPE
 *     (enum), INVALID_DESTINATION (>200 chars), NOT_FOUND (contact not on
 *     tenant), NOT_VISA_SURE (contact in a different sub-brand → 403),
 *     happy 201 returns the created row with status='intake'.
 *   - PATCH /applications/:id: field-by-field opt-in, EMPTY_BODY when no
 *     updatable fields, INVALID_STATUS / INVALID_RISK_FLAG enum gates,
 *     null / "" clears advisorRiskFlag, status transitions fire the
 *     `visa.status_changed` event via safeEmitEvent (mocked).
 *
 * Test pattern mirrors backend/test/routes/travel-visa-analytics.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed with the
 * dev-fallback secret. verifyToken + verifyRole + requireTravelTenant
 * stay in the chain (no bypass) so the guards are exercised end-to-end.
 *
 * The eventBus.safeEmitEvent helper is vi.mock()'d at the module level so
 * we can assert it fires on real status transitions without coupling to
 * Socket.io / webhook delivery.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

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
diagnosticModule.findLatestDiagnostic = mockFindLatestDiagnostic;

// ─── Patch prisma singleton BEFORE requiring the router ──────────────
prisma.contact = {
  ...(prisma.contact || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
prisma.visaApplication = {
  ...(prisma.visaApplication || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
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
  prisma.visaApplication.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaApplication.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.count.mockReset().mockResolvedValue(0);
  prisma.visaApplication.create.mockReset();
  prisma.visaApplication.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  mockSafeEmitEvent.mockReset();
  mockFindLatestDiagnostic.mockReset().mockResolvedValue(null);
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
    const res = await request(makeApp())
      .get('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    // verifyRole trips BEFORE requireTravelTenant fires the tenant lookup.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('USER role rejected by verifyRole on PATCH', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/visa/applications/42')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ status: 'filed' });
    expect(res.status).toBe(403);
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
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('tenant row missing → 404 TENANT_NOT_FOUND (detail)', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/77')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
  });
});

// ─── GET /applications (list) ─────────────────────────────────────────

describe('GET /applications — empty + happy paths', () => {
  test('zero visasure contacts → empty envelope without touching visaApplication tables', async () => {
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
    // Contact lookup narrowed to (tenantId, subBrand=visasure).
    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'visasure' },
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
        destinationCountry: 'AE', status: 'intake', readinessLevel: 1,
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

  test('application found but Contact.subBrand != visasure → 404 NOT_VISA_SURE', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, contactId: 99, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake', documentChecklist: [],
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 99, name: 'Stray', email: 's@x', phone: '0', source: 'web', subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_VISA_SURE' });
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
      source: 'google-ads', subBrand: 'visasure',
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
    expect(res.body.contact).toMatchObject({ id: 11, subBrand: 'visasure' });
    expect(res.body.diagnostic).toMatchObject({
      id: 7, classification: 'high', recommendedTier: 'premium', score: 0.82,
    });
    expect(res.body.documentChecklist).toHaveLength(2);
    // Diagnostic helper called with (prisma, tenantId, contactId, 'visasure').
    expect(mockFindLatestDiagnostic.mock.calls[0][1]).toBe(1);
    expect(mockFindLatestDiagnostic.mock.calls[0][2]).toBe(11);
    expect(mockFindLatestDiagnostic.mock.calls[0][3]).toBe('visasure');
  });

  test('diagnostic helper throws → diagnostic=null but response is still 200', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 51, tenantId: 1, contactId: 11, applicationType: 'tourist',
      destinationCountry: 'AE', status: 'intake', documentChecklist: [],
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, name: 'A', email: 'a@x', phone: '1', source: 'web', subBrand: 'visasure',
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

describe('POST /applications — validation + happy path', () => {
  test('no contactId → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ applicationType: 'tourist', destinationCountry: 'AE' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('applicationType not in enum → 400 INVALID_APPLICATION_TYPE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'family', destinationCountry: 'AE' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_APPLICATION_TYPE' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('destinationCountry > 200 chars → 400 INVALID_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'tourist', destinationCountry: 'X'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DESTINATION' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('contact not on tenant → 404 NOT_FOUND', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 9999, applicationType: 'tourist', destinationCountry: 'AE' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('contact exists but Contact.subBrand != visasure → 403 NOT_VISA_SURE', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'rfu' });
    const res = await request(makeApp())
      .post('/api/travel/visa/applications')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 11, applicationType: 'umrah', destinationCountry: 'SA' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_VISA_SURE' });
    expect(prisma.visaApplication.create).not.toHaveBeenCalled();
  });

  test('happy path: 201 returns created row with status=intake; create called with tenant + fields', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
      id: 101, status: 'intake', applicationType: 'tourist', destinationCountry: 'AE',
    });
    expect(prisma.visaApplication.create.mock.calls[0][0]).toMatchObject({
      data: {
        tenantId: 1, contactId: 11, applicationType: 'tourist',
        destinationCountry: 'AE', status: 'intake',
      },
    });
    // Sub-brand check narrows by (id, tenantId) → defense-in-depth for tenant isolation.
    expect(prisma.contact.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 11, tenantId: 1 },
      select: { id: true, subBrand: true },
    });
  });
});

// ─── PATCH /applications/:id (status + field edits) ───────────────────

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
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
      id: 50, contactId: 11, subBrand: 'visasure',
      oldStatus: 'intake', newStatus: 'filed', tenantId: 1,
    });
    expect(tenantArg).toBe(1);
    expect(context).toBe('travel-visa/patch');
  });

  test('no-op status (intake → intake) does NOT fire safeEmitEvent', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 50, contactId: 11, status: 'intake' });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
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
