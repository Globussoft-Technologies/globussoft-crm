/**
 * Unit tests for backend/cron/travelDiagnosticAdvisorAlerts.js — diagnostic-
 * to-advisor escalation cron. Mirrors the tripPaymentReminders.test.js
 * pattern.
 *
 * Branches covered:
 *   runDiagnosticAlertsForTenant:
 *     - query shape: tenant + contactId not null + 30m..24h window
 *     - empty fast-path: 0 diagnostics → skip outreach probe
 *     - happy path: 1 stalled diagnostic, no outreach → escalation notification created
 *     - dedup: existing escalation notification → skipped
 *     - outreach via Activity: skipped (no escalation)
 *     - outreach via Task: skipped
 *     - missing models (Activity/Task throws) → treated as no-outreach,
 *       diagnostic still escalates
 *     - race-tolerance: notification.create throws → cron continues
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { runDiagnosticAlertsForTenant } from '../../cron/travelDiagnosticAdvisorAlerts.js';

beforeAll(() => {
  prisma.travelDiagnostic = { findMany: vi.fn() };
  prisma.notification = { findFirst: vi.fn(), create: vi.fn() };
  prisma.activity = { findFirst: vi.fn() };
  prisma.task = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.travelDiagnostic.findMany.mockReset();
  prisma.notification.findFirst.mockReset();
  prisma.notification.create.mockReset();
  prisma.activity.findFirst.mockReset();
  prisma.task.findFirst.mockReset();

  prisma.travelDiagnostic.findMany.mockResolvedValue([]);
  prisma.notification.findFirst.mockResolvedValue(null);
  prisma.notification.create.mockResolvedValue({ id: 1 });
  prisma.activity.findFirst.mockResolvedValue(null);
  prisma.task.findFirst.mockResolvedValue(null);
});

describe('cron/travelDiagnosticAdvisorAlerts — runDiagnosticAlertsForTenant', () => {
  test('query shape: tenant + contactId not null + createdAt window', async () => {
    await runDiagnosticAlertsForTenant(42);
    const arg = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.contactId).toEqual({ not: null });
    expect(arg.where.createdAt).toHaveProperty('gte');
    expect(arg.where.createdAt).toHaveProperty('lte');
    expect(arg.where.createdAt.gte.getTime()).toBeLessThan(arg.where.createdAt.lte.getTime());
  });

  test('empty diagnostics → 0/0, no outreach probe', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 0 });
    expect(prisma.activity.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('happy path: 1 stalled diagnostic with no outreach → notification created', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      {
        id: 100, subBrand: 'rfu', contactId: 200,
        classificationLabel: 'Confident', recommendedTier: 'primary',
        createdAt: halfHourAgo,
      },
    ]);

    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 1, skipped: 0 });
    const createArg = prisma.notification.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.entityType).toBe('TravelDiagnostic');
    expect(createArg.data.entityId).toBe(100);
    expect(createArg.data.type).toBe('warning');
    expect(createArg.data.priority).toBe('high');
  });

  test('dedup: existing warning notification → skipped, no second create', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.notification.findFirst.mockResolvedValue({ id: 999 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 1 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('outreach via Activity → diagnostic skipped', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockResolvedValue({ id: 42 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 1 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('outreach via Task (when Activity has none) → diagnostic skipped', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockResolvedValue(null);
    prisma.task.findFirst.mockResolvedValue({ id: 7 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 0, skipped: 1 });
  });

  test('Activity model unreachable (throws) → falls through to Task; still escalates if both no-hit', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
    ]);
    prisma.activity.findFirst.mockRejectedValue(new Error('Activity model missing'));
    prisma.task.findFirst.mockResolvedValue(null);
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result).toEqual({ alerted: 1, skipped: 0 });
  });

  test('race-tolerance: notification.create throws → next diagnostic still processed', async () => {
    const halfHourAgo = new Date(Date.now() - 35 * 60 * 1000);
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 100, subBrand: 'rfu', contactId: 200, classificationLabel: 'X', recommendedTier: 'entry', createdAt: halfHourAgo },
      { id: 101, subBrand: 'tmc', contactId: 201, classificationLabel: 'Y', recommendedTier: 'primary', createdAt: halfHourAgo },
    ]);
    prisma.notification.create
      .mockRejectedValueOnce(new Error('race'))
      .mockResolvedValueOnce({ id: 5 });
    const result = await runDiagnosticAlertsForTenant(1);
    expect(result.alerted).toBe(1);
  });
});
