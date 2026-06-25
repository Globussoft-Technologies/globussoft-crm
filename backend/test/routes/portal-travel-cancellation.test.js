// @ts-check
/**
 * POST /api/portal/travel/itineraries/:id/request-cancellation — customer
 * cancellation request guards (portal). Focus: a trip that has already
 * departed can no longer be cancelled online (TRIP_ALREADY_STARTED).
 *
 * Mirrors portal.test.js: patch the prisma singleton BEFORE requiring the
 * router; drive supertest with a real PORTAL bearer.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';

prisma.tenant = { findUnique: vi.fn() };
prisma.itinerary = { findFirst: vi.fn(), update: vi.fn() };
prisma.contact = { findFirst: vi.fn(), findUnique: vi.fn() };
prisma.notification = { ...(prisma.notification || {}), create: vi.fn().mockResolvedValue({}) };
prisma.user = { ...(prisma.user || {}), findMany: vi.fn().mockResolvedValue([]) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const portalRouter = requireCJS('../../routes/portal');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal', portalRouter);
  return app;
}
function portalBearer({ contactId = 42, tenantId = 1 } = {}) {
  return 'Bearer ' + jwt.sign({ contactId, tenantId, type: 'PORTAL' }, JWT_SECRET, { expiresIn: '7d' });
}

const DAY = 86_400_000;
function itin(over = {}) {
  return {
    id: 9, status: 'advance_paid', subBrand: 'travelstall', destination: 'Dwarika',
    cancellationStatus: null, advancePaidAmount: 5000, currency: 'INR',
    startDate: new Date(Date.now() + 10 * DAY), endDate: new Date(Date.now() + 15 * DAY),
    ...over,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'travel' });
  prisma.itinerary.findFirst.mockReset();
  prisma.itinerary.update.mockReset().mockImplementation(async ({ data }) => ({ id: 9, status: 'advance_paid', ...data }));
  prisma.user.findMany.mockReset().mockResolvedValue([]);
});

describe('request-cancellation — departure guard', () => {
  test('past trip (already started) → 409 TRIP_ALREADY_STARTED, no write', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin({ startDate: new Date(Date.now() - 10 * DAY), endDate: new Date(Date.now() - 5 * DAY) }));
    const res = await request(makeApp())
      .post('/api/portal/travel/itineraries/9/request-cancellation')
      .set('Authorization', portalBearer())
      .send({ reason: 'changed plans' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRIP_ALREADY_STARTED');
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
  });

  test('trip that ended but no start date → still blocked via endDate', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin({ startDate: null, endDate: new Date(Date.now() - 1 * DAY) }));
    const res = await request(makeApp())
      .post('/api/portal/travel/itineraries/9/request-cancellation')
      .set('Authorization', portalBearer())
      .send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRIP_ALREADY_STARTED');
  });

  test('future trip → request accepted (cancellationStatus=requested)', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin());
    const res = await request(makeApp())
      .post('/api/portal/travel/itineraries/9/request-cancellation')
      .set('Authorization', portalBearer())
      .send({ reason: 'changed plans' });
    expect(res.status).toBe(200);
    expect(prisma.itinerary.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cancellationStatus: 'requested' }) }),
    );
  });

  test('no dates at all → not blocked by the date guard (proceeds)', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin({ startDate: null, endDate: null }));
    const res = await request(makeApp())
      .post('/api/portal/travel/itineraries/9/request-cancellation')
      .set('Authorization', portalBearer())
      .send({ reason: 'x' });
    expect(res.status).toBe(200);
  });
});
