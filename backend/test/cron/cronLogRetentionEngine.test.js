/**
 * Unit tests for backend/cron/cronLogRetentionEngine.js — purges old
 * CronExecutionLog rows per the Super Admin-configured retention window.
 *
 * Pinned:
 *   - No SystemSetting row yet → falls back to DEFAULT_RETENTION_DAYS (30).
 *   - A persisted setting overrides the default.
 *   - A malformed/non-numeric setting value falls back to the default
 *     rather than computing a garbage cutoff (e.g. NaN days).
 *   - deleteMany is called with startedAt < cutoff, where cutoff = now -
 *     retainDays (computed correctly).
 *   - Returns { deleted, retainDays, cutoff } for the caller/log line.
 *   - initCronLogRetentionCron registers via cronRegistry with the daily
 *     03:15 default schedule.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

prisma.systemSetting = { ...(prisma.systemSetting || {}), findUnique: vi.fn() };
prisma.cronExecutionLog = { ...(prisma.cronExecutionLog || {}), deleteMany: vi.fn() };

const registerMock = vi.fn().mockResolvedValue({});
const registryPath = requireCJS.resolve('../../lib/cronRegistry.js');
Module._cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: { register: registerMock } };

const sut = requireCJS('../../cron/cronLogRetentionEngine.js');

beforeEach(() => {
  prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.cronExecutionLog.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  registerMock.mockReset().mockResolvedValue({});
});

describe('runCronLogRetentionSweep', () => {
  test('falls back to the 30-day default when no SystemSetting row exists', async () => {
    const result = await sut.runCronLogRetentionSweep();
    expect(result.retainDays).toBe(30);
    expect(prisma.cronExecutionLog.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: expect.any(Date) } },
    });
  });

  test('uses the persisted retention setting when present', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '7' });
    prisma.cronExecutionLog.deleteMany.mockResolvedValue({ count: 12 });
    const result = await sut.runCronLogRetentionSweep();
    expect(result.retainDays).toBe(7);
    expect(result.deleted).toBe(12);
  });

  test('a non-numeric setting value falls back to the default (no NaN cutoff)', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: 'not-a-number' });
    const result = await sut.runCronLogRetentionSweep();
    expect(result.retainDays).toBe(30);
    expect(result.cutoff.getTime()).not.toBeNaN();
  });

  test('a zero or negative setting value falls back to the default', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '0' });
    const result = await sut.runCronLogRetentionSweep();
    expect(result.retainDays).toBe(30);
  });

  test('cutoff is computed as now - retainDays (within a small tolerance)', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '10' });
    const before = Date.now();
    const result = await sut.runCronLogRetentionSweep();
    const expectedCutoff = before - 10 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.cutoff.getTime() - expectedCutoff)).toBeLessThan(5000);
  });

  test('returns the deleteMany count as `deleted`', async () => {
    prisma.cronExecutionLog.deleteMany.mockResolvedValue({ count: 42 });
    const result = await sut.runCronLogRetentionSweep();
    expect(result.deleted).toBe(42);
  });
});

describe('initCronLogRetentionCron', () => {
  test('registers via cronRegistry with the daily 03:15 default schedule', () => {
    sut.initCronLogRetentionCron();
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cronLogRetentionEngine',
        defaultSchedule: '15 3 * * *',
        tickFn: sut.runCronLogRetentionSweep,
      }),
    );
  });
});
