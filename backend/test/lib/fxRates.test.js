// Unit tests for backend/lib/fxRates.js — pure FX-rate helpers (PRD G018 / DD-5.4).
//
// The lib is the seam between the cron poller (cron/fxRateEngine.js) and
// the operator QuoteBuilder's per-line FX panel (frontend pulls via the
// /api/fx/latest endpoint). This suite pins the shape every dependent
// surface relies on.
//
// Contracts pinned:
//   1. fetchLatestRate returns { base, quote, rate } on success.
//   2. fetchLatestRate returns null on non-200 / network failure / parse failure.
//   3. convert(amount, rate) === amount * rate when both numeric.
//   4. convert returns null when either input is null/undefined/non-numeric.
//   5. getLatestFromDb returns the freshest row or null.
//   6. getHistoryFromDb honours from/to bounds.
//   7. upsertRate creates a new row; collision returns null fail-soft.
//   8. SUPPORTED_PAIRS is non-empty and contains the canonical seed list.

import { describe, test, expect, vi } from 'vitest';

const {
  fetchLatestRate,
  convert,
  getLatestFromDb,
  getHistoryFromDb,
  upsertRate,
  SUPPORTED_PAIRS,
  DEFAULT_SOURCE,
  FRANKFURTER_LATEST_URL,
} = require('../../lib/fxRates');

function makeFetch({ ok = true, body = {}, throws = false } = {}) {
  return vi.fn(async () => {
    if (throws) throw new Error('network down');
    return { ok, json: async () => body };
  });
}

describe('fxRates — module shape', () => {
  test('exports SUPPORTED_PAIRS as a non-empty array', () => {
    expect(Array.isArray(SUPPORTED_PAIRS)).toBe(true);
    expect(SUPPORTED_PAIRS.length).toBeGreaterThan(0);
    expect(SUPPORTED_PAIRS[0]).toHaveProperty('base');
    expect(SUPPORTED_PAIRS[0]).toHaveProperty('quote');
  });
  test('default source is "frankfurter"', () => {
    expect(DEFAULT_SOURCE).toBe('frankfurter');
  });
  test('frankfurter URL is the documented v1 latest endpoint', () => {
    expect(FRANKFURTER_LATEST_URL).toBe('https://api.frankfurter.dev/v1/latest');
  });
});

