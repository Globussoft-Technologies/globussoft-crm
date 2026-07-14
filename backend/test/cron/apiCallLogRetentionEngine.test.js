/**
 * Unit tests for backend/cron/apiCallLogRetentionEngine.js — purges old
 * LlmCallLog + ApiCallLog rows per the Super Admin-configured retention
 * window. Mirrors test/cron/cronLogRetentionEngine.test.js's structure,
 * applied to the two API Analytics tables instead of CronExecutionLog.
 *
 * Pinned:
 *   - No SystemSetting row yet → falls back to DEFAULT_RETENTION_DAYS (30).
 *   - A persisted setting overrides the default.
 *   - A malformed/non-numeric setting value falls back to the default
 *     rather than computing a garbage cutoff (e.g. NaN days).
 *   - Both llmCallLog.deleteMany and apiCallLog.deleteMany are called with
 *     createdAt < cutoff, where cutoff = now - retainDays.
 *   - Returns { deletedLlmCallLog, deletedApiCallLog, retainDays, cutoff }.
 *   - initApiCallLogRetentionCron registers via cronRegistry with the daily
 *     03:20 default schedule.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

prisma.systemSetting = { ...(prisma.systemSetting || {}), findUnique: vi.fn() };
prisma.llmCallLog = { ...(prisma.llmCallLog || {}), deleteMany: vi.fn() };
prisma.apiCallLog = { ...(prisma.apiCallLog || {}), deleteMany: vi.fn() };

const registerMock = vi.fn().mockResolvedValue({});
const registryPath = requireCJS.resolve('../../lib/cronRegistry.js');
Module._cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: { register: registerMock } };

const sut = requireCJS('../../cron/apiCallLogRetentionEngine.js');

beforeEach(() => {
  prisma.systemSetting.findUnique.mockReset().mockResolvedValue(null);
  prisma.llmCallLog.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.apiCallLog.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  registerMock.mockReset().mockResolvedValue({});
});

describe('runApiCallLogRetentionSweep', () => {
  test('falls back to the 30-day default when no SystemSetting row exists', async () => {
    const result = await sut.runApiCallLogRetentionSweep();
    expect(result.retainDays).toBe(30);
    expect(prisma.llmCallLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    expect(prisma.apiCallLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
  });

  test('uses the persisted retention setting when present', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '7' });
    prisma.llmCallLog.deleteMany.mockResolvedValue({ count: 12 });
    prisma.apiCallLog.deleteMany.mockResolvedValue({ count: 3 });
    const result = await sut.runApiCallLogRetentionSweep();
    expect(result.retainDays).toBe(7);
    expect(result.deletedLlmCallLog).toBe(12);
    expect(result.deletedApiCallLog).toBe(3);
  });

  test('a non-numeric setting value falls back to the default (no NaN cutoff)', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: 'not-a-number' });
    const result = await sut.runApiCallLogRetentionSweep();
    expect(result.retainDays).toBe(30);
    expect(result.cutoff.getTime()).not.toBeNaN();
  });

  test('a zero or negative setting value falls back to the default', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '0' });
    const result = await sut.runApiCallLogRetentionSweep();
    expect(result.retainDays).toBe(30);
  });

  test('cutoff is computed as now - retainDays (within a small tolerance)', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '10' });
    const before = Date.now();
    const result = await sut.runApiCallLogRetentionSweep();
    const expectedCutoff = before - 10 * 24 * 60 * 60 * 1000;
    expect(Math.abs(result.cutoff.getTime() - expectedCutoff)).toBeLessThan(5000);
  });

  test('both deleteMany calls use the SAME cutoff instant', async () => {
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '15' });
    await sut.runApiCallLogRetentionSweep();
    const llmCutoff = prisma.llmCallLog.deleteMany.mock.calls[0][0].where.createdAt.lt;
    const apiCutoff = prisma.apiCallLog.deleteMany.mock.calls[0][0].where.createdAt.lt;
    expect(llmCutoff.getTime()).toBe(apiCutoff.getTime());
  });
});

describe('initApiCallLogRetentionCron', () => {
  test('registers via cronRegistry with the daily 03:20 default schedule', () => {
    sut.initApiCallLogRetentionCron();
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'apiCallLogRetentionEngine',
        defaultSchedule: '20 3 * * *',
        tickFn: sut.runApiCallLogRetentionSweep,
      }),
    );
  });
});
