// @ts-check
// services/tripGoClient.js — TripGo (SkedGo) transfer routing provider.
// All tests inject a fake axios (the `ax` param) so nothing hits the network.
// Verifies isConfigured, geocode, the guards, and the routing → normalized map.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const requireCJS = createRequire(import.meta.url);
const tripgo = requireCJS('../../services/tripGoClient');

const ORIG = process.env.TRIPGO_API_KEY;
beforeEach(() => { process.env.TRIPGO_API_KEY = 'test-tripgo-key'; });
afterEach(() => {
  if (ORIG === undefined) delete process.env.TRIPGO_API_KEY;
  else process.env.TRIPGO_API_KEY = ORIG;
  vi.restoreAllMocks();
});

describe('isConfigured', () => {
  test('reflects the key presence', () => {
    expect(tripgo.isConfigured()).toBe(true);
    delete process.env.TRIPGO_API_KEY;
    expect(tripgo.isConfigured()).toBe(false);
  });
});

describe('geocode', () => {
  test('returns the first choice with usable coords', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: { choices: [{ name: 'Makkah', lat: 21.42, lng: 39.82 }] } }) };
    const r = await tripgo.geocode('Makkah', ax);
    expect(r).toEqual({ lat: 21.42, lng: 39.82, name: 'Makkah' });
    expect(ax.get.mock.calls[0][0]).toContain('/geocode.json');
  });
  test('returns null on empty input or no choices', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: { choices: [] } }) };
    expect(await tripgo.geocode('', ax)).toBeNull();
    expect(await tripgo.geocode('Nowhere', ax)).toBeNull();
  });
});

describe('mapTrips', () => {
  const data = {
    segmentTemplates: [
      { hashCode: 1, modeIdentifier: 'wa_wal', modeInfo: { alt: 'Walk' } },
      { hashCode: 2, modeIdentifier: 'ps_tax', modeInfo: { alt: 'Taxi' } },
      { hashCode: 3, modeIdentifier: 'pt_pub', modeInfo: { alt: 'Train' } },
    ],
    groups: [
      { trips: [{ depart: 1000, arrive: 1000 + 270 * 60, moneyCost: 320, currencyCode: 'SAR', segments: [
        { segmentTemplateHashCode: 1, startTime: 1000, endTime: 1100 },
        { segmentTemplateHashCode: 2, startTime: 1100, endTime: 1000 + 270 * 60 },
      ] }] },
      { trips: [{ depart: 2000, arrive: 2000 + 300 * 60, moneyCost: 60, currencyCode: 'SAR', segments: [
        { segmentTemplateHashCode: 3, startTime: 2000, endTime: 2000 + 300 * 60 },
      ] }] },
      { trips: [{ depart: 3000, arrive: 3600, segments: [{ segmentTemplateHashCode: 2, startTime: 3000, endTime: 3600 }] }] }, // no moneyCost → dropped
    ],
  };
  test('maps priced trips, derives vehicle + mode + duration, drops fare-less trips', () => {
    const out = tripgo.mapTrips(data, { from: 'Makkah', to: 'Madina', pax: 2 });
    expect(out).toHaveLength(2); // third has no moneyCost
    expect(out[0]).toMatchObject({ vehicle: 'Taxi', mode: 'road', from: 'Makkah', to: 'Madina', durationMinutes: 270, price: 320, pax: 2 });
    expect(out[0].note).toContain('SAR 320');
    // transit train → rail mode
    expect(out[1]).toMatchObject({ vehicle: 'Train', mode: 'rail', durationMinutes: 300, price: 60 });
  });
});

describe('searchTransfers', () => {
  test('returns null without a key', async () => {
    delete process.env.TRIPGO_API_KEY;
    expect(await tripgo.searchTransfers({ from: 'Makkah', to: 'Madina' })).toBeNull();
  });

  test('returns null when an endpoint cannot be geocoded', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: { choices: [] } }) };
    expect(await tripgo.searchTransfers({ from: 'Makkah', to: 'Madina', pax: 2 }, ax)).toBeNull();
  });

  test('geocodes both endpoints then routes + maps', async () => {
    const ax = {
      get: vi.fn()
        .mockResolvedValueOnce({ data: { choices: [{ name: 'Makkah', lat: 21.42, lng: 39.82 }] } }) // geocode from
        .mockResolvedValueOnce({ data: { choices: [{ name: 'Madina', lat: 24.47, lng: 39.61 }] } }) // geocode to
        .mockResolvedValueOnce({ data: {
          segmentTemplates: [{ hashCode: 9, modeIdentifier: 'ps_tax', modeInfo: { alt: 'Taxi' } }],
          groups: [{ trips: [{ depart: 0, arrive: 270 * 60, moneyCost: 350, currencyCode: 'SAR', segments: [{ segmentTemplateHashCode: 9, startTime: 0, endTime: 270 * 60 }] }] }],
        } }),
    };
    const out = await tripgo.searchTransfers({ from: 'Makkah', to: 'Madina', pax: 2 }, ax);
    expect(ax.get).toHaveBeenCalledTimes(3);
    expect(ax.get.mock.calls[2][0]).toContain('/routing.json');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ vehicle: 'Taxi', price: 350, from: 'Makkah', to: 'Madina', pax: 2 });
  });

  test('TripGo error body → null', async () => {
    const ax = {
      get: vi.fn()
        .mockResolvedValueOnce({ data: { choices: [{ name: 'A', lat: 1, lng: 1 }] } })
        .mockResolvedValueOnce({ data: { choices: [{ name: 'B', lat: 2, lng: 2 }] } })
        .mockResolvedValueOnce({ data: { error: 'quota exceeded' } }),
    };
    expect(await tripgo.searchTransfers({ from: 'A', to: 'B', pax: 1 }, ax)).toBeNull();
  });
});
