/**
 * Unit tests for backend/cron/tripPostTripFeedback.js — daily TMC
 * post-trip feedback cron. Mirrors the wellnessOpsEngine.test.js
 * mocking pattern (monkey-patch prisma model accessors; vitest config
 * inlines the SUT so its require('../lib/prisma') resolves to the
 * same singleton).
 *
 * Branches covered:
 *   runPostTripFeedbackForTenant:
 *     - query shape: tenant + returnDate window [now-7d, now-24h] +
 *       status ∈ {completed, in-trip, confirmed}
 *     - happy path: no prior survey → Survey.create called per trip
 *     - dedup: Survey with name `posttrip-trip-<tripId>` already exists →
 *       skipped, no second create call
 *     - mixed: 3 trips where 1 has prior survey → created=2, skipped=1
 *     - empty result: tenant with no eligible trips → 0/0
 *     - race-tolerance: Survey.create throws (e.g. unique violation on
 *       concurrent worker) → logged + continues, doesn't propagate
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import { runPostTripFeedbackForTenant } from '../../cron/tripPostTripFeedback.js';

beforeAll(() => {
  prisma.tmcTrip = { findMany: vi.fn() };
  prisma.survey = { findFirst: vi.fn(), create: vi.fn() };
  // subBrandConfig resolver pull — Q9 cut-over plumbing reads tenant
  // .subBrandConfigJson once per pass for the per-survey wabaId log.
  prisma.tenant = { findUnique: vi.fn() };
});

beforeEach(() => {
  prisma.tmcTrip.findMany.mockReset();
  prisma.survey.findFirst.mockReset();
  prisma.survey.create.mockReset();
  prisma.tenant.findUnique.mockReset();

  // Sensible defaults — each test overrides as needed.
  prisma.tmcTrip.findMany.mockResolvedValue([]);
  prisma.survey.findFirst.mockResolvedValue(null);
  prisma.survey.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ subBrandConfigJson: null });
});

describe('cron/tripPostTripFeedback — runPostTripFeedbackForTenant', () => {
  test('queries trips scoped to tenant + status enum + returnDate window', async () => {
    await runPostTripFeedbackForTenant(42);

    expect(prisma.tmcTrip.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.tmcTrip.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    // Window — 1d ≤ now - returnDate ≤ 7d
    expect(arg.where.returnDate).toHaveProperty('gte');
    expect(arg.where.returnDate).toHaveProperty('lte');
    expect(arg.where.returnDate.gte).toBeInstanceOf(Date);
    expect(arg.where.returnDate.lte).toBeInstanceOf(Date);
    expect(arg.where.returnDate.gte.getTime()).toBeLessThan(
      arg.where.returnDate.lte.getTime(),
    );
    // Status filter: completed | in-trip | confirmed (excludes cancelled).
    expect(arg.where.status).toEqual({ in: ['completed', 'in-trip', 'confirmed'] });
  });

  test('window: lte is ~24h ago and gte is ~7d ago', async () => {
    const before = Date.now();
    await runPostTripFeedbackForTenant(1);
    const after = Date.now();

    const arg = prisma.tmcTrip.findMany.mock.calls[0][0];
    const lte = arg.where.returnDate.lte.getTime();
    const gte = arg.where.returnDate.gte.getTime();

    const expectedLteLow = before - 24 * 3600 * 1000;
    const expectedLteHigh = after - 24 * 3600 * 1000;
    expect(lte).toBeGreaterThanOrEqual(expectedLteLow - 50);
    expect(lte).toBeLessThanOrEqual(expectedLteHigh + 50);

    const expectedGteLow = before - 7 * 86400 * 1000;
    const expectedGteHigh = after - 7 * 86400 * 1000;
    expect(gte).toBeGreaterThanOrEqual(expectedGteLow - 50);
    expect(gte).toBeLessThanOrEqual(expectedGteHigh + 50);
  });

  test('happy path: 1 trip, no prior survey → Survey.create called, created=1', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 7, tripCode: 'BALI26', destination: 'Bali', schoolContactId: 100 },
    ]);
    prisma.survey.findFirst.mockResolvedValue(null);
    prisma.survey.create.mockResolvedValue({ id: 99 });

    const result = await runPostTripFeedbackForTenant(1);
    expect(result).toEqual({ created: 1, skipped: 0 });

    expect(prisma.survey.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 1, name: 'posttrip-trip-7' },
      select: { id: true },
    });
    expect(prisma.survey.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.survey.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.name).toBe('posttrip-trip-7');
    expect(createArg.data.type).toBe('NPS');
    expect(createArg.data.question).toContain('Bali');
  });

  test('dedup: existing survey for trip → skipped, no create', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 7, tripCode: 'BALI26', destination: 'Bali', schoolContactId: 100 },
    ]);
    // The first findFirst returns an existing row.
    prisma.survey.findFirst.mockResolvedValue({ id: 55 });

    const result = await runPostTripFeedbackForTenant(1);
    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(prisma.survey.create).not.toHaveBeenCalled();
  });

  test('mixed: 3 trips where one is already invited → created=2, skipped=1', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, tripCode: 'T1', destination: 'Paris', schoolContactId: 10 },
      { id: 2, tripCode: 'T2', destination: 'Rome', schoolContactId: 20 },
      { id: 3, tripCode: 'T3', destination: 'Berlin', schoolContactId: 30 },
    ]);
    // Trip 2 already has a survey; 1 and 3 do not.
    prisma.survey.findFirst.mockImplementation(({ where }) => {
      if (where.name === 'posttrip-trip-2') return Promise.resolve({ id: 200 });
      return Promise.resolve(null);
    });
    prisma.survey.create.mockResolvedValue({ id: 999 });

    const result = await runPostTripFeedbackForTenant(1);
    expect(result).toEqual({ created: 2, skipped: 1 });
    expect(prisma.survey.create).toHaveBeenCalledTimes(2);
  });

  test('empty result: no eligible trips → {created:0, skipped:0}', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([]);
    const result = await runPostTripFeedbackForTenant(1);
    expect(result).toEqual({ created: 0, skipped: 0 });
    expect(prisma.survey.create).not.toHaveBeenCalled();
  });

  test('race-tolerance: Survey.create throws → logged + continues, no propagation', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, tripCode: 'T1', destination: 'Paris', schoolContactId: 10 },
      { id: 2, tripCode: 'T2', destination: 'Rome', schoolContactId: 20 },
    ]);
    prisma.survey.findFirst.mockResolvedValue(null);
    // First create throws; second succeeds.
    prisma.survey.create
      .mockRejectedValueOnce(new Error('duplicate name (race)'))
      .mockResolvedValueOnce({ id: 50 });

    const result = await runPostTripFeedbackForTenant(1);
    // The thrown trip is NOT counted in `created` (the create branch
    // catches and continues without incrementing). One success +
    // one race-failure → created=1, skipped=0.
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
