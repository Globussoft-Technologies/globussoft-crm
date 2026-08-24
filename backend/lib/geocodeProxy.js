// lib/geocodeProxy.js — shared forward/reverse geocoding via Photon.
//
// Extracted from routes/travel_pois.js so non-travel verticals (wellness
// clinic geofencing, and anything else that needs "type a place name, get
// coordinates") can reuse the exact same upstream + parsing without
// importing a travel route or hard-coding a /api/travel/... URL.
//
// Why Photon (photon.komoot.io) and not Nominatim / Google:
//   - Same OpenStreetMap data as Nominatim, but NO API key, no billing
//     account, and far more lenient rate limits. Nominatim was banning the
//     server IP on every itinerary page load because the auto-geocode
//     effect fires one request per item.
//   - Google Places autocomplete would need a Maps JS + Places API key and
//     an active billing account, and its results may not legally be stored
//     outside a Google map. Photon results are ODbL — we can persist the
//     lat/lng on our own Location rows.
//
// Why this must run server-side at all:
//   Photon's responses carry no CORS headers, so the browser cannot fetch
//   it cross-origin. Node has no such restriction (and can set a real
//   User-Agent, which browsers forbid as a header name).
//
// Photon response shape (GeoJSON):
//   { features: [{ geometry: { coordinates: [lng, lat] }, properties: {...} }] }
// NOTE: GeoJSON coordinates are [longitude, latitude] — NOT [lat, lng].

const https = require("https");

const PHOTON_BASE = "https://photon.komoot.io";
const USER_AGENT = "GlobussoftCRM/1.0 (https://crm.globusdemos.com)";
// Photon can be slow or hang; without a timeout a stuck socket would pin an
// Express handler open until the client gives up.
const REQUEST_TIMEOUT_MS = 8000;

function geocoderFetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
      (resp) => {
        let raw = "";
        resp.on("data", (chunk) => { raw += chunk; });
        resp.on("end", () => {
          if (resp.statusCode !== 200) {
            return reject(
              Object.assign(new Error(`Geocoder HTTP ${resp.statusCode}`), { status: 502 }),
            );
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("Geocoder timeout"), { status: 504 }));
    });
  });
}

// Builds the human-readable label shown in the picker's suggestion list.
//
// Photon's `properties` are sparse and inconsistent by feature type: a POI
// has { name, street, city, state, country }, a street has no `name` but a
// `street` + `housenumber`, a city has only { name, state, country }. Join
// whatever IS present, de-duplicated in place order, so "Nexus Mall,
// Koramangala, Bengaluru, Karnataka, India" reads naturally and a city
// result doesn't come back as "Ranchi, Ranchi, Jharkhand".
function buildDisplayName(props, fallbackQuery) {
  const p = props || {};
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  // locality -> district -> city -> county walks OSM's admin hierarchy from
  // smallest to largest. Photon populates a different subset per feature, so
  // listing all of them and de-duplicating below is what produces a readable
  // line for a mall, a street, and a city alike.
  const parts = [p.name, street, p.locality, p.district, p.city, p.county, p.state, p.country];
  const seen = new Set();
  const label = parts
    .filter(Boolean)
    .map(String)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
  return label || fallbackQuery;
}

/**
 * Normalize a Photon GeoJSON payload into our flat result shape.
 * Drops any feature whose coordinates aren't a finite lat/lng pair.
 *
 * @returns {Array<{lat:number, lng:number, display_name:string, name:string, city:string, state:string, country:string, postcode:string}>}
 */
function parsePhotonResults(data, fallbackQuery) {
  return (data?.features || [])
    .map((f) => {
      const [lng, lat] = f.geometry?.coordinates || [];
      const p = f.properties || {};
      return {
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        display_name: buildDisplayName(p, fallbackQuery),
        // Echoed so a caller can auto-fill sibling address fields (the
        // wellness clinic form pre-fills city/state/pincode from the picked
        // suggestion instead of making the admin retype them).
        name: p.name || "",
        street: [p.housenumber, p.street].filter(Boolean).join(" "),
        // `city` is absent on plenty of Indian OSM features (a mall may only
        // carry `district` + `county`). Fall back down the hierarchy rather
        // than handing the caller an empty city box: county ("Bangalore
        // South") is a closer answer than nothing, and the operator can edit
        // it in the form.
        city: p.city || p.county || p.district || p.locality || "",
        district: p.district || p.locality || "",
        county: p.county || "",
        state: p.state || "",
        country: p.country || "",
        postcode: p.postcode || "",
      };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

/**
 * Validate a caller-supplied bbox string.
 *
 * Format is Photon's own: "minLon,minLat,maxLon,maxLat". Returns the
 * normalized string, or null when it is absent/malformed — a bad bbox
 * degrades to a worldwide search rather than 400-ing, because the bbox is
 * always a relevance hint, never the user's actual request.
 */
function normalizeBbox(bbox) {
  if (!bbox) return null;
  const parts = String(bbox).split(",").map((n) => parseFloat(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) return null;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  return parts.join(",");
}

/**
 * Forward-geocode free text to a ranked list of candidate places.
 *
 * @param {string} query
 * @param {number} [limit=5] — clamped to 1..10
 * @param {object} [opts]
 * @param {string} [opts.bbox] — "minLon,minLat,maxLon,maxLat". Photon treats
 *        this as a HARD filter, not a soft bias (its lat/lon bias parameters
 *        barely reorder results — a search for an Indian clinic without a
 *        bbox happily returns a same-named salon in Canada first). Callers
 *        that pass one should be prepared to retry without it when the box
 *        yields nothing.
 * @returns {Promise<Array>} parsed results (possibly empty)
 */
async function forwardGeocode(query, limit = 5, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10);
  const bbox = normalizeBbox(opts.bbox);
  const url =
    `${PHOTON_BASE}/api/?q=${encodeURIComponent(q)}&limit=${safeLimit}` +
    (bbox ? `&bbox=${bbox}` : "");
  const data = await geocoderFetch(url);
  return parsePhotonResults(data, q);
}

/**
 * Reverse-geocode a coordinate pair to the nearest named place.
 *
 * @returns {Promise<{lat:number, lng:number, display_name:string|null}>}
 */
async function reverseGeocode(lat, lng) {
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw Object.assign(new Error("lat and lng required for reverse geocode"), { status: 400 });
  }
  const url = `${PHOTON_BASE}/reverse?lat=${latNum}&lon=${lngNum}`;
  const data = await geocoderFetch(url);
  const results = parsePhotonResults(data, `${latNum},${lngNum}`);
  return { lat: latNum, lng: lngNum, display_name: results[0]?.display_name || null, results };
}

module.exports = {
  PHOTON_BASE,
  geocoderFetch,
  parsePhotonResults,
  buildDisplayName,
  normalizeBbox,
  forwardGeocode,
  reverseGeocode,
};
