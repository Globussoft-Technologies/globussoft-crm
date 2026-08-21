// @ts-check
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const originalLandingPage = prisma.landingPage;
prisma.landingPage = {
  ...(prisma.landingPage || {}),
  findFirst: vi.fn(),
};

const tripsPublicModule = requireCJS('../../routes/trips_public');
const router = tripsPublicModule.router;

function makeApp() {
  const app = express();
  app.use('/trips', router);
  app.use((_req, res) => res.status(204).end());
  return app;
}

beforeEach(() => {
  prisma.landingPage.findFirst.mockReset();
});

afterAll(() => {
  prisma.landingPage = originalLandingPage;
  vi.restoreAllMocks();
});

describe('GET /trips', () => {
  test('falls through to the SPA fallback and does not hit the landing lookup', async () => {
    const res = await request(makeApp()).get('/trips');

    expect(res.status).toBe(204);
    expect(prisma.landingPage.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /trips/:idOrSlug', () => {
  test('redirects a numeric trip id to the canonical /p/:slug URL', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce({ slug: 'japan-2026' });

    const res = await request(makeApp()).get('/trips/123?utm_source=demo');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/p/japan-2026?utm_source=demo');
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { tripId: 123, status: 'PUBLISHED' },
      select: { slug: true },
    });
  });

  test('redirects a slug directly when the published page is found by slug', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce({ slug: 'bali-2026' });

    const res = await request(makeApp()).get('/trips/bali-2026');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/p/bali-2026');
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { slug: 'bali-2026', status: 'PUBLISHED' },
      select: { slug: true },
    });
  });

  test('returns 404 when no published landing page matches', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/trips/missing-page');

    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Trip page not found/i);
  });
});
