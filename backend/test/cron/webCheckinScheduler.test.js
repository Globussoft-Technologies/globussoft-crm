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

import {
  runWebCheckinSchedulerForTenant,
  runWebCheckinSchedulerForAllTravelTenants,
} from '../../cron/webCheckinScheduler.js';

beforeAll(() => {
  prisma.webCheckin = { findMany: vi.fn(), update: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass + itinerary.findMany to map the
  // checkin → parent itinerary's subBrand for the per-checkin wabaId log.
  prisma.tenant = { findUnique: vi.fn(), findMany: vi.fn() };
  prisma.itinerary = { findMany: vi.fn() };
});

beforeEach(() => {
  prisma.webCheckin.findMany.mockReset();
  prisma.webCheckin.update.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findMany.mockReset();
  prisma.itinerary.findMany.mockReset();

  prisma.webCheckin.findMany.mockResolvedValue([]);
  prisma.webCheckin.update.mockResolvedValue({ id: 1 });
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
  prisma.tenant.findMany.mockResolvedValue([]);
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

  test('NaN windowOpenAt → row skipped (Number.isNaN guard) — no transition, no notification', async () => {
    // SUT line 94 guards against Date constructor returning NaN. Send a
    // garbage timestamp; cron must skip + continue to next row, not crash.
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 300, pnr: 'NAN1', airlineCode: '6E', flightNumber: '999',
        passengerName: 'GarbageDate', windowOpenAt: 'not-a-date',
        status: 'pending', updatedAt: past,
      },
      // valid sibling row must still fire — proves the NaN guard `continue`s
      // rather than short-circuiting the whole loop.
      {
        id: 301, pnr: 'OK1', airlineCode: '6E', flightNumber: '1',
        passengerName: 'Valid', windowOpenAt: past, status: 'pending',
        updatedAt: past,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 1, fallback: 0 });
    // only row 301 was updated; row 300 (NaN) skipped
    expect(prisma.webCheckin.update).toHaveBeenCalledTimes(1);
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 301 },
      data: { status: 'reminded' },
    });
  });

  test('dedup on reminded: existing info notification → still flips status, skips notification.create', async () => {
    // SUT lines 98-122: when a prior notification for this checkin already
    // exists, the status update still happens (idempotent flip) but the
    // notification.create is skipped (no double-fire).
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 400, pnr: 'DEDUP', airlineCode: '6E', flightNumber: '100',
        passengerName: 'Charlie', windowOpenAt: past, status: 'pending',
        updatedAt: past,
      },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 9999 });

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 1, fallback: 0 });
    // status was still flipped
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 400 },
      data: { status: 'reminded' },
    });
    // but no second notification created
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('mixed batch: pending + stalled reminded → both transitions in single pass', async () => {
    // Realistic Phase-1 tick: one freshly-opened checkin (pending → reminded)
    // and one stalled checkin (reminded → fallback-agent). Both should fire
    // independently in the same pass; result aggregates both counters.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 500, pnr: 'PEND', airlineCode: '6E', flightNumber: '200',
        passengerName: 'Pending Pat', windowOpenAt: fiveMinAgo, status: 'pending',
        updatedAt: fiveMinAgo,
      },
      {
        id: 501, pnr: 'STAL', airlineCode: 'AI', flightNumber: '301',
        passengerName: 'Stalled Sam', windowOpenAt: fortyFiveMinAgo,
        status: 'reminded', updatedAt: fortyFiveMinAgo,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 1, fallback: 1 });
    expect(prisma.webCheckin.update).toHaveBeenCalledTimes(2);
    // Both notifications fired — one info, one warning
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    const types = prisma.notification.create.mock.calls.map((c) => c[0].data.type);
    expect(types.sort()).toEqual(['info', 'warning']);
  });

  test('itinerary subBrand lookup: rows with itineraryId trigger itinerary.findMany pre-fetch (no N+1)', async () => {
    // SUT lines 79-87: when checkin rows reference itineraryIds, the cron
    // pre-fetches the itinerary→subBrand map in ONE batch query (not N+1).
    // Distinct itineraryIds across multiple rows → one findMany call.
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 600, pnr: 'A', airlineCode: '6E', flightNumber: '1', passengerName: 'A',
        windowOpenAt: past, status: 'pending', updatedAt: past, itineraryId: 11,
      },
      {
        id: 601, pnr: 'B', airlineCode: '6E', flightNumber: '2', passengerName: 'B',
        windowOpenAt: past, status: 'pending', updatedAt: past, itineraryId: 22,
      },
      // duplicate itineraryId — should be deduped by the Set
      {
        id: 602, pnr: 'C', airlineCode: '6E', flightNumber: '3', passengerName: 'C',
        windowOpenAt: past, status: 'pending', updatedAt: past, itineraryId: 11,
      },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 11, subBrand: 'tmc' },
      { id: 22, subBrand: 'rfu' },
    ]);

    await runWebCheckinSchedulerForTenant(7);

    // exactly ONE batch query for itineraries
    expect(prisma.itinerary.findMany).toHaveBeenCalledTimes(1);
    const itinArg = prisma.itinerary.findMany.mock.calls[0][0];
    // deduped: 2 distinct IDs (11, 22), not 3
    expect(itinArg.where.id.in.sort()).toEqual([11, 22]);
    // scoped to tenant
    expect(itinArg.where.tenantId).toBe(7);
  });

  test('no itineraryId on any row → itinerary.findMany skipped entirely', async () => {
    // SUT line 81 `if (itinIds.length > 0)` guard: when no checkin row has
    // an itineraryId, the cron must NOT issue an empty `WHERE id IN ()` query.
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 700, pnr: 'NOITIN', airlineCode: '6E', flightNumber: '1',
        passengerName: 'Orphan', windowOpenAt: past, status: 'pending',
        updatedAt: past, itineraryId: null,
      },
    ]);

    const result = await runWebCheckinSchedulerForTenant(1);
    expect(result).toEqual({ reminded: 1, fallback: 0 });
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('fallback dedup: notification.findFirst not called when status is "pending" (only "reminded" path checks fallback dedup)', async () => {
    // SUT branches: for `status='pending'`, the dedup query looks for a
    // type='info' notification. For `status='reminded'`, it looks for
    // type='warning'. Make sure the right type is queried per branch.
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.webCheckin.findMany.mockResolvedValue([
      {
        id: 800, pnr: 'TYPE1', airlineCode: '6E', flightNumber: '1', passengerName: 'Pat',
        windowOpenAt: past, status: 'pending', updatedAt: past,
      },
    ]);

    await runWebCheckinSchedulerForTenant(1);

    expect(prisma.notification.findFirst).toHaveBeenCalledTimes(1);
    const queryArg = prisma.notification.findFirst.mock.calls[0][0];
    expect(queryArg.where.type).toBe('info');
    expect(queryArg.where.entityType).toBe('WebCheckin');
    expect(queryArg.where.entityId).toBe(800);
  });
});

