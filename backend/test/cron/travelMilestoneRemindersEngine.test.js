// @ts-check
/**
 * Unit tests for backend/cron/travelMilestoneRemindersEngine.js — the 4-hourly
 * sweep that scans `TravelPaymentSchedule` rows for milestones whose `dueDate`
 * lands within T-7 / T-3 / T-1 / T+0 windows (UTC midnight buckets) and fires
 * a reminder per milestone. #901 Travel Billing — Arc 2 Slice 7 (PRD_TRAVEL_
 * BILLING.md UC-2.4).
 *
 * Why this file exists (gap class — new engine, cred-blocked STUB mode):
 *   - Real Wati/email delivery is Q9 cred-blocked. The STUB path MUST write
 *     an audit row with `stub: true` so the operator surface knows the
 *     notification was not actually sent. A regression that flips the stub
 *     flag to false silently would surface as "we thought the reminder went
 *     out but it didn't" — a customer-facing data-integrity issue.
 *   - Window bucketing is UTC-midnight half-open intervals; off-by-one in
 *     either boundary either double-fires (same milestone in two windows)
 *     or skips a day entirely (T-7 = 6 days because of < instead of <=).
 *   - Status filter must reject paid/overdue/waived. A regression that
 *     drops the filter spams paid customers with chase reminders.
 *   - Audit ordering matters: notify BEFORE audit. A swap would write
 *     "REMINDER_SENT" rows for failed deliveries, drift the operator's
 *     mental model of what's been chased.
 *   - One milestone failing must not abort the sweep — per-milestone try/
 *     catch isolates failures, and subsequent milestones in the same +
 *     later windows still run.
 *
 * Functions covered:
 *   - runMilestoneRemindersEngine
 *       Happy path: milestones across all 4 windows → processed counts
 *         match + byWindow tallies match.
 *       Empty world: zero rows → returns zeros, no audit calls.
 *       Status filter: WHERE.status uses { in: ['pending', 'partial'] }.
 *       Window query shape: 4 findMany calls, each with a different UTC-
 *         midnight half-open interval.
 *       Custom notify: called once per milestone with (m, invoice, days).
 *       Audit row shape: entity='TravelPaymentSchedule',
 *         action='MILESTONE_REMINDER_SENT', userId=null, details includes
 *         invoiceId + milestoneOrder + windowDays + stub flag.
 *       Stub flag: true when no notify arg, false when notify passed.
 *       `now` override shifts the window cutoffs accordingly.
 *       Audit ordering: notify is called BEFORE writeAudit per milestone.
 *       Failure isolation: one notify throw doesn't break the loop; other
 *         milestones still get their reminders.
 *   - computeWindow (pure helper)
 *       UTC midnight bucketing — handles day boundaries + month rollover.
 *
 * NOT covered (intentional):
 *   - server.js cron wire-in (slice 8 separate scope).
 *   - Real Wati / email delivery path (Q9 cred-blocked).
 *   - Inner audit-chain hash logic (audit.js has its own test file).
 *
 * Mocking strategy:
 *   Standard prisma-singleton monkey-patch via `import prisma from
 *   '../../lib/prisma.js'`. SUT module inlined via vitest.config.js's
 *   inline list. writeAuditSafe is self-spied via module.exports to avoid
 *   spinning a real audit-chain write (CJS-self-mocking-seam pattern,
 *   cron-learnings entry 2026-05-24 ~01:43 UTC). defaultStubNotifier is
 *   spied via module.exports too so the "stub fired N times" assertion
 *   works without intercepting console.log.
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const engine = requireCJS('../../cron/travelMilestoneRemindersEngine.js');

beforeAll(() => {
  prisma.travelPaymentSchedule = {
    findMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.travelPaymentSchedule.findMany.mockReset();
  // Default-pass shape: empty world.
  prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);

  // Self-spy seams. Tests that need to assert call args replace these.
  engine.writeAuditSafe = vi.fn().mockResolvedValue(undefined);
  engine.defaultStubNotifier = vi.fn().mockResolvedValue(undefined);
});

function milestone({
  id,
  tenantId = 1,
  invoiceId = 100,
  milestoneOrder = 1,
  status = 'pending',
  invoice = { id: 100, invoiceNum: 'TMC-2026-001', subBrand: 'TMC', contactId: 5, tenantId: 1, currency: 'INR' },
} = {}) {
  return { id, tenantId, invoiceId, milestoneOrder, status, invoice };
}

// ─── computeWindow (pure helper) ─────────────────────────────────────────────

describe('cron/travelMilestoneRemindersEngine — computeWindow', () => {
  test('T+0 window: [today-00:00 UTC, tomorrow-00:00 UTC)', () => {
    const now = new Date('2026-05-25T14:32:11.123Z');
    const { target, next } = engine.computeWindow(now, 0);
    expect(target.toISOString()).toBe('2026-05-25T00:00:00.000Z');
    expect(next.toISOString()).toBe('2026-05-26T00:00:00.000Z');
  });

  test('T-7 window: 7 days ahead at UTC midnight', () => {
    const now = new Date('2026-05-25T14:32:11.123Z');
    const { target, next } = engine.computeWindow(now, 7);
    expect(target.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(next.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  test('month rollover: T+0 from 2026-05-31 → June day-bucket arithmetic', () => {
    const now = new Date('2026-05-31T23:59:59.999Z');
    const { target, next } = engine.computeWindow(now, 1);
    // 1 day after 2026-05-31 UTC = 2026-06-01 UTC midnight.
    expect(target.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(next.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  test('half-open contract: next is exactly 1 day after target', () => {
    const now = new Date('2026-05-25T00:00:00.000Z');
    const { target, next } = engine.computeWindow(now, 3);
    expect(next.getTime() - target.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

// ─── Query shape ────────────────────────────────────────────────────────────

describe('cron/travelMilestoneRemindersEngine — query shape', () => {
  test('fires findMany once per window (4 calls — T-7 / T-3 / T-1 / T+0)', async () => {
    await engine.runMilestoneRemindersEngine({ now: new Date('2026-05-25T12:00:00.000Z') });
    expect(prisma.travelPaymentSchedule.findMany).toHaveBeenCalledTimes(4);
  });

  test('WHERE.status filter restricts to pending|partial only (not paid / overdue / waived)', async () => {
    await engine.runMilestoneRemindersEngine({ now: new Date('2026-05-25T12:00:00.000Z') });
    for (const call of prisma.travelPaymentSchedule.findMany.mock.calls) {
      expect(call[0].where.status).toEqual({ in: ['pending', 'partial'] });
    }
  });

  test('WHERE.dueDate spans a half-open 1-day UTC interval per window', async () => {
    const now = new Date('2026-05-25T12:00:00.000Z');
    await engine.runMilestoneRemindersEngine({ now });

    // 4 calls, one per window. Each WHERE.dueDate is { gte: <target>, lt: <next> }.
    const calls = prisma.travelPaymentSchedule.findMany.mock.calls;
    expect(calls.length).toBe(4);
    for (const [arg] of calls) {
      const { gte, lt } = arg.where.dueDate;
      // 24-hour half-open interval.
      expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000);
      // Both at UTC midnight (00:00:00.000).
      expect(gte.getUTCHours()).toBe(0);
      expect(gte.getUTCMinutes()).toBe(0);
      expect(gte.getUTCSeconds()).toBe(0);
      expect(gte.getUTCMilliseconds()).toBe(0);
    }
  });

  test('include.invoice pulls invoiceNum + subBrand + contactId + tenantId + currency', async () => {
    await engine.runMilestoneRemindersEngine({ now: new Date('2026-05-25T12:00:00.000Z') });
    const arg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    expect(arg.include.invoice.select).toMatchObject({
      id: true,
      invoiceNum: true,
      subBrand: true,
      contactId: true,
      tenantId: true,
      currency: true,
    });
  });

  test('window targets are 7 / 3 / 1 / 0 days from now (UTC midnight)', async () => {
    const now = new Date('2026-05-25T12:00:00.000Z');
    await engine.runMilestoneRemindersEngine({ now });

    // Each call's dueDate.gte should match one of the 4 UTC-midnight targets.
    const calls = prisma.travelPaymentSchedule.findMany.mock.calls;
    const gteISOs = calls.map((c) => c[0].where.dueDate.gte.toISOString()).sort();
    expect(gteISOs).toEqual(
      [
        '2026-05-25T00:00:00.000Z', // T+0
        '2026-05-26T00:00:00.000Z', // T-1
        '2026-05-28T00:00:00.000Z', // T-3
        '2026-06-01T00:00:00.000Z', // T-7
      ].sort(),
    );
  });
});

// ─── Happy path: notifier fired + audit written per milestone ────────────────

describe('cron/travelMilestoneRemindersEngine — happy path', () => {
  test('milestones in 3 windows → processed=3 + byWindow tallies match', async () => {
    const m7 = milestone({ id: 11 });
    const m3 = milestone({ id: 12 });
    const m1 = milestone({ id: 13 });
    // findMany returns rows in window order: T-7, T-3, T-1, T+0.
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([m7]) // T-7
      .mockResolvedValueOnce([m3]) // T-3
      .mockResolvedValueOnce([m1]) // T-1
      .mockResolvedValueOnce([]); // T+0

    const res = await engine.runMilestoneRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.processed).toBe(3);
    expect(res.byWindow).toEqual({ 7: 1, 3: 1, 1: 1, 0: 0 });
    expect(res.errors).toEqual([]);
  });

  test('custom notify is called once per milestone with (milestone, invoice, windowDays)', async () => {
    const m = milestone({ id: 99 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([m]) // T-7
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const notify = vi.fn().mockResolvedValue(undefined);
    await engine.runMilestoneRemindersEngine({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(m, m.invoice, 7);
  });

  test('audit row emitted per milestone with action=MILESTONE_REMINDER_SENT + windowDays + invoiceId', async () => {
    const m = milestone({ id: 42, invoiceId: 555, milestoneOrder: 2, tenantId: 7 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([m]) // T-3
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runMilestoneRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    const args = engine.writeAuditSafe.mock.calls[0];
    expect(args[0]).toBe('TravelPaymentSchedule');
    expect(args[1]).toBe('MILESTONE_REMINDER_SENT');
    expect(args[2]).toBe(42); // entityId
    expect(args[3]).toBe(null); // system actor
    expect(args[4]).toBe(7); // tenantId
    expect(args[5]).toMatchObject({
      invoiceId: 555,
      milestoneOrder: 2,
      windowDays: 3,
      stub: false, // notify was passed → real delivery → stub=false
    });
  });

  test('stub flag: stub=true when notify omitted (default STUB path)', async () => {
    const m = milestone({ id: 1 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([m])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runMilestoneRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.defaultStubNotifier).toHaveBeenCalledTimes(1);
    expect(engine.defaultStubNotifier).toHaveBeenCalledWith(m, m.invoice, 7);
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(true);
  });

  test('stub flag: stub=false when real notify passed in (wire-in path)', async () => {
    const m = milestone({ id: 2 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([m])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runMilestoneRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.defaultStubNotifier).not.toHaveBeenCalled();
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(false);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('cron/travelMilestoneRemindersEngine — edge cases', () => {
  test('empty world (no matching milestones in any window) → processed=0, byWindow all-zero, no audit calls', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);

    const res = await engine.runMilestoneRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res).toEqual({
      processed: 0,
      byWindow: { 7: 0, 3: 0, 1: 0, 0: 0 },
      errors: [],
    });
    expect(engine.writeAuditSafe).not.toHaveBeenCalled();
    expect(engine.defaultStubNotifier).not.toHaveBeenCalled();
  });

  test('multiple milestones in same window → all processed; byWindow counts increment correctly', async () => {
    const m1 = milestone({ id: 1 });
    const m2 = milestone({ id: 2 });
    const m3 = milestone({ id: 3 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([]) // T-3
      .mockResolvedValueOnce([m1, m2, m3]) // T-1: 3 hits
      .mockResolvedValueOnce([]); // T+0

    const res = await engine.runMilestoneRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.processed).toBe(3);
    expect(res.byWindow).toEqual({ 7: 0, 3: 0, 1: 3, 0: 0 });
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(3);
  });

  test('notify failure for one milestone does NOT break the loop (errors[] captures it, others still run)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m1 = milestone({ id: 1 });
    const m2 = milestone({ id: 2 });
    const m3 = milestone({ id: 3 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([m1, m2, m3]) // T-7: 3 hits
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const notify = vi
      .fn()
      .mockResolvedValueOnce(undefined) // m1 OK
      .mockRejectedValueOnce(new Error('wati timeout')) // m2 fails
      .mockResolvedValueOnce(undefined); // m3 OK

    const res = await engine.runMilestoneRemindersEngine({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.processed).toBe(2); // m1 + m3
    expect(res.byWindow).toEqual({ 7: 2, 3: 0, 1: 0, 0: 0 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ milestoneId: 2, error: 'wati timeout' });

    // Audit was written for m1 + m3 only (m2 failed before audit).
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(2);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('notify is called BEFORE writeAudit per milestone (audit ordering)', async () => {
    const m = milestone({ id: 1 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([m])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const callOrder = [];
    const notify = vi.fn(async () => {
      callOrder.push('notify');
    });
    engine.writeAuditSafe = vi.fn(async () => {
      callOrder.push('audit');
    });

    await engine.runMilestoneRemindersEngine({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(callOrder).toEqual(['notify', 'audit']);
  });

  test('`now` override shifts window cutoffs accordingly (not bound to wall-clock time)', async () => {
    const now1 = new Date('2026-05-25T00:00:00.000Z');
    const now2 = new Date('2027-01-15T00:00:00.000Z');

    await engine.runMilestoneRemindersEngine({ now: now1 });
    const gte1 = prisma.travelPaymentSchedule.findMany.mock.calls[0][0].where.dueDate.gte;
    expect(gte1.toISOString()).toBe('2026-06-01T00:00:00.000Z'); // T-7 from May 25

    prisma.travelPaymentSchedule.findMany.mockClear();
    await engine.runMilestoneRemindersEngine({ now: now2 });
    const gte2 = prisma.travelPaymentSchedule.findMany.mock.calls[0][0].where.dueDate.gte;
    expect(gte2.toISOString()).toBe('2027-01-22T00:00:00.000Z'); // T-7 from Jan 15
  });

  test('default `now`: when no `now` passed, uses real wall-clock — windows computed against current UTC day', async () => {
    const before = new Date();
    before.setUTCHours(0, 0, 0, 0);

    await engine.runMilestoneRemindersEngine({});

    const after = new Date();
    after.setUTCHours(0, 0, 0, 0);
    after.setUTCDate(after.getUTCDate() + 1);

    // T+0 window's gte should be today (UTC midnight). Allow for the rare
    // case where the test crosses UTC midnight mid-run.
    const calls = prisma.travelPaymentSchedule.findMany.mock.calls;
    const t0gte = calls[3][0].where.dueDate.gte; // T+0 is the 4th call
    expect(t0gte.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(t0gte.getTime()).toBeLessThan(after.getTime());
  });
});

// ─── Exported surface ───────────────────────────────────────────────────────

describe('cron/travelMilestoneRemindersEngine — exports', () => {
  test('REMINDER_WINDOWS_DAYS is [7, 3, 1, 0] in descending order', () => {
    expect(engine.REMINDER_WINDOWS_DAYS).toEqual([7, 3, 1, 0]);
  });

  test('module exports the surface used by tests + future wire-in slice', () => {
    expect(typeof engine.runMilestoneRemindersEngine).toBe('function');
    expect(typeof engine.computeWindow).toBe('function');
    expect(typeof engine.defaultStubNotifier).toBe('function');
    expect(typeof engine.writeAuditSafe).toBe('function');
    expect(Array.isArray(engine.REMINDER_WINDOWS_DAYS)).toBe(true);
  });
});
