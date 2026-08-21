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
  startDnpRetryEngine,
  stopDnpRetryEngine,
} = engineModule;

function mockSettings({ enabled = true, maxRetries = 3, intervalMinutes = 60 } = {}) {
  getSetting.mockImplementation(async (_tenantId, key) => {
    if (key === 'feature.callified.dnp_retry.enabled') return enabled;
    if (key === 'feature.callified.dnp_retry.max_retries') return maxRetries;
    if (key === 'feature.callified.dnp_retry.interval_minutes') return intervalMinutes;
    return null;
  });
}

describe('callifiedDnpRetryEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stopDnpRetryEngine();
    enqueueMock.mockReset();
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
    expect(settings).toEqual({ enabled: true, maxRetries: 5, intervalMinutes: 90 });
  });

  test('getDnpRetrySettings clamps out-of-range values', async () => {
    mockSettings({ enabled: false, maxRetries: 99, intervalMinutes: 9999 });
    const settings = await getDnpRetrySettings(1);
    expect(settings).toEqual({ enabled: false, maxRetries: 10, intervalMinutes: 24 * 60 });
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
      },
    ]);

    await processDnpRetries();

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ tenantId: 1, contactId: 11, campaignId: 42, userId: null });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 11, tenantId: 1 },
      data: {
        callifiedDnpRetryCount: { increment: 1 },
        callifiedDnpNextRetryAt: expect.any(Date),
      },
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
