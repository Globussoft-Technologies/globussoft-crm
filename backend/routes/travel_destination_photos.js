// Public destination-photo proxy for the customer-facing travel pages
// (quote-accept landing, itinerary share, trip microsite).
//
// GET /api/travel/destination-photos/public?q=<destination>&limit=<n>
//
// Delegates to the shared services/destinationImageProvider cascade
// (Pexels → Unsplash → Pixabay, stock-only — AI generation excluded for
// customer-facing rails) so this endpoint reuses the SAME provider keys,
// 7-day cache, and normalization the landing-page engine already uses —
// rather than maintaining a second, drifting Pexels client. The key stays
// server-side; the shared cache absorbs provider rate limits across all
// visitors, which is what removes the "images vanish again and again"
// flicker the old keyless client-side Wikipedia path had.
//
// Returns an empty `photos` array (200, not an error) when no provider key is
// configured or all providers miss — the frontend then falls back to its
// keyless Wikipedia path, so the page is never blocked on this endpoint.
//
// Public (no auth): consumers are anonymous customers viewing a shared
// quote/itinerary link. Exposed via the `/travel/destination-photos/public`
// entry in server.js openPaths. Reads no tenant data and leaks no secret —
// it only echoes back public stock-photo URLs for a free-text query.

const express = require("express");
const router = express.Router();
const { fetchMany } = require("../services/destinationImageProvider");

// Countries / broad regions whose raw name tends to surface wildlife or
// generic landscape photos on Pexels rather than iconic city landmarks.
// Each maps to a curated Pexels query that anchors the search to a
// recognisable landmark so the hero image actually symbolises the place.
const LANDMARK_QUERIES = {
  australia: "Sydney Opera House Australia scenic",
  "new zealand": "New Zealand Milford Sound scenic",
  canada: "Canada Banff scenic landscape",
  "south africa": "South Africa Cape Town scenic",
  kenya: "Kenya Nairobi Masai Mara scenic",
  egypt: "Egypt pyramids Giza scenic",
  brazil: "Brazil Rio de Janeiro scenic",
  argentina: "Argentina Buenos Aires scenic",
  mexico: "Mexico City historic landmark scenic",
  peru: "Peru Machu Picchu scenic",
  greece: "Greece Santorini scenic landmark",
  italy: "Italy Colosseum Rome scenic",
  germany: "Germany landmark scenic cityscape",
  spain: "Spain Barcelona Sagrada Familia scenic",
  france: "France Paris Eiffel Tower scenic",
  switzerland: "Switzerland Alps scenic landscape",
  austria: "Austria Vienna scenic landmark",
  netherlands: "Netherlands Amsterdam canal scenic",
  portugal: "Portugal Lisbon scenic cityscape",
  russia: "Russia Moscow Red Square scenic",
  china: "China Great Wall Beijing scenic",
  japan: "Japan Tokyo Mount Fuji scenic",
  "south korea": "South Korea Seoul city scenic",
  vietnam: "Vietnam Ha Long Bay scenic",
  cambodia: "Cambodia Angkor Wat scenic",
  nepal: "Nepal Himalayas scenic landscape",
  "sri lanka": "Sri Lanka scenic landscape",
  usa: "USA city iconic landmark scenic",
  "united states": "United States city landmark scenic",
  uk: "United Kingdom London Bridge scenic",
  "united kingdom": "London Big Ben scenic cityscape",
};

/**
 * Enrich a raw destination query for Pexels so it returns iconic travel
 * photography rather than wildlife or generic nature shots. For broad
 * country names uses a curated landmark query; for everything else
 * appends "scenic travel" to bias toward well-composed travel shots.
 */
function enrichDestinationQuery(destination) {
  const norm = destination.toLowerCase().trim();
  for (const [key, curated] of Object.entries(LANDMARK_QUERIES)) {
    if (norm === key || norm.startsWith(key + " ") || norm.endsWith(" " + key) || norm.includes(" " + key + " ")) {
      return curated;
    }
  }
  return destination + " scenic travel";
}

router.get("/public", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.json({ query: "", photos: [], source: "none" });
  }
  const enrichedQuery = enrichDestinationQuery(q);
  let results = [];
  try {
    results = await fetchMany(enrichedQuery, { limit: req.query.limit });
  } catch (_e) {
    results = [];
  }
  const photos = results.map((r) => ({
    url: r.url,
    thumb: r.thumbUrl || r.url,
    caption: q,
    description:
      r.attribution && r.attribution.photographer
        ? `Photo by ${r.attribution.photographer}`
        : null,
  }));
  return res.json({
    query: q,
    photos,
    source: photos.length ? "stock" : "none",
  });
});

module.exports = router;
