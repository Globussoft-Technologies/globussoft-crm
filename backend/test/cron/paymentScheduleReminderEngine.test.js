// @ts-check
/**
 * Unit tests for backend/cron/paymentScheduleReminderEngine.js — C8 of the
 * Travel Codeable Backlog (PRD_TRAVEL_BILLING UC-2.4).
 *
 * The engine sweeps TravelPaymentSchedule rows whose dueDate lands in the
 * T-7 / T-3 / T-1 UTC-midnight windows + status ∈ {pending, partial},
 * fires a per-row send via the injectable notify callback (SMS + email
 * real once the callback is wired; WA leg STUBbed pending Q9), bumps
 * remindersSentCount + lastReminderSentAt on the schedule, and writes
 * an audit row.
 *
 * Why this file exists (gap classes the C8 engine introduces):
 *   - Window bucketing identical to the supplier sibling — off-by-one in
 *     either UTC boundary either double-fires (same schedule in two
 *     windows) or skips a day entirely. Mirrors travelMilestoneRemindersEngine
 *     / supplierPayableRemindersEngine to keep the 3 sibling engines
 *     contract-aligned.
 *   - Status filter must reject paid / overdue / waived. A regression
 *     dropping the filter would spam already-settled milestones.
 *   - Per-schedule send cap MAX_REMINDERS_PER_SCHEDULE = 3 prevents a
 *     same-tick re-run from over-sending. A regression flipping the
 *     comparator to `>` instead of `>=` would silently allow a 4th send.
 *   - Counter increment + lastReminderSentAt timestamp must happen on
 *     successful send only — failed sends must not bump the counter, or
 *     the next tick won't retry them.
 *   - Audit ordering: notify BEFORE audit + counter bump. A swap would
 *     drift the operator's mental model of what's actually been sent.
 *   - Per-row failure isolation — one row's notify throw must not abort
 *     the sweep; subsequent rows + later windows still run.
 *   - tenantsProcessed counts unique tenants — multi-tenant 1-tick sweep
 *     groups correctly without per-tenant orchestration.
 *
 * Functions covered:
 *   - processReminders (happy path, status filter, query shape, counter
 *     bump, idempotency cap, audit ordering, failure isolation, multi-
 *     tenant, T+0 NOT included, custom notify)
 *   - computeWindow (pure helper)
 *
 * NOT covered (intentional):
 *   - server.js cron wire-in (separate concern; covered by the import
 *     test on the module's `initCron` export).
 *   - Real SMS/email dispatcher path (depends on injected notify
 *     callback; the wire-in slice for real delivery is out of scope).
 *
 * Mocking strategy:
 *   prisma singleton monkey-patch (engine inlined via vitest.config.js
 *   server.deps.inline). writeAuditSafe + defaultStubNotifier self-spied
 *   via module.exports per the CJS-self-mocking-seam pattern
 *   (cron-learnings entry 2026-05-24 ~01:43 UTC).
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const engine = requireCJS('../../cron/paymentScheduleReminderEngine.js');

beforeAll(() => {
  prisma.travelPaymentSchedule = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.travelPaymentSchedule.update.mockReset().mockResolvedValue({ id: 0 });
  engine.writeAuditSafe = vi.fn().mockResolvedValue(undefined);
  engine.defaultStubNotifier = vi.fn().mockResolvedValue(undefined);
});

function schedule({
  id = 1,
  tenantId = 1,
  invoiceId = 99,
  milestoneOrder = 1,
  status = 'pending',
  expectedAmount = '50000.00',
  expectedCurrency = 'INR',
  remindersSentCount = 0,
  invoice = {
    id: 99,
    invoiceNum: 'TINV-2026-0001',
    subBrand: 'tmc',
    contactId: 555,
    tenantId: 1,
    currency: 'INR',
    totalAmount: '200000.00',
  },
} = {}) {
  return {
    id,
    tenantId,
    invoiceId,
    milestoneOrder,
    status,
    expectedAmount,
    expectedCurrency,
    remindersSentCount,
    lastReminderSentAt: null,
    invoice,
  };
}

// ─── computeWindow (pure helper) ─────────────────────────────────────────────

describe('cron/paymentScheduleReminderEngine — computeWindow', () => {
  test('T-7 window: [day+7-00:00 UTC, day+8-00:00 UTC)', () => {
    const now = new Date('2026-05-25T14:32:11.123Z');
    const { target, next } = engine.computeWindow(now, 7);
    expect(target.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(next.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  test('T-1 window: tomorrow at UTC midnight', () => {
    const now = new Date('2026-05-25T14:32:11.123Z');
    const { target, next } = engine.computeWindow(now, 1);
    expect(target.toISOString()).toBe('2026-05-26T00:00:00.000Z');
    expect(next.toISOString()).toBe('2026-05-27T00:00:00.000Z');
  });

  test('half-open contract: next is exactly 1 day after target', () => {
    const now = new Date('2026-05-25T00:00:00.000Z');
    const { target, next } = engine.computeWindow(now, 3);
    expect(next.getTime() - target.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

// ─── Test 1 + 5 — empty + T+0 NOT fired ──────────────────────────────────────

describe('cron/paymentScheduleReminderEngine — empty + window contract', () => {
  test('case 1 — empty schedule list → 0 reminders sent', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    const res = await engine.processReminders({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(res.remindersSent).toBe(0);
    expect(res.schedulesEvaluated).toBe(0);
    expect(res.tenantsProcessed).toBe(0);
    expect(res.errors).toEqual([]);
    expect(engine.writeAuditSafe).not.toHaveBeenCalled();
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });

  test('case 5 — T+0 (today) does NOT fire (only T-7 / T-3 / T-1)', async () => {
    await engine.processReminders({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    // 3 windows, not 4 — T+0 deliberately excluded per the engine spec.
    expect(prisma.travelPaymentSchedule.findMany).toHaveBeenCalledTimes(3);
    expect(engine.REMINDER_WINDOWS_DAYS).toEqual([7, 3, 1]);

    const gteISOs = prisma.travelPaymentSchedule.findMany.mock.calls
      .map((c) => c[0].where.dueDate.gte.toISOString())
      .sort();
    expect(gteISOs).toEqual(
      [
        '2026-05-26T00:00:00.000Z', // T-1
        '2026-05-28T00:00:00.000Z', // T-3
        '2026-06-01T00:00:00.000Z', // T-7
      ].sort(),
    );
    // T+0 (2026-05-25) is NOT in the list.
    expect(gteISOs).not.toContain('2026-05-25T00:00:00.000Z');
  });
});

// ─── Test 2, 3, 4 — T-7 / T-3 / T-1 milestone fires ──────────────────────────

describe('cron/paymentScheduleReminderEngine — window milestones', () => {
  test('case 2 — T-7 milestone fires (byWindow[7] increments)', async () => {
    const s = schedule({ id: 11 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([s]) // T-7
      .mockResolvedValueOnce([]) // T-3
      .mockResolvedValueOnce([]); // T-1
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(res.byWindow).toEqual({ 7: 1, 3: 0, 1: 0 });
    expect(res.remindersSent).toBe(1);
    expect(notify).toHaveBeenCalledWith(s, s.invoice, 7);
  });

  test('case 3 — T-3 milestone fires (byWindow[3] increments)', async () => {
    const s = schedule({ id: 22 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([s]) // T-3
      .mockResolvedValueOnce([]); // T-1
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(res.byWindow).toEqual({ 7: 0, 3: 1, 1: 0 });
    expect(notify).toHaveBeenCalledWith(s, s.invoice, 3);
  });

  test('case 4 — T-1 milestone fires (byWindow[1] increments)', async () => {
    const s = schedule({ id: 33 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([]) // T-7
      .mockResolvedValueOnce([]) // T-3
      .mockResolvedValueOnce([s]); // T-1
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(res.byWindow).toEqual({ 7: 0, 3: 0, 1: 1 });
    expect(notify).toHaveBeenCalledWith(s, s.invoice, 1);
  });
});

// ─── Test 6, 7, 8 — guards: cap, cancelled, paid ────────────────────────────

describe('cron/paymentScheduleReminderEngine — guards', () => {
  test('case 6 — already-sent guard (remindersSentCount >= 3) → skip (no notify, no audit, no update)', async () => {
    const capped = schedule({ id: 50, remindersSentCount: 3 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([capped]) // T-7
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(engine.writeAuditSafe).not.toHaveBeenCalled();
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
    expect(res.remindersSent).toBe(0);
    expect(res.schedulesEvaluated).toBe(1);
  });

  test('case 7 — cancelled / waived / overdue / paid never appear in the query (status filter pins pending|partial)', async () => {
    await engine.processReminders({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    for (const call of prisma.travelPaymentSchedule.findMany.mock.calls) {
      expect(call[0].where.status).toEqual({ in: ['pending', 'partial'] });
    }
  });

  test('case 8 — paid schedule never appears in the query (status filter pins pending|partial)', async () => {
    // Mirrors case 7 from a different angle — explicitly pin that the
    // engine never targets `paid`. (A future regression that flips the
    // status set silently would surface here OR in case 7.)
    await engine.processReminders({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    for (const call of prisma.travelPaymentSchedule.findMany.mock.calls) {
      const set = call[0].where.status.in;
      expect(set).not.toContain('paid');
      expect(set).not.toContain('overdue');
      expect(set).not.toContain('waived');
      expect(set).not.toContain('cancelled');
    }
  });
});

// ─── Test 9 — provider error isolation ──────────────────────────────────────

describe('cron/paymentScheduleReminderEngine — failure isolation', () => {
  test('case 9 — one notify throw doesn\'t break the sweep; row recorded in errors[]; counter NOT bumped for failed row', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s1 = schedule({ id: 1 });
    const s2 = schedule({ id: 2 });
    const s3 = schedule({ id: 3 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([s1, s2, s3]) // T-7: 3 hits
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const notify = vi
      .fn()
      .mockResolvedValueOnce(undefined) // s1 OK
      .mockRejectedValueOnce(new Error('sendgrid 503')) // s2 fails
      .mockResolvedValueOnce(undefined); // s3 OK

    const res = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(res.remindersSent).toBe(2);
    expect(res.errors).toEqual([
      { scheduleId: 2, error: 'sendgrid 503' },
    ]);
    expect(res.byWindow[7]).toBe(2);

    // Update fired for s1 + s3 only — s2 failed BEFORE the counter bump.
    expect(prisma.travelPaymentSchedule.update).toHaveBeenCalledTimes(2);
    const updatedIds = prisma.travelPaymentSchedule.update.mock.calls.map(
      (c) => c[0].where.id,
    );
    expect(updatedIds.sort()).toEqual([1, 3]);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── Test 10 — multi-tenant counts ──────────────────────────────────────────

describe('cron/paymentScheduleReminderEngine — multi-tenant', () => {
  test('case 10 — tenantsProcessed counts unique tenants seen across windows', async () => {
    const a = schedule({ id: 1, tenantId: 7 });
    const b = schedule({ id: 2, tenantId: 7 }); // same tenant
    const c = schedule({ id: 3, tenantId: 99 }); // different
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([a, c]) // T-7
      .mockResolvedValueOnce([b]) // T-3
      .mockResolvedValueOnce([]);

    const notify = vi.fn().mockResolvedValue(undefined);
    const res = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(res.tenantsProcessed).toBe(2);
    expect(res.remindersSent).toBe(3);
  });
});

// ─── Test 11 — same-day re-run idempotency via counter ──────────────────────

describe('cron/paymentScheduleReminderEngine — idempotency', () => {
  test('case 11 — counter bump persists between re-runs (simulates 2nd tick within same day)', async () => {
    // First tick: counter starts at 0, bumps to 1.
    const first = schedule({ id: 70, remindersSentCount: 0 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const notify = vi.fn().mockResolvedValue(undefined);
    const r1 = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(r1.remindersSent).toBe(1);
    expect(prisma.travelPaymentSchedule.update).toHaveBeenCalledWith({
      where: { id: 70 },
      data: expect.objectContaining({ remindersSentCount: 1 }),
    });

    // Reset spy state; second tick: same row but counter is now at the cap (3).
    notify.mockClear();
    engine.writeAuditSafe.mockClear();
    prisma.travelPaymentSchedule.update.mockClear();
    const capped = schedule({ id: 70, remindersSentCount: 3 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([capped])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const r2 = await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:30:00.000Z'),
    });
    expect(r2.remindersSent).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });
});

// ─── Test 12 — audit row shape ──────────────────────────────────────────────

describe('cron/paymentScheduleReminderEngine — audit', () => {
  test('case 12 — audit row created on each send with full detail shape (entity, action, ids, channels, stub)', async () => {
    const s = schedule({
      id: 42,
      tenantId: 7,
      invoiceId: 999,
      milestoneOrder: 2,
      expectedAmount: '125000.50',
      expectedCurrency: 'INR',
      invoice: {
        id: 999,
        invoiceNum: 'TINV-2026-0042',
        subBrand: 'tmc',
        contactId: 11,
        tenantId: 7,
        currency: 'INR',
        totalAmount: '500000.00',
      },
    });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([s]) // T-3
      .mockResolvedValueOnce([]);

    await engine.processReminders({
      notify: vi.fn().mockResolvedValue(undefined),
      now: new Date('2026-05-25T12:00:00.000Z'),
    });

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    const args = engine.writeAuditSafe.mock.calls[0];
    expect(args[0]).toBe('TravelPaymentSchedule');
    expect(args[1]).toBe('PAYMENT_SCHEDULE_REMINDER_SENT');
    expect(args[2]).toBe(42); // entityId
    expect(args[3]).toBe(null); // system actor
    expect(args[4]).toBe(7); // tenantId
    expect(args[5]).toMatchObject({
      invoiceId: 999,
      invoiceNum: 'TINV-2026-0042',
      milestoneOrder: 2,
      windowDays: 3,
      expectedAmount: '125000.50',
      expectedCurrency: 'INR',
      channels: { sms: true, email: true, wa: false },
      stub: false, // real notify passed → stub=false
    });
  });

  test('audit ordering: notify is called BEFORE writeAudit + counter bump', async () => {
    const s = schedule({ id: 1 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([s])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const callOrder = [];
    const notify = vi.fn(async () => { callOrder.push('notify'); });
    engine.writeAuditSafe = vi.fn(async () => { callOrder.push('audit'); });
    prisma.travelPaymentSchedule.update.mockImplementation(async () => {
      callOrder.push('counter-bump');
      return { id: 1 };
    });

    await engine.processReminders({
      notify,
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(callOrder).toEqual(['notify', 'counter-bump', 'audit']);
  });

  test('stub flag: stub=true when notify omitted (default STUB path)', async () => {
    const s = schedule({ id: 1 });
    prisma.travelPaymentSchedule.findMany
      .mockResolvedValueOnce([s])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await engine.processReminders({
      now: new Date('2026-05-25T12:00:00.000Z'),
    });
    expect(engine.defaultStubNotifier).toHaveBeenCalledTimes(1);
    expect(engine.writeAuditSafe.mock.calls[0][5].stub).toBe(true);
    expect(engine.writeAuditSafe.mock.calls[0][5].channels).toEqual({
      sms: false,
      email: false,
      wa: false,
    });
  });
});

// ─── Module surface ─────────────────────────────────────────────────────────

describe('cron/paymentScheduleReminderEngine — exports', () => {
  test('REMINDER_WINDOWS_DAYS pins to [7, 3, 1] (NOT [7,3,1,0] — T+0 owned by overdue cron)', () => {
    expect(engine.REMINDER_WINDOWS_DAYS).toEqual([7, 3, 1]);
  });

  test('MAX_REMINDERS_PER_SCHEDULE is 3 (the per-row send cap)', () => {
    expect(engine.MAX_REMINDERS_PER_SCHEDULE).toBe(3);
  });

  test('module exports the surface used by tests + future wire-in slice', () => {
    expect(typeof engine.processReminders).toBe('function');
    expect(typeof engine.initCron).toBe('function');
    expect(typeof engine.computeWindow).toBe('function');
    expect(typeof engine.defaultStubNotifier).toBe('function');
    expect(typeof engine.writeAuditSafe).toBe('function');
    expect(Array.isArray(engine.REMINDER_WINDOWS_DAYS)).toBe(true);
    expect(typeof engine.MAX_REMINDERS_PER_SCHEDULE).toBe('number');
  });
});
