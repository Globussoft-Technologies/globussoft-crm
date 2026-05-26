// @ts-check
/**
 * Unit tests for backend/cron/supplierPayableRemindersEngine.js — the 4-hourly
 * sweep that scans `TravelSupplierPayable` rows for payables whose `dueDate`
 * lands within T-7 / T-3 / T-1 / T+0 windows (UTC midnight buckets) and fires
 * a reminder per payable. #903 Travel Supplier Master — Arc 2 follow-on
 * (PRD_TRAVEL_SUPPLIER_MASTER.md + PRD_TRAVEL_BILLING.md UC-2.3).
 *
 * Why this file exists (gap class — new engine, cred-blocked STUB mode):
 *   - Real Wati/email delivery to suppliers is Q9 cred-blocked. The STUB
 *     path MUST write an audit row with `stub: true` so the operator
 *     surface knows the notification was not actually sent. A regression
 *     that flips the stub flag to false silently would surface as "we
 *     thought the reminder went out but it didn't" — an AP-operator
 *     data-integrity issue.
 *   - Window bucketing is UTC-midnight half-open intervals; off-by-one in
 *     either boundary either double-fires (same payable in two windows)
 *     or skips a day entirely (T-7 = 6 days because of < instead of <=).
 *   - Status filter must reject `paid` and `cancelled`. A regression that
 *     drops the filter spams already-paid suppliers with chase reminders
 *     (relationship damage) or chases cancelled POs (operator confusion).
 *     IMPORTANT: TravelSupplierPayable's status set is { pending,
 *     scheduled, paid, cancelled } — DIFFERENT from TravelPaymentSchedule
 *     (the sibling milestone engine), which uses { pending, partial, paid,
 *     overdue, waived }. Tests pin the supplier-payable-specific set.
 *   - Audit ordering matters: notify BEFORE audit. A swap would write
 *     "REMINDER_SENT" rows for failed deliveries, drift the operator's
 *     mental model of what's been chased.
 *   - One payable failing must not abort the sweep — per-payable try/
 *     catch isolates failures, and subsequent payables in the same +
 *     later windows still run.
 *
 * Functions covered:
 *   - runSupplierPayableRemindersEngine
 *       Happy path: payables across all 4 windows → processed counts
 *         match + byWindow tallies match.
 *       Empty world: zero rows → returns zeros, no audit calls.
 *       Status filter: WHERE.status uses { in: ['pending', 'scheduled'] }.
 *       Window query shape: 4 findMany calls, each with a different UTC-
 *         midnight half-open interval.
 *       Custom notify: called once per payable with (payable, supplier, days).
 *       Audit row shape: entity='TravelSupplierPayable',
 *         action='SUPPLIER_PAYABLE_REMINDER_SENT', userId=null, details
 *         includes supplierId + poNumber + amount + currency + windowDays
 *         + stub flag.
 *       Stub flag: true when no notify arg, false when notify passed.
 *       `now` override shifts the window cutoffs accordingly.
 *       Audit ordering: notify is called BEFORE writeAudit per payable.
 *       Failure isolation: one notify throw doesn't break the loop; other
 *         payables still get their reminders.
 *   - computeWindow (pure helper)
 *       UTC midnight bucketing — handles day boundaries + month rollover.
 *
 * NOT covered (intentional):
 *   - server.js cron wire-in (separate slice, OUT OF SCOPE).
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
const engine = requireCJS('../../cron/supplierPayableRemindersEngine.js');

beforeAll(() => {
  prisma.travelSupplierPayable = {
    findMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.travelSupplierPayable.findMany.mockReset();
  // Default-pass shape: empty world.
  prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

  // Self-spy seams. Tests that need to assert call args replace these.
  engine.writeAuditSafe = vi.fn().mockResolvedValue(undefined);
  engine.defaultStubNotifier = vi.fn().mockResolvedValue(undefined);
});

function payable({
  id,
  tenantId = 1,
  supplierId = 50,
  poNumber = 'PO-2026-0123',
  amount = '450000.00',
  currency = 'INR',
  status = 'pending',
  supplier = {
    id: 50,
    name: 'Air India',
    tenantId: 1,
    email: 'ap@airindia.in',
    phone: '+911140000000',
    subBrand: 'RFU',
  },
} = {}) {
  return { id, tenantId, supplierId, poNumber, amount, currency, status, supplier };
}

// ─── computeWindow (pure helper) ─────────────────────────────────────────────

describe('cron/supplierPayableRemindersEngine — computeWindow', () => {
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

  test('month rollover: 1 day after 2026-05-31 → 2026-06-01 UTC midnight', () => {
    const now = new Date('2026-05-31T23:59:59.999Z');
    const { target, next } = engine.computeWindow(now, 1);
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

describe('cron/supplierPayableRemindersEngine — query shape', () => {
  test('fires findMany once per window (4 calls — T-7 / T-3 / T-1 / T+0)', async () => {
    await engine.runSupplierPayableRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(prisma.travelSupplierPayable.findMany).toHaveBeenCalledTimes(4);
  });

  test('WHERE.status filter restricts to pending|scheduled only (not paid / cancelled)', async () => {
    await engine.runSupplierPayableRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    for (const call of prisma.travelSupplierPayable.findMany.mock.calls) {
      expect(call[0].where.status).toEqual({ in: ['pending', 'scheduled'] });
    }
  });

  test('WHERE.dueDate spans a half-open 1-day UTC interval per window', async () => {
    const now = new Date('2026-05-25T12:00:00.000Z');
    await engine.runSupplierPayableRemindersEngine({ now });

    const calls = prisma.travelSupplierPayable.findMany.mock.calls;
    expect(calls.length).toBe(4);
    for (const [arg] of calls) {
      const { gte, lt } = arg.where.dueDate;
      expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(gte.getUTCHours()).toBe(0);
      expect(gte.getUTCMinutes()).toBe(0);
      expect(gte.getUTCSeconds()).toBe(0);
      expect(gte.getUTCMilliseconds()).toBe(0);
    }
  });

  test('include.supplier pulls name + tenantId + email + phone (operator-contactable fields)', async () => {
    await engine.runSupplierPayableRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    const arg = prisma.travelSupplierPayable.findMany.mock.calls[0][0];
    expect(arg.include.supplier.select).toMatchObject({
      id: true,
      name: true,
      tenantId: true,
      email: true,
      phone: true,
      subBrand: true,
    });
  });

  test('window targets are 7 / 3 / 1 / 0 days from now (UTC midnight)', async () => {
    const now = new Date('2026-05-25T12:00:00.000Z');
    await engine.runSupplierPayableRemindersEngine({ now });

    const calls = prisma.travelSupplierPayable.findMany.mock.calls;
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

// ─── Happy path: notifier fired + audit written per payable ──────────────────

describe('cron/supplierPayableRemindersEngine — happy path', () => {
  test('payables in 3 windows → processed=3 + byWindow tallies match', async () => {
    const p7 = payable({ id: 11 });
    const p3 = payable({ id: 12 });
    const p1 = payable({ id: 13 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p7]) // T-7
      .mockResolvedValueOnce([p3]) // T-3
      .mockResolvedValueOnce([p1]) // T-1
      .mockResolvedValueOnce([]); // T+0

    const res = await engine.runSupplierPayableRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.processed).toBe(3);
    expect(res.byWindow).toEqual({ 7: 1, 3: 1, 1: 1, 0: 0 });
    expect(res.errors).toEqual([]);
  });

  test('custom notify is called once per payable with (payable, supplier, windowDays)', async () => {
    const p = payable({ id: 99 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p]) // T-7
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const notify = vi.fn().mockResolvedValue(undefined);
    await engine.runSupplierPayableRemindersEngine({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(p, p.supplier, 7);
  });

  test('audit row emitted per payable with action=SUPPLIER_PAYABLE_REMINDER_SENT + full detail shape', async () => {
    const p = payable({
      id: 42,
      tenantId: 7,
      supplierId: 88,
      poNumber: 'PO-2026-0555',
      amount: '125000.50',
      currency: 'INR',
    });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([p]) // T-3
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runSupplierPayableRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    const args = engine.writeAuditSafe.mock.calls[0];
    expect(args[0]).toBe('TravelSupplierPayable');
    expect(args[1]).toBe('SUPPLIER_PAYABLE_REMINDER_SENT');
    expect(args[2]).toBe(42); // entityId
    expect(args[3]).toBe(null); // system actor
    expect(args[4]).toBe(7); // tenantId
    expect(args[5]).toMatchObject({
      supplierId: 88,
      poNumber: 'PO-2026-0555',
      amount: '125000.50',
      currency: 'INR',
      windowDays: 3,
      stub: false, // notify was passed → real delivery → stub=false
    });
  });

  test('audit detail handles null poNumber (free-form-PO is optional in schema)', async () => {
    const p = payable({ id: 5, poNumber: null });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runSupplierPayableRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    const details = engine.writeAuditSafe.mock.calls[0][5];
    expect(details.poNumber).toBe(null);
  });

  test('stub flag: stub=true when notify omitted (default STUB path)', async () => {
    const p = payable({ id: 1 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runSupplierPayableRemindersEngine({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.defaultStubNotifier).toHaveBeenCalledTimes(1);
    expect(engine.defaultStubNotifier).toHaveBeenCalledWith(p, p.supplier, 7);
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(true);
  });

  test('stub flag: stub=false when real notify passed in (wire-in path)', async () => {
    const p = payable({ id: 2 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.runSupplierPayableRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.defaultStubNotifier).not.toHaveBeenCalled();
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(false);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('cron/supplierPayableRemindersEngine — edge cases', () => {
  test('empty world → processed=0, byWindow all-zero, no audit/notify calls', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);

    const res = await engine.runSupplierPayableRemindersEngine({
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

  test('multiple payables in same window → all processed; byWindow counts increment correctly', async () => {
    const p1 = payable({ id: 1 });
    const p2 = payable({ id: 2 });
    const p3 = payable({ id: 3 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([]) // T-3
      .mockResolvedValueOnce([p1, p2, p3]) // T-1: 3 hits
      .mockResolvedValueOnce([]); // T+0

    const res = await engine.runSupplierPayableRemindersEngine({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.processed).toBe(3);
    expect(res.byWindow).toEqual({ 7: 0, 3: 0, 1: 3, 0: 0 });
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(3);
  });

  test('notify failure for one payable does NOT break the loop (errors[] captures it, others still run)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p1 = payable({ id: 1 });
    const p2 = payable({ id: 2 });
    const p3 = payable({ id: 3 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p1, p2, p3]) // T-7: 3 hits
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const notify = vi
      .fn()
      .mockResolvedValueOnce(undefined) // p1 OK
      .mockRejectedValueOnce(new Error('wati timeout')) // p2 fails
      .mockResolvedValueOnce(undefined); // p3 OK

    const res = await engine.runSupplierPayableRemindersEngine({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.processed).toBe(2); // p1 + p3 only
    expect(res.byWindow).toEqual({ 7: 2, 3: 0, 1: 0, 0: 0 });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ payableId: 2, error: 'wati timeout' });

    // Audit was written for p1 + p3 only (p2 failed before audit).
    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(2);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('notify is called BEFORE writeAudit per payable (audit ordering)', async () => {
    const p = payable({ id: 1 });
    prisma.travelSupplierPayable.findMany
      .mockResolvedValueOnce([p])
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

    await engine.runSupplierPayableRemindersEngine({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(callOrder).toEqual(['notify', 'audit']);
  });

  test('`now` override shifts window cutoffs accordingly (not bound to wall-clock)', async () => {
    const now1 = new Date('2026-05-25T00:00:00.000Z');
    const now2 = new Date('2027-01-15T00:00:00.000Z');

    await engine.runSupplierPayableRemindersEngine({ now: now1 });
    const gte1 = prisma.travelSupplierPayable.findMany.mock.calls[0][0].where.dueDate.gte;
    expect(gte1.toISOString()).toBe('2026-06-01T00:00:00.000Z'); // T-7 from May 25

    prisma.travelSupplierPayable.findMany.mockClear();
    await engine.runSupplierPayableRemindersEngine({ now: now2 });
    const gte2 = prisma.travelSupplierPayable.findMany.mock.calls[0][0].where.dueDate.gte;
    expect(gte2.toISOString()).toBe('2027-01-22T00:00:00.000Z'); // T-7 from Jan 15
  });

  test('default `now`: when no `now` passed, uses real wall-clock — windows computed against current UTC day', async () => {
    const before = new Date();
    before.setUTCHours(0, 0, 0, 0);

    await engine.runSupplierPayableRemindersEngine({});

    const after = new Date();
    after.setUTCHours(0, 0, 0, 0);
    after.setUTCDate(after.getUTCDate() + 1);

    // T+0 window's gte should be today (UTC midnight). Allow for the rare
    // case where the test crosses UTC midnight mid-run.
    const calls = prisma.travelSupplierPayable.findMany.mock.calls;
    const t0gte = calls[3][0].where.dueDate.gte; // T+0 is the 4th call
    expect(t0gte.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(t0gte.getTime()).toBeLessThan(after.getTime());
  });
});

// ─── Exported surface ───────────────────────────────────────────────────────

describe('cron/supplierPayableRemindersEngine — exports', () => {
  test('REMINDER_WINDOWS_DAYS is [7, 3, 1, 0] in descending order', () => {
    expect(engine.REMINDER_WINDOWS_DAYS).toEqual([7, 3, 1, 0]);
  });

  test('module exports the surface used by tests + future wire-in slice', () => {
    expect(typeof engine.runSupplierPayableRemindersEngine).toBe('function');
    expect(typeof engine.computeWindow).toBe('function');
    expect(typeof engine.defaultStubNotifier).toBe('function');
    expect(typeof engine.writeAuditSafe).toBe('function');
    expect(Array.isArray(engine.REMINDER_WINDOWS_DAYS)).toBe(true);
  });
});
