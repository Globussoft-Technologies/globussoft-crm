// @ts-check
// services/serpApiClient.js — SerpApi (Google Flights + Hotels) search provider.
// All tests inject a fake axios (the `ax` param) so nothing hits the network.
// Verifies isConfigured, the required-param guards, and the SerpApi → normalized
// mapping for both flights and hotels.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const requireCJS = createRequire(import.meta.url);
const serp = requireCJS('../../services/serpApiClient');

const ORIG_KEY = process.env.SERP_API_KEY;
beforeEach(() => { process.env.SERP_API_KEY = 'test-serp-key'; });
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.SERP_API_KEY;
  else process.env.SERP_API_KEY = ORIG_KEY;
  vi.restoreAllMocks();
});

describe('isConfigured', () => {
  test('true with a key, false without', () => {
    expect(serp.isConfigured()).toBe(true);
    delete process.env.SERP_API_KEY;
    expect(serp.isConfigured()).toBe(false);
  });
});

describe('searchFlights', () => {
  test('returns null when no key (so tboClient falls through)', async () => {
    delete process.env.SERP_API_KEY;
    expect(await serp.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02' })).toBeNull();
  });

  test('returns null when the outbound date is missing', async () => {
    expect(await serp.searchFlights({ from: 'DEL', to: 'JED' })).toBeNull();
  });

  test('one-way request sets type=2 and maps best+other flights', async () => {
    const ax = {
      get: vi.fn().mockResolvedValue({
        data: {
          best_flights: [{
            price: 38800,
            total_duration: 320,
            layovers: [{ name: 'Dubai' }],
            flights: [
              { departure_airport: { id: 'DEL', time: '2026-08-02 02:10' }, arrival_airport: { id: 'DXB', time: '2026-08-02 05:00' }, airline: 'IndiGo', flight_number: '6E 1407', travel_class: 'Economy' },
              { departure_airport: { id: 'DXB', time: '2026-08-02 07:30' }, arrival_airport: { id: 'JED', time: '2026-08-02 09:40' }, airline: 'IndiGo', flight_number: '6E 1408', travel_class: 'Economy' },
            ],
          }],
          other_flights: [{
            price: 51000,
            total_duration: 240,
            layovers: [],
            flights: [
              { departure_airport: { id: 'DEL', time: '2026-08-02 04:00' }, arrival_airport: { id: 'JED', time: '2026-08-02 08:00' }, airline: 'Air India', flight_number: 'AI 305', travel_class: 'Economy' },
            ],
          }],
        },
      }),
    };
    const out = await serp.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02', adults: 2, currency: 'INR' }, ax);
    // params
    const params = ax.get.mock.calls[0][1].params;
    expect(params).toMatchObject({ engine: 'google_flights', departure_id: 'DEL', arrival_id: 'JED', outbound_date: '2026-08-02', type: 2, adults: 2 });
    expect(params.return_date).toBeUndefined();
    // mapping
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ airline: '6E', airlineName: 'IndiGo', flightNumber: '6E 1407', from: 'DEL', to: 'JED', stops: 1, fare: 38800, durationMinutes: 320 });
    expect(out[1]).toMatchObject({ airline: 'AI', airlineName: 'Air India', stops: 0, fare: 51000 });
  });

  test('round trip passes return_date and omits type', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: { best_flights: [], other_flights: [] } }) };
    await serp.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02', returnDate: '2026-08-09' }, ax);
    const params = ax.get.mock.calls[0][1].params;
    expect(params.return_date).toBe('2026-08-09');
    expect(params.type).toBeUndefined();
  });

  test('SerpApi error body → null', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: { error: 'Invalid API key' } }) };
    expect(await serp.searchFlights({ from: 'DEL', to: 'JED', departDate: '2026-08-02' }, ax)).toBeNull();
  });
});

describe('searchHotels', () => {
  test('returns null when dates are missing', async () => {
    expect(await serp.searchHotels({ city: 'Goa' })).toBeNull();
  });

  test('maps properties incl. rating, bookingLink, and total-rate fallback', async () => {
    const ax = {
      get: vi.fn().mockResolvedValue({
        data: {
          properties: [
            { name: 'Taj Goa', extracted_hotel_class: 5, overall_rating: 4.6, rate_per_night: { extracted_lowest: 12000 }, total_rate: { extracted_lowest: 60000 }, thumbnail: 'https://t/1.jpg', link: 'https://book/taj', address: 'Sinquerim, Goa' },
            { name: 'Budget Inn', extracted_hotel_class: 3, overall_rating: 3.8, rate_per_night: { extracted_lowest: 3000 }, images: [{ thumbnail: 'https://t/2.jpg' }] }, // no total_rate → fallback nightly×nights
          ],
        },
      }),
    };
    const out = await serp.searchHotels({ city: 'Goa', checkIn: '2026-07-10', checkOut: '2026-07-15', adults: 2, currency: 'INR', nights: 5 }, ax);
    const params = ax.get.mock.calls[0][1].params;
    expect(params).toMatchObject({ engine: 'google_hotels', q: 'Goa', check_in_date: '2026-07-10', check_out_date: '2026-07-15', adults: 2 });
    expect(out[0]).toMatchObject({ name: 'Taj Goa', starRating: 5, rating: 4.6, ratePerNight: 12000, totalRate: 60000, thumbnail: 'https://t/1.jpg', bookingLink: 'https://book/taj' });
    // fallback: 3000 × 5 nights
    expect(out[1]).toMatchObject({ name: 'Budget Inn', totalRate: 15000, thumbnail: 'https://t/2.jpg' });
  });

  test('drops properties with no usable price', async () => {
    const ax = { get: vi.fn().mockResolvedValue({ data: { properties: [{ name: 'No Price Hotel' }] } }) };
    const out = await serp.searchHotels({ city: 'Goa', checkIn: '2026-07-10', checkOut: '2026-07-15' }, ax);
    expect(out).toEqual([]);
  });
});
