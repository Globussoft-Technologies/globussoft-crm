// @ts-check
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const { mockExtractHotelOfferPricing } = vi.hoisted(() => {
  const { createRequire } = require('node:module');
  const hoistedRequire = createRequire(__filename || process.cwd() + '/');

  const authModule = hoistedRequire('../../middleware/auth');
  authModule.verifyToken = (req, _res, next) => {
    req.user = { userId: 7, tenantId: 42, role: 'ADMIN' };
    next();
  };

  const travelGuardsModule = hoistedRequire('../../middleware/travelGuards');
  travelGuardsModule.requireTravelTenant = (req, _res, next) => {
    req.travelTenant = { id: req.user?.tenantId || 42 };
    next();
  };

  const uploadModule = hoistedRequire('../../middleware/uploadHandler');
  uploadModule.uploadImageMultiple = (req, _res, next) => {
    req.files = [{ buffer: Buffer.from('png'), mimetype: 'image/png', originalname: 'shot.png' }];
    next();
  };
  uploadModule.validateImages = (_req, _res, next) => next();

  const hotelModule = hoistedRequire('../../services/hotelOfferImageExtractionLLM');
  hotelModule.extractHotelOfferPricing = vi.fn();

  return { mockExtractHotelOfferPricing: hotelModule.extractHotelOfferPricing };
});

const travelFlightQuotesRouter = requireCJS('../../routes/travel_flight_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/flight-plugin', travelFlightQuotesRouter);
  return app;
}

beforeEach(() => {
  mockExtractHotelOfferPricing.mockReset();
  mockExtractHotelOfferPricing.mockResolvedValue({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    stub: false,
    currency: 'INR',
    hotelLabel: 'Hotel quotation',
    city: 'Goa',
    stayLabel: '2 nights',
    checkIn: '2026-08-12',
    checkOut: '2026-08-14',
    rows: [
      {
        label: 'Hotel 1',
        roomType: 'Deluxe',
        basePrice: 12000,
        priceBasis: 'total',
        nights: 2,
        currency: 'INR',
      },
    ],
    summary: {
      hotelLabel: 'Hotel quotation',
      city: 'Goa',
      stayLabel: '2 nights',
      checkIn: '2026-08-12',
      checkOut: '2026-08-14',
    },
  });
});

describe('POST /api/v1/flight-plugin/extract-hotel-prices', () => {
  it('extracts hotel pricing from uploaded screenshots', async () => {
    const res = await request(makeApp())
      .post('/api/v1/flight-plugin/extract-hotel-prices')
      .attach('images', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'shot.png');

    expect(res.status).toBe(200);
    expect(mockExtractHotelOfferPricing).toHaveBeenCalledTimes(1);
    expect(mockExtractHotelOfferPricing).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.any(Array) })
    );
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.city).toBe('Goa');
  });
});

