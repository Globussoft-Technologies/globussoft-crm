import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fx = require('../../lib/dashboardExchangeRates');
const registry = require('../../lib/cronRegistry');
vi.spyOn(fx, 'getSnapshot');
vi.spyOn(registry, 'register').mockResolvedValue(undefined);
const engine = require('../../cron/exchangeRatesEngine');
afterEach(() => vi.clearAllMocks());

it('registers hourly rate refresh through the managed cron registry', async () => {
  await engine.initExchangeRatesCron();
  expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({
    name: 'exchangeRatesEngine', defaultSchedule: '15 * * * *', tickFn: engine.tickExchangeRates,
  }));
});
it('reports failure rather than claiming stale data refreshed successfully', async () => {
  fx.getSnapshot.mockResolvedValue({ snapshot: {}, refreshFailed: true });
  await expect(engine.tickExchangeRates()).rejects.toThrow('refresh failed');
});
it('reports the successful snapshot timestamp', async () => {
  fx.getSnapshot.mockResolvedValue({ snapshot: { source: 'Frankfurter', checkedAt: '2026-10-16' }, refreshFailed: false });
  await expect(engine.tickExchangeRates()).resolves.toEqual({ source: 'Frankfurter', checkedAt: '2026-10-16' });
});
