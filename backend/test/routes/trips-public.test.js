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

const landingPageRenderer = requireCJS('../../services/landingPageRenderer');
const renderPageSpy = vi.spyOn(landingPageRenderer, 'renderPage').mockImplementation((page) => {
  return `<!doctype html><html><body>${page?.title || page?.slug || 'trip'}</body></html>`;
});

const tripsPublicModule = requireCJS('../../routes/trips_public');
const router = tripsPublicModule.router;

function makeApp() {
  const app = express();
  app.use('/trips', router);
  app.use((_req, res) => res.status(204).end());
  return app;
}

function expectWanderluxCsp(res) {
  expect(res.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  expect(res.headers['content-security-policy']).toContain('https://cdn.jsdelivr.net');
}

beforeEach(() => {
  prisma.landingPage.findFirst.mockReset();
  renderPageSpy.mockClear();
});

afterAll(() => {
  prisma.landingPage = originalLandingPage;
  vi.restoreAllMocks();
});

describe('GET /trips', () => {
  test('renders the featured travel page in place when one is configured and allows the Wanderlux runtime', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce({
      id: 50,
      slug: 'japan-2026',
      title: 'Japan 2026',
      status: 'PUBLISHED',
      templateType: 'wanderlux-v1',
      destination: 'Japan',
      subBrand: 'travelstall',
      metaTitle: 'Japan 2026',
      metaDescription: 'Visit Japan',
      content: [],
      cssOverrides: '',
      tripId: 50,
    });

    const res = await request(makeApp()).get('/trips');

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expectWanderluxCsp(res);
    expect(res.text).toContain('Japan 2026');
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isFeatured: true,
          status: 'PUBLISHED',
          OR: [
            { subBrand: { in: ['tmc', 'rfu', 'travelstall', 'visasure'] } },
            {
              templateType: {
                in: [
                  'wanderlux-v1',
                  'educational-trip-v1',
                  'religious-tour-v1',
                  'family-trip-v1',
                  'luxury-tour-v1',
                  'travel-premium-v1',
                ],
              },
            },
          ],
        }),
        orderBy: { featuredAt: 'desc' },
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          templateType: true,
          destination: true,
          subBrand: true,
          metaTitle: true,
          metaDescription: true,
          content: true,
          cssOverrides: true,
          tripId: true,
        },
      }),
    );
    expect(renderPageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'japan-2026',
        title: 'Japan 2026',
      }),
    );
  });

  test('falls through to the SPA fallback when no featured page is configured', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/trips');

    expect(res.status).toBe(204);
    expect(renderPageSpy).not.toHaveBeenCalled();
  });
});

describe('GET /trips/:idOrSlug', () => {
  test('renders a numeric page id in place without redirecting to /p and applies the Wanderlux CSP override', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce({
      id: 123,
      slug: 'japan-2026',
      title: 'Japan 2026',
      status: 'PUBLISHED',
      templateType: 'wanderlux-v1',
      destination: 'Japan',
      subBrand: 'travelstall',
      metaTitle: 'Japan 2026',
      metaDescription: 'Visit Japan',
      content: [],
      cssOverrides: '',
      tripId: 777,
    });

    const res = await request(makeApp()).get('/trips/123?utm_source=demo');

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expectWanderluxCsp(res);
    expect(res.text).toContain('Japan 2026');
    expect(prisma.landingPage.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { id: 123, status: 'PUBLISHED' },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        templateType: true,
        destination: true,
        subBrand: true,
        metaTitle: true,
        metaDescription: true,
        content: true,
        cssOverrides: true,
        tripId: true,
      },
    });
    expect(renderPageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 123,
        slug: 'japan-2026',
        title: 'Japan 2026',
      }),
    );
  });

  test('falls back to tripId when a numeric page id does not exist', async () => {
    prisma.landingPage.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 456,
        slug: 'bali-2026',
        title: 'Bali 2026',
        status: 'PUBLISHED',
        templateType: 'travel_destination',
        destination: 'Bali',
        subBrand: 'travelstall',
        metaTitle: 'Bali 2026',
        metaDescription: 'Visit Bali',
        content: [],
        cssOverrides: '',
        tripId: 41,
      });

    const res = await request(makeApp()).get('/trips/41');

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('Bali 2026');
    expect(prisma.landingPage.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.landingPage.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: 41, status: 'PUBLISHED' },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        templateType: true,
        destination: true,
        subBrand: true,
        metaTitle: true,
        metaDescription: true,
        content: true,
        cssOverrides: true,
        tripId: true,
      },
    });
    expect(prisma.landingPage.findFirst).toHaveBeenNthCalledWith(2, {
      where: { tripId: 41, status: 'PUBLISHED' },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        templateType: true,
        destination: true,
        subBrand: true,
        metaTitle: true,
        metaDescription: true,
        content: true,
        cssOverrides: true,
        tripId: true,
      },
    });
    expect(renderPageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 456,
        slug: 'bali-2026',
        title: 'Bali 2026',
      }),
    );
  });

  test('still accepts a legacy slug match for backward compatibility', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce({
      id: 456,
      slug: 'bali-2026',
      title: 'Bali 2026',
      status: 'PUBLISHED',
      templateType: 'travel_destination',
      destination: 'Bali',
      subBrand: 'travelstall',
      metaTitle: 'Bali 2026',
      metaDescription: 'Visit Bali',
      content: [],
      cssOverrides: '',
      tripId: 456,
    });

    const res = await request(makeApp()).get('/trips/bali-2026');

    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('Bali 2026');
    expect(prisma.landingPage.findFirst).toHaveBeenCalledWith({
      where: { slug: 'bali-2026', status: 'PUBLISHED' },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        templateType: true,
        destination: true,
        subBrand: true,
        metaTitle: true,
        metaDescription: true,
        content: true,
        cssOverrides: true,
        tripId: true,
      },
    });
    expect(renderPageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 456,
        slug: 'bali-2026',
        title: 'Bali 2026',
      }),
    );
  });

  test('returns 404 when no published landing page matches', async () => {
    prisma.landingPage.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get('/trips/missing-page');

    expect(res.status).toBe(404);
    expect(res.text).toMatch(/Trip page not found/i);
  });
});
