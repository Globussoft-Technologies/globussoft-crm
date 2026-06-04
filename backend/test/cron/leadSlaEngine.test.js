// @ts-check
/**
 * Unit tests for backend/cron/leadSlaEngine.js — Lead-side SLA breach detector
 * that runs every 2 minutes (PRD §6.4). Distinct from cron/slaBreachEngine.js
 * (Ticket-side). Candidate set per tenant:
 *   - tenantId scoped
 *   - status = 'Lead'
 *   - firstResponseAt IS NULL
 *   - firstResponseDueAt < now()
 *   - slaBreached = false           ← idempotency gate
 *   - deletedAt IS NULL             ← soft-delete safety
 *
 * For each match: flips slaBreached=true + stamps slaBreachedAt=now,
 * then emits 'lead.sla_breached' on the in-process event bus with payload:
 *   { contactId, name, email, phone, source, assigneeId, dueAt, breachedAt,
 *     breachedBy }
 *
 * Per-row try/catch so one failed update can't abort siblings; per-tenant
 * try/catch around processTenant so one bad tenant can't kill the tick.
 *
 * Why this file exists (regression class — Wave 5 Agent XX cron coverage gap):
 *   - Engine has zero existing vitest unit coverage. Awkward branches:
 *       - Per-row error containment when contact.update throws mid-loop
 *         (one failed lead does NOT block sibling leads in the same tenant).
 *       - Per-tenant isolation in tickLeadSlaBreaches — one bad tenant doesn't
 *         abort the cron.
 *       - Idempotency gate (slaBreached=false in WHERE) — already-breached rows
 *         filtered at the DB layer.
 *       - The defensive `breachedBy = dueAt ? ... : 0` branch — if a candidate
 *         row's firstResponseDueAt is null (shouldn't happen given WHERE
 *         clause, but defensively handled), the engine still emits with
 *         breachedBy=0 instead of throwing on null arithmetic.
 *       - Soft-deleted contact filter (deletedAt: null) — a leak there would
 *             tick GDPR-erased leads.
 *
 * Functions / branches covered:
 *   - processTenant
 *       Happy path → contact.update fires with {slaBreached:true, slaBreachedAt:Date}
 *         AND emitEvent fires (proven via prisma.automationRule.findMany as proxy,
 *         see "Mocking strategy" below).
 *       Empty candidate set → no update, no emit, returns {checked:0, breached:0}.
 *       findMany WHERE shape: tenantId + status='Lead' + firstResponseAt:null
 *         + firstResponseDueAt:{lt: now} + slaBreached:false + deletedAt:null.
 *       findMany SELECT shape: id/name/email/phone/source/assignedToId
 *         /firstResponseDueAt/tenantId.
 *       Per-row error containment: failing update logs + continues; sibling
 *         still processed; breachedIds contains only the survivor.
 *       breachedBy math: dueAt → breachedAt - dueAt (positive ms);
 *                         null dueAt → 0 (defensive fallback).
 *       Return shape: {tenant, checked, breached, ids} keyed on slug or id.
 *   - tickLeadSlaBreaches (top-level orchestrator)
 *       Tenant query: where.isActive=true + scoped select {id, slug}.
 *       Aggregates totalChecked + totalBreached across N tenants.
 *       Per-tenant error isolation: one tenant throws → siblings still ticked,
 *         tenantsProcessed reflects only the successful ones.
 *       Top-level findMany failure → caught, returns zeros.
 *   - runForTenant (manual-trigger entry point)
 *       Unknown tenant id → returns {checked:0, breached:0, ids:[]}.
 *       Known tenant → delegates to processTenant, returns {checked, breached, ids}.
 *
 * NOT covered (intentional):
 *   - initLeadSlaCron: schedule shell (registers cron + logs init line).
 *     Asserting node-cron registration provides no behavioural coverage.
 *   - Direct payload-shape assertions on the 'lead.sla_breached' event.
 *     Vitest's vi.mock cannot intercept the SUT's CJS `require('../lib/eventBus')`
 *     in this repo. Same indirection as slaBreachEngine.test.js — emitEvent's
 *     async tail invokes prisma.automationRule.findMany, so we observe the
 *     downstream side effect to prove the emit fired with the right
 *     eventName + tenantId.
 *
 * Mocking strategy:
 *   Mirror backend/test/cron/slaBreachEngine.test.js (32 tests, 91% coverage).
 *   Import the prisma singleton, monkey-patch model methods. The SUT module
 *   is inlined via vitest.config.js so its `require('../lib/prisma')` resolves
 *   to the same singleton instance under test.
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';

import prisma from '../../lib/prisma.js';

import {
  processTenant,
  tickLeadSlaBreaches,
  runForTenant,
} from '../../cron/leadSlaEngine.js';

beforeAll(() => {
  prisma.contact = { findMany: vi.fn(), updateMany: vi.fn() };
  prisma.tenant = { findMany: vi.fn(), findUnique: vi.fn() };
  // emitEvent's async tail touches automationRule.findMany + webhook.findMany.
  // Stub both so the real emitEvent (running inside the SUT) returns clean
  // and we can use automationRule.findMany.mock.calls as a proxy for "emitEvent
  // fired with eventName=X, tenantId=Y".
  prisma.automationRule = { findMany: vi.fn() };
  prisma.webhook = { findMany: vi.fn() };
});

beforeEach(() => {
  prisma.contact.findMany.mockReset();
  prisma.contact.updateMany.mockReset();
  prisma.tenant.findMany.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.automationRule.findMany.mockReset();
  prisma.webhook.findMany.mockReset();

  prisma.contact.findMany.mockResolvedValue([]);
  // Atomic breach flip (commit 214017c1): updateMany guarded by
  // slaBreached:false; count===1 means "we won the race", engine proceeds.
  prisma.contact.updateMany.mockResolvedValue({ count: 1 });
  prisma.tenant.findMany.mockResolvedValue([]);
  prisma.tenant.findUnique.mockResolvedValue(null);
  prisma.automationRule.findMany.mockResolvedValue([]); // no rules → no executeAction
  prisma.webhook.findMany.mockResolvedValue([]);
});

const TENANT = { id: 'tenant-A', slug: 'enhanced' };

function leadCandidate({
  id,
  name = 'Aanya Sharma',
  email = 'aanya@example.in',
  phone = '+919812345678',
  source = 'IndiaMART',
  assignedToId = 17,
  firstResponseDueAt = new Date(Date.now() - 60 * 1000), // 1 min ago
  tenantId = 'tenant-A',
}) {
  return { id, name, email, phone, source, assignedToId, firstResponseDueAt, tenantId };
}

/**
 * Filters automationRule.findMany invocations to those triggered by emitEvent
 * (where.triggerType present). Returns an array of {eventName, tenantId}
 * derived from the where clause — one entry per emitEvent call.
 */
