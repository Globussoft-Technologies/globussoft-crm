// @ts-check
// services/tboClient.js — 4-tier travel search provider
// (SerpApi → TBO → LLM web → stub). These tests run with no TBO creds (TBO tier
// skipped) and force the SerpApi tier OFF by default (so a developer's local
// SERP_API_KEY can't make these tests hit the network); the LLM tier is driven
// by spying llmRouter.routeRequest. Verifies the stub fallback, the LLM-web path
// (incl. fenced-JSON parsing), the SerpApi tier, and query/output normalization.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const requireCJS = createRequire(import.meta.url);
const tboClient = requireCJS('../../services/tboClient');
const llmRouter = requireCJS('../../lib/llmRouter');
const serpApiClient = requireCJS('../../services/serpApiClient');
const osmTransfers = requireCJS('../../services/osmTransfersClient');

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.TBO_FLIGHT_SEARCH_URL;
  delete process.env.TBO_HOTEL_SEARCH_URL;
  delete process.env.TBO_USERNAME;
  delete process.env.TBO_PASSWORD;
  // Force the SerpApi + OSM-transfer tiers off by default — individual tests opt
  // back in. This keeps the lower-tier (TBO/LLM/stub) assertions deterministic +
  // offline (OSM is key-free + on-by-default, so it must be muted here).
  vi.spyOn(serpApiClient, 'isConfigured').mockReturnValue(false);
  vi.spyOn(osmTransfers, 'isConfigured').mockReturnValue(false);
});

describe('searchFlights', () => {
  test('falls back to stub when no TBO creds + LLM stubbed', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({ text: '[STUB]', stub: true });
    const res = await tboClient.searchFlights({ from: 'del', to: 'jed', departDate: '2026-08-02', currency: 'inr' });
    expect(res.provider).toBe('stub');
    expect(res.stub).toBe(true);
    expect(res.currency).toBe('INR'); // normalized upper-case
    expect(res.options.length).toBeGreaterThan(0);
    const o = res.options[0];
    expect(o.from).toBe('DEL');
    expect(o.to).toBe('JED');
    expect(typeof o.fare).toBe('number');
    expect(o.fare).toBeGreaterThan(0);
  });

  test('uses LLM web results when the model returns JSON (fenced)', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({
      stub: false,
      text: '```json\n{"options":[{"airline":"ai","from":"DEL","to":"JED","fare":50000,"fareClass":"Economy","departAt":"2026-08-02T18:10:00"}]}\n```',
    });
    const res = await tboClient.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02' });
    expect(res.provider).toBe('llm-web');
    expect(res.stub).toBe(false);
    expect(res.options).toHaveLength(1);
    expect(res.options[0].airline).toBe('AI'); // normalized
    expect(res.options[0].fare).toBe(50000);
  });

  test('uses SerpApi results (tier 0) when configured', async () => {
    vi.spyOn(serpApiClient, 'isConfigured').mockReturnValue(true);
    vi.spyOn(serpApiClient, 'searchFlights').mockResolvedValue([
      { airline: '6E', airlineName: 'IndiGo', flightNumber: '6E 2341', from: 'DEL', to: 'JED', fare: 38800, fareClass: 'Economy', stops: 1 },
    ]);
    const llmSpy = vi.spyOn(llmRouter, 'routeRequest');
    const res = await tboClient.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02' });
    expect(res.provider).toBe('serpapi');
    expect(res.stub).toBe(false);
    expect(res.options[0].airlineName).toBe('IndiGo');
    expect(res.options[0].fare).toBe(38800);
    expect(llmSpy).not.toHaveBeenCalled(); // tier 0 short-circuits the LLM tier
  });

  test('falls through to the LLM tier when SerpApi returns nothing', async () => {
    vi.spyOn(serpApiClient, 'isConfigured').mockReturnValue(true);
    vi.spyOn(serpApiClient, 'searchFlights').mockResolvedValue([]); // no results
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({
      stub: false,
      text: '{"options":[{"airline":"AI","from":"DEL","to":"JED","fare":51000}]}',
    });
    const res = await tboClient.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02' });
    expect(res.provider).toBe('llm-web');
  });

  test('drops LLM options with no fare, then stubs if none remain', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({
      stub: false,
      text: '{"options":[{"airline":"AI","from":"DEL","to":"JED"}]}', // no fare → dropped
    });
    const res = await tboClient.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02' });
    expect(res.provider).toBe('stub'); // LLM produced nothing usable
  });
});

