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

router.get("/public", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res.json({ query: "", photos: [], source: "none" });
  }
  let results = [];
  try {
    results = await fetchMany(q, { limit: req.query.limit });
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
