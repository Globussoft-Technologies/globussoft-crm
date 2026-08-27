// @ts-check
/**
 * Unit tests for backend/routes/wellness_prescription_requests.js — the STAFF
 * half of the prescription renewal / medicine-request workflow.
 *
 * Why this file exists
 * ────────────────────
 * The route module is deliberately thin (all logic lives in
 * lib/prescriptionRenewalService.js, pinned by
 * test/lib/prescriptionRenewalService.test.js), so what needs pinning HERE is
 * the wire contract the admin page depends on and the RBAC shape:
 *   • the list envelope is { items, total, counts } — the page's status tabs
 *     read `counts`, and a regression to a bare array silently blanks them;
 *   • every read is tenant-scoped from the JWT, never from the querystring;
 *   • a request from another tenant is a 404, not a leak;
 *   • RenewalRequestError's status/code reach the client verbatim, because
 *     the page branches on the code (e.g. REJECTION_REASON_REQUIRED);
 *   • the write gate is narrower than the read gate — a telecaller can see
 *     the queue but cannot accept or reject a renewal.
 *
 * Endpoints under test
 * ────────────────────
 *   GET   /prescription-requests
 *   GET   /prescription-requests/:id
 *   PATCH /prescription-requests/:id/status
 *
 * Pattern: auth-middleware bypass + prisma singleton monkey-patch, mirroring
 * backend/test/routes/drugs.test.js (synthetic req.user carrying
 * `vertical: 'wellness'` so verifyWellnessRole short-circuits its tenant
 * lookup) and backend/test/routes/accounting.test.js (verifyToken replaced
 * with a pass-through before the router is required).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// verifyToken is destructured at module load, so patch before the require.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

const prisma = requireCJS('../../lib/prisma');

prisma.prescriptionRequest = prisma.prescriptionRequest || {};
prisma.prescriptionRequest.findMany = vi.fn();
prisma.prescriptionRequest.findFirst = vi.fn();
prisma.prescriptionRequest.count = vi.fn();
prisma.prescriptionRequest.groupBy = vi.fn();
prisma.prescriptionRequest.updateMany = vi.fn();

prisma.prescriptionRequestEvent = prisma.prescriptionRequestEvent || {};
prisma.prescriptionRequestEvent.create = vi.fn();

prisma.prescription = prisma.prescription || {};
prisma.prescription.findFirst = vi.fn();

// The review endpoint resolves per-medicine availability through
// lib/drugStock.js, which reads quantity straight off the drug catalogue.
prisma.drug = prisma.drug || {};
prisma.drug.findMany = vi.fn();

prisma.patientNotification = prisma.patientNotification || {};
prisma.patientNotification.create = vi.fn().mockResolvedValue({ id: 1 });

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// verifyWellnessRole falls back to a tenant lookup when req.user.vertical is
// absent; we inject it, but stub defensively.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

// The `anyOfPermissions` escape hatch resolves grants through these two when
// the wellnessRole allow-list misses — stub to "no grants" so the denial path
// under test is reached.
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn().mockResolvedValue([]);
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue(null);
prisma.user.findMany = vi.fn().mockResolvedValue([]);

const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

const router = requireCJS('../../routes/wellness_prescription_requests');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole,
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wellness', router);
  return app;
}

const ROW = {
  id: 30,
  status: 'PENDING',
  prescriptionId: 9,
  patientId: 3,
  doctorId: 11,
  requestedDrugs: null,
  requestedDurationDays: 30,
  requestedFrom: null,
  requestedTo: null,
  notes: 'Running low',
  createdAt: new Date('2026-08-26T09:00:00Z'),
  updatedAt: new Date('2026-08-26T09:00:00Z'),
  tenantId: 1,
  patient: { id: 3, name: 'Asha Menon', phone: '9999295298' },
  doctor: { id: 11, name: 'Dr Rao' },
  prescription: { id: 9, drugs: '[{"name":"Amoxicillin"}]', createdAt: new Date() },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.prescriptionRequest.findMany.mockResolvedValue([]);
  prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
  prisma.prescriptionRequest.count.mockResolvedValue(0);
  prisma.prescriptionRequest.groupBy.mockResolvedValue([]);
  prisma.prescriptionRequest.updateMany.mockResolvedValue({ count: 1 });
  prisma.prescriptionRequestEvent.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.userRole.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.drug.findMany.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /prescription-requests
// ─────────────────────────────────────────────────────────────────────────

describe('GET /prescription-requests', () => {
  test('returns the { items, total, counts } envelope the status tabs read', async () => {
    prisma.prescriptionRequest.findMany.mockResolvedValue([ROW]);
    prisma.prescriptionRequest.count.mockResolvedValue(1);
    prisma.prescriptionRequest.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { _all: 1 } },
    ]);

    const res = await request(makeApp()).get('/api/wellness/prescription-requests');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.counts).toEqual({
      PENDING: 1,
      ACCEPTED: 0,
      REJECTED: 0,
      COMPLETED: 0,
    });
    expect(res.body.items).toHaveLength(1);
    // The derived flag the Android app and the admin table both branch on.
    expect(res.body.items[0].isFullPrescription).toBe(true);
    expect(res.body.items[0].patientName).toBe('Asha Menon');
    expect(res.body.items[0].doctorName).toBe('Dr Rao');
  });

  test('scopes to the caller\'s tenant from the JWT, not the querystring', async () => {
    await request(makeApp({ tenantId: 42 })).get(
      '/api/wellness/prescription-requests?tenantId=1',
    );
    expect(prisma.prescriptionRequest.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 42,
    });
  });

  test('passes the status filter through, normalised', async () => {
    await request(makeApp()).get('/api/wellness/prescription-requests?status=accepted');
    expect(prisma.prescriptionRequest.findMany.mock.calls[0][0].where.status).toBe(
      'ACCEPTED',
    );
  });

  test('an unknown status is ignored rather than returning an empty page', async () => {
    await request(makeApp()).get('/api/wellness/prescription-requests?status=banana');
    expect(
      prisma.prescriptionRequest.findMany.mock.calls[0][0].where.status,
    ).toBeUndefined();
  });

  test('a helper wellnessRole is denied the queue', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: 'helper' })).get(
      '/api/wellness/prescription-requests',
    );
    expect(res.status).toBe(403);
    expect(prisma.prescriptionRequest.findMany).not.toHaveBeenCalled();
  });

  test('a doctor can open the queue — they are notified about their own Rx', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: 'doctor' })).get(
      '/api/wellness/prescription-requests',
    );
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /prescription-requests/:id
// ─────────────────────────────────────────────────────────────────────────

describe('GET /prescription-requests/:id', () => {
  test('404s a request that belongs to another tenant', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 42 })).get(
      '/api/wellness/prescription-requests/30',
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('REQUEST_NOT_FOUND');
    expect(prisma.prescriptionRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 30, tenantId: 42 } }),
    );
  });

  test('returns the review payload: request + original Rx + history', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...ROW,
      prescription: {
        id: 9,
        drugs: '[{"name":"Amoxicillin","dosage":"1 capsule","frequency":"twice daily"}]',
        instructions: 'After food',
        createdAt: new Date(),
        visit: { id: 4, visitDate: new Date(), service: { name: 'Dermatology' } },
      },
      events: [
        { id: 1, action: 'CREATED', toStatus: 'PENDING', actorType: 'patient', createdAt: new Date() },
      ],
    });

    const res = await request(makeApp()).get('/api/wellness/prescription-requests/30');

    expect(res.status).toBe(200);
    expect(res.body.prescription.instructions).toBe('After food');
    expect(res.body.prescription.serviceName).toBe('Dermatology');
    // Drugs come back normalised, same as every other Rx response.
    expect(res.body.prescription.drugs[0]).toMatchObject({ dosage: 1, frequency: 2 });
    expect(res.body.history).toHaveLength(1);
  });

  test('attaches per-medicine availability, scoped to what was requested', async () => {
    // Partial request → availability is about the REQUESTED medicine only,
    // not everything on the source prescription.
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...ROW,
      requestedDrugs: '[{"name":"Minoxidil 5%"}]',
      prescription: {
        id: 9,
        drugs: '[{"name":"Minoxidil 5%"},{"name":"Tramadol"}]',
        createdAt: new Date(),
      },
    });
    prisma.drug.findMany.mockResolvedValue([
      { id: 96, name: 'Minoxidil', quantity: 6, lowStockThreshold: 25, isActive: true },
    ]);

    const res = await request(makeApp()).get('/api/wellness/prescription-requests/30');

    expect(res.status).toBe(200);
    expect(res.body.stock).toHaveLength(1);
    expect(res.body.stock[0]).toMatchObject({
      name: 'Minoxidil 5%',
      state: 'low',
      drugName: 'Minoxidil',
      quantity: 6,
    });
    expect(res.body.stockSummary).toMatchObject({ summary: 'low', low: 1, total: 1 });
  });

  test('a medicine the catalogue has never seen reports unknown, never out of stock', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...ROW,
      requestedDrugs: '[{"name":"Tramadol"}]',
    });
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/wellness/prescription-requests/30');

    expect(res.body.stock[0].state).toBe('not_in_catalogue');
    expect(res.body.stock[0].state).not.toBe('out');
    // A wholly-unknown set must not read as available.
    expect(res.body.stockSummary.summary).toBe('unknown');
  });

  test('a full-prescription request reports on every medicine on the Rx', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...ROW,
      requestedDrugs: null, // full-Rx
      prescription: {
        id: 9,
        drugs: '[{"name":"A"},{"name":"B"},{"name":"C"}]',
        createdAt: new Date(),
      },
    });
    const res = await request(makeApp()).get('/api/wellness/prescription-requests/30');
    expect(res.body.stock).toHaveLength(3);
  });

  test('a stock lookup failure degrades to null, it does not 500 the review', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...ROW,
      requestedDrugs: '[{"name":"Minoxidil 5%"}]',
    });
    prisma.drug.findMany.mockRejectedValue(new Error('inventory db is down'));

    const res = await request(makeApp()).get('/api/wellness/prescription-requests/30');

    // The request itself is the point of this endpoint — losing availability
    // must not cost the reviewer the whole screen.
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(30);
    expect(res.body.stock).toBeNull();
    expect(res.body.stockSummary).toBeNull();
  });

  test('a non-numeric id is a 404, not a 500', async () => {
    const res = await request(makeApp()).get('/api/wellness/prescription-requests/abc');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /prescription-requests/:id/status
// ─────────────────────────────────────────────────────────────────────────

describe('PATCH /prescription-requests/:id/status', () => {
  test('accepts a pending request and returns the updated row', async () => {
    prisma.prescriptionRequest.findFirst
      .mockResolvedValueOnce(ROW)
      .mockResolvedValueOnce({ ...ROW, status: 'ACCEPTED', reviewedById: 7 });

    const res = await request(makeApp())
      .patch('/api/wellness/prescription-requests/30/status')
      .send({ status: 'ACCEPTED', note: 'Repeat for 30 days' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACCEPTED');
    expect(prisma.prescriptionRequest.updateMany).toHaveBeenCalled();
    expect(prisma.prescriptionRequestEvent.create).toHaveBeenCalled();
  });

  test('surfaces REJECTION_REASON_REQUIRED verbatim so the page can branch on it', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(ROW);

    const res = await request(makeApp())
      .patch('/api/wellness/prescription-requests/30/status')
      .send({ status: 'REJECTED' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REJECTION_REASON_REQUIRED');
    expect(prisma.prescriptionRequest.updateMany).not.toHaveBeenCalled();
  });

  test('a closed request cannot be reopened', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue({
      ...ROW,
      status: 'REJECTED',
    });

    const res = await request(makeApp())
      .patch('/api/wellness/prescription-requests/30/status')
      .send({ status: 'ACCEPTED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REQUEST_CLOSED');
  });

  test('an unknown status is a 400', async () => {
    prisma.prescriptionRequest.findFirst.mockResolvedValue(ROW);
    const res = await request(makeApp())
      .patch('/api/wellness/prescription-requests/30/status')
      .send({ status: 'DISPENSED_MAYBE' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });

  test('a telecaller can read the queue but cannot action a request', async () => {
    const readRes = await request(
      makeApp({ role: 'USER', wellnessRole: 'telecaller' }),
    ).get('/api/wellness/prescription-requests');
    expect(readRes.status).toBe(200);

    const writeRes = await request(
      makeApp({ role: 'USER', wellnessRole: 'telecaller' }),
    )
      .patch('/api/wellness/prescription-requests/30/status')
      .send({ status: 'ACCEPTED' });
    expect(writeRes.status).toBe(403);
    expect(prisma.prescriptionRequest.updateMany).not.toHaveBeenCalled();
  });
});
