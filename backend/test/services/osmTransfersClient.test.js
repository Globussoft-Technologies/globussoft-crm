// @ts-check
// services/osmTransfersClient.js — OSM (Nominatim geocode + OSRM route) ground-
// transfer provider. All tests inject a fake axios (the `ax` param) so nothing
// hits the network. Verifies isConfigured, geocode, the route→fare mapping, and
// the end-to-end searchTransfers flow + guards.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const requireCJS = createRequire(import.meta.url);
const osm = requireCJS('../../services/osmTransfersClient');

const ORIG_DISABLED = process.env.OSM_TRANSFERS_DISABLED;
beforeEach(() => { delete process.env.OSM_TRANSFERS_DISABLED; });
afterEach(() => {
  if (ORIG_DISABLED === undefined) delete process.env.OSM_TRANSFERS_DISABLED;
  else process.env.OSM_TRANSFERS_DISABLED = ORIG_DISABLED;
  vi.restoreAllMocks();
});

describe('isConfigured', () => {
  test('on by default (no key needed), off when disabled', () => {
    expect(osm.isConfigured()).toBe(true);
    process.env.OSM_TRANSFERS_DISABLED = '1';
    expect(osm.isConfigured()).toBe(false);
  });
});

describe('geocode (Nominatim)', () => {
  test('maps the first result to lat/lng', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: [{ lat: '23.37', lon: '85.325', display_name: 'Ranchi, Jharkhand, India' }] }) };
    const r = await osm.geocode('Ranchi', ax);
    expect(r).toEqual({ lat: 23.37, lng: 85.325, name: 'Ranchi, Jharkhand, India' });
    expect(ax.get.mock.calls[0][0]).toContain('/search');
    expect(ax.get.mock.calls[0][1].params).toMatchObject({ q: 'Ranchi', format: 'json', limit: 1 });
  });
  test('returns null on empty input or no results', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: [] }) };
    expect(await osm.geocode('', ax)).toBeNull();
    expect(await osm.geocode('Nowhereville', ax)).toBeNull();
  });
});

describe('buildOptions (route → priced vehicle classes)', () => {
  test('prices each vehicle = base + perKm × km, in the quote currency', () => {
    const opts = osm.buildOptions({ km: 153.5, minutes: 132 }, { from: 'Ranchi', to: 'Netarhat', pax: 2, currency: 'INR' });
    expect(opts).toHaveLength(3); // Sedan / SUV / Tempo
    // Sedan: 800 + 13*153.5 = 2795.5 → 2796
    expect(opts[0]).toMatchObject({ vehicle: 'Private Sedan', mode: 'road', price: 2796, durationMinutes: 132, from: 'Ranchi', to: 'Netarhat', pax: 2 });
    expect(opts[0].note).toContain('153.5 km');
    expect(opts[0].note).toContain('INR 13/km');
    // SUV: 1200 + 19*153.5 = 4116.5 → 4117
    expect(opts[1]).toMatchObject({ vehicle: 'Private SUV', price: 4117 });
  });
  test('returns [] for a currency with no rate card (→ caller falls to LLM)', () => {
    expect(osm.buildOptions({ km: 100, minutes: 90 }, { from: 'A', to: 'B', currency: 'USD' })).toEqual([]);
  });
});

describe('searchTransfers', () => {
  test('disabled → null', async () => {
    process.env.OSM_TRANSFERS_DISABLED = 'true';
    expect(await osm.searchTransfers({ from: 'Ranchi', to: 'Netarhat', currency: 'INR' })).toBeNull();
  });

  test('un-geocodable endpoint → null', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: [] }) };
    expect(await osm.searchTransfers({ from: 'Ranchi', to: 'Netarhat', currency: 'INR' }, ax)).toBeNull();
  });

  test('geocodes both, routes via OSRM, returns priced options', async () => {
    const ax = {
      get: vi.fn()
        .mockResolvedValueOnce({ data: [{ lat: '23.37', lon: '85.325', display_name: 'Ranchi' }] }) // geocode from
        .mockResolvedValueOnce({ data: [{ lat: '23.47', lon: '84.268', display_name: 'Netarhat' }] }) // geocode to
        .mockResolvedValueOnce({ data: { code: 'Ok', routes: [{ distance: 153500, duration: 7920 }] } }), // OSRM
    };
    const out = await osm.searchTransfers({ from: 'Ranchi', to: 'Netarhat', pax: 2, currency: 'INR' }, ax);
    expect(ax.get).toHaveBeenCalledTimes(3);
    expect(ax.get.mock.calls[2][0]).toContain('/route/v1/driving/');
    // OSRM wants lng,lat order in the path
    expect(ax.get.mock.calls[2][0]).toContain('85.325,23.37;84.268,23.47');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ vehicle: 'Private Sedan', mode: 'road', from: 'Ranchi', to: 'Netarhat', durationMinutes: 132 });
  });

  test('OSRM returns no route → null', async () => {
    const ax = {
      get: vi.fn()
        .mockResolvedValueOnce({ data: [{ lat: '1', lon: '1', display_name: 'A' }] })
        .mockResolvedValueOnce({ data: [{ lat: '2', lon: '2', display_name: 'B' }] })
        .mockResolvedValueOnce({ data: { code: 'NoRoute', routes: [] } }),
    };
    expect(await osm.searchTransfers({ from: 'A', to: 'B', pax: 1, currency: 'INR' }, ax)).toBeNull();
  });
});
