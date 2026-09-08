import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runCalendarRemindersForTenant,
  runCalendarRemindersForAllTenants,
} from '../../cron/calendarReminderEngine.js';

beforeAll(() => {
  prisma.calendarEvent = { findMany: vi.fn() };
  prisma.tenant = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  prisma.notificationPreference = { findUnique: vi.fn() };
});

beforeEach(() => {
  prisma.calendarEvent.findMany.mockReset();
  prisma.tenant.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.notificationPreference.findUnique.mockReset();

  prisma.calendarEvent.findMany.mockResolvedValue([]);
  prisma.tenant.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prisma.notificationPreference.findUnique.mockResolvedValue(null);
});

function event({ id, minsUntilStart, title = 'Project meeting', description = '', provider = 'google', userId = 11, tenantId = 7 }) {
  return {
    id,
    title,
    description,
    provider,
    userId,
    tenantId,
    startTime: new Date(Date.now() + minsUntilStart * 60 * 1000),
  };
}

describe('cron/calendarReminderEngine', () => {
  test('queries tenant events inside the 24h horizon', async () => {
    await runCalendarRemindersForTenant(7);
    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(7);
    expect(arg.where.startTime).toHaveProperty('gte');
    expect(arg.where.startTime).toHaveProperty('lte');
    expect(arg.where.startTime.lte.getTime() - arg.where.startTime.gte.getTime())
      .toBeGreaterThan(23 * 3600 * 1000);
  });

  test('sends 30m and 10m reminders as notifications', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      event({ id: 101, minsUntilStart: 30, title: 'Sales sync' }),
      event({ id: 102, minsUntilStart: 10, title: 'Demo review' }),
      event({ id: 103, minsUntilStart: 24 * 60, title: 'Later meeting' }),
    ]);

    const result = await runCalendarRemindersForTenant(7);
    expect(result.notified).toBe(3);
    expect(prisma.notification.create).toHaveBeenCalledTimes(3);

    const titles = prisma.notification.create.mock.calls.map((call) => call[0].data.title);
    expect(titles).toEqual(expect.arrayContaining([
      'Meeting reminder: Later meeting',
      'Meeting starting in 30 mins: Sales sync',
      'Meeting starting in 10 mins: Demo review',
    ]));
  });

  test('backfills a missed 24h reminder within the safety window', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      event({ id: 104, minsUntilStart: 23 * 60 + 34, title: 'Late 24h reminder' }),
    ]);

    const result = await runCalendarRemindersForTenant(7);
    expect(result.notified).toBe(1);
    const title = prisma.notification.create.mock.calls[0][0].data.title;
    expect(title).toBe('Meeting reminder: Late 24h reminder');
  });

  test('deduped reminder does not create a notification row', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      event({ id: 201, minsUntilStart: 30, title: 'Duplicate check' }),
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 555 });

    const result = await runCalendarRemindersForTenant(7);
    expect(result.notified).toBe(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('all-tenant sweep iterates active tenants', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 7, slug: 'alpha' }, { id: 8, slug: 'beta' }]);
    prisma.calendarEvent.findMany
      .mockResolvedValueOnce([event({ id: 301, minsUntilStart: 10, tenantId: 7 })])
      .mockResolvedValueOnce([]);

    const result = await runCalendarRemindersForAllTenants();
    expect(result.totalNotified).toBe(1);
    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(2);
  });
});