function emitEventCalls() {
  return prisma.automationRule.findMany.mock.calls
    .map((c) => c[0]?.where)
    .filter((w) => w && w.triggerType)
    .map((w) => ({ eventName: w.triggerType, tenantId: w.tenantId }));
}

// ─── Candidate query shape ──────────────────────────────────────────────────

describe('cron/leadSlaEngine — candidate query shape', () => {
  test('issues exactly ONE contact.findMany per processTenant run', async () => {
    await processTenant(TENANT);
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
  });

  test('where clause scopes to tenantId + status="Lead" + null firstResponseAt + overdue + slaBreached=false + deletedAt:null', async () => {
    const before = Date.now();
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];

    expect(arg.where.tenantId).toBe('tenant-A');
    expect(arg.where.status).toBe('Lead');
    expect(arg.where.firstResponseAt).toBeNull();
    expect(arg.where.slaBreached).toBe(false);
    expect(arg.where.deletedAt).toBeNull();

    expect(arg.where.firstResponseDueAt).toHaveProperty('lt');
    const lt = arg.where.firstResponseDueAt.lt.getTime();
    expect(lt).toBeGreaterThanOrEqual(before);
    expect(lt).toBeLessThanOrEqual(Date.now() + 50);
  });

  test('select pins the exact column set (id, name, email, phone, source, assignedToId, firstResponseDueAt, tenantId)', async () => {
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      name: true,
      email: true,
      phone: true,
      source: true,
      assignedToId: true,
      firstResponseDueAt: true,
      tenantId: true,
    });
  });

  test('uses strict less-than (lt), not lte/gt — "due exactly now" is NOT yet breached', async () => {
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where.firstResponseDueAt).toHaveProperty('lt');
    expect(arg.where.firstResponseDueAt).not.toHaveProperty('lte');
    expect(arg.where.firstResponseDueAt).not.toHaveProperty('gt');
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe('cron/leadSlaEngine — happy path: breach detected', () => {
  test('overdue lead → contact.update flips slaBreached=true + emits lead.sla_breached', async () => {
    const due = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 42, firstResponseDueAt: due }),
    ]);

    const res = await processTenant(TENANT);

    expect(prisma.contact.updateMany).toHaveBeenCalledTimes(1);
    const updArg = prisma.contact.updateMany.mock.calls[0][0];
    expect(updArg.where).toEqual({ id: 42, slaBreached: false });
    expect(updArg.data.slaBreached).toBe(true);
    expect(updArg.data.slaBreachedAt).toBeInstanceOf(Date);

    const emits = emitEventCalls();
    expect(emits).toHaveLength(1);
    expect(emits[0].eventName).toBe('lead.sla_breached');
    expect(emits[0].tenantId).toBe('tenant-A');

    expect(res).toEqual({
      tenant: 'enhanced',
      checked: 1,
      breached: 1,
      ids: [42],
    });
  });

  test('slaBreachedAt on contact.update is approximately now() (within 1s)', async () => {
    const before = Date.now();
    prisma.contact.findMany.mockResolvedValueOnce([leadCandidate({ id: 1 })]);

    await processTenant(TENANT);

    const slaBreachedAt = prisma.contact.updateMany.mock.calls[0][0].data.slaBreachedAt;
    expect(slaBreachedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(slaBreachedAt.getTime()).toBeLessThanOrEqual(Date.now() + 50);
  });

  test('multiple overdue leads → all updated + all emitted (one event per row)', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 1 }),
      leadCandidate({ id: 2 }),
      leadCandidate({ id: 3 }),
    ]);

    const res = await processTenant(TENANT);

    expect(prisma.contact.updateMany).toHaveBeenCalledTimes(3);
    expect(emitEventCalls()).toHaveLength(3);
    expect(res.checked).toBe(3);
    expect(res.breached).toBe(3);
    expect(res.ids).toEqual([1, 2, 3]);
  });

  test('returns tenant identifier from slug when present, falls back to id otherwise', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([leadCandidate({ id: 1 })]);
    const slugRes = await processTenant({ id: 'tenant-A', slug: 'enhanced' });
    expect(slugRes.tenant).toBe('enhanced');

    prisma.contact.findMany.mockResolvedValueOnce([leadCandidate({ id: 2 })]);
    const idRes = await processTenant({ id: 'tenant-B' /* no slug */ });
    expect(idRes.tenant).toBe('tenant-B');
  });
});

