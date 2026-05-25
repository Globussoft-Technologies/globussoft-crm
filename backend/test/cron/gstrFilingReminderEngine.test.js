// @ts-check
/**
 * Unit tests for backend/cron/gstrFilingReminderEngine.js — the daily sweep
 * that nudges GST-registered travel operators about the monthly GSTR-1
 * filing deadline (10th of each month). #902 Travel GST Compliance — slice
 * 11 (PRD_TRAVEL_GST_COMPLIANCE.md, reminder-ladder section).
 *
 * Why this file exists (gap class — new engine, cred-blocked STUB mode):
 *   - Real Wati/Mailgun delivery is Q9 / Q1 cred-blocked. The STUB path
 *     MUST write an audit row with `stub: true` so the operator surface
 *     knows the notification was not actually sent. A regression that
 *     silently flips the stub flag to false would surface as "we thought
 *     the GSTR-1 reminder went out but it didn't" — a compliance-facing
 *     data-integrity issue with monetary stakes (late fee + interest).
 *   - Tier-mapping arithmetic is the load-bearing piece: T-3 / T-1 / T-0 /
 *     T+ are the only days that send; T-7 / T-5 / T-4 / T-2 must be SILENT.
 *     A regression that broadens the silent range spams operators with
 *     daily nudges; a regression that narrows it silently misses the legal
 *     deadline.
 *   - Status / docType filter must reject CreditNote / DebitNote / Proforma
 *     / TravelVoucher — they don't enter GSTR-1 outward-supplies. A
 *     regression that broadens the filter scares operators who only ran
 *     credit-note activity in the prior month into thinking they have a
 *     return to file.
 *   - Audit ordering: notify BEFORE audit. A swap would write
 *     "GSTR_FILING_REMINDER_SENT" rows for failed deliveries, drift the
 *     operator's mental model of what's been chased.
 *   - Per-tenant try/catch isolates one Wati timeout from aborting the
 *     sweep — subsequent tenants still get their reminders.
 *
 * Functions covered:
 *   - reminderTier (pure): T-7 / T-5 / T-4 / T-2 → null (silent days);
 *       T-3 → "T-3", T-1 → "T-1", T-0 → "T-0", T+1 / T+5 → "T+".
 *   - computeDeadline (pure): 10th-of-current-month at UTC midnight.
 *   - computePriorMonthWindow (pure): prior-month [start, end) UTC window;
 *       handles year rollover at January.
 *   - runGstrFilingReminderEngine:
 *       Happy path: 3 travel tenants in a T-3 tick → processed=3, audit
 *         rows + notify calls match.
 *       Silent days: T-7 tick → processed=0, no findMany / notify / audit.
 *       Empty world: T-3 tick but no matching tenants → processed=0.
 *       Custom notify: called with (tenant, tier, daysToDeadline).
 *       Stub flag: true when notify omitted, false when passed in.
 *       Failure isolation: one notify throw doesn't break the loop.
 *       Audit ordering: notify before writeAudit per tenant.
 *       Query shape: where.vertical='travel', where.travelInvoices.some
 *         filters docType in ['TaxInvoice', null] + createdAt in last-
 *         month window.
 *       Custom `now`: deadline + prior-month window track the override.
 *
 * NOT covered (intentional):
 *   - server.js cron wire-in (out of scope for slice 11 — wire-in slice
 *     deferred to a follow-up).
 *   - Real Wati / Mailgun delivery path (Q9 / Q1 cred-blocked).
 *   - Inner audit-chain hash logic (audit.js has its own test file).
 *
 * Mocking strategy:
 *   Standard prisma-singleton monkey-patch via `import prisma from
 *   '../../lib/prisma.js'`. SUT module inlined via vitest.config.js's
 *   inline list. writeAuditSafe + defaultStubNotifier are self-spied via
 *   module.exports to avoid spinning a real audit-chain write + intercept
 *   the stub log (CJS-self-mocking-seam pattern, cron-learnings entry
 *   2026-05-24 ~01:43 UTC).
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const engine = requireCJS('../../cron/gstrFilingReminderEngine.js');

beforeAll(() => {
  prisma.tenant = {
    findMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.tenant.findMany.mockReset();
  // Default-pass shape: empty world.
  prisma.tenant.findMany.mockResolvedValue([]);

  // Self-spy seams. Tests that need to assert call args replace these.
  engine.writeAuditSafe = vi.fn().mockResolvedValue(undefined);
  engine.defaultStubNotifier = vi.fn().mockResolvedValue(undefined);
});

function tenant({ id, name = `Tenant ${id}`, slug = `t-${id}` } = {}) {
  return { id, name, slug };
}

// ─── reminderTier (pure helper) ──────────────────────────────────────────────

describe('cron/gstrFilingReminderEngine — reminderTier (pure)', () => {
  test('silent days (T-7, T-5, T-4, T-2) → null', () => {
    expect(engine.reminderTier(7)).toBeNull();
    expect(engine.reminderTier(5)).toBeNull();
    expect(engine.reminderTier(4)).toBeNull();
    expect(engine.reminderTier(2)).toBeNull();
  });

  test('T-3 → "T-3" (first reminder)', () => {
    expect(engine.reminderTier(3)).toBe('T-3');
  });

  test('T-1 → "T-1" (urgent reminder)', () => {
    expect(engine.reminderTier(1)).toBe('T-1');
  });

  test('T-0 → "T-0" (final reminder, day-of)', () => {
    expect(engine.reminderTier(0)).toBe('T-0');
  });

  test('post-deadline days (T+1, T+5, T+30) → "T+" (late warning)', () => {
    expect(engine.reminderTier(-1)).toBe('T+');
    expect(engine.reminderTier(-5)).toBe('T+');
    expect(engine.reminderTier(-30)).toBe('T+');
  });
});

// ─── computeDeadline + computePriorMonthWindow (pure helpers) ───────────────

describe('cron/gstrFilingReminderEngine — date helpers', () => {
  test('computeDeadline: 10th of current month at UTC midnight (from mid-month)', () => {
    const now = new Date('2026-05-25T14:32:11.123Z');
    expect(engine.computeDeadline(now).toISOString()).toBe(
      '2026-05-10T00:00:00.000Z',
    );
  });

  test('computeDeadline: from a date BEFORE the 10th still returns the 10th of same month', () => {
    const now = new Date('2026-05-03T00:00:00.000Z');
    expect(engine.computeDeadline(now).toISOString()).toBe(
      '2026-05-10T00:00:00.000Z',
    );
  });

  test('computePriorMonthWindow: from mid-May → April 1 ... May 1 UTC half-open', () => {
    const now = new Date('2026-05-25T14:32:11.123Z');
    const { start, end } = engine.computePriorMonthWindow(now);
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('computePriorMonthWindow: January now → prior month spans Dec 1 of prior year', () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    const { start, end } = engine.computePriorMonthWindow(now);
    expect(start.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

// ─── Silent / early-exit paths ──────────────────────────────────────────────

describe('cron/gstrFilingReminderEngine — silent days', () => {
  test('T-7 tick (early, silent) → processed=0, tier=null, NO prisma + NO audit + NO notify', async () => {
    // May 3 → deadline May 10 → 7 days out → silent.
    const res = await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-03T00:00:00.000Z'),
    });
    expect(res).toEqual({ processed: 0, tier: null, daysToDeadline: 7, errors: [] });
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    expect(engine.writeAuditSafe).not.toHaveBeenCalled();
    expect(engine.defaultStubNotifier).not.toHaveBeenCalled();
  });

  test('T-2 tick (cooldown, silent) → processed=0, tier=null, NO prisma calls', async () => {
    // May 8 → deadline May 10 → 2 days out → silent.
    const res = await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-08T00:00:00.000Z'),
    });
    expect(res.processed).toBe(0);
    expect(res.tier).toBeNull();
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });
});

// ─── Happy path: notifier + audit per tenant ────────────────────────────────

describe('cron/gstrFilingReminderEngine — happy path', () => {
  test('T-3 tick with 3 travel tenants → processed=3, audit + notify called per tenant', async () => {
    const tenants = [tenant({ id: 11 }), tenant({ id: 12 }), tenant({ id: 13 })];
    prisma.tenant.findMany.mockResolvedValue(tenants);

    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await engine.runGstrFilingReminderEngine({
      notify,
      now: new Date('2026-05-07T00:00:00.000Z'), // T-3 from May 10
    });

    expect(res.processed).toBe(3);
    expect(res.tier).toBe('T-3');
    expect(res.daysToDeadline).toBe(3);
    expect(res.errors).toEqual([]);

    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenNthCalledWith(1, tenants[0], 'T-3', 3);
    expect(notify).toHaveBeenNthCalledWith(2, tenants[1], 'T-3', 3);
    expect(notify).toHaveBeenNthCalledWith(3, tenants[2], 'T-3', 3);

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(3);
  });

  test('T-0 tick with 1 tenant → audit row carries action + entity + tier + tenantId correctly', async () => {
    const t = tenant({ id: 42 });
    prisma.tenant.findMany.mockResolvedValue([t]);

    await engine.runGstrFilingReminderEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-10T00:00:00.000Z'),
    });

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    const args = engine.writeAuditSafe.mock.calls[0];
    expect(args[0]).toBe('Tenant');
    expect(args[1]).toBe('GSTR_FILING_REMINDER_SENT');
    expect(args[2]).toBe(42); // entityId
    expect(args[3]).toBe(null); // system actor
    expect(args[4]).toBe(42); // tenantId (self-scoped)
    expect(args[5]).toMatchObject({
      tier: 'T-0',
      daysToDeadline: 0,
      stub: false, // notify was passed → real delivery
    });
  });

  test('T+5 tick (post-deadline late warning) → tier="T+", daysToDeadline=-5', async () => {
    const t = tenant({ id: 7 });
    prisma.tenant.findMany.mockResolvedValue([t]);

    const res = await engine.runGstrFilingReminderEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-15T00:00:00.000Z'),
    });

    expect(res.tier).toBe('T+');
    expect(res.daysToDeadline).toBe(-5);
    expect(res.processed).toBe(1);
  });

  test('stub flag: stub=true when notify omitted (default STUB path)', async () => {
    const t = tenant({ id: 1 });
    prisma.tenant.findMany.mockResolvedValue([t]);

    await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    expect(engine.defaultStubNotifier).toHaveBeenCalledTimes(1);
    expect(engine.defaultStubNotifier).toHaveBeenCalledWith(t, 'T-3', 3);
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(true);
  });

  test('stub flag: stub=false when real notify passed in (wire-in path)', async () => {
    const t = tenant({ id: 2 });
    prisma.tenant.findMany.mockResolvedValue([t]);

    await engine.runGstrFilingReminderEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-09T00:00:00.000Z'),
    });

    expect(engine.defaultStubNotifier).not.toHaveBeenCalled();
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(false);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('cron/gstrFilingReminderEngine — edge cases', () => {
  test('empty world (T-1 tick, no matching tenants) → processed=0 + tier still computed', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);

    const res = await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-09T00:00:00.000Z'),
    });

    expect(res).toEqual({
      processed: 0,
      tier: 'T-1',
      daysToDeadline: 1,
      errors: [],
    });
    expect(engine.writeAuditSafe).not.toHaveBeenCalled();
    expect(engine.defaultStubNotifier).not.toHaveBeenCalled();
  });

  test('notify failure for one tenant does NOT break the loop (errors[] captures it, others still run)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [t1, t2, t3] = [tenant({ id: 1 }), tenant({ id: 2 }), tenant({ id: 3 })];
    prisma.tenant.findMany.mockResolvedValue([t1, t2, t3]);

    const notify = vi
      .fn()
      .mockResolvedValueOnce(undefined) // t1 OK
      .mockRejectedValueOnce(new Error('wati 503 timeout')) // t2 fails
      .mockResolvedValueOnce(undefined); // t3 OK

    const res = await engine.runGstrFilingReminderEngine({
      notify,
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    expect(res.processed).toBe(2); // t1 + t3
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ tenantId: 2, error: 'wati 503 timeout' });

    // Audit was written for t1 + t3 only (t2 failed before audit).
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(2);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('notify is called BEFORE writeAudit per tenant (audit ordering)', async () => {
    const t = tenant({ id: 1 });
    prisma.tenant.findMany.mockResolvedValue([t]);

    const callOrder = [];
    const notify = vi.fn(async () => {
      callOrder.push('notify');
    });
    engine.writeAuditSafe = vi.fn(async () => {
      callOrder.push('audit');
    });

    await engine.runGstrFilingReminderEngine({
      notify,
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    expect(callOrder).toEqual(['notify', 'audit']);
  });

  test('`now` override shifts deadline computation (not bound to wall-clock)', async () => {
    // Two distinct months — deadline arithmetic should track the override.
    const t = tenant({ id: 1 });
    prisma.tenant.findMany.mockResolvedValue([t]);

    const notify = vi.fn().mockResolvedValue(undefined);

    // June 7 → T-3 from June 10
    const res1 = await engine.runGstrFilingReminderEngine({
      notify,
      now: new Date('2026-06-07T00:00:00.000Z'),
    });
    expect(res1.tier).toBe('T-3');
    expect(res1.daysToDeadline).toBe(3);

    notify.mockClear();
    engine.writeAuditSafe.mockClear();

    // December 10 → T-0 from December 10
    const res2 = await engine.runGstrFilingReminderEngine({
      notify,
      now: new Date('2026-12-10T00:00:00.000Z'),
    });
    expect(res2.tier).toBe('T-0');
    expect(res2.daysToDeadline).toBe(0);
  });
});

// ─── Query shape ────────────────────────────────────────────────────────────

describe('cron/gstrFilingReminderEngine — query shape', () => {
  test('where.vertical = "travel" + travelInvoices.some.docType in [TaxInvoice, null]', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);

    await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where.vertical).toBe('travel');
    expect(arg.where.travelInvoices.some.docType).toEqual({
      in: ['TaxInvoice', null],
    });
  });

  test('where.travelInvoices.some.createdAt spans the prior calendar month [start, end)', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);

    await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    const arg = prisma.tenant.findMany.mock.calls[0][0];
    const { gte, lt } = arg.where.travelInvoices.some.createdAt;
    expect(gte.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(lt.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('select projects only id + name + slug (no PHI / no full row leak)', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);

    await engine.runGstrFilingReminderEngine({
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({ id: true, name: true, slug: true });
  });
});

// ─── Exported surface ───────────────────────────────────────────────────────

describe('cron/gstrFilingReminderEngine — exports', () => {
  test('FILING_DEADLINE_DAY constant is 10 (GoI rule)', () => {
    expect(engine.FILING_DEADLINE_DAY).toBe(10);
  });

  test('module exports the surface used by tests + future wire-in slice', () => {
    expect(typeof engine.runGstrFilingReminderEngine).toBe('function');
    expect(typeof engine.reminderTier).toBe('function');
    expect(typeof engine.computeDeadline).toBe('function');
    expect(typeof engine.computePriorMonthWindow).toBe('function');
    expect(typeof engine.defaultStubNotifier).toBe('function');
    expect(typeof engine.writeAuditSafe).toBe('function');
  });
});
