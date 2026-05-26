/**
 * Unit tests for backend/cron/webCheckinScheduler.js — Travel CRM
 * web check-in lifecycle scheduler. Mirrors the tripPaymentReminders
 * mocking pattern.
 *
 * Branches covered:
 *   runWebCheckinSchedulerForTenant:
 *     - query shape: tenant + status ∈ {pending, reminded} + windowOpenAt
 *       within look-ahead bound
 *     - empty result → fast-path {reminded:0, fallback:0}
 *     - pending with windowOpenAt in past → reminded transition +
 *       notification (type='info')
 *     - pending with windowOpenAt still in future → no transition
 *     - reminded but updatedAt > 30m ago → fallback-agent transition +
 *       warning notification
 *     - reminded but recently updated → no fallback
 *     - dedup: existing reminded-info notification → still flip status,
 *       skip notification create
 *     - dedup: existing fallback warning → no second fallback
 *     - race-tolerance: update throws → cron continues, next row processes
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { runWebCheckinSchedulerForTenant } from '../../cron/webCheckinScheduler.js';

beforeAll(() => {
  prisma.webCheckin = { findMany: vi.fn(), update: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass + itinerary.findMany to map the
  // checkin → parent itinerary's subBrand for the per-checkin wabaId log.
  prisma.tenant = { findUnique: vi.fn() };
  prisma.itinerary = { findMany: vi.fn() };
});

beforeEach(() => {
  prisma.webCheckin.findMany.mockReset();
  prisma.webCheckin.update.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.itinerary.findMany.mockReset();

  prisma.webCheckin.findMany.mockResolvedValue([]);
  prisma.webCheckin.update.mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
  prisma.itinerary.findMany.mockResolvedValue([]);
});

describe('cron/webCheckinScheduler — runWebCheckinSchedulerForTenant', () => {
  test('query shape: tenant + status enum + windowOpenAt lookahead', async () => {
    await runWebCheckinSchedulerForTenant(42);
    expect(prisma.webCheckin.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.webCheckin.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.status).toEqual({ in: ['pending', 'reminded'] });
    expect(arg.where.windowOpenAt).toHaveProperty('lte');
    expect(arg.where.windowOpenAt.lte).toBeInstanceOf(Date);
    // Lookahead should be ~now + 7d
    const expected = Date.now() + 7 * 86400_000;
    expect(arg.where.windowOpenAt.lte.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(arg.where.windowOpenAt.lte.getTime()).toBeLessThanOrEqual(expected + 1000);
  });

  test('empty rows → fast-path {reminded:0, fallback:0}, no update/notification calls', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([]);
    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 0, fallback: 0 });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('pending with windowOpenAt 5min ago → flips to reminded + info notification', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 100, pnr: 'ABC123', airlineCode: '6E', flightNumber: '203',
        passengerName: 'Alice', windowOpenAt: fiveMinAgo, status: 'pending',
        updatedAt: fiveMinAgo,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 1, fallback: 0 });
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { status: 'reminded' },
    });
    const noteArg = prisma.notification.create.mock.calls[0][0];
    expect(noteArg.data.entityType).toBe('WebCheckin');
    expect(noteArg.data.entityId).toBe(100);
    expect(noteArg.data.type).toBe('info');
  });

  test('pending with windowOpenAt in future → no transition', async () => {
    const twoHoursAhead = new Date(Date.now() + 2 * 3600 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 100, pnr: 'ABC123', airlineCode: '6E', flightNumber: '203',
        passengerName: 'Alice', windowOpenAt: twoHoursAhead, status: 'pending',
        updatedAt: twoHoursAhead,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 0, fallback: 0 });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('reminded stalled 45min ago → fallback-agent + warning notification', async () => {
    const stalledAt = new Date(Date.now() - 45 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 200, pnr: 'XYZ999', airlineCode: 'AI', flightNumber: '101',
        passengerName: 'Bob', windowOpenAt: stalledAt, status: 'reminded',
        updatedAt: stalledAt,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 0, fallback: 1 });
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 200 },
      data: { status: 'fallback-agent' },
    });
    const noteArg = prisma.notification.create.mock.calls[0][0];
    expect(noteArg.data.type).toBe('warning');
    expect(noteArg.data.priority).toBe('high');
  });

  test('reminded recently (5 min ago) → no fallback (within stall window)', async () => {
    const recentAt = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 200, pnr: 'XYZ999', airlineCode: 'AI', flightNumber: '101',
        passengerName: 'Bob', windowOpenAt: recentAt, status: 'reminded',
        updatedAt: recentAt,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 0, fallback: 0 });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('dedup on fallback: existing warning notification → no double-fallback', async () => {
    const stalledAt = new Date(Date.now() - 45 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 200, pnr: 'XYZ999', airlineCode: 'AI', flightNumber: '101',
        passengerName: 'Bob', windowOpenAt: stalledAt, status: 'reminded',
        updatedAt: stalledAt,
      },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 99 });

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 0, fallback: 0 });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('race-tolerance: webCheckin.update throws → next row still processes', async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      { id: 100, pnr: 'A', airlineCode: '6E', flightNumber: '1', passengerName: 'A', windowOpenAt: past, status: 'pending', updatedAt: past },
      { id: 101, pnr: 'B', airlineCode: '6E', flightNumber: '2', passengerName: 'B', windowOpenAt: past, status: 'pending', updatedAt: past },
    ]);
    prisma.webCheckin.update
      .mockRejectedValueOnce(new Error('race'))
      .mockResolvedValueOnce({ id: 101 });

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result.reminded).toBe(1);
  });
});
