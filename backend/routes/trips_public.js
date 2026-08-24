'use strict';

/**
 * Public travel-trip share links.
 *
 * GET "/" renders the currently featured travel landing page in place.
 *
 * Canonical published share links use /trips/:id and render the
 * published landing page in place without bouncing through /p/:slug.
 * We still fall back to tripId and slug matches so legacy links keep
 * working while the UI migrates to the numeric path.
 */

const express = require('express');
const prisma = require('../lib/prisma');
const { renderPage } = require('../services/landingPageRenderer');

const router = express.Router();

const VALID_TRAVEL_SUB_BRANDS = ['tmc', 'rfu', 'travelstall', 'visasure'];
const TRAVEL_TEMPLATE_TYPES = [
  'wanderlux-v1',
  'educational-trip-v1',
  'religious-tour-v1',
  'family-trip-v1',
  'luxury-tour-v1',
  'travel-premium-v1',
];

const PUBLIC_TRIP_PAGE_SELECT = {
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
};

const WANDERLUX_PUBLIC_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https://image.pollinations.ai https://unpkg.com",
  "frame-src 'self' https://*.wistia.net https://*.wistia.com https://fast.wistia.net https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com",
  "frame-ancestors 'self' https://themodernclassroom.in https://www.themodernclassroom.in http://localhost:8000 http://127.0.0.1:8000",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function travelFeaturedWhere() {
  return {
    isFeatured: true,
    status: 'PUBLISHED',
    OR: [
      { subBrand: { in: VALID_TRAVEL_SUB_BRANDS } },
      { templateType: { in: TRAVEL_TEMPLATE_TYPES } },
    ],
  };
}

async function resolveFeaturedLandingPage() {
  return prisma.landingPage.findFirst({
    where: travelFeaturedWhere(),
    orderBy: { featuredAt: 'desc' },
    select: PUBLIC_TRIP_PAGE_SELECT,
  });
}

async function resolvePublishedLandingPage(idOrSlug) {
  const raw = String(idOrSlug || '').trim();
  if (!raw) return null;

  const numericId = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  if (numericId) {
    const byId = await prisma.landingPage.findFirst({
      where: { id: numericId, status: 'PUBLISHED' },
      select: PUBLIC_TRIP_PAGE_SELECT,
    });
    if (byId) return byId;

    const byTrip = await prisma.landingPage.findFirst({
      where: { tripId: numericId, status: 'PUBLISHED' },
      select: PUBLIC_TRIP_PAGE_SELECT,
    });
    if (byTrip) return byTrip;
  }

  return prisma.landingPage.findFirst({
    where: { slug: raw, status: 'PUBLISHED' },
    select: PUBLIC_TRIP_PAGE_SELECT,
  });
}

function sendRenderedTripPage(res, page) {
  const html = renderPage(page);

  res.set('Content-Type', 'text/html; charset=utf-8');

  if (page && page.templateType === 'wanderlux-v1') {
    res.set('Content-Security-Policy', WANDERLUX_PUBLIC_CSP);
    res.removeHeader('Content-Security-Policy-Report-Only');
  }

  return res.send(html);
}

router.get('/', async (_req, res, next) => {
  try {
    const page = await resolveFeaturedLandingPage();
    if (!page) {
      return next();
    }

    return sendRenderedTripPage(res, page);
  } catch (err) {
    console.error('[TripsPublic] featured resolve error:', err);
    return res.status(500).send('<h1>Failed to load featured trip page</h1>');
  }
});

router.get('/:idOrSlug', async (req, res) => {
  try {
    const page = await resolvePublishedLandingPage(req.params.idOrSlug);
    if (!page) {
      return res.status(404).send('<h1>Trip page not found</h1>');
    }

    return sendRenderedTripPage(res, page);
  } catch (err) {
    console.error('[TripsPublic] resolve error:', err);
    return res.status(500).send('<h1>Failed to load trip page</h1>');
  }
});

module.exports = { router };
