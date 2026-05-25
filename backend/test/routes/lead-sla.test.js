// @ts-check
/**
 * Unit tests for backend/routes/lead_sla.js — first vitest pin for the
 * Lead-side SLA dashboard endpoints (PRD §6.4 "zero missed leads").
 *
 * Why this file exists
 * ────────────────────
 * routes/lead_sla.js (139 LOC) had ZERO vitest coverage prior to this file.
 * It is the read-side companion to cron/leadSlaEngine.js (which has its own
 * dedicated test) — three endpoints that surface lead-SLA state to the
 * manager dashboard:
 *
 *   1. GET  /api/lead-sla/breaches       — past-due lead feed (cron-flagged
 *                                          + on-the-fly), ordered by due-date
 *   2. GET  /api/lead-sla/stats          — { pendingLeads, breachesToday,
 *                                          totalBreaches } counter envelope
 *   3. POST /api/lead-sla/check-breaches — ADMIN-only manual cron trigger
 *                                          (mirrors the engine for test/ops)
 *
 * Silent contract drift on any of these would either red the manager
 * dashboard's lead-SLA tile OR (worse) silently understate the
 * breach-backlog after a schema change. The route is also load-bearing for
 * the AutomationRule listeners that hang off the 'lead.sla_breached' event
 * the engine emits — when an operator triggers /check-breaches manually,
 * the downstream notifications/whatsapp holding template/escalation flows
 * must remain intact. Pin the wire shape now.
 *
 * Cases (8 total)
 * ───────────────
 *   1. GET /breaches: tenant-scoped query + ordering + overdueMinutes
 *      enrichment math + 500-row cap
 *   2. GET /breaches: empty result → [] (sanity)
 *   3. GET /stats: returns the 3-field counter envelope + tenant-scoped
 *      across all three Promise.all parallel counts
 *   4. POST /check-breaches: ADMIN happy path delegates to runForTenant
 *      with the caller's tenantId
 *   5. POST /check-breaches: MANAGER (router-level allowed) but inner
 *      ADMIN gate denies → 403 RBAC_DENIED
 *   6. RBAC: USER role → 403 RBAC_DENIED (router-level gate)
 *   7. INVALID-shape: GET /breaches with prisma error → 500 envelope
 *   8. POST /check-breaches engine error → 500 envelope
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js exactly:
 *   - prisma singleton monkey-patch BEFORE requiring the router so the
 *     route's `require('../lib/prisma')` resolves to the patched
 *     instance (CJS self-mocking seam).
 *   - leadSlaEngine.runForTenant patched the same way — the route does
 *     `const { runForTenant: runLeadSlaForTenant } =
 *     require('../cron/leadSlaEngine')` at module-load, so we patch the
 *     module-exports property on the cached module object BEFORE
 *     requiring the router. The route's destructured local binding
 *     then captures the mock.
 *   - Fake-auth middleware in makeApp() populates req.user with the
 *     desired { userId, tenantId, role }. verifyRole stays REAL so the
 *     ADMIN/MANAGER router-level gate AND the inner ADMIN gate on
 *     /check-breaches are end-to-end.
 *   - eventBus stubs (best-effort) — the engine emits and the audit
 *     middleware probes during route execution; without these the unit
 *     test env (no DATABASE_URL) trips on automationRule.findMany.
 *
 * No real DB. Drive via supertest.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching — BEFORE the router is required ──────────
const prisma = requireCJS('../../lib/prisma');

prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.count = vi.fn();
// eventBus / writeAudit best-effort stubs so the route-side audit probe
// doesn't blow up the unit_tests env (no DATABASE_URL).
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// ── leadSlaEngine singleton patching (CJS self-mocking seam) ───────────
// The route does `const { runForTenant: runLeadSlaForTenant } =
// require('../cron/leadSlaEngine')` at module-load, so we must patch the
// module-exports' runForTenant property BEFORE the router is required.
const leadSlaEngine = requireCJS('../../cron/leadSlaEngine');
leadSlaEngine.runForTenant = vi.fn();

// ── eventBus stubs (best-effort) ───────────────────────────────────────
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const leadSlaRouter = requireCJS('../../routes/lead_sla');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Default role = ADMIN (since /check-breaches
 * gates on ADMIN); override via { role } to exercise the verifyRole
 * denial paths at both the router level and the inner /check-breaches
 * level.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/lead-sla', leadSlaRouter);
  return app;
}

beforeEach(() => {
  prisma.contact.findMany.mockReset();
  prisma.contact.count.mockReset();
  leadSlaEngine.runForTenant.mockReset();

  // Sensible defaults — individual tests override.
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.contact.count.mockResolvedValue(0);
  leadSlaEngine.runForTenant.mockResolvedValue({
    processed: 0,
    breached: 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/lead-sla/breaches — past-due lead feed
// ─────────────────────────────────────────────────────────────────────────

describe('GET /api/lead-sla/breaches — past-due lead feed', () => {
  test('200 with tenant-scoped query, ordered by firstResponseDueAt asc, 500-cap, + overdueMinutes enrichment', async () => {
    // Fixed clock anchor so overdueMinutes is deterministic.
    const now = new Date('2026-05-25T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Two leads — one 60 min overdue, one 120 min overdue.
    const sixtyMinAgo = new Date(now.getTime() - 60 * 60_000);
    const twoHoursAgo = new Date(now.getTime() - 120 * 60_000);

    prisma.contact.findMany.mockResolvedValue([
      {
        id: 101,
        name: 'Priya Iyer',
        email: 'priya@example.com',
        phone: '+919811000001',
        source: 'IndiaMART',
        aiScore: 78,
        assignedToId: 4,
        assignedTo: { id: 4, name: 'Suresh Babu', email: 'suresh@crm.com' },
        firstResponseDueAt: sixtyMinAgo,
        slaBreached: true,
        slaBreachedAt: sixtyMinAgo,
        createdAt: new Date(now.getTime() - 90 * 60_000),
      },
      {
        id: 102,
        name: 'Aman Khan',
        email: 'aman@example.com',
        phone: '+919811000002',
        source: 'TradeIndia',
        aiScore: 55,
        assignedToId: 4,
        assignedTo: { id: 4, name: 'Suresh Babu', email: 'suresh@crm.com' },
        firstResponseDueAt: twoHoursAgo,
        slaBreached: false,
        slaBreachedAt: null,
        createdAt: new Date(now.getTime() - 180 * 60_000),
      },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get(
      '/api/lead-sla/breaches',
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    // Query shape pinned: tenant-scoped + status=Lead + no first-response yet
    // + due date in the past + not deleted + 500-row cap + asc ordering.
    expect(prisma.contact.findMany).toHaveBeenCalledOnce();
    const args = prisma.contact.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.status).toBe('Lead');
    expect(args.where.firstResponseAt).toBeNull();
    expect(args.where.firstResponseDueAt).toEqual({ lt: now });
    expect(args.where.deletedAt).toBeNull();
    expect(args.orderBy).toEqual({ firstResponseDueAt: 'asc' });
    expect(args.take).toBe(500);

    // Select-shape pinned: includes assignedTo nested object.
    expect(args.select.assignedTo).toEqual({
      select: { id: true, name: true, email: true },
    });

    // overdueMinutes enrichment: math is (now - dueAt) / 60_000, rounded.
    expect(res.body[0].overdueMinutes).toBe(60);
    expect(res.body[1].overdueMinutes).toBe(120);
    // Original due-date passes through (as ISO string after JSON round-trip).
    expect(res.body[0]).toHaveProperty('firstResponseDueAt');
    expect(res.body[0]).toHaveProperty('assignedTo.name', 'Suresh Babu');

    vi.useRealTimers();
  });

  test('200 [] when no leads currently breaching', async () => {
    prisma.contact.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/lead-sla/breaches');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('500 envelope on unexpected prisma error', async () => {
    prisma.contact.findMany.mockRejectedValue(new Error('connection lost'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(makeApp()).get('/api/lead-sla/breaches');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch lead SLA breaches' });
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/lead-sla/stats — counter envelope for dashboard tile
// ─────────────────────────────────────────────────────────────────────────

describe('GET /api/lead-sla/stats — dashboard counter envelope', () => {
  test('200 returns { pendingLeads, breachesToday, totalBreaches } — all 3 counts tenant-scoped', async () => {
    // The three counts fire in Promise.all order — mock once each in order.
    prisma.contact.count
      .mockResolvedValueOnce(17) // pendingLeads
      .mockResolvedValueOnce(3) //  breachesToday
      .mockResolvedValueOnce(9); //  totalBreaches

    const res = await request(makeApp({ tenantId: 99 })).get(
      '/api/lead-sla/stats',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pendingLeads: 17,
      breachesToday: 3,
      totalBreaches: 9,
    });

    // All three count calls must be tenant-scoped to req.user.tenantId.
    expect(prisma.contact.count).toHaveBeenCalledTimes(3);
    for (const call of prisma.contact.count.mock.calls) {
      expect(call[0].where.tenantId).toBe(99);
      expect(call[0].where.status).toBe('Lead');
      expect(call[0].where.deletedAt).toBeNull();
    }

    // pendingLeads = status=Lead + no first-response yet (no slaBreached filter)
    const pendingArgs = prisma.contact.count.mock.calls[0][0];
    expect(pendingArgs.where.firstResponseAt).toBeNull();
    expect(pendingArgs.where.slaBreached).toBeUndefined();

    // breachesToday = slaBreached=true + slaBreachedAt >= startOfDay
    const todayArgs = prisma.contact.count.mock.calls[1][0];
    expect(todayArgs.where.slaBreached).toBe(true);
    expect(todayArgs.where.slaBreachedAt).toHaveProperty('gte');
    expect(todayArgs.where.slaBreachedAt.gte).toBeInstanceOf(Date);

    // totalBreaches = slaBreached=true, no time bound
    const totalArgs = prisma.contact.count.mock.calls[2][0];
    expect(totalArgs.where.slaBreached).toBe(true);
    expect(totalArgs.where.slaBreachedAt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/lead-sla/check-breaches — manual cron trigger (ADMIN-only)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/lead-sla/check-breaches — manual cron trigger', () => {
  test('200 ADMIN happy path delegates to runForTenant with caller tenantId', async () => {
    leadSlaEngine.runForTenant.mockResolvedValue({
      processed: 12,
      breached: 4,
    });

    const res = await request(makeApp({ tenantId: 55, role: 'ADMIN' })).post(
      '/api/lead-sla/check-breaches',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 12, breached: 4 });
    expect(leadSlaEngine.runForTenant).toHaveBeenCalledOnce();
    // Route passes `tenantId(req)` — the resolved tenant integer, not a
    // tenant object. Pin the call-shape.
    expect(leadSlaEngine.runForTenant).toHaveBeenCalledWith(55);
  });

  test('403 RBAC_DENIED when MANAGER calls /check-breaches (inner ADMIN gate)', async () => {
    // MANAGER passes the router-level verifyRole(['ADMIN','MANAGER']) gate
    // but fails the inner verifyRole(['ADMIN']) gate on this endpoint.
    const res = await request(makeApp({ role: 'MANAGER' })).post(
      '/api/lead-sla/check-breaches',
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(leadSlaEngine.runForTenant).not.toHaveBeenCalled();
  });

  test('500 envelope on engine error', async () => {
    leadSlaEngine.runForTenant.mockRejectedValue(new Error('engine boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(makeApp({ role: 'ADMIN' })).post(
      '/api/lead-sla/check-breaches',
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to run lead SLA check' });
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RBAC: router-level verifyRole(['ADMIN','MANAGER']) gate
// ─────────────────────────────────────────────────────────────────────────

describe('RBAC: router-level ADMIN/MANAGER gate', () => {
  test('403 RBAC_DENIED on every endpoint when role=USER', async () => {
    const app = makeApp({ role: 'USER' });

    // All three endpoints sit under the same router-level verifyRole gate.
    const breachesRes = await request(app).get('/api/lead-sla/breaches');
    expect(breachesRes.status).toBe(403);
    expect(breachesRes.body.code).toBe('RBAC_DENIED');

    const statsRes = await request(app).get('/api/lead-sla/stats');
    expect(statsRes.status).toBe(403);
    expect(statsRes.body.code).toBe('RBAC_DENIED');

    const checkRes = await request(app).post('/api/lead-sla/check-breaches');
    expect(checkRes.status).toBe(403);
    expect(checkRes.body.code).toBe('RBAC_DENIED');

    // Router short-circuits BEFORE the handler runs.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.contact.count).not.toHaveBeenCalled();
    expect(leadSlaEngine.runForTenant).not.toHaveBeenCalled();
  });
});