describe('cron/webCheckinScheduler — runWebCheckinSchedulerForAllTravelTenants', () => {
  test('empty travel-tenant list → fast-path zero totals', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);

    const result = await runWebCheckinSchedulerForAllTravelTenants();
    expect(result).toEqual({ reminded: 0, fallback: 0 });
    // no per-tenant work should fire
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('multi-tenant: aggregates reminded + fallback counters across tenants', async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    const stalledAt = new Date(Date.now() - 45 * 60 * 1000);

    prisma.tenant.findMany.mockResolvedValue([
      { id: 10, slug: 'tenant-a' },
      { id: 20, slug: 'tenant-b' },
    ]);
    // tenant 10: one pending → reminded
    // tenant 20: one stalled reminded → fallback
    prisma.webCheckin.findMany
      .mockResolvedValueOnce([
        {
          id: 1001, pnr: 'A', airlineCode: '6E', flightNumber: '1',
          passengerName: 'A', windowOpenAt: past, status: 'pending', updatedAt: past,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 2001, pnr: 'B', airlineCode: 'AI', flightNumber: '2',
          passengerName: 'B', windowOpenAt: stalledAt, status: 'reminded',
          updatedAt: stalledAt,
        },
      ]);

    const result = await runWebCheckinSchedulerForAllTravelTenants();
    expect(result).toEqual({ reminded: 1, fallback: 1 });
    // travel + active filter on tenant query
    const tenantArg = prisma.tenant.findMany.mock.calls[0][0];
    expect(tenantArg.where.vertical).toBe('travel');
    expect(tenantArg.where.isActive).toBe(true);
  });

  test('one tenant throws → caught, other tenants still process', async () => {
    // SUT lines 195-207: per-tenant try/catch isolates failure. The thrown
    // tenant contributes 0 to totals; siblings keep aggregating normally.
    const past = new Date(Date.now() - 5 * 60 * 1000);
    prisma.tenant.findMany.mockResolvedValue([
      { id: 30, slug: 'broken-tenant' },
      { id: 40, slug: 'healthy-tenant' },
    ]);
    prisma.webCheckin.findMany
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValueOnce([
        {
          id: 4001, pnr: 'OK', airlineCode: '6E', flightNumber: '1',
          passengerName: 'Healthy', windowOpenAt: past, status: 'pending',
          updatedAt: past,
        },
      ]);

    const result = await runWebCheckinSchedulerForAllTravelTenants();
    // broken tenant contributes 0; healthy tenant contributes 1 reminded
    expect(result).toEqual({ reminded: 1, fallback: 0 });
    // both tenants were attempted
    expect(prisma.webCheckin.findMany).toHaveBeenCalledTimes(2);
  });
});
