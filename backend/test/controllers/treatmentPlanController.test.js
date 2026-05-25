// @ts-check
/**
 * Unit tests for backend/controllers/treatmentPlanController.js.
 *
 * Pins the wellness TreatmentPlan controller contract:
 *
 *   GET  /api/wellness/activetreatment       → getAllTreatmentPlans
 *   PUT  /api/wellness/treatment-plans/:id   → updateTreatmentPlan
 *
 * Router-level guards (`verifyWellnessRole(['doctor','professional',
 * 'manager','admin'])` for list, `requireClinicalRole` for the PUT) live in
 * routes/wellness.js — outside the controller's surface. The controller
 * itself only enforces tenant scope + #179 audit on status change. Role
 * gating is exercised by e2e/tests/wellness-treatment-plans-api.spec.js.
 *
 * What this file pins
 * ───────────────────
 *   1. List: returns { success, count, data } envelope, scoped to tenantId,
 *      includes patient + service, orderBy id desc (no createdAt on model).
 *   2. List: 401 when req.user has no tenantId (no silent tenantId=1 leak).
 *   3. Update: happy path returns 200 + updated row + writes #179 audit with
 *      fromStatus / toStatus / patientId in the details blob.
 *   4. Update: 401 when req.user has no tenantId.
 *   5. Update: 400 when status missing from body.
 *   6. Update: 404 when the id belongs to another tenant (cross-tenant
 *      isolation — findFirst must scope by both id AND tenantId).
 *   7. Update: parses string id param to int for the Prisma where clause.
 *   8. Update: audit-write failures are swallowed (warn-only) so the 200
 *      response still reaches the client.
 *   9. List: 500 envelope on Prisma error with { success:false, message,
 *      error } shape (not a bare 500 with no body).
 *
 * Source bugs surfaced during authoring
 * ─────────────────────────────────────
 *   None — the controller's contract is internally consistent. The
 *   schema's missing `createdAt` is noted in a TODO comment in the SUT
 *   itself (orderBy id desc as proxy); not a bug, just a future
 *   migration. Body does not validate against a status enum — any
 *   string is accepted and stored. That's intentional per PRD §11
 *   (status taxonomy lives in the frontend Service catalog editor).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Stub the prisma surfaces the controller touches BEFORE the controller is
// required. Without this the controller's `require('../lib/prisma')` picks
// up the un-mocked client and tries to talk to a real DB.
prisma.treatmentPlan = prisma.treatmentPlan || {};
prisma.treatmentPlan.findMany = vi.fn();
prisma.treatmentPlan.findFirst = vi.fn();
prisma.treatmentPlan.update = vi.fn();

// Patch the audit helper on the shared module.exports surface so the
// controller's `writeAudit(...)` closure-binding picks up the mock. The
// audit module exports `{ writeAudit, ... }` — replacing module.exports
// in place lets us count + control calls without rewriting the SUT.
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const auditMod = requireCJS('../../lib/audit');
const writeAuditMock = vi.fn().mockResolvedValue(undefined);
auditMod.writeAudit = writeAuditMock;

const {
  getAllTreatmentPlans,
  updateTreatmentPlan,
} = requireCJS('../../controllers/treatmentPlanController');

const tenantId = 42;
const userId = 7;

function makeReqRes({ params = {}, body = {}, user = { tenantId, userId, role: 'ADMIN' } } = {}) {
  const req = { user, params, body };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req, res };
}

beforeEach(() => {
  prisma.treatmentPlan.findMany.mockReset();
  prisma.treatmentPlan.findFirst.mockReset();
  prisma.treatmentPlan.update.mockReset();
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
});

describe('treatmentPlanController.getAllTreatmentPlans', () => {
  test('returns { success, count, data } envelope scoped to tenantId', async () => {
    const rows = [
      { id: 11, tenantId, patientId: 100, status: 'IN_PROGRESS',
        patient: { id: 100, name: 'Asha Patel' },
        service: { id: 5, name: 'Hair Botox' } },
      { id: 10, tenantId, patientId: 101, status: 'PLANNED',
        patient: { id: 101, name: 'Rohan Kumar' },
        service: { id: 6, name: 'PRP Therapy' } },
    ];
    prisma.treatmentPlan.findMany.mockResolvedValue(rows);

    const { req, res } = makeReqRes();
    await getAllTreatmentPlans(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.data).toEqual(rows);

    // findMany must be tenant-scoped, include patient + service, and order
    // id desc (the SUT's documented proxy for createdAt-desc).
    const call = prisma.treatmentPlan.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(tenantId);
    expect(call.include).toEqual({ patient: true, service: true });
    expect(call.orderBy).toEqual({ id: 'desc' });
  });

  test('401 + { error: "no tenant" } when req.user has no tenantId', async () => {
    const { req, res } = makeReqRes({ user: { userId, role: 'ADMIN' } });
    await getAllTreatmentPlans(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'no tenant' });
    // CRITICAL: never silently fall back to tenantId=1 — verify findMany
    // was NOT called at all when the tenant is missing.
    expect(prisma.treatmentPlan.findMany).not.toHaveBeenCalled();
  });

  test('500 envelope { success:false, message, error } on Prisma failure', async () => {
    prisma.treatmentPlan.findMany.mockRejectedValue(new Error('boom: db unreachable'));

    const { req, res } = makeReqRes();
    await getAllTreatmentPlans(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Failed to fetch treatment plans');
    expect(res.body.error).toBe('boom: db unreachable');
  });
});

describe('treatmentPlanController.updateTreatmentPlan', () => {
  test('happy path: 200 + updated row + #179 audit recorded', async () => {
    const planBefore = { id: 11, tenantId, patientId: 100, status: 'PLANNED' };
    const planAfter = {
      id: 11, tenantId, patientId: 100, status: 'COMPLETED',
      patient: { id: 100, name: 'Asha Patel' },
      service: { id: 5, name: 'Hair Botox' },
    };
    prisma.treatmentPlan.findFirst.mockResolvedValue(planBefore);
    prisma.treatmentPlan.update.mockResolvedValue(planAfter);

    const { req, res } = makeReqRes({
      params: { id: '11' },
      body: { status: 'COMPLETED' },
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(planAfter);

    // #179 audit MUST be called with TreatmentPlan / UPDATE / id / userId /
    // tenantId and the from→to status delta in details.
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const [entity, action, entityId, callerId, callerTenant, details] =
      writeAuditMock.mock.calls[0];
    expect(entity).toBe('TreatmentPlan');
    expect(action).toBe('UPDATE');
    expect(entityId).toBe(11);
    expect(callerId).toBe(userId);
    expect(callerTenant).toBe(tenantId);
    expect(details).toEqual({
      patientId: 100,
      fromStatus: 'PLANNED',
      toStatus: 'COMPLETED',
    });
  });

  test('401 when req.user has no tenantId', async () => {
    const { req, res } = makeReqRes({
      params: { id: '11' },
      body: { status: 'COMPLETED' },
      user: { userId, role: 'ADMIN' },
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'no tenant' });
    expect(prisma.treatmentPlan.findFirst).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.update).not.toHaveBeenCalled();
  });

  test('400 + { error } when status missing from body', async () => {
    const { req, res } = makeReqRes({
      params: { id: '11' },
      body: {}, // status absent
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Status required' });
    expect(prisma.treatmentPlan.findFirst).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.update).not.toHaveBeenCalled();
  });

  test('404 on cross-tenant id (findFirst scopes by both id AND tenantId)', async () => {
    // findFirst returns null because the id belongs to another tenant.
    prisma.treatmentPlan.findFirst.mockResolvedValue(null);

    const { req, res } = makeReqRes({
      params: { id: '999' },
      body: { status: 'COMPLETED' },
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Treatment plan not found' });

    // Verify the lookup was scoped — the SUT MUST pass tenantId in the
    // where clause; without that scope a foreign-tenant row could match.
    const call = prisma.treatmentPlan.findFirst.mock.calls[0][0];
    expect(call.where.tenantId).toBe(tenantId);
    expect(call.where.id).toBe(999);

    // No write + no audit when the row isn't found.
    expect(prisma.treatmentPlan.update).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  test('parses string id param to int for Prisma where clause', async () => {
    const planBefore = { id: 11, tenantId, patientId: 100, status: 'PLANNED' };
    const planAfter = { ...planBefore, status: 'IN_PROGRESS',
      patient: { id: 100 }, service: { id: 5 } };
    prisma.treatmentPlan.findFirst.mockResolvedValue(planBefore);
    prisma.treatmentPlan.update.mockResolvedValue(planAfter);

    const { req, res } = makeReqRes({
      params: { id: '11' }, // string id from URL
      body: { status: 'IN_PROGRESS' },
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(200);
    // Both queries must receive id as Number(11), not the string '11'.
    expect(prisma.treatmentPlan.findFirst.mock.calls[0][0].where.id).toBe(11);
    expect(prisma.treatmentPlan.update.mock.calls[0][0].where.id).toBe(11);
  });

  test('audit-write failure is swallowed; client still gets 200 + data', async () => {
    const planBefore = { id: 11, tenantId, patientId: 100, status: 'PLANNED' };
    const planAfter = { ...planBefore, status: 'CANCELLED',
      patient: { id: 100 }, service: { id: 5 } };
    prisma.treatmentPlan.findFirst.mockResolvedValue(planBefore);
    prisma.treatmentPlan.update.mockResolvedValue(planAfter);
    writeAuditMock.mockRejectedValue(new Error('audit chain unavailable'));

    // Silence the expected console.warn so test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { req, res } = makeReqRes({
      params: { id: '11' },
      body: { status: 'CANCELLED' },
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(planAfter);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test('500 envelope on Prisma update failure', async () => {
    const planBefore = { id: 11, tenantId, patientId: 100, status: 'PLANNED' };
    prisma.treatmentPlan.findFirst.mockResolvedValue(planBefore);
    prisma.treatmentPlan.update.mockRejectedValue(new Error('write conflict'));

    // Silence console.error from the controller's catch.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { req, res } = makeReqRes({
      params: { id: '11' },
      body: { status: 'COMPLETED' },
    });
    await updateTreatmentPlan(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Failed to update treatment plan');
    // No audit on the failed write.
    expect(writeAuditMock).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
