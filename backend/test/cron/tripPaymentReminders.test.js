/**
 * Unit tests for backend/cron/tripPaymentReminders.js — daily TMC
 * payment-reminders cron. Mirrors the tripPostTripFeedback.test.js
 * mocking pattern.
 *
 * Branches covered:
 *   runPaymentRemindersForTenant:
 *     - query shape (tenant via trip relation, pending+partial status,
 *       30-day past + 60-day future bound)
 *     - phase classification (pre-due vs overdue) per reminderDays
 *     - reminderDays lookup from TripPaymentPlan.instalmentsJson (default
 *       7 when missing or unparseable)
 *     - dedup: existing Notification with (entityType+entityId+type) →
 *       skipped
 *     - both phases for the same instalment counted independently if
 *       neither notification exists yet
 *     - race-tolerance: Notification.create throws → cron continues
 *     - empty instalment list → fast-path, no plan fetch attempted
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runPaymentRemindersForTenant,
  runPaymentRemindersForAllTravelTenants,
} from '../../cron/tripPaymentReminders.js';

beforeAll(() => {
  prisma.tripInstalmentPayment = { findMany: vi.fn() };
  prisma.tripPaymentPlan = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass for the per-instalment wabaId log.
  prisma.tenant = { findUnique: vi.fn(), findMany: vi.fn() };
});

beforeEach(() => {
  prisma.tripInstalmentPayment.findMany.mockReset();
  prisma.tripPaymentPlan.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();

  prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
  prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
  prisma.tenant.findMany.mockResolvedValue([]);
});

describe('cron/tripPaymentReminders — runPaymentRemindersForTenant', () => {
  test('query shape: tenant via trip relation + pending/partial + 30d past / 60d future', async () => {
    await runPaymentRemindersForTenant(42);

    expect(prisma.tripInstalmentPayment.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tripInstalmentPayment.findMany.mock.calls[0][0];
    expect(arg.where.trip).toEqual({ tenantId: 42 });
    expect(arg.where.status).toEqual({ in: ['pending', 'partial'] });
    expect(arg.where.dueDate).toHaveProperty('gte');
    expect(arg.where.dueDate).toHaveProperty('lte');
    expect(arg.where.dueDate.gte.getTime()).toBeLessThan(arg.where.dueDate.lte.getTime());
  });

  test('empty instalment list short-circuits — plan fetch not called', async () => {
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 0, overdue: 0 });
    expect(prisma.tripPaymentPlan.findMany).not.toHaveBeenCalled();
  });

  test('pre-due window: instalment 3 days out with reminderDays=7 → info notification', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      {
        id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending',
      },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 1, overdue: 0 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.entityType).toBe('TripInstalmentPayment');
    expect(createArg.data.entityId).toBe(100);
    expect(createArg.data.type).toBe('info');
    expect(createArg.data.priority).toBe('normal');
  });

  test('overdue window: instalment dueDate 5 days ago → warning notification', async () => {
    const due5DaysAgo = new Date(Date.now() - 5 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      {
        id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: due5DaysAgo, amount: 5000, paidAmount: 0, status: 'pending',
      },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 0, overdue: 1 });
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.type).toBe('warning');
    expect(createArg.data.priority).toBe('high');
  });

  test('outside pre-due window: instalment 20 days out, reminderDays=7 → no notification', async () => {
    const dueIn20Days = new Date(Date.now() + 20 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      {
        id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn20Days, amount: 5000, paidAmount: 0, status: 'pending',
      },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 0, overdue: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('default reminderDays=7 used when plan JSON is missing/empty', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      {
        id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending',
      },
    ]);
    // No plan row at all.
    prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 1, overdue: 0 });
  });

  test('dedup: existing notification with same entity+type → skipped', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      {
        id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending',
      },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 999 });

    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 0, overdue: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('race-tolerance: Notification.create throws → cron continues, no propagation', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0, dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
      { id: 101, tripId: 7, participantId: 201, instalmentIndex: 0, dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('unique violation (race)'))
      .mockResolvedValueOnce({ id: 50 });

    const result = await runPaymentRemindersForTenant(1);
    // First create throws (not counted); second succeeds.
    expect(result.dueSoon).toBe(1);
    expect(result.overdue).toBe(0);
  });

  test('mixed: two instalments, one pre-due + one overdue → both counted', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    const due5DaysAgo = new Date(Date.now() - 5 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0, dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
      { id: 101, tripId: 8, participantId: 201, instalmentIndex: 0, dueDate: due5DaysAgo, amount: 7500, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
      { tripId: 8, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    expect(result.dueSoon).toBe(1);
    expect(result.overdue).toBe(1);
  });

  // ── new cases (tick of test-writing cron) ────────────────────────────

  test('query shape: 500-row cap + only id/tripId/participantId/etc selected', async () => {
    await runPaymentRemindersForTenant(42);
    const arg = prisma.tripInstalmentPayment.findMany.mock.calls[0][0];
    expect(arg.take).toBe(500);
    expect(arg.select).toEqual({
      id: true,
      tripId: true,
      participantId: true,
      instalmentIndex: true,
      dueDate: true,
      amount: true,
      paidAmount: true,
      status: true,
    });
  });

  test('malformed plan instalmentsJson → defaults to reminderDays=7 + no throw', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    // Garbage JSON — try/catch in cron falls back to empty array → default=7.
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: '{not-valid-json' },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 1, overdue: 0 });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  test('non-finite reminderDays in plan entry → defaults to 7', async () => {
    const dueIn5Days = new Date(Date.now() + 5 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn5Days, amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      // reminderDays is "soon" — Number("soon") = NaN, isFinite(NaN) = false → default 7.
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 'soon' }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    // 5 days out, default 7 → in pre-due window → notification fires.
    expect(result).toEqual({ dueSoon: 1, overdue: 0 });
  });

  test('extended reminderDays=14 widens the pre-due window — 10-day-out instalment fires', async () => {
    const dueIn10Days = new Date(Date.now() + 10 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn10Days, amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 14 }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    // 10 days out, reminderDays=14 → in pre-due window → fire.
    expect(result).toEqual({ dueSoon: 1, overdue: 0 });
  });

  test('invalid dueDate (NaN) → instalment skipped (continue), no create + no throw', async () => {
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        // new Date('not-a-date').getTime() is NaN → cron `continue`s.
        dueDate: new Date('not-a-date'), amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);

    const result = await runPaymentRemindersForTenant(1);
    expect(result).toEqual({ dueSoon: 0, overdue: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('notification body includes amount (locale-formatted) + ISO due-date', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    const dueIso = dueIn3Days.toISOString().slice(0, 10);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 2,
        dueDate: dueIn3Days, amount: 125000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      // instalmentIndex=2 → plan entry at [2] missing → defaults to {} → reminderDays default 7.
      { tripId: 7, instalmentsJson: JSON.stringify([{}, {}, { reminderDays: 7 }]) },
    ]);

    await runPaymentRemindersForTenant(1);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const data = prisma.notification.create.mock.calls[0][0].data;
    // amount uses en-IN locale: 125000 → "1,25,000".
    expect(data.title).toContain('1,25,000');
    expect(data.title).toContain('due soon');
    expect(data.message).toContain(dueIso);
    // instalmentIndex=2 → displayed as #3 (1-based).
    expect(data.message).toContain('#3');
  });

  test('subBrandConfigJson with tmc.wabaId resolved + log line printed (no PII leak)', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({
      subBrandConfigJson: JSON.stringify({
        tmc: { wabaId: 'WABA_TMC_001', gstin: '29ABCDE1234F1Z5' },
      }),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runPaymentRemindersForTenant(1);
    expect(result.dueSoon).toBe(1);
    // wabaId IS logged (per cron's own design).
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toContain('WABA_TMC_001');
    // gstin/legalEntityCode must NEVER leak to logs (subBrandConfig PII-safety).
    expect(joined).not.toContain('29ABCDE1234F1Z5');
    logSpy.mockRestore();
  });

  test('tenant has no subBrandConfig → wabaId log reads "(no-config)" — sentinel string', async () => {
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
        dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);
    prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runPaymentRemindersForTenant(1);
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toContain('wabaId=(no-config)');
    logSpy.mockRestore();
  });
});

describe('cron/tripPaymentReminders — runPaymentRemindersForAllTravelTenants', () => {
  test('queries only travel + isActive tenants', async () => {
    await runPaymentRemindersForAllTravelTenants();
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ vertical: 'travel', isActive: true });
    expect(arg.select).toEqual({ id: true, slug: true });
  });

  test('per-tenant failure isolation — first throws, second still processed; totals accumulate', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 1, slug: 'tmc-tenant-a' },
      { id: 2, slug: 'tmc-tenant-b' },
    ]);
    const dueIn3Days = new Date(Date.now() + 3 * 86400_000);
    // tenant 1: instalment findMany throws.
    prisma.tripInstalmentPayment.findMany
      .mockRejectedValueOnce(new Error('db blip'))
      // tenant 2: one pre-due instalment.
      .mockResolvedValueOnce([
        { id: 100, tripId: 7, participantId: 200, instalmentIndex: 0,
          dueDate: dueIn3Days, amount: 5000, paidAmount: 0, status: 'pending' },
      ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 7, instalmentsJson: JSON.stringify([{ reminderDays: 7 }]) },
    ]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPaymentRemindersForAllTravelTenants();
    // tenant 1's failure absorbed; tenant 2's 1 due-soon counted.
    expect(result).toEqual({ dueSoon: 1, overdue: 0 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
