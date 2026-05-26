// @ts-check
/**
 * Unit tests for backend/routes/sla.js — pin the contract of the SLA-policy
 * CRUD surface + SLA-apply + breach reporting + admin test-helper.
 *
 * Why this file exists
 * ────────────────────
 * routes/sla.js (410 LOC) had ZERO vitest coverage prior to this file. It
 * owns the SlaPolicy CRUD, the apply-policy-to-ticket(s) handlers, the
 * /breaches read-side enrichment used by the SLA dashboard, the /stats
 * aggregator that feeds the support-ops KPI tile, and an ADMIN-only
 * test-helper (POST /_test/backdate-ticket/:id) that the e2e-full
 * release-validation suite relies on to drive deterministic breach Flow 3.
 * Silent contract drift on any of these would either red the e2e flow OR
 * (worse) auto-breach every ticket in the support queue when an operator
 * tweaks a policy. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET    /policies                     — list (tenant-scoped, ordered)
 *   2. POST   /policies                     — create with #465 validation
 *   3. PUT    /policies/:id                 — update with #465 validation
 *   4. DELETE /policies/:id                 — 204 No Content (per #550)
 *   5. POST   /apply/:ticketId              — apply matching policy
 *   6. POST   /apply-all                    — bulk apply (force / non-force)
 *   7. GET    /breaches                     — enriched breach feed
 *   8. GET    /stats                        — KPI summary
 *   9. POST   /check-breaches               — ADMIN-only cron mirror
 *  10. POST   /_test/backdate-ticket/:id    — ADMIN-only env-gated helper
 *
 * Cases (24 total)
 * ────────────────
 *   list: tenant-scoped + correct ordering (1)
 *   create: 400 missing name/priority; 400 INVALID_RESPONSE_MINUTES on 0
 *     and -1; 400 INVALID_RESOLVE_MINUTES on 0; happy 201 with defaults;
 *     happy 201 with explicit values; isActive default true (6)
 *   update: 400 invalid id; 404 cross-tenant; 400 INVALID_RESPONSE_MINUTES
 *     on 0; happy 200 partial-update (4)
 *   delete: 400 invalid id; 404 cross-tenant; happy 204 No Content (3)
 *   apply/:ticketId: 404 ticket not found (cross-tenant via findFirst);
 *     404 when no policy matches priority; happy 200 stamps due fields (3)
 *   apply-all: happy 200 default-mode skips already-stamped tickets;
 *     ?force=true overwrites stamped tickets; skips priority-without-policy (3)
 *   breaches: enriched with responseBreach/resolveBreach + overdueMinutes (1)
 *   stats: returns the 6-field envelope shape (1)
 *   check-breaches: ADMIN gates; happy delegates to engine.runForTenant (2)
 *   backdate-ticket: 404 when SLA_TEST_HELPERS unset & NODE_ENV=production (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/admin.test.js (auth-middleware bypass +
 * prisma singleton monkey-patch BEFORE requiring the router) — the sla
 * router doesn't require verifyToken itself (the global guard does), so
 * we install a fake-auth middleware in makeApp that populates req.user
 * with the desired { userId, tenantId, role }. verifyRole stays REAL so
 * the ADMIN-gate assertions on /check-breaches + /_test/backdate-ticket
 * are end-to-end.
 *
 * The slaBreachEngine module is patched the same way as admin.test.js
 * patches backupEngine — its runForTenant export is swapped for a vi.fn()
 * on the module-exports object BEFORE the router is required, so the
 * router's destructured `{ runForTenant: runSlaBreachForTenant } =
 * require('../cron/slaBreachEngine')` captures the mock.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.slaPolicy = prisma.slaPolicy || {};
prisma.slaPolicy.findMany = vi.fn();
prisma.slaPolicy.findFirst = vi.fn();
prisma.slaPolicy.create = vi.fn();
prisma.slaPolicy.update = vi.fn();
prisma.slaPolicy.delete = vi.fn();
prisma.slaPolicy.count = vi.fn();
prisma.ticket = prisma.ticket || {};
prisma.ticket.findFirst = vi.fn();
prisma.ticket.findMany = vi.fn();
prisma.ticket.update = vi.fn();
prisma.ticket.count = vi.fn();
// eventBus's best-effort emit walks automationRule.findMany — stub so it
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── slaBreachEngine singleton patching (CJS self-mocking seam) ─────────
// The route does `const { runForTenant: runSlaBreachForTenant } =
// require('../cron/slaBreachEngine')` at module-load, so we must patch
// the module-exports' runForTenant property BEFORE the router is required.
const slaBreachEngine = requireCJS('../../cron/slaBreachEngine');
slaBreachEngine.runForTenant = vi.fn();

// ── eventBus stubs (best-effort writeAudit / route-side emit) ──────────
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const slaRouter = requireCJS('../../routes/sla');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Default role = ADMIN (since two endpoints gate on
 * ADMIN); override via { role } to exercise verifyRole denial paths.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/sla', slaRouter);
  return app;
}

beforeEach(() => {
  prisma.slaPolicy.findMany.mockReset();
  prisma.slaPolicy.findFirst.mockReset();
  prisma.slaPolicy.create.mockReset();
  prisma.slaPolicy.update.mockReset();
  prisma.slaPolicy.delete.mockReset();
  prisma.slaPolicy.count.mockReset();
  prisma.ticket.findFirst.mockReset();
  prisma.ticket.findMany.mockReset();
  prisma.ticket.update.mockReset();
  prisma.ticket.count.mockReset();
  slaBreachEngine.runForTenant.mockReset();

  // Sensible defaults — individual tests override.
  prisma.slaPolicy.findMany.mockResolvedValue([]);
  prisma.slaPolicy.findFirst.mockResolvedValue(null);
  prisma.slaPolicy.create.mockResolvedValue({ id: 1 });
  prisma.slaPolicy.update.mockResolvedValue({ id: 1 });
  prisma.slaPolicy.delete.mockResolvedValue({ id: 1 });
  prisma.slaPolicy.count.mockResolvedValue(0);
  prisma.ticket.findFirst.mockResolvedValue(null);
  prisma.ticket.findMany.mockResolvedValue([]);
  prisma.ticket.update.mockResolvedValue({ id: 1 });
  prisma.ticket.count.mockResolvedValue(0);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /policies — list (tenant-scoped + active-first ordering)
// ─────────────────────────────────────────────────────────────────────────

describe('GET /policies — list SLA policies', () => {
  test('200 with tenant-scoped findMany ordered by [isActive desc, priority asc, createdAt desc]', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([
      { id: 1, name: 'High', priority: 'High', isActive: true, responseMinutes: 30, resolveMinutes: 240 },
      { id: 2, name: 'Low', priority: 'Low', isActive: true, responseMinutes: 240, resolveMinutes: 1440 },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/sla/policies');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.slaPolicy.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: [{ isActive: 'desc' }, { priority: 'asc' }, { createdAt: 'desc' }],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /policies?fields=summary — #920 slice 20 slim-shape opt-in
// ─────────────────────────────────────────────────────────────────────────

describe('GET /policies?fields=summary — slim-shape opt-in (#920 slice 20)', () => {
  test('passes a Prisma select that drops tenantId + createdAt when ?fields=summary is set', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([
      { id: 1, name: 'Gold', priority: 'High', responseMinutes: 30, resolveMinutes: 240, isActive: true },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/sla/policies?fields=summary');

    expect(res.status).toBe(200);
    const callArg = prisma.slaPolicy.findMany.mock.calls[0][0];
    expect(callArg.select).toEqual({
      id: true,
      name: true,
      priority: true,
      responseMinutes: true,
      resolveMinutes: true,
      isActive: true,
    });
    // tenantId + createdAt deliberately absent from the slim select.
    expect(callArg.select).not.toHaveProperty('tenantId');
    expect(callArg.select).not.toHaveProperty('createdAt');
  });

  test('preserves tenant scoping + ordering when slim-shape is requested', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 99 })).get('/api/sla/policies?fields=summary');

    expect(res.status).toBe(200);
    const callArg = prisma.slaPolicy.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ tenantId: 99 });
    expect(callArg.orderBy).toEqual([
      { isActive: 'desc' },
      { priority: 'asc' },
      { createdAt: 'desc' },
    ]);
  });

  test('omits select entirely (full row shape) when ?fields is absent', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/sla/policies');

    expect(res.status).toBe(200);
    const callArg = prisma.slaPolicy.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('omits select when ?fields=full (any non-exact value falls through to full shape)', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/sla/policies?fields=full');

    expect(res.status).toBe(200);
    const callArg = prisma.slaPolicy.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('omits select on ?fields=SUMMARY (case-sensitive exact match — only lowercase "summary" opts in)', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/sla/policies?fields=SUMMARY');

    expect(res.status).toBe(200);
    const callArg = prisma.slaPolicy.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('returns the rows verbatim from Prisma without post-processing in slim mode', async () => {
    const slimRow = { id: 5, name: 'Bronze', priority: 'Low', responseMinutes: 240, resolveMinutes: 1440, isActive: true };
    prisma.slaPolicy.findMany.mockResolvedValue([slimRow]);

    const res = await request(makeApp()).get('/api/sla/policies?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([slimRow]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /policies — create with #465 zero/negative-minutes guard
// ─────────────────────────────────────────────────────────────────────────

describe('POST /policies — create', () => {
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/sla/policies')
      .send({ priority: 'High' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and priority/i);
    expect(prisma.slaPolicy.create).not.toHaveBeenCalled();
  });

  test('400 when priority missing', async () => {
    const res = await request(makeApp())
      .post('/api/sla/policies')
      .send({ name: 'Gold' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and priority/i);
  });

  test('400 INVALID_RESPONSE_MINUTES when responseMinutes is 0 (#465 — vacuous policy)', async () => {
    const res = await request(makeApp())
      .post('/api/sla/policies')
      .send({ name: 'Gold', priority: 'High', responseMinutes: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESPONSE_MINUTES');
    expect(res.body.error).toMatch(/at least 1/i);
    expect(prisma.slaPolicy.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_RESPONSE_MINUTES when responseMinutes is negative', async () => {
    const res = await request(makeApp())
      .post('/api/sla/policies')
      .send({ name: 'Gold', priority: 'High', responseMinutes: -5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESPONSE_MINUTES');
  });

  test('400 INVALID_RESOLVE_MINUTES when resolveMinutes is 0', async () => {
    const res = await request(makeApp())
      .post('/api/sla/policies')
      .send({ name: 'Gold', priority: 'High', resolveMinutes: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESOLVE_MINUTES');
  });

  test('201 with defaults: responseMinutes=60, resolveMinutes=1440, isActive=true, tenantId from JWT', async () => {
    prisma.slaPolicy.create.mockResolvedValue({
      id: 99,
      name: 'Gold',
      priority: 'High',
      responseMinutes: 60,
      resolveMinutes: 1440,
      isActive: true,
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/sla/policies')
      .send({ name: 'Gold', priority: 'High' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    expect(prisma.slaPolicy.create).toHaveBeenCalledWith({
      data: {
        name: 'Gold',
        priority: 'High',
        responseMinutes: 60,
        resolveMinutes: 1440,
        isActive: true,
        tenantId: 42,
      },
    });
  });

  test('201 with explicit values: isActive=false honored + minutes coerced to int', async () => {
    prisma.slaPolicy.create.mockResolvedValue({ id: 100 });

    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/sla/policies')
      .send({
        name: 'Silver',
        priority: 'Medium',
        responseMinutes: '45.7', // non-int string should be truncated to 45
        resolveMinutes: 720,
        isActive: false,
      });

    expect(res.status).toBe(201);
    const createArg = prisma.slaPolicy.create.mock.calls[0][0].data;
    expect(createArg.responseMinutes).toBe(45);
    expect(createArg.resolveMinutes).toBe(720);
    expect(createArg.isActive).toBe(false);
    expect(createArg.tenantId).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /policies/:id — update with cross-tenant 404
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /policies/:id — update', () => {
  test('400 when :id is not a number', async () => {
    const res = await request(makeApp())
      .put('/api/sla/policies/not-an-int')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.slaPolicy.update).not.toHaveBeenCalled();
  });

  test('404 when policy belongs to a different tenant (findFirst returns null)', async () => {
    prisma.slaPolicy.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/sla/policies/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.slaPolicy.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.slaPolicy.update).not.toHaveBeenCalled();
  });

  test('400 INVALID_RESPONSE_MINUTES when responseMinutes is 0 on update (#465)', async () => {
    prisma.slaPolicy.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, responseMinutes: 60, resolveMinutes: 1440,
    });

    const res = await request(makeApp())
      .put('/api/sla/policies/50')
      .send({ responseMinutes: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESPONSE_MINUTES');
    expect(prisma.slaPolicy.update).not.toHaveBeenCalled();
  });

  test('200 partial-update: only supplied fields written, isActive coerced to bool', async () => {
    prisma.slaPolicy.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, responseMinutes: 60, resolveMinutes: 1440,
    });
    prisma.slaPolicy.update.mockResolvedValue({
      id: 50, name: 'Renamed', isActive: false, responseMinutes: 60, resolveMinutes: 1440,
    });

    const res = await request(makeApp())
      .put('/api/sla/policies/50')
      .send({ name: 'Renamed', isActive: 0 /* falsy → coerced to false */ });

    expect(res.status).toBe(200);
    expect(prisma.slaPolicy.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'Renamed', isActive: false },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /policies/:id — 204 No Content per #550 sweep
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /policies/:id — delete', () => {
  test('400 when :id is not a number', async () => {
    const res = await request(makeApp()).delete('/api/sla/policies/abc');

    expect(res.status).toBe(400);
    expect(prisma.slaPolicy.delete).not.toHaveBeenCalled();
  });

  test('404 when policy belongs to a different tenant', async () => {
    prisma.slaPolicy.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/sla/policies/777');

    expect(res.status).toBe(404);
    expect(prisma.slaPolicy.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.slaPolicy.delete).not.toHaveBeenCalled();
  });

  test('204 No Content on successful delete (#550 — DELETE→204 sweep)', async () => {
    prisma.slaPolicy.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.slaPolicy.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp()).delete('/api/sla/policies/50');

    expect(res.status).toBe(204);
    // 204 must have NO body.
    expect(res.body).toEqual({});
    expect(prisma.slaPolicy.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /apply/:ticketId — apply matching policy to a single ticket
// ─────────────────────────────────────────────────────────────────────────

describe('POST /apply/:ticketId — apply matching policy', () => {
  test('404 when ticket lookup returns null (cross-tenant via findFirst)', async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/sla/apply/123')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ticket not found/i);
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { id: 123, tenantId: 1 },
    });
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  test('404 when no active policy matches the ticket priority', async () => {
    prisma.ticket.findFirst.mockResolvedValue({
      id: 123, tenantId: 1, priority: 'High', createdAt: new Date('2026-05-25T00:00:00Z'),
    });
    prisma.slaPolicy.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/sla/apply/123')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active sla policy/i);
    expect(prisma.slaPolicy.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 1, priority: 'High', isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  test('200 stamps slaResponseDue + slaResolveDue based on ticket.createdAt + policy minutes', async () => {
    const created = new Date('2026-05-25T10:00:00Z');
    prisma.ticket.findFirst.mockResolvedValue({
      id: 123, tenantId: 1, priority: 'High', createdAt: created,
    });
    prisma.slaPolicy.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, priority: 'High', isActive: true,
      responseMinutes: 30, resolveMinutes: 240,
    });
    prisma.ticket.update.mockResolvedValue({
      id: 123,
      slaResponseDue: new Date(created.getTime() + 30 * 60000),
      slaResolveDue: new Date(created.getTime() + 240 * 60000),
    });

    const res = await request(makeApp()).post('/api/sla/apply/123').send({});

    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeDefined();
    expect(res.body.policy).toMatchObject({ id: 50, priority: 'High' });
    const updateArg = prisma.ticket.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 123 });
    // +30 min from createdAt
    expect(new Date(updateArg.data.slaResponseDue).getTime()).toBe(created.getTime() + 30 * 60000);
    expect(new Date(updateArg.data.slaResolveDue).getTime()).toBe(created.getTime() + 240 * 60000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /apply-all — bulk apply with force flag
// ─────────────────────────────────────────────────────────────────────────

describe('POST /apply-all — bulk apply', () => {
  test('200 default mode: only stamps tickets with slaResponseDue=null + skips priority-without-policy', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([
      { id: 50, priority: 'High', responseMinutes: 30, resolveMinutes: 240 },
    ]);
    prisma.ticket.findMany.mockResolvedValue([
      { id: 1, priority: 'High', createdAt: new Date('2026-05-25T00:00:00Z') },
      { id: 2, priority: 'Low', createdAt: new Date('2026-05-25T00:00:00Z') }, // no matching policy
    ]);

    const res = await request(makeApp({ tenantId: 1 })).post('/api/sla/apply-all').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 1, skipped: 1, total: 2, force: false });
    // Default mode passes the slaResponseDue=null filter to ticket.findMany.
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, slaResponseDue: null },
    });
    expect(prisma.ticket.update).toHaveBeenCalledTimes(1);
    expect(prisma.ticket.update.mock.calls[0][0].where).toEqual({ id: 1 });
  });

  test('200 ?force=true mode: drops the slaResponseDue=null filter (overwrites in-flight tickets)', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([
      { id: 50, priority: 'High', responseMinutes: 30, resolveMinutes: 240 },
    ]);
    prisma.ticket.findMany.mockResolvedValue([
      { id: 1, priority: 'High', createdAt: new Date('2026-05-25T00:00:00Z') },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/sla/apply-all?force=true')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.force).toBe(true);
    // force=true drops the slaResponseDue:null clause.
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
    });
  });

  test('200 force via body { force: true } honored equivalently to query', async () => {
    prisma.slaPolicy.findMany.mockResolvedValue([]);
    prisma.ticket.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/sla/apply-all')
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body.force).toBe(true);
    expect(prisma.ticket.findMany).toHaveBeenCalledWith({ where: { tenantId: 1 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /breaches — enriched feed of currently-breaching tickets
// ─────────────────────────────────────────────────────────────────────────

describe('GET /breaches — currently-breaching tickets', () => {
  test('200 enriches each ticket with responseBreach/resolveBreach + overdueMinutes (tenant-scoped)', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 1,
        tenantId: 1,
        priority: 'High',
        status: 'Open',
        slaResponseDue: past,
        slaResolveDue: past,
        firstResponseAt: null,
        assignee: null,
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/sla/breaches');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    expect(row.responseBreach).toBe(true);
    expect(row.resolveBreach).toBe(true);
    // ~60 min overdue (some slack for the test running long).
    expect(row.responseOverdueMinutes).toBeGreaterThanOrEqual(60);
    expect(row.resolveOverdueMinutes).toBeGreaterThanOrEqual(60);

    // Tenant scoping + OR clause shape.
    const callArg = prisma.ticket.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(1);
    expect(callArg.where.OR).toHaveLength(2);
    expect(callArg.include).toEqual({
      assignee: { select: { id: true, name: true, email: true } },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /stats — KPI summary envelope
// ─────────────────────────────────────────────────────────────────────────

describe('GET /stats — KPI summary', () => {
  test('200 returns { activePolicies, breachesToday, avgResponseMinutes, avgResolveMinutes, sampleResponseCount, sampleResolveCount }', async () => {
    prisma.slaPolicy.count.mockResolvedValue(3);
    prisma.ticket.count.mockResolvedValue(5);
    // First findMany call → respondedTickets; second → resolvedTickets
    prisma.ticket.findMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date('2026-05-25T10:00:00Z'),
          firstResponseAt: new Date('2026-05-25T10:30:00Z'), // 30 min
        },
        {
          createdAt: new Date('2026-05-25T11:00:00Z'),
          firstResponseAt: new Date('2026-05-25T11:10:00Z'), // 10 min
        },
      ])
      .mockResolvedValueOnce([
        {
          createdAt: new Date('2026-05-25T10:00:00Z'),
          resolvedAt: new Date('2026-05-25T14:00:00Z'), // 240 min
        },
      ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/sla/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activePolicies: 3,
      breachesToday: 5,
      avgResponseMinutes: 20, // (30 + 10) / 2
      avgResolveMinutes: 240,
      sampleResponseCount: 2,
      sampleResolveCount: 1,
    });
    expect(prisma.slaPolicy.count).toHaveBeenCalledWith({
      where: { tenantId: 1, isActive: true },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /check-breaches — ADMIN-only cron mirror
// ─────────────────────────────────────────────────────────────────────────

describe('POST /check-breaches — admin manual cron trigger', () => {
  test('200 delegates to slaBreachEngine.runForTenant with req.user.tenantId', async () => {
    slaBreachEngine.runForTenant.mockResolvedValue({
      breached: 2,
      processed: 10,
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42, role: 'ADMIN' }))
      .post('/api/sla/check-breaches')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ breached: 2, processed: 10, tenantId: 42 });
    expect(slaBreachEngine.runForTenant).toHaveBeenCalledWith(42);
  });

  test('403 RBAC_DENIED when caller is not ADMIN (USER role)', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/sla/check-breaches')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(slaBreachEngine.runForTenant).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /_test/backdate-ticket/:id — env-gated admin test helper
// ─────────────────────────────────────────────────────────────────────────

describe('POST /_test/backdate-ticket/:id — env-gated test helper', () => {
  test('404 when NODE_ENV=production and SLA_TEST_HELPERS unset (route hidden)', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevHelpers = process.env.SLA_TEST_HELPERS;
    process.env.NODE_ENV = 'production';
    delete process.env.SLA_TEST_HELPERS;

    try {
      const res = await request(makeApp({ role: 'ADMIN' }))
        .post('/api/sla/_test/backdate-ticket/123')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    } finally {
      // Restore env so other tests aren't affected.
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevHelpers === undefined) delete process.env.SLA_TEST_HELPERS;
      else process.env.SLA_TEST_HELPERS = prevHelpers;
    }
  });
});
