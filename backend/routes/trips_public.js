'use strict';

/**
 * Public travel-trip share links.
 *
 * This router intentionally does NOT define GET "/" so the bare /trips
 * path can keep falling through to the SPA shell. The frontend's
 * TripsResolver owns that entry point and decides whether to write the
 * featured page HTML or show the fallback TripsLanding screen.
 *
 * Direct share links use /trips/:id-or-slug and are canonicalised onto
 * the existing /p/:slug public landing-page route.
 */

const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

async function resolvePublishedLandingPage(idOrSlug) {
  const raw = String(idOrSlug || '').trim();
  if (!raw) return null;

  const numericTripId = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  if (numericTripId) {
    const byTrip = await prisma.landingPage.findFirst({
      where: { tripId: numericTripId, status: 'PUBLISHED' },
      select: { slug: true },
    });
    if (byTrip) return byTrip;
  }

  return prisma.landingPage.findFirst({
    where: { slug: raw, status: 'PUBLISHED' },
    select: { slug: true },
  });
}

router.get('/:idOrSlug', async (req, res) => {
  try {
    const page = await resolvePublishedLandingPage(req.params.idOrSlug);
    if (!page) {
      return res.status(404).send('<h1>Trip page not found</h1>');
    }

    const queryIndex = req.url.indexOf('?');
    const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
    return res.redirect(302, `/p/${encodeURIComponent(page.slug)}${query}`);
  } catch (err) {
    console.error('[TripsPublic] resolve error:', err);
    return res.status(500).send('<h1>Failed to load trip page</h1>');
  }
});

module.exports = { router };
