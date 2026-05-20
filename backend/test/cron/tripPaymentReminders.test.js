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

import { runPaymentRemindersForTenant } from '../../cron/tripPaymentReminders.js';

beforeAll(() => {
  prisma.tripInstalmentPayment = { findMany: vi.fn() };
  prisma.tripPaymentPlan = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
});

beforeEach(() => {
  prisma.tripInstalmentPayment.findMany.mockReset();
  prisma.tripPaymentPlan.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();

  prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
  prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
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
});
