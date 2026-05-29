/**
 * Unit tests for backend/cron/travelJourneyReminders.js — RFU Umrah
 * milestone reminders. Same mocking pattern as the prior cron tests.
 *
 * Branches covered:
 *   runJourneyRemindersForTenant:
 *     - query shape: tenant + subBrand=rfu + status=accepted + startDate window
 *     - empty itineraries → fast-path
 *     - itinerary with startDate at T-1 day: fires the T-1d milestone
 *     - itinerary outside milestone windows → no notification created
 *     - dedup: existing notification with same title-tag → skipped
 *     - race-tolerance: notification.create throws → cron continues
 *
 *   relevantMilestones (pure):
 *     - T-7d / T-3d / T-1d / T-0 / T+2d / T+7d each detected within
 *       the 35-min window
 *     - boundary outside the window → empty array
 *     - invalid startDate → empty array (no NaN propagation)
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  runJourneyRemindersForTenant,
  runJourneyRemindersForAllTravelTenants,
  relevantMilestones,
  MILESTONES,
} from '../../cron/travelJourneyReminders.js';

beforeAll(() => {
  prisma.itinerary = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass for the milestone-fire wabaId log.
  prisma.tenant = { findUnique: vi.fn() };
});

beforeEach(() => {
  prisma.itinerary.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.itinerary.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
});

describe('cron/travelJourneyReminders — relevantMilestones (pure)', () => {
  test('T-7d milestone fires when startDate is exactly 7d ahead', () => {
    const startDate = new Date(Date.now() + 7 * 86400_000);
    const hits = relevantMilestones(startDate);
    expect(hits.map((m) => m.tag)).toContain('doc-checklist-t7');
  });

  test('T-0 milestone fires when startDate is now', () => {
    const startDate = new Date(Date.now());
    const hits = relevantMilestones(startDate);
    expect(hits.map((m) => m.tag)).toContain('sendoff-t0');
  });

  test('T+7d milestone fires when startDate was 7d ago', () => {
    const startDate = new Date(Date.now() - 7 * 86400_000);
    const hits = relevantMilestones(startDate);
    expect(hits.map((m) => m.tag)).toContain('return-t7');
  });

  test('startDate far outside any milestone window → empty array', () => {
    const startDate = new Date(Date.now() + 30 * 86400_000);
    expect(relevantMilestones(startDate)).toEqual([]);
  });

  test('invalid startDate → empty array (no NaN propagation)', () => {
    expect(relevantMilestones(null)).toEqual([]);
    expect(relevantMilestones('not-a-date')).toEqual([]);
  });

  test('MILESTONES module-export includes exactly 6 entries', () => {
    expect(MILESTONES).toHaveLength(6);
    const tags = MILESTONES.map((m) => m.tag);
    expect(tags).toEqual([
      'doc-checklist-t7', 'driver-hotel-t3', 'group-meeting-t1',
      'sendoff-t0', 'ziyarah-t2', 'return-t7',
    ]);
  });
});

describe('cron/travelJourneyReminders — runJourneyRemindersForTenant', () => {
  test('query shape: tenant + RFU + accepted + ±14d window', async () => {
    await runJourneyRemindersForTenant(42);
    const arg = prisma.itinerary.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.subBrand).toBe('rfu');
    expect(arg.where.status).toBe('accepted');
    expect(arg.where.startDate.gte).toBeInstanceOf(Date);
    expect(arg.where.startDate.lte).toBeInstanceOf(Date);
  });

  test('empty itineraries → 0/0, no notification create', async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);
    const result = await runJourneyRemindersForTenant(1);
    expect(result).toEqual({ fired: 0, skipped: 0 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('T-1d itinerary fires the group-meeting milestone', async () => {
    const startDate = new Date(Date.now() + 86400_000);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 7, contactId: 100, destination: 'Makkah', startDate },
    ]);
    const result = await runJourneyRemindersForTenant(1);
    expect(result.fired).toBeGreaterThanOrEqual(1);
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.entityType).toBe('Itinerary');
    expect(createArg.data.entityId).toBe(7);
    expect(createArg.data.title).toContain('[group-meeting-t1]');
  });

  test('itinerary outside any milestone window → no notification', async () => {
    const startDate = new Date(Date.now() + 11 * 86400_000); // 11 days out (between T-7 and T-14)
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 7, contactId: 100, destination: 'Makkah', startDate },
    ]);
    const result = await runJourneyRemindersForTenant(1);
    expect(result).toEqual({ fired: 0, skipped: 0 });
  });

  test('dedup: existing notification with same title-tag → skipped', async () => {
    const startDate = new Date(Date.now() + 86400_000); // T-1d
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 7, contactId: 100, destination: 'Makkah', startDate },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 99 });
    const result = await runJourneyRemindersForTenant(1);
    expect(result).toEqual({ fired: 0, skipped: 1 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('race-tolerance: notification.create throws → next itinerary still processes', async () => {
    const startDate = new Date(Date.now() + 86400_000);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 7, contactId: 100, destination: 'Makkah', startDate },
      { id: 8, contactId: 101, destination: 'Madinah', startDate },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('unique violation'))
      .mockResolvedValueOnce({ id: 50 });
    const result = await runJourneyRemindersForTenant(1);
    expect(result.fired).toBe(1);
  });

  // ─── NEW CASES (+8) ─────────────────────────────────────────────────

  test('T-3d itinerary fires the driver-hotel milestone (pure helper)', () => {
    const startDate = new Date(Date.now() + 3 * 86400_000);
    const hits = relevantMilestones(startDate);
    expect(hits.map((m) => m.tag)).toContain('driver-hotel-t3');
  });

  test('T+2d itinerary fires the ziyarah milestone (pure helper)', () => {
    const startDate = new Date(Date.now() - 2 * 86400_000);
    const hits = relevantMilestones(startDate);
    expect(hits.map((m) => m.tag)).toContain('ziyarah-t2');
  });

  test('query bounds: take=500 + select shape matches PRD §4.8', async () => {
    await runJourneyRemindersForTenant(42);
    const arg = prisma.itinerary.findMany.mock.calls[0][0];
    expect(arg.take).toBe(500);
    expect(arg.select).toEqual({
      id: true, contactId: true, destination: true, startDate: true,
    });
  });

  test('message body includes destination + itinerary id + portal advisor link', async () => {
    const startDate = new Date(Date.now() + 86400_000);
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 42, contactId: 100, destination: 'Madinah', startDate },
    ]);
    await runJourneyRemindersForTenant(1);
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.message).toContain('Itinerary 42');
    expect(createArg.data.message).toContain('Madinah');
    expect(createArg.data.message).toContain('/travel/itineraries');
    expect(createArg.data.type).toBe('info');
    expect(createArg.data.priority).toBe('normal');
    expect(createArg.data.tenantId).toBe(1);
  });

  test('tenant.findUnique is invoked with the active tenantId (Q9 wabaId log plumbing)', async () => {
    await runJourneyRemindersForTenant(77);
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { subBrandConfigJson: true },
    });
  });

  test('dedup lookup filters on entityType=Itinerary + entityId + tagged title', async () => {
    const startDate = new Date(Date.now() + 86400_000); // T-1d
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 7, contactId: 100, destination: 'Makkah', startDate },
    ]);
    await runJourneyRemindersForTenant(1);
    const findArg = prisma.notification.findFirst.mock.calls[0][0];
    expect(findArg.where.tenantId).toBe(1);
    expect(findArg.where.entityType).toBe('Itinerary');
    expect(findArg.where.entityId).toBe(7);
    expect(findArg.where.title).toContain('[group-meeting-t1]');
  });

  test('runJourneyRemindersForAllTravelTenants filters vertical=travel + isActive=true', async () => {
    prisma.tenant.findMany = vi.fn().mockResolvedValue([]);
    await runJourneyRemindersForAllTravelTenants();
    const arg = prisma.tenant.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ vertical: 'travel', isActive: true });
    expect(arg.select).toEqual({ id: true, slug: true });
  });

  test('runJourneyRemindersForAllTravelTenants continues past a failing tenant + sums totalFired', async () => {
    prisma.tenant.findMany = vi.fn().mockResolvedValue([
      { id: 1, slug: 'tenantA' },
      { id: 2, slug: 'tenantB' },
    ]);
    // Tenant A throws on the itinerary scan; tenant B fires 1 milestone.
    const startDate = new Date(Date.now() + 86400_000);
    prisma.itinerary.findMany
      .mockRejectedValueOnce(new Error('db disconnect'))
      .mockResolvedValueOnce([{ id: 9, contactId: 100, destination: 'Makkah', startDate }]);
    const total = await runJourneyRemindersForAllTravelTenants();
    // Tenant A failed entirely → 0; tenant B produced 1 fired. Total = 1.
    expect(total).toBe(1);
    expect(prisma.itinerary.findMany).toHaveBeenCalledTimes(2);
  });
});
