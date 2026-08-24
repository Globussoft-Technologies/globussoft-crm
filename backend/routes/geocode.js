/**
 * /api/geocode — vertical-neutral place search + reverse geocoding.
 *
 * Why this exists separately from /api/travel/pois/geocode:
 *   The travel router already exposed a geocode proxy, but it lives under
 *   /api/travel/* — a namespace a wellness or generic tenant has no business
 *   calling, and one that would silently break the moment someone bolts
 *   `requireTravelTenant` onto that router. This mount is the shared surface;
 *   both routes now delegate to lib/geocodeProxy.js so there is exactly one
 *   upstream + one parser to maintain.
 *
 * Auth: verifyToken only (any signed-in staff user). No RBAC gate — this
 * reads a public OSM-derived dataset and writes nothing.
 *
 * Endpoints:
 *   GET /api/geocode?q=<text>&limit=<1..10>&bbox=<minLon,minLat,maxLon,maxLat>
 *       → 200 { results: [{ lat, lng, display_name, name, street, city,
 *                           district, county, state, country, postcode }] }
 *       `bbox` is optional and is a HARD filter upstream — a malformed one is
 *       ignored (worldwide search) rather than rejected, since it is only ever
 *       a relevance hint layered on top of the user's actual query.
 *   GET /api/geocode?reverse=1&lat=<n>&lng=<n>
 *       → 200 { lat, lng, display_name, results: [...] }
 *
 * Errors: 400 MISSING_FIELDS, 502 GEOCODE_UPSTREAM_ERROR.
 */

const express = require("express");
const router = express.Router();

const { verifyToken } = require("../middleware/auth");
const { forwardGeocode, reverseGeocode } = require("../lib/geocodeProxy");

router.get("/", verifyToken, async (req, res) => {
  if (req.query.reverse === "1") {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res
        .status(400)
        .json({ error: "lat and lng required for reverse geocode", code: "MISSING_FIELDS" });
    }
    try {
      return res.json(await reverseGeocode(lat, lng));
    } catch (e) {
      console.error("[geocode] reverse error:", e.message);
      return res
        .status(502)
        .json({ error: "Geocoding service unavailable", code: "GEOCODE_UPSTREAM_ERROR" });
    }
  }

  const q = (req.query.q || "").trim();
  if (!q) {
    return res.status(400).json({ error: "q required", code: "MISSING_FIELDS" });
  }

  try {
    const results = await forwardGeocode(q, req.query.limit, { bbox: req.query.bbox });
    return res.json({ results });
  } catch (e) {
    console.error("[geocode] forward error:", e.message);
    return res
      .status(502)
      .json({ error: "Geocoding service unavailable", code: "GEOCODE_UPSTREAM_ERROR" });
  }
});

module.exports = router;
