import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';
const require = createRequire(import.meta.url);
const fx = require('../../lib/dashboardExchangeRates');

const snapshot = () => ({ source: 'Frankfurter', checkedAt: new Date().toISOString(),
  rates: { USD: 1, INR: 80, EUR: 0.8 }, dates: { USD: '2026-10-16', INR: '2026-10-16', EUR: '2026-10-16' } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
  prisma.systemSetting = { findUnique: vi.fn().mockResolvedValue({ value: JSON.stringify(snapshot()) }), upsert: vi.fn() };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('dashboard exchange rates', () => {
  it('converts using a common USD reference, including non-USD bases', async () => {
    const result = await fx.getDashboardRates('INR', ['USD', 'EUR', 'INR']);
    expect(result.rates).toEqual({ INR: 1, USD: 80, EUR: 100 });
    expect(result).toMatchObject({ incomplete: false, stale: false, asOf: '2026-10-16' });
  });

  it('refreshes yesterday’s snapshot and coalesces concurrent requests', async () => {
    const old = snapshot(); old.checkedAt = '2026-10-16T22:00:00Z';
    prisma.systemSetting.findUnique.mockResolvedValue({ value: JSON.stringify(old) });
    vi.spyOn(fx, 'refreshSnapshot').mockResolvedValue(snapshot());
    await Promise.all([fx.getSnapshot(), fx.getSnapshot()]);
    expect(fx.refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it('persists only validated public quotes with source and timestamps', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [
      { base: 'USD', quote: 'INR', rate: 84.5, date: '2026-10-16' },
      { base: 'USD', quote: 'EUR', rate: 0.9, date: '2026-10-16' },
    ] }));
    const result = await fx.refreshSnapshot();
    expect(result.rates.INR).toBe(84.5);
    expect(prisma.systemSetting.upsert).toHaveBeenCalledOnce();
    expect(result.source).toBe('Frankfurter');
  });

  it('rejects malformed, zero and future quotes without overwriting the cache', async () => {
    for (const row of [
      { base: 'USD', quote: 'INR', rate: 0, date: '2026-10-16' },
      { base: 'USD', quote: 'INR', rate: 84, date: '2026-10-18' },
      { base: 'EUR', quote: 'INR', rate: 84, date: '2026-10-16' },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [row] }));
      await expect(fx.refreshSnapshot()).rejects.toThrow();
    }
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('flags unsupported currencies without inventing a 1:1 rate', async () => {
    const result = await fx.getDashboardRates('USD', ['XYZ']);
    expect(result.incomplete).toBe(true);
    expect(result.missingCurrencies).toEqual(['XYZ']);
    expect(result.rates.XYZ).toBeUndefined();
  });

  it('retains the last successful snapshot and flags failure; retries are throttled', async () => {
    const old = snapshot(); old.checkedAt = '2026-10-15T00:00:00Z';
    prisma.systemSetting.findUnique.mockResolvedValue({ value: JSON.stringify(old) });
    vi.spyOn(fx, 'refreshSnapshot').mockRejectedValue(new Error('Offline'));
    const first = await fx.getDashboardRates('USD', ['INR']);
    const second = await fx.getDashboardRates('USD', ['INR']);
    expect(first).toMatchObject({ stale: true, incomplete: false, rates: { INR: 1 / 80 } });
    expect(second.stale).toBe(true);
    expect(fx.refreshSnapshot).toHaveBeenCalledOnce();
  });
});
