// Unit tests for backend/routes/travel_flight_quotes.js's
// POST /extract-prices and POST /extract-hotel-prices — the screenshot-based
// fare/rate extraction endpoints used by the Flight/Hotel Quote agent UI.
//
// Why this file exists
// ─────────────────────
// Both endpoints used to call their respective service's 3-provider loop
// (Gemini vision → OpenAI vision → Groq OCR fallback) directly by raw env
// key. They now thread req.user.tenantId into
// flightOfferImageExtraction.extractFlightOfferPricing /
// hotelOfferImageExtraction.extractHotelOfferPricing, which resolve AI
// access via lib/aiGateway (BYOK or a funded CRM-managed subscription).
// This file pins:
//   - requireTravelTenant gates both routes (non-travel tenant → 403)
//   - validateImages gates both routes (no files → 400)
//   - tenantId is threaded from req.user into the service call
//   - the service's return value is passed through as the response body
//     verbatim (200), including the stub shape when AI access is blocked
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ─── Auth + service mocks (must be set up BEFORE the router is required) ──
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

import prisma from '../../lib/prisma.js';
prisma.tenant = { findUnique: vi.fn() };

const { mockExtractFlight, mockExtractHotel } = vi.hoisted(() => ({
  mockExtractFlight: vi.fn(),
  mockExtractHotel: vi.fn(),
}));
vi.mock('../../services/flightOfferImageExtractionLLM', () => ({
  default: { extractFlightOfferPricing: mockExtractFlight },
  extractFlightOfferPricing: mockExtractFlight,
}));
vi.mock('../../services/hotelOfferImageExtractionLLM', () => ({
  default: { extractHotelOfferPricing: mockExtractHotel },
  extractHotelOfferPricing: mockExtractHotel,
}));
const flightSvcPath = requireCJS.resolve('../../services/flightOfferImageExtractionLLM');
require('node:module')._cache[flightSvcPath] = {
  id: flightSvcPath, filename: flightSvcPath, loaded: true,
  exports: { extractFlightOfferPricing: mockExtractFlight },
  children: [], paths: [],
};
const hotelSvcPath = requireCJS.resolve('../../services/hotelOfferImageExtractionLLM');
require('node:module')._cache[hotelSvcPath] = {
  id: hotelSvcPath, filename: hotelSvcPath, loaded: true,
  exports: { extractHotelOfferPricing: mockExtractHotel },
  children: [], paths: [],
};

import express from 'express';
import request from 'supertest';
const flightQuotesRouter = requireCJS('../../routes/travel_flight_quotes');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/v1/flight-plugin', flightQuotesRouter);
  return app;
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

beforeEach(() => {
  prisma.tenant.findUnique.mockReset();
  mockExtractFlight.mockReset();
  mockExtractHotel.mockReset();
  prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'travel', name: 'Acme Travel', slug: 'acme' });
});

describe('POST /extract-prices', () => {
  test('403 when tenant is not travel-vertical', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'wellness', name: 'Spa', slug: 'spa' });

    const res = await request(makeApp())
      .post('/api/v1/flight-plugin/extract-prices')
      .attach('images', TINY_PNG, 'fare.png');

    expect(res.status).toBe(403);
    expect(mockExtractFlight).not.toHaveBeenCalled();
  });

  test('400 when no images are attached', async () => {
    const res = await request(makeApp())
      .post('/api/v1/flight-plugin/extract-prices')
      .field('tripType', 'domestic');

    expect(res.status).toBe(400);
    expect(mockExtractFlight).not.toHaveBeenCalled();
  });

  test('threads tenantId + tripType into the service, returns its result verbatim', async () => {
    mockExtractFlight.mockResolvedValue({
      provider: 'gemini', model: 'gemini-2.5-flash', stub: false, currency: 'INR',
      tripType: 'domestic', routeLabel: 'Delhi to Goa',
      rows: [{ label: 'Air India', basePrice: 12000, currency: 'INR' }],
    });

    const res = await request(makeApp({ tenantId: 5 }))
      .post('/api/v1/flight-plugin/extract-prices')
      .field('tripType', 'domestic')
      .attach('images', TINY_PNG, 'fare.png');

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(mockExtractFlight).toHaveBeenCalledTimes(1);
    const arg = mockExtractFlight.mock.calls[0][0];
    expect(arg.tenantId).toBe(5);
    expect(arg.tripType).toBe('domestic');
    expect(arg.files).toHaveLength(1);
  });

  test('a blocked-AI stub result still returns 200 with the stub shape (graceful degrade)', async () => {
    mockExtractFlight.mockResolvedValue({
      provider: 'stub', model: null, stub: true, currency: 'INR',
      tripType: 'domestic', routeLabel: null,
      rows: [{ label: 'Fare 1', basePrice: null, currency: 'INR' }],
      note: 'Your organization has not configured an AI provider yet.',
    });

    const res = await request(makeApp())
      .post('/api/v1/flight-plugin/extract-prices')
      .attach('images', TINY_PNG, 'fare.png');

    expect(res.status).toBe(200);
    expect(res.body.stub).toBe(true);
    expect(res.body.note).toMatch(/not configured an AI provider/);
  });
});

describe('POST /extract-hotel-prices', () => {
  test('403 when tenant is not travel-vertical', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'wellness', name: 'Spa', slug: 'spa' });

    const res = await request(makeApp())
      .post('/api/v1/flight-plugin/extract-hotel-prices')
      .attach('images', TINY_PNG, 'hotel.png');

    expect(res.status).toBe(403);
    expect(mockExtractHotel).not.toHaveBeenCalled();
  });

  test('400 when no images are attached', async () => {
    const res = await request(makeApp())
      .post('/api/v1/flight-plugin/extract-hotel-prices');

    expect(res.status).toBe(400);
    expect(mockExtractHotel).not.toHaveBeenCalled();
  });

  test('threads tenantId into the service, returns its result verbatim', async () => {
    mockExtractHotel.mockResolvedValue({
      provider: 'gemini', model: 'gemini-2.5-flash', stub: false, currency: 'INR',
      hotelLabel: 'Taj Lands End', city: 'Mumbai',
      rows: [{ label: 'Taj Lands End', basePrice: 15000, currency: 'INR' }],
    });

    const res = await request(makeApp({ tenantId: 9 }))
      .post('/api/v1/flight-plugin/extract-hotel-prices')
      .attach('images', TINY_PNG, 'hotel.png');

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(mockExtractHotel).toHaveBeenCalledTimes(1);
    const arg = mockExtractHotel.mock.calls[0][0];
    expect(arg.tenantId).toBe(9);
    expect(arg.files).toHaveLength(1);
  });
});