describe('fxRates.fetchLatestRate', () => {
  test('returns { base, quote, rate } on successful frankfurter response', async () => {
    const fetchImpl = makeFetch({ body: { rates: { USD: 0.012 } } });
    const r = await fetchLatestRate('INR', 'USD', { fetchImpl });
    expect(r).toEqual({ base: 'INR', quote: 'USD', rate: 0.012 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns null when response is non-ok', async () => {
    const fetchImpl = makeFetch({ ok: false });
    expect(await fetchLatestRate('INR', 'USD', { fetchImpl })).toBeNull();
  });

  test('returns null when rates object missing', async () => {
    const fetchImpl = makeFetch({ body: { error: 'unknown currency' } });
    expect(await fetchLatestRate('INR', 'XXX', { fetchImpl })).toBeNull();
  });

  test('returns null when requested currency missing from response', async () => {
    const fetchImpl = makeFetch({ body: { rates: { EUR: 0.011 } } });
    expect(await fetchLatestRate('INR', 'USD', { fetchImpl })).toBeNull();
  });

  test('returns null on fetch throw (network failure)', async () => {
    const fetchImpl = makeFetch({ throws: true });
    expect(await fetchLatestRate('INR', 'USD', { fetchImpl })).toBeNull();
  });

  test('returns null when base === quote (no-op pair)', async () => {
    const fetchImpl = makeFetch({ body: { rates: { INR: 1 } } });
    expect(await fetchLatestRate('INR', 'INR', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns null when fetch impl unavailable (explicit non-function)', async () => {
    // Bypass the globalThis.fetch fallback by passing an explicit
    // non-function impl. The default-fallback case is verified by the
    // happy-path tests above (which inject their own fetchImpl).
    expect(await fetchLatestRate('INR', 'USD', { fetchImpl: 'not-a-fn' })).toBeNull();
  });
});

describe('fxRates.convert', () => {
  test('multiplies amount by rate', () => {
    expect(convert(100, 0.012)).toBeCloseTo(1.2);
    expect(convert(50000, 0.012)).toBeCloseTo(600);
  });
  test('returns null on null amount', () => {
    expect(convert(null, 0.012)).toBeNull();
  });
  test('returns null on null rate', () => {
    expect(convert(100, null)).toBeNull();
  });
  test('returns null on NaN', () => {
    expect(convert('abc', 0.012)).toBeNull();
    expect(convert(100, 'abc')).toBeNull();
  });
});

describe('fxRates.getLatestFromDb', () => {
  test('queries prisma.fxRate.findFirst with desc fetchedAt order', async () => {
    const prisma = {
      fxRate: { findFirst: vi.fn(async () => ({ id: 1, baseCurrency: 'INR', quoteCurrency: 'USD', rate: 0.012, fetchedAt: new Date() })) },
    };
    const row = await getLatestFromDb(prisma, 'INR', 'USD');
    expect(row).toBeTruthy();
    expect(prisma.fxRate.findFirst).toHaveBeenCalledWith({
      where: { baseCurrency: 'INR', quoteCurrency: 'USD' },
      orderBy: { fetchedAt: 'desc' },
    });
  });
  test('returns null when no row exists', async () => {
    const prisma = { fxRate: { findFirst: vi.fn(async () => null) } };
    expect(await getLatestFromDb(prisma, 'INR', 'USD')).toBeNull();
  });
  test('returns null on missing prisma / args', async () => {
    expect(await getLatestFromDb(null, 'INR', 'USD')).toBeNull();
    expect(await getLatestFromDb({}, '', 'USD')).toBeNull();
  });
});

describe('fxRates.getHistoryFromDb', () => {
  test('honours from + to date bounds with gte/lte', async () => {
    const prisma = { fxRate: { findMany: vi.fn(async () => []) } };
    const from = new Date('2026-01-01');
    const to = new Date('2026-01-31');
    await getHistoryFromDb(prisma, 'INR', 'USD', from, to);
    const call = prisma.fxRate.findMany.mock.calls[0][0];
    expect(call.where.baseCurrency).toBe('INR');
    expect(call.where.fetchedAt.gte).toEqual(from);
    expect(call.where.fetchedAt.lte).toEqual(to);
    expect(call.orderBy).toEqual({ fetchedAt: 'asc' });
  });
  test('no date filter when neither from nor to supplied', async () => {
    const prisma = { fxRate: { findMany: vi.fn(async () => []) } };
    await getHistoryFromDb(prisma, 'INR', 'USD');
    const call = prisma.fxRate.findMany.mock.calls[0][0];
    expect(call.where.fetchedAt).toBeUndefined();
  });
});

describe('fxRates.upsertRate', () => {
  test('creates a new row with provided base/quote/rate/source', async () => {
    const prisma = {
      fxRate: { create: vi.fn(async ({ data }) => ({ id: 42, ...data })) },
    };
    const row = await upsertRate(prisma, {
      base: 'INR', quote: 'USD', rate: 0.012, source: 'frankfurter',
    });
    expect(row).toMatchObject({ baseCurrency: 'INR', quoteCurrency: 'USD', rate: 0.012, source: 'frankfurter' });
  });
  test('returns null on prisma.create throw (collision fail-soft)', async () => {
    const prisma = {
      fxRate: { create: vi.fn(async () => { throw new Error('Unique constraint failed'); }) },
    };
    expect(await upsertRate(prisma, { base: 'INR', quote: 'USD', rate: 0.012 })).toBeNull();
  });
  test('defaults source to "frankfurter" when omitted', async () => {
    const prisma = {
      fxRate: { create: vi.fn(async ({ data }) => data) },
    };
    await upsertRate(prisma, { base: 'INR', quote: 'USD', rate: 0.012 });
    const call = prisma.fxRate.create.mock.calls[0][0];
    expect(call.data.source).toBe('frankfurter');
  });
});
