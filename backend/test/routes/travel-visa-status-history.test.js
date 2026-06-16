// @ts-check
/**
 * Travel CRM — Visa Sure GET /api/travel/visa/applications/:id/status-history
 * contract tests (Phase 3 cluster B3, audit-trail slice mirroring #900
 * slice 15 + #908 slice 18).
 *
 * Pins backend/routes/travel_visa.js (status-history surface):
 *
 *   GET /api/travel/visa/applications/:id/status-history
 *
 * What's pinned
 * -------------
 *   - Auth + role gate: USER role → 403 (requirePermission('visa','read')).
 *   - INVALID_ID: non-numeric :id → 400.
 *   - APPLICATION_NOT_FOUND: no row in {id, tenantId} → 404 (tenant-scoped
 *     lookup catches cross-tenant ids).
 *   - NOT_VISA_SURE: application exists but Contact.subBrand != 'visasure'
 *     → 404 (sub-brand isolation, defense-in-depth).
 *   - Happy path: 3 CREATE/UPDATE audit rows → returns 3 history entries
 *     in ASC chronological order with parsed details and surfaced
 *     fromStatus/toStatus projections.
 *   - Limit clamp: ?limit=2 → take=2; ?limit=999 → take=500 (max);
 *     ?limit=0 / negative → defaults to 100.
 *   - Empty defensive: no audit rows → 200 with {applicationId, total: 0,
 *     history: []}, NOT 404.
 *   - JSON details parsing: string-stored details JSON parses cleanly;
 *     malformed JSON folds to {_raw: <original-string>}.
 *   - Date bound validation: ?from=garbage → 400 INVALID_DATE_BOUND.
 *
 * Mocking pattern mirrors backend/test/routes/travel-visa.test.js —
 * monkey-patch the prisma singleton BEFORE requiring the router. This
 * keeps verifyToken + requirePermission + requireTravelTenant in the chain
 * (no bypass) so the guards are exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

import { createRequire } from 'node:module';
const requireCJS_init = createRequire(import.meta.url);

// findLatestDiagnostic / eventBus aren't reachable from this endpoint but
// the route module loads them at the top — pre-stub so they don't try to
// hit a real DB at module-load time.
const eventBusModule = requireCJS_init('../../lib/eventBus');
eventBusModule.safeEmitEvent = vi.fn();
const diagnosticModule = requireCJS_init('../../lib/travelLatestDiagnostic');
diagnosticModule.findLatestDiagnostic = vi.fn().mockResolvedValue(null);

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
  findMany: vi.fn(),
  count: vi.fn(),
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
  prisma.auditLog.findMany.mockReset().mockResolvedValue([]);
  prisma.auditLog.count.mockReset().mockResolvedValue(0);
});

// ─── Auth + role gate ────────────────────────────────────────────────

describe('GET /applications/:id/status-history — auth gate', () => {
  test('USER role rejected by verifyRole (no application lookup fires)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('missing Bearer → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history');
    expect(res.status).toBe(401);
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
  });
});

// ─── INVALID_ID / APPLICATION_NOT_FOUND ──────────────────────────────

describe('GET /applications/:id/status-history — id resolution', () => {
  test('INVALID_ID: non-numeric :id → 400 (no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/not-a-number/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.visaApplication.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('APPLICATION_NOT_FOUND: no row in {id, tenantId} → 404', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/999/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'APPLICATION_NOT_FOUND' });
    expect(prisma.visaApplication.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 999, tenantId: 1,
    });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404 (tenant-scoped findFirst returns null)', async () => {
    // Application exists in another tenant; tenant-scoped lookup misses.
    prisma.visaApplication.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/55/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'APPLICATION_NOT_FOUND' });
    // The where clause carried the calling tenant's id, not the row's.
    expect(prisma.visaApplication.findFirst.mock.calls[0][0].where.tenantId).toBe(1);
  });
});

// ─── NOT_VISA_SURE sub-brand isolation ───────────────────────────────

describe('GET /applications/:id/status-history — sub-brand gate', () => {
  test('Contact.subBrand != "visasure" → 404 NOT_VISA_SURE', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 42, contactId: 11,
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, subBrand: 'tmc-school-trips',
    });
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_VISA_SURE' });
    // Audit not read — gate trips before the query.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('Contact missing → 404 NOT_VISA_SURE (defense-in-depth)', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 42, contactId: 11,
    });
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_VISA_SURE' });
  });
});

// ─── Happy paths ─────────────────────────────────────────────────────

describe('GET /applications/:id/status-history — happy', () => {
  function primeVisaSureApp() {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 42, contactId: 11,
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, subBrand: 'visasure',
    });
  }

  test('3 audit rows → 3 history entries in chronological order with parsed details + fromStatus/toStatus surfaced', async () => {
    primeVisaSureApp();
    const t1 = new Date('2026-05-01T08:00:00.000Z');
    const t2 = new Date('2026-05-02T10:30:00.000Z');
    const t3 = new Date('2026-05-03T14:15:00.000Z');
    const rows = [
      {
        id: 1, action: 'CREATE', createdAt: t1, userId: 7,
        details: JSON.stringify({ subBrand: 'visasure', contactId: 11, applicationType: 'tourist', destinationCountry: 'AE' }),
      },
      {
        id: 2, action: 'UPDATE', createdAt: t2, userId: 7,
        details: JSON.stringify({ subBrand: 'visasure', changedFields: ['status'], status: 'docs-pending' }),
      },
      {
        id: 3, action: 'STATUS_CHANGE', createdAt: t3, userId: 9,
        details: JSON.stringify({ fromStatus: 'docs-pending', toStatus: 'filed', byUser: 9 }),
      },
    ];
    prisma.auditLog.findMany.mockResolvedValue(rows);
    prisma.auditLog.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.applicationId).toBe(42);
    expect(res.body.total).toBe(3);
    expect(res.body.history).toHaveLength(3);

    // Row 1: CREATE — no fromStatus/toStatus surfaced (no status keys in details).
    expect(res.body.history[0]).toMatchObject({
      at: t1.toISOString(),
      action: 'CREATE',
      fromStatus: null,
      toStatus: null,
      userId: 7,
    });
    expect(res.body.history[0].details).toMatchObject({
      applicationType: 'tourist', destinationCountry: 'AE',
    });

    // Row 2: UPDATE — details carries `status` field (today's PATCH shape).
    // The endpoint surfaces it as `toStatus`.
    expect(res.body.history[1]).toMatchObject({
      action: 'UPDATE',
      fromStatus: null,
      toStatus: 'docs-pending',
      userId: 7,
    });

    // Row 3: STATUS_CHANGE — explicit from/to keys parsed.
    expect(res.body.history[2]).toMatchObject({
      action: 'STATUS_CHANGE',
      fromStatus: 'docs-pending',
      toStatus: 'filed',
      userId: 9,
    });

    // Where clause: tenant + entity + entityId + lifecycle actions; asc.
    const findCall = prisma.auditLog.findMany.mock.calls[0][0];
    expect(findCall.where).toMatchObject({
      tenantId: 1,
      entity: 'VisaApplication',
      entityId: 42,
      action: { in: ['CREATE', 'UPDATE', 'STATUS_CHANGE'] },
    });
    expect(findCall.orderBy).toMatchObject({ createdAt: 'asc' });
  });

  test('Defensive empty: 0 audit rows → {applicationId, total: 0, history: []} (NOT 404)', async () => {
    primeVisaSureApp();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      applicationId: 42,
      total: 0,
      history: [],
    });
  });

  test('?limit=2 clamps take to 2', async () => {
    primeVisaSureApp();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(5);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history?limit=2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(2);
    // total still reflects pre-limit count.
    expect(res.body.total).toBe(5);
  });

  test('?limit=999 clamps to 500 (max)', async () => {
    primeVisaSureApp();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(500);
  });

  test('?limit=0 falls back to default 100', async () => {
    primeVisaSureApp();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history?limit=0')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(100);
  });

  test('JSON details with string-stored value parses cleanly; malformed JSON folds to {_raw}', async () => {
    primeVisaSureApp();
    const t1 = new Date('2026-05-01T08:00:00.000Z');
    const t2 = new Date('2026-05-02T08:00:00.000Z');
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 1, action: 'CREATE', createdAt: t1, userId: 7,
        details: JSON.stringify({ subBrand: 'visasure', applicationType: 'umrah' }),
      },
      {
        id: 2, action: 'UPDATE', createdAt: t2, userId: null,
        details: 'this is not json{',
      },
    ]);
    prisma.auditLog.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.history[0].details).toMatchObject({
      subBrand: 'visasure', applicationType: 'umrah',
    });
    // Malformed JSON → row still surfaced with _raw fallback.
    expect(res.body.history[1].details).toMatchObject({ _raw: 'this is not json{' });
    // System-actor (userId null) tolerated.
    expect(res.body.history[1].userId).toBeNull();
  });

  test('null details row tolerated (surfaces details: null)', async () => {
    primeVisaSureApp();
    const t = new Date('2026-05-01T08:00:00.000Z');
    prisma.auditLog.findMany.mockResolvedValue([
      { id: 1, action: 'CREATE', createdAt: t, userId: 7, details: null },
    ]);
    prisma.auditLog.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.history[0]).toMatchObject({
      action: 'CREATE',
      fromStatus: null,
      toStatus: null,
      details: null,
    });
  });
});

// ─── Date bounds ─────────────────────────────────────────────────────

describe('GET /applications/:id/status-history — date bounds', () => {
  function primeVisaSureApp() {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 42, contactId: 11,
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 11, subBrand: 'visasure',
    });
  }

  test('?from=garbage → 400 INVALID_DATE_BOUND', async () => {
    primeVisaSureApp();
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE_BOUND' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  test('?from=ISO + ?to=ISO narrows the where.createdAt range', async () => {
    primeVisaSureApp();
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.auditLog.count.mockResolvedValue(0);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history?from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.999Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const where = prisma.auditLog.findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect(where.createdAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-05-31T23:59:59.999Z');
  });
});

// ─── Internal error ──────────────────────────────────────────────────

describe('GET /applications/:id/status-history — internal errors', () => {
  test('audit findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({ id: 42, contactId: 11 });
    prisma.contact.findFirst.mockResolvedValue({ id: 11, subBrand: 'visasure' });
    prisma.auditLog.findMany.mockRejectedValue(new Error('mysql gone away'));
    prisma.auditLog.count.mockRejectedValue(new Error('mysql gone away'));
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/42/status-history')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/mysql gone away/);
  });
});