// ─── Empty / negative candidate sets (state-filter guarantees) ──────────────

describe('cron/leadSlaEngine — within-SLA / non-breach paths', () => {
  test('empty candidate set → no update, no emit, returns zeros', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([]);

    const res = await processTenant(TENANT);

    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    expect(emitEventCalls()).toHaveLength(0);
    expect(res).toEqual({ tenant: 'enhanced', checked: 0, breached: 0, ids: [] });
  });

  test('idempotency: already-breached rows are filtered at the DB layer (slaBreached=false in WHERE)', async () => {
    // The state filter is part of the WHERE clause — when slaBreached=true,
    // prisma simply excludes the row. Engine sees no candidates → zero work.
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where.slaBreached).toBe(false);
  });

  test('soft-deleted contacts (deletedAt != null) excluded from candidate set', async () => {
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where.deletedAt).toBeNull();
  });

  test('non-Lead status (e.g. Customer / Active) excluded — engine only ticks status="Lead"', async () => {
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('Lead');
  });

  test('already-acknowledged leads (firstResponseAt != null) excluded — engine only ticks unacknowledged', async () => {
    await processTenant(TENANT);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where.firstResponseAt).toBeNull();
  });
});

// ─── breachedBy math ────────────────────────────────────────────────────────

describe('cron/leadSlaEngine — breachedBy timing math', () => {
  test('positive breachedBy when dueAt is in the past (breach detected)', async () => {
    const due = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 5, firstResponseDueAt: due }),
    ]);

    await processTenant(TENANT);

    // We can't easily inspect the emitted payload (vi.mock can't intercept the
    // SUT's CJS-required eventBus), but we CAN observe via automationRule.findMany
    // that emitEvent fired exactly once.
    expect(emitEventCalls()).toHaveLength(1);
    // And we CAN inspect contact.update side effect — slaBreachedAt is set.
    const slaBreachedAt = prisma.contact.updateMany.mock.calls[0][0].data.slaBreachedAt;
    // breachedBy = slaBreachedAt - dueAt; expect ~10min = 600,000 ms ± 1s.
    const computedBreachedBy = slaBreachedAt.getTime() - due.getTime();
    expect(computedBreachedBy).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(computedBreachedBy).toBeLessThan(10 * 60 * 1000 + 5000);
  });

  test('null firstResponseDueAt on candidate → engine still updates + emits without throwing on null arithmetic (defensive fallback)', async () => {
    // The engine has `breachedBy = dueAt ? breachedAt - dueAt : 0` — even if
    // a row sneaks through with null firstResponseDueAt, no NaN / TypeError.
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 1, firstResponseDueAt: null }),
    ]);

    const res = await processTenant(TENANT);

    expect(res.breached).toBe(1);
    expect(prisma.contact.updateMany).toHaveBeenCalledTimes(1);
    expect(emitEventCalls()).toHaveLength(1);
  });
});

