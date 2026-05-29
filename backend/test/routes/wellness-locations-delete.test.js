/**
 * Unit tests for DELETE /api/wellness/locations/:id
 * (backend/routes/wellness.js — added 2026-05-30).
 *
 * What this pins
 * ──────────────
 *   D1. Endpoint mounted + reachable for ADMIN on a wellness tenant.
 *   D2. 404 when the :id doesn't exist (or is in a different tenant —
 *       tenantWhere scopes the findFirst).
 *   D3. 409 LOCATION_IN_USE when ANY linked child still references the
 *       row. The route counts FIVE FK relations in parallel (patients,
 *       visits, resources, holidays, registers) and refuses the delete
 *       if the SUM > 0 — preserves PHI integrity by routing the operator
 *       toward the soft-disable affordance instead.
 *   D4. 409 envelope carries a per-relation breakdown so the UI can
 *       surface "3 patients + 1 visit still here" instead of a bare
 *       "in use" message.
 *   D5. 200 happy path: prisma.location.delete is called, audit row
 *       written with action=DELETE, response is { ok: true }.
 *   D6. Audit-row failure does NOT roll back the delete (best-effort
 *       writeAudit per the lib's existing pattern).
 *
 * Pattern: clones wellness-patient-anniversary-gst.test.js — prisma
 * singleton monkey-patch + supertest with a fake auth middleware. The
 * `vertical: 'wellness'` claim on req.user lets verifyWellnessRole
 * skip the tenant.findUnique fallback.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by the DELETE handler ────────────────────
prisma.location = {
  findFirst: vi.fn(),
  delete: vi.fn(),
};
prisma.patient = prisma.patient || {};
prisma.patient.count = vi.fn();
prisma.visit = prisma.visit || {};
prisma.visit.count = vi.fn();
prisma.resource = prisma.resource || {};
prisma.resource.count = vi.fn();
prisma.holiday = prisma.holiday || {};
prisma.holiday.count = vi.fn();
prisma.register = prisma.register || {};
prisma.register.count = vi.fn();

// Defensive permissive stubs for surfaces the wellness router touches
// at module-eval time (mirrors wellness-patient-anniversary-gst.test.js).
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.referral = prisma.referral || {
  findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
};
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn(),
};
prisma.auditLog = {
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.automationRule = prisma.automationRule || { findMany: vi.fn().mockResolvedValue([]) };
if (!prisma.automationRule.findMany || !prisma.automationRule.findMany._isMockFunction) {
  prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
}

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // wellnessRole='admin' + vertical='wellness' so verifyWellnessRole's
    // 'admin' allowed-token branch fires immediately without a DB lookup.
    req.user = { userId, tenantId, role, wellnessRole: 'admin', vertical: 'wellness' };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.location.findFirst.mockReset();
  prisma.location.delete.mockReset();
  prisma.patient.count.mockReset();
  prisma.visit.count.mockReset();
  prisma.resource.count.mockReset();
  prisma.holiday.count.mockReset();
  prisma.register.count.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);

  // Sensible defaults — each test overrides as needed.
  prisma.location.delete.mockResolvedValue({ id: 1 });
  prisma.patient.count.mockResolvedValue(0);
  prisma.visit.count.mockResolvedValue(0);
  prisma.resource.count.mockResolvedValue(0);
  prisma.holiday.count.mockResolvedValue(0);
  prisma.register.count.mockResolvedValue(0);
});

// ── D2: 404 not found ───────────────────────────────────────────────

describe('DELETE /api/wellness/locations/:id — D2 not found', () => {
  test('unknown :id → 404, no delete attempted, no audit row', async () => {
    prisma.location.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).delete('/api/wellness/locations/9999');

    expect(res.status).toBe(404);
    expect(prisma.location.delete).not.toHaveBeenCalled();
    expect(prisma.patient.count).not.toHaveBeenCalled();
    // Audit row should not be written for a no-op delete.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('findFirst is scoped by tenant — cross-tenant probe yields 404', async () => {
    prisma.location.findFirst.mockResolvedValue(null);

    await request(makeApp({ tenantId: 1 })).delete('/api/wellness/locations/42');

    // The findFirst where-clause MUST carry tenantId — without it a tenant-A
    // admin could probe (and delete!) tenant-B locations by id.
    expect(prisma.location.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1, id: 42 }),
    }));
  });
});

// ── D3 / D4: 409 LOCATION_IN_USE ────────────────────────────────────

describe('DELETE /api/wellness/locations/:id — D3/D4 in-use guard', () => {
  test('refuses with 409 LOCATION_IN_USE when patients reference the row', async () => {
    prisma.location.findFirst.mockResolvedValue({ id: 42, name: 'Ranchi', city: 'Ranchi', tenantId: 1 });
    prisma.patient.count.mockResolvedValue(3);

    const res = await request(makeApp()).delete('/api/wellness/locations/42');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCATION_IN_USE');
    // Critical: delete must NOT be attempted — otherwise Prisma would
    // throw P2003 and the route would 500 instead of returning a
    // friendly envelope.
    expect(prisma.location.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('refuses when ANY single child relation has a reference (visits)', async () => {
    prisma.location.findFirst.mockResolvedValue({ id: 42, name: 'Ranchi', city: 'Ranchi', tenantId: 1 });
    prisma.visit.count.mockResolvedValue(1);

    const res = await request(makeApp()).delete('/api/wellness/locations/42');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCATION_IN_USE');
  });

  test('409 envelope carries a per-relation breakdown for the UI', async () => {
    prisma.location.findFirst.mockResolvedValue({ id: 42, name: 'Ranchi', city: 'Ranchi', tenantId: 1 });
    prisma.patient.count.mockResolvedValue(3);
    prisma.visit.count.mockResolvedValue(1);
    prisma.resource.count.mockResolvedValue(0);
    prisma.holiday.count.mockResolvedValue(2);
    prisma.register.count.mockResolvedValue(0);

    const res = await request(makeApp()).delete('/api/wellness/locations/42');

    expect(res.status).toBe(409);
    expect(res.body.inUse).toEqual({
      patients: 3, visits: 1, resources: 0, holidays: 2, registers: 0,
    });
    // The user-facing error should mention the location name so it's
    // self-describing when surfaced as a toast.
    expect(res.body.error).toMatch(/Ranchi/);
    expect(res.body.error).toMatch(/6/); // total = 3 + 1 + 0 + 2 + 0
  });

  test('counts are tenant-scoped — won\'t double-count cross-tenant rows', async () => {
    prisma.location.findFirst.mockResolvedValue({ id: 42, name: 'Ranchi', city: 'Ranchi', tenantId: 1 });

    await request(makeApp({ tenantId: 1 })).delete('/api/wellness/locations/42');

    // Every count() call must constrain by tenantId so a multi-tenant
    // database doesn't bleed unrelated tenants' patient/visit counts
    // into this tenant's in-use check.
    for (const fn of [prisma.patient.count, prisma.visit.count, prisma.resource.count, prisma.holiday.count, prisma.register.count]) {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, locationId: 42 }),
      }));
    }
  });
});

// ── D5: happy path ──────────────────────────────────────────────────

describe('DELETE /api/wellness/locations/:id — D5 happy path', () => {
  test('all-zero child counts → 200, prisma.delete called, audit written', async () => {
    prisma.location.findFirst.mockResolvedValue({
      id: 42, name: 'Bangalore', city: 'Bengaluru', tenantId: 1,
    });

    const res = await request(makeApp()).delete('/api/wellness/locations/42');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(prisma.location.delete).toHaveBeenCalledWith({ where: { id: 42 } });

    // Audit row carries the name + city so the audit viewer surfaces
    // human-readable identifiers without a join back to the (now
    // deleted) Location row.
    const deleteAudit = prisma.auditLog.create.mock.calls.find(
      (c) => c[0] && c[0].data && c[0].data.action === 'DELETE',
    );
    expect(deleteAudit).toBeDefined();
    const auditData = deleteAudit[0].data;
    expect(auditData.entity).toBe('Location');
    expect(auditData.entityId).toBe(42);
    expect(auditData.userId).toBe(7);
    expect(auditData.tenantId).toBe(1);
    // writeAudit JSON-stringifies the details payload.
    const details = JSON.parse(auditData.details || '{}');
    expect(details.name).toBe('Bangalore');
    expect(details.city).toBe('Bengaluru');
  });
});

// ── D6: audit failure is fail-soft ──────────────────────────────────

describe('DELETE /api/wellness/locations/:id — D6 audit failure is fail-soft', () => {
  test('audit-write error does NOT roll back the delete or 500 the response', async () => {
    prisma.location.findFirst.mockResolvedValue({ id: 42, name: 'Test', city: 'Test', tenantId: 1 });
    prisma.auditLog.create.mockRejectedValue(new Error('audit table is locked'));

    const res = await request(makeApp()).delete('/api/wellness/locations/42');

    // Critical: audit failure is fail-soft per writeAudit's contract.
    // The delete already succeeded on the prisma.location.delete call;
    // a 500 here would mislead the UI into showing "delete failed" even
    // though the row is gone.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.location.delete).toHaveBeenCalled();
  });
});
