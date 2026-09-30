// @ts-check
/**
 * Tests for backend/lib/callifiedDnpRetryEngine.js.
 *
 * Pins the DNP retry contract:
 *   - A fresh DNP lead gets a future retry window.
 *   - The engine tick enqueues due retries up to the configured max.
 *   - Qualified/Junk classifications clear retry state.
 *   - Manual calls / manual overrides can schedule or clear retries.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

const requireCJS = (await import('node:module')).createRequire(import.meta.url);
const Module = requireCJS('node:module');

// Patch auto-dial queue BEFORE the engine module loads it.
const queuePath = requireCJS.resolve('../../lib/callifiedAutoDialQueue.js');
const enqueueMock = vi.fn();
Module._cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: { enqueue: enqueueMock },
};

// Patch tenant settings so we control retry configuration.
const tenantSettingsPath = requireCJS.resolve('../../lib/tenantSettings.js');
Module._cache[tenantSettingsPath] = {
  id: tenantSettingsPath,
  filename: tenantSettingsPath,
  loaded: true,
  exports: {
    KEYS: {
      CALLIFIED_DNP_RETRY_ENABLED: 'feature.callified.dnp_retry.enabled',
      CALLIFIED_DNP_RETRY_MAX_RETRIES: 'feature.callified.dnp_retry.max_retries',
      CALLIFIED_DNP_RETRY_INTERVAL_MINUTES: 'feature.callified.dnp_retry.interval_minutes',
      CALLIFIED_DNP_RETRY_MODE: 'feature.callified.dnp_retry.mode',
      CALLIFIED_DNP_RETRY_DAY_INTERVAL: 'feature.callified.dnp_retry.day_interval',
      CALLIFIED_DNP_RETRY_TIME_LOCAL: 'feature.callified.dnp_retry.time_local',
      CALLIFIED_PENDING_RETRY_ENABLED: 'feature.callified.pending_retry.enabled',
      CALLIFIED_PENDING_RETRY_MAX_RETRIES: 'feature.callified.pending_retry.max_retries',
      CALLIFIED_PENDING_RETRY_INTERVAL_MINUTES: 'feature.callified.pending_retry.interval_minutes',
      CALLIFIED_PENDING_RETRY_MODE: 'feature.callified.pending_retry.mode',
      CALLIFIED_PENDING_RETRY_DAY_INTERVAL: 'feature.callified.pending_retry.day_interval',
      CALLIFIED_PENDING_RETRY_TIME_LOCAL: 'feature.callified.pending_retry.time_local',
      CALLIFIED_RETRY_TIMEZONE: 'feature.callified.retry.timezone',
    },
    getSetting: vi.fn(),
  },
};

const { getSetting } = Module._cache[tenantSettingsPath].exports;

const enginePath = requireCJS.resolve('../../lib/callifiedDnpRetryEngine.js');
const engineModule = requireCJS(enginePath);
const {
  getDnpRetrySettings,
  scheduleDnpRetry,
  clearDnpRetryState,
  processDnpRetries,
  processPendingRetries,
  computeNextRetryAt,
  startDnpRetryEngine,
  stopDnpRetryEngine,
} = engineModule;

function mockSettings({ enabled = true, maxRetries = 3, intervalMinutes = 60, mode = 'delay', dayInterval = 1, timeLocal = '10:00', timezone = 'UTC' } = {}) {
  getSetting.mockImplementation(async (_tenantId, key) => {
    if (key === 'feature.callified.dnp_retry.enabled') return enabled;
    if (key === 'feature.callified.dnp_retry.max_retries') return maxRetries;
    if (key === 'feature.callified.dnp_retry.interval_minutes') return intervalMinutes;
    if (key === 'feature.callified.dnp_retry.mode') return mode;
    if (key === 'feature.callified.dnp_retry.day_interval') return dayInterval;
    if (key === 'feature.callified.dnp_retry.time_local') return timeLocal;
    if (key === 'feature.callified.pending_retry.enabled') return enabled;
    if (key === 'feature.callified.pending_retry.max_retries') return maxRetries;
    if (key === 'feature.callified.pending_retry.interval_minutes') return intervalMinutes;
    if (key === 'feature.callified.pending_retry.mode') return mode;
    if (key === 'feature.callified.pending_retry.day_interval') return dayInterval;
    if (key === 'feature.callified.pending_retry.time_local') return timeLocal;
    if (key === 'feature.callified.retry.timezone') return timezone;
    return null;
  });
}

describe('callifiedDnpRetryEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stopDnpRetryEngine();
    enqueueMock.mockReset().mockReturnValue(true);
    getSetting.mockReset();
    mockSettings();

    prisma.contact = prisma.contact || {};
    prisma.contact.update = vi.fn().mockResolvedValue({ id: 1 });
    prisma.contact.findMany = vi.fn().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    stopDnpRetryEngine();
  });

  test('getDnpRetrySettings returns parsed defaults', async () => {
    mockSettings({ enabled: true, maxRetries: 5, intervalMinutes: 90 });
    const settings = await getDnpRetrySettings(1);
    expect(settings).toEqual({ enabled: true, maxRetries: 5, intervalMinutes: 90, mode: 'delay', dayInterval: 1, timeLocal: '10:00', timezone: 'UTC' });
  });

  test('getDnpRetrySettings clamps out-of-range values', async () => {
    mockSettings({ enabled: false, maxRetries: 99, intervalMinutes: 99999 });
    const settings = await getDnpRetrySettings(1);
    expect(settings).toEqual({ enabled: false, maxRetries: 10, intervalMinutes: 30 * 24 * 60, mode: 'delay', dayInterval: 1, timeLocal: '10:00', timezone: 'UTC' });
  });

  test('computeNextRetryAt schedules the chosen local time in the configured timezone', () => {
    const now = new Date('2026-09-28T03:00:00.000Z'); // 08:30 in Asia/Kolkata
    const next = computeNextRetryAt({
      mode: 'scheduled', dayInterval: 1, timeLocal: '10:00',
      timezone: 'Asia/Kolkata', intervalMinutes: 60,
    }, now);
    expect(next.toISOString()).toBe('2026-09-28T04:30:00.000Z');
  });

  test('computeNextRetryAt advances by N calendar days after the scheduled time', () => {
    const now = new Date('2026-09-28T06:00:00.000Z'); // 11:30 in Asia/Kolkata
    const next = computeNextRetryAt({
      mode: 'scheduled', dayInterval: 2, timeLocal: '10:00',
      timezone: 'Asia/Kolkata', intervalMinutes: 60,
    }, now);
    expect(next.toISOString()).toBe('2026-09-30T04:30:00.000Z');
  });

  test('scheduleDnpRetry sets next retry window without resetting count', async () => {
    mockSettings({ enabled: true, intervalMinutes: 60 });
    await scheduleDnpRetry(1, 11);

    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 11, tenantId: 1 },
      data: {
        callifiedDnpNextRetryAt: expect.any(Date),
      },
    });

    const nextRetryAt = prisma.contact.update.mock.calls[0][0].data.callifiedDnpNextRetryAt;
    const expected = new Date(Date.now() + 60 * 60 * 1000);
    expect(Math.abs(nextRetryAt.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  test('scheduleDnpRetry is a no-op when disabled', async () => {
    mockSettings({ enabled: false });
    const result = await scheduleDnpRetry(1, 11);
    expect(result).toBeNull();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('clearDnpRetryState resets retry counters', async () => {
    await clearDnpRetryState(11);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: {
        callifiedDnpRetryCount: 0,
        callifiedDnpNextRetryAt: null,
      },
    });
  });

  test('processDnpRetries enqueues a due DNP lead and updates state', async () => {
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 11,
        tenantId: 1,
        callifiedCampaignId: 42,
        callifiedDnpRetryCount: 0,
        callifiedDnpNextRetryAt: new Date(Date.now() - 1000),
      },
    ]);

    await processDnpRetries();

    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenant: { vertical: 'generic' } }),
    }));
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ tenantId: 1, contactId: 11, campaignId: 42, userId: null, retryAttempt: true });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 11, tenantId: 1 },
      data: {
        callifiedDnpNextRetryAt: expect.any(Date),
      },
    });
  });

  test('processPendingRetries schedules the configured delay for an existing unscheduled pending lead', async () => {
    prisma.contact.findMany.mockResolvedValue([{
      id: 12,
      tenantId: 1,
      callifiedCampaignId: 43,
      callifiedDnpRetryCount: 1,
      callifiedDnpNextRetryAt: null,
      callifiedLeadStatus: 'pending',
    }]);

    await processPendingRetries();

    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenant: { vertical: 'generic' },
        callifiedLeadStatus: 'pending',
        OR: expect.arrayContaining([{ callifiedDnpNextRetryAt: null }]),
      }),
    }));
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 12, tenantId: 1 },
      data: {
        callifiedDnpNextRetryAt: expect.any(Date),
      },
    });
  });

  test('processPendingRetries enqueues a pending lead after its scheduled delay', async () => {
    prisma.contact.findMany.mockResolvedValue([{
      id: 12,
      tenantId: 1,
      callifiedCampaignId: 43,
      callifiedDnpRetryCount: 0,
      callifiedDnpNextRetryAt: new Date(Date.now() - 1000),
      callifiedLeadStatus: 'pending',
    }]);

    await processPendingRetries();

    expect(enqueueMock).toHaveBeenCalledWith({ tenantId: 1, contactId: 12, campaignId: 43, userId: null, retryAttempt: true });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 12, tenantId: 1 },
      data: {
        callifiedDnpNextRetryAt: expect.any(Date),
      },
    });
  });

  test('a duplicate queue rejection does not consume or reschedule a retry', async () => {
    enqueueMock.mockReturnValue(false);
    prisma.contact.findMany.mockResolvedValue([{
      id: 13,
      tenantId: 1,
      callifiedCampaignId: 44,
      callifiedDnpRetryCount: 1,
      callifiedDnpNextRetryAt: new Date(Date.now() - 1000),
      callifiedLeadStatus: 'pending',
    }]);

    await processPendingRetries();

    expect(enqueueMock).toHaveBeenCalledOnce();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('processDnpRetries schedules the configured delay for an existing unscheduled DNP lead', async () => {
    prisma.contact.findMany.mockResolvedValue([{
      id: 11,
      tenantId: 1,
      callifiedCampaignId: 42,
      callifiedDnpRetryCount: 0,
      callifiedDnpNextRetryAt: null,
    }]);

    await processDnpRetries();

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 11, tenantId: 1 },
      data: { callifiedDnpNextRetryAt: expect.any(Date) },
    });
  });

  test('processDnpRetries skips leads that have exhausted max retries', async () => {
    mockSettings({ maxRetries: 2 });
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 11,
        tenantId: 1,
        callifiedCampaignId: 42,
        callifiedDnpRetryCount: 2,
      },
    ]);

    await processDnpRetries();

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test('processDnpRetries skips disabled tenants', async () => {
    mockSettings({ enabled: false });
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 11,
        tenantId: 1,
        callifiedCampaignId: 42,
        callifiedDnpRetryCount: 0,
        callifiedDnpNextRetryAt: new Date(Date.now() - 1000),
      },
    ]);

    await processDnpRetries();

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  test('startDnpRetryEngine ticks on interval', async () => {
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 11,
        tenantId: 1,
        callifiedCampaignId: 42,
        callifiedDnpRetryCount: 0,
        callifiedDnpNextRetryAt: new Date(Date.now() - 1000),
      },
    ]);

    startDnpRetryEngine();
    // The initial tick is async; flush the event loop so it completes.
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueMock).toHaveBeenCalledTimes(1); // initial tick

    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });
});