// ─── Per-row error containment ──────────────────────────────────────────────

describe('cron/leadSlaEngine — per-row error containment', () => {
  test('one failing update does NOT abort siblings; survivor still updated + emitted', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 1 }),
      leadCandidate({ id: 2 }),
      leadCandidate({ id: 3 }),
    ]);
    prisma.contact.updateMany
      .mockRejectedValueOnce(new Error('DB write failed for id=1'))
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const res = await processTenant(TENANT);

    // All three attempts fired
    expect(prisma.contact.updateMany).toHaveBeenCalledTimes(3);
    // Only two emits (the failing row never reached emitEvent)
    expect(emitEventCalls()).toHaveLength(2);
    // breachedIds reflects only the successful rows
    expect(res.checked).toBe(3);
    expect(res.breached).toBe(2);
    expect(res.ids).toEqual([2, 3]);
  });

  test('failing update logs to console.error (no silent swallow)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.contact.findMany.mockResolvedValueOnce([leadCandidate({ id: 99 })]);
    prisma.contact.updateMany.mockRejectedValueOnce(new Error('boom'));

    await processTenant(TENANT);

    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(msg).toContain('LeadSLABreach');
    expect(msg).toContain('contact=99');

    errSpy.mockRestore();
  });

  test('processTenant resolves (does NOT throw) when every row fails', async () => {
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 1 }),
      leadCandidate({ id: 2 }),
    ]);
    prisma.contact.updateMany
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'));

    await expect(processTenant(TENANT)).resolves.toEqual({
      tenant: 'enhanced',
      checked: 2,
      breached: 0,
      ids: [],
    });
  });
});