describe('searchHotels', () => {
  test('stub fallback returns sample hotels', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({ text: '[STUB]', stub: true });
    const res = await tboClient.searchHotels({ city: 'Jeddah', checkIn: '2026-08-02', checkOut: '2026-08-04', rooms: 1 });
    expect(res.provider).toBe('stub');
    expect(res.hotels.length).toBeGreaterThan(0);
    expect(typeof res.hotels[0].totalRate).toBe('number');
  });

  test('uses SerpApi hotels (tier 0) when configured, carrying rating + bookingLink', async () => {
    vi.spyOn(serpApiClient, 'isConfigured').mockReturnValue(true);
    vi.spyOn(serpApiClient, 'searchHotels').mockResolvedValue([
      { name: 'Mövenpick Jeddah', starRating: 5, ratePerNight: 9000, totalRate: 18000, thumbnail: 'https://x/y.jpg', rating: 4.4, bookingLink: 'https://book/x' },
    ]);
    const res = await tboClient.searchHotels({ city: 'Jeddah', checkIn: '2026-08-02', checkOut: '2026-08-04' });
    expect(res.provider).toBe('serpapi');
    expect(res.hotels[0].name).toBe('Mövenpick Jeddah');
    expect(res.hotels[0].rating).toBe(4.4);
    expect(res.hotels[0].bookingLink).toBe('https://book/x');
  });

  test('LLM hotels when JSON returned', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({
      stub: false,
      text: '{"hotels":[{"name":"Conrad Jeddah","starRating":5,"ratePerNight":9000,"totalRate":18000,"roomType":"Suite","board":"Breakfast"}]}',
    });
    const res = await tboClient.searchHotels({ city: 'Jeddah', checkIn: '2026-08-02', checkOut: '2026-08-04' });
    expect(res.provider).toBe('llm-web');
    expect(res.hotels[0].name).toBe('Conrad Jeddah');
    expect(res.hotels[0].totalRate).toBe(18000);
  });
});

describe('searchTransfers', () => {
  test('stub fallback returns sample road transfers', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({ text: '[STUB]', stub: true });
    const res = await tboClient.searchTransfers({ from: 'Makkah', to: 'Madina', date: '2026-08-04', pax: 2 });
    expect(res.provider).toBe('stub');
    expect(res.transfers.length).toBeGreaterThan(0);
    const t = res.transfers[0];
    expect(t.from).toBe('Makkah');
    expect(t.to).toBe('Madina');
    expect(typeof t.price).toBe('number');
    expect(t.price).toBeGreaterThan(0);
  });

  test('uses OSM road transfers (tier 0) when enabled', async () => {
    vi.spyOn(osmTransfers, 'isConfigured').mockReturnValue(true);
    vi.spyOn(osmTransfers, 'searchTransfers').mockResolvedValue([
      { mode: 'road', vehicle: 'Private Sedan', from: 'Ranchi', to: 'Netarhat', durationMinutes: 132, price: 2790, pax: 2, note: '~153 km · ~2.2h drive' },
    ]);
    const llmSpy = vi.spyOn(llmRouter, 'routeRequest');
    const res = await tboClient.searchTransfers({ from: 'Ranchi', to: 'Netarhat', pax: 2 });
    expect(res.provider).toBe('osm-road');
    expect(res.stub).toBe(false);
    expect(res.transfers[0].vehicle).toBe('Private Sedan');
    expect(res.transfers[0].price).toBe(2790);
    expect(llmSpy).not.toHaveBeenCalled(); // tier 0 short-circuits the LLM
  });

  test('falls through to LLM when OSM returns nothing priced', async () => {
    vi.spyOn(osmTransfers, 'isConfigured').mockReturnValue(true);
    vi.spyOn(osmTransfers, 'searchTransfers').mockResolvedValue([]); // un-geocodable / no route
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({
      stub: false,
      text: '{"transfers":[{"mode":"road","vehicle":"Private SUV","from":"Makkah","to":"Madina","price":9500,"pax":2}]}',
    });
    const res = await tboClient.searchTransfers({ from: 'Makkah', to: 'Madina', pax: 2 });
    expect(res.provider).toBe('llm-web');
  });

  test('uses LLM transfers when the model returns JSON', async () => {
    vi.spyOn(llmRouter, 'routeRequest').mockResolvedValue({
      stub: false,
      text: '{"transfers":[{"mode":"road","vehicle":"Private SUV","from":"Makkah","to":"Madina","durationMinutes":270,"price":9500,"pax":2}]}',
    });
    const res = await tboClient.searchTransfers({ from: 'Makkah', to: 'Madina', date: '2026-08-04', pax: 2 });
    expect(res.provider).toBe('llm-web');
    expect(res.transfers[0].vehicle).toBe('Private SUV');
    expect(res.transfers[0].price).toBe(9500);
  });
});

describe('parseJsonLoose', () => {
  test('extracts JSON from a fenced block', () => {
    expect(tboClient.parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test('extracts a bare array embedded in prose', () => {
    expect(tboClient.parseJsonLoose('Here you go: [1,2,3] thanks')).toEqual([1, 2, 3]);
  });
  test('returns null when there is no JSON', () => {
    expect(tboClient.parseJsonLoose('no json here')).toBeNull();
  });
});

describe('normalizeFlightQuery', () => {
  test('upper-cases codes/currency and floors pax sensibly', () => {
    const q = tboClient.normalizeFlightQuery({ from: 'del', to: 'jed', adults: 0, currency: 'usd' });
    expect(q.from).toBe('DEL');
    expect(q.to).toBe('JED');
    expect(q.adults).toBe(1); // floored to at least 1
    expect(q.currency).toBe('USD');
    expect(q.cabinClass).toBe('Economy');
  });
});
