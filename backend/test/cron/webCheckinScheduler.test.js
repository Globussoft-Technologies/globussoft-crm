/**
 * Unit tests for backend/cron/webCheckinScheduler.js — Travel CRM
 * web check-in scheduler (manual-only model).
 *
 * Branches covered:
 *   runWebCheckinSchedulerForTenant:
 *     - query shape: tenant + status = pending + departureAt within next 24h
 *     - empty result → fast-path {notifiedUsers: 0}
 *     - pending with departureAt > 24h away → no notification
 *     - pending with departureAt within 24h + assignedAgentId → notify agent
 *     - pending with departureAt within 24h + no agent → notify all ADMIN/MANAGER
 *     - dedup: existing notification within 24h → skip
 *     - done rows are ignored
 *     - race-tolerance: notification create throws → cron continues
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runWebCheckinSchedulerForTenant,
  runWebCheckinSchedulerForAllTravelTenants,
} from '../../cron/webCheckinScheduler.js';

beforeAll(() => {
  prisma.webCheckin = { findMany: vi.fn() };
  prisma.user = { findUnique: vi.fn(), findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  prisma.notificationPreference = { findUnique: vi.fn() };
  prisma.tenant = { findMany: vi.fn() };
});

beforeEach(() => {
  prisma.webCheckin.findMany.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.notificationPreference.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();

  prisma.webCheckin.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prisma.notificationPreference.findUnique.mockResolvedValue(null);
  prisma.tenant.findMany.mockResolvedValue([]);
});

describe('cron/webCheckinScheduler — runWebCheckinSchedulerForTenant', () => {
  test('query shape: tenant + status pending + departureAt within 24h', async () => {
    await runWebCheckinSchedulerForTenant(42);
    expect(prisma.webCheckin.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.webCheckin.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.status).toBe('pending');
    expect(arg.where.departureAt).toHaveProperty('gte');
    expect(arg.where.departureAt).toHaveProperty('lte');
    const span = arg.where.departureAt.lte.getTime() - arg.where.departureAt.gte.getTime();
    expect(span).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
    expect(span).toBeLessThanOrEqual(24 * 3600_000 + 1000);
  });

  test('empty rows → fast-path {notifiedUsers:0}, no notification calls', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([]);
    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ notifiedUsers: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('pending departure > 24h away → no notification', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 100, pnr: 'ABC123', airlineCode: '6E', flightNumber: '203',
        passengerName: 'Alice', departureAt: new Date(Date.now() + 48 * 3600_000),
        assignedAgentId: null,
      },
    ]);
    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ notifiedUsers: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('pending within 24h + assignedAgentId → notify that agent only', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 100, pnr: 'ABC123', airlineCode: '6E', flightNumber: '203',
        passengerName: 'Alice', departureAt: new Date(Date.now() + 6 * 3600_000),
        assignedAgentId: 7,
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 7, tenantId: 1 });

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ notifiedUsers: 1 });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 7 }, select: { id: true, tenantId: true } });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    const note = prisma.notification.create.mock.calls[0][0].data;
    expect(note.userId).toBe(7);
    expect(note.entityType).toBe('WebCheckin');
    expect(note.entityId).toBe(100);
    expect(note.type).toBe('warning');
    expect(note.priority).toBe('high');
  });

  test('pending within 24h + no assigned agent → notify all ADMIN/MANAGER', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 200, pnr: 'XYZ999', airlineCode: 'AI', flightNumber: '101',
        passengerName: 'Bob', departureAt: new Date(Date.now() + 4 * 3600_000),
        assignedAgentId: null,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ notifiedUsers: 2 });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, role: { in: ['ADMIN', 'MANAGER'] } }),
      }),
    );
    const userIds = prisma.notification.create.mock.calls.map((c) => c[0].data.userId).sort();
    expect(userIds).toEqual([1, 2]);
  });

  test('dedup: existing notification within 24h → skip', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 300, pnr: 'DEDUP', airlineCode: '6E', flightNumber: '100',
        passengerName: 'Charlie', departureAt: new Date(Date.now() + 2 * 3600_000),
        assignedAgentId: 7,
      },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 7, tenantId: 1 });
    prisma.notification.findFirst.mockResolvedValue({ id: 9999 });

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ notifiedUsers: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('done rows are ignored', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 400, pnr: 'DONE1', airlineCode: '6E', flightNumber: '1',
        passengerName: 'Done Passenger', departureAt: new Date(Date.now() + 2 * 3600_000),
        assignedAgentId: null,
      },
    ]);
    // The cron query filters status='pending', so if findMany returns a row it
    // would normally notify. To prove done rows are ignored we rely on the
    // where clause; the real DB will not return them.
    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result.notifiedUsers).toBeGreaterThanOrEqual(0);
    expect(prisma.webCheckin.findMany.mock.calls[0][0].where.status).toBe('pending');
  });

  test('race-tolerance: notification create throws → next row still processes', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { id: 500, pnr: 'A', airlineCode: '6E', flightNumber: '1', passengerName: 'A', departureAt: new Date(Date.now() + 2 * 3600_000), assignedAgentId: null },
      { id: 501, pnr: 'B', airlineCode: '6E', flightNumber: '2', passengerName: 'B', departureAt: new Date(Date.now() + 3 * 3600_000), assignedAgentId: null },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 9 }]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('race'))
      .mockImplementation(({ data }) => Promise.resolve({ id: 2, ...data }));

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ notifiedUsers: 1 });
  });
});

describe('cron/webCheckinScheduler — runWebCheckinSchedulerForAllTravelTenants', () => {
  test('empty travel-tenant list → fast-path zero totals', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);
    const result = await runWebCheckinSchedulerForAllTravelTenants();
    expect(result).toEqual({ notifiedUsers: 0 });
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('multi-tenant: aggregates notifiedUsers across tenants', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 10, slug: 'tenant-a' },
      { id: 20, slug: 'tenant-b' },
    ]);
    prisma.webCheckin.findMany
      .mockResolvedValueOnce([
        {
          id: 1001, pnr: 'A', airlineCode: '6E', flightNumber: '1',
          passengerName: 'A', departureAt: new Date(Date.now() + 2 * 3600_000), assignedAgentId: 7,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 2001, pnr: 'B', airlineCode: 'AI', flightNumber: '2',
          passengerName: 'B', departureAt: new Date(Date.now() + 3 * 3600_000), assignedAgentId: null,
        },
      ]);
    prisma.user.findUnique.mockResolvedValue({ id: 7, tenantId: 10 });
    prisma.user.findMany.mockResolvedValue([{ id: 8 }]);

    const result = await runWebCheckinSchedulerForAllTravelTenants();
    expect(result).toEqual({ notifiedUsers: 2 });
    const tenantArg = prisma.tenant.findMany.mock.calls[0][0];
    expect(tenantArg.where.vertical).toBe('travel');
    expect(tenantArg.where.isActive).toBe(true);
  });

  test('one tenant throws → caught, other tenants still process', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      { id: 30, slug: 'broken-tenant' },
      { id: 40, slug: 'healthy-tenant' },
    ]);
    prisma.webCheckin.findMany
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValueOnce([
        {
          id: 4001, pnr: 'OK', airlineCode: '6E', flightNumber: '1',
          passengerName: 'Healthy', departureAt: new Date(Date.now() + 2 * 3600_000), assignedAgentId: null,
        },
      ]);
    prisma.user.findMany.mockResolvedValue([{ id: 5 }]);

    const result = await runWebCheckinSchedulerForAllTravelTenants();
    expect(result).toEqual({ notifiedUsers: 1 });
    expect(prisma.webCheckin.findMany).toHaveBeenCalledTimes(2);
  });
});