// ─── Top-level tickLeadSlaBreaches orchestrator ─────────────────────────────

describe('cron/leadSlaEngine — tickLeadSlaBreaches orchestrator', () => {
  test('queries active tenants only (where.isActive=true) with scoped select {id, slug}', async () => {
    await tickLeadSlaBreaches();
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isActive: true });
    expect(arg.select).toEqual({ id: true, slug: true });
  });

  test('aggregates totalChecked + totalBreached across tenants', async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: 'tA', slug: 'a' },
      { id: 'tB', slug: 'b' },
    ]);
    // Tenant A: 2 candidates, both breach
    prisma.contact.findMany
      .mockResolvedValueOnce([leadCandidate({ id: 1, tenantId: 'tA' }), leadCandidate({ id: 2, tenantId: 'tA' })])
      .mockResolvedValueOnce([leadCandidate({ id: 3, tenantId: 'tB' })]);

    const res = await tickLeadSlaBreaches();

    expect(res.tenantsProcessed).toBe(2);
    expect(res.totalChecked).toBe(3);
    expect(res.totalBreached).toBe(3);
  });

  test('per-tenant isolation: one tenant throwing does NOT abort siblings', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: 'tA', slug: 'a' },
      { id: 'tB', slug: 'b' },
      { id: 'tC', slug: 'c' },
    ]);
    // Tenant A: ok 1 lead. Tenant B: findMany throws. Tenant C: ok 1 lead.
    prisma.contact.findMany
      .mockResolvedValueOnce([leadCandidate({ id: 1, tenantId: 'tA' })])
      .mockRejectedValueOnce(new Error('tenant B db down'))
      .mockResolvedValueOnce([leadCandidate({ id: 9, tenantId: 'tC' })]);

    const res = await tickLeadSlaBreaches();

    expect(res.tenantsProcessed).toBe(2);
    expect(res.totalChecked).toBe(2);
    expect(res.totalBreached).toBe(2);
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  test('top-level tenant.findMany failure → caught, returns zeros', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.tenant.findMany.mockRejectedValueOnce(new Error('top-level db down'));

    const res = await tickLeadSlaBreaches();

    expect(res).toEqual({ tenantsProcessed: 0, totalChecked: 0, totalBreached: 0 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('zero tenants → returns clean zeros, no contact.findMany calls', async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([]);

    const res = await tickLeadSlaBreaches();

    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(res).toEqual({ tenantsProcessed: 0, totalChecked: 0, totalBreached: 0 });
  });
});

// ─── runForTenant manual-trigger entry point ────────────────────────────────

describe('cron/leadSlaEngine — runForTenant', () => {
  test('unknown tenant id → returns {checked:0, breached:0, ids:[]} without DB churn', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);

    const res = await runForTenant('non-existent');

    expect(res).toEqual({ checked: 0, breached: 0, ids: [] });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  test('known tenant → delegates to processTenant; returns {checked, breached, ids} (sans tenant key)', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 'tenant-A', slug: 'enhanced' });
    prisma.contact.findMany.mockResolvedValueOnce([
      leadCandidate({ id: 11 }),
      leadCandidate({ id: 22 }),
    ]);

    const res = await runForTenant('tenant-A');

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 'tenant-A' },
      select: { id: true, slug: true },
    });
    expect(res).toEqual({ checked: 2, breached: 2, ids: [11, 22] });
    // Note: 'tenant' key is intentionally stripped by runForTenant.
    expect(res).not.toHaveProperty('tenant');
  });

  test('runForTenant scopes to ONLY the requested tenant (no cross-tenant leakage)', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 'tenant-X', slug: 'x' });
    prisma.contact.findMany.mockResolvedValueOnce([leadCandidate({ id: 1 })]);

    await runForTenant('tenant-X');

    // Only ONE contact.findMany call, scoped to tenantId='tenant-X'
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findMany.mock.calls[0][0].where.tenantId).toBe('tenant-X');
  });
});
