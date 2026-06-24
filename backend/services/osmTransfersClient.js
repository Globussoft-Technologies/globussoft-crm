// OSM-based ground-TRANSFER provider — the real-data source for local /
// inter-city road transfers, worldwide and key-free.
//
// WHY (replaces TripGo) — TripGo/SkedGo routing does NOT cover India or Saudi
// Arabia (verified: "Origin lies outside covered area" for Ranchi, Bangalore,
// Makkah→Madina), and its geocoder can't even resolve "Ranchi". Both are core
// markets here (India school tours + Umrah), so TripGo is unusable. OpenStreetMap
// covers the whole world:
//   - Nominatim   → geocode a place NAME → lat/lng   (no key)
//   - OSRM        → real DRIVING distance + duration  (no key)
// We then price vehicle classes at a per-km rate, so the fare is in the quote's
// currency (no foreign-currency mismatch) and is a transparent, editable estimate.
//
// DATA ONLY — never books. Returns an ARRAY of normalizeTransfer-input objects
// (one per vehicle class) or null (disabled / un-geocodable / no route / error)
// so tboClient falls through to the LLM → stub tiers. NEVER throws.
//
// PRODUCTION NOTE — the public Nominatim/OSRM demo servers are fine for operator-
// driven, cached, low-volume lookups but have fair-use limits (Nominatim ≤1 req/s
// + User-Agent required). Point OSM_NOMINATIM_URL / OSM_OSRM_URL at a self-hosted
// or paid endpoint for scale. Results are cached (below) to minimise calls.

const axios = require("axios");

const NOMINATIM = () => process.env.OSM_NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const OSRM = () => process.env.OSM_OSRM_URL || "https://router.project-osrm.org";
const UA = () => process.env.OSM_USER_AGENT || "GlobussoftTravelCRM/1.0 (travel quote builder)";
const TIMEOUT_MS = Number(process.env.OSM_TIMEOUT_MS || 15000);

// Per-km vehicle rate cards by quote currency. The fare is base + perKm × km —
// a clearly-flagged ESTIMATE the operator confirms with the supplier. Defaults
// are typical Indian private-transfer rates (INR). Override the whole table via
// OSM_RATE_CARD_JSON ({"INR":[{vehicle,base,perKm,cap},...]}) if needed.
const DEFAULT_RATE_CARDS = {
  INR: [
    { vehicle: "Private Sedan", base: 800, perKm: 13, cap: 4 },
    { vehicle: "Private SUV", base: 1200, perKm: 19, cap: 6 },
    { vehicle: "Tempo Traveller", base: 1800, perKm: 26, cap: 12 },
  ],
};
function rateCards() {
  if (process.env.OSM_RATE_CARD_JSON) {
    try { return JSON.parse(process.env.OSM_RATE_CARD_JSON); } catch { /* fall back */ }
  }
  return DEFAULT_RATE_CARDS;
}

function isConfigured() {
  // Key-free; on unless explicitly disabled.
  return !/^(1|true|yes)$/i.test(process.env.OSM_TRANSFERS_DISABLED || "");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── quota / fair-use cache (bypassed under test) ─────────────────────
const CACHE_TTL_MS = Number(process.env.OSM_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const _geoCache = new Map(); // name → {at, val}
const _routeCache = new Map(); // key → {at, val}
function _cacheGet(map, key) {
  if (process.env.NODE_ENV === "test") return undefined;
  const e = map.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) { map.delete(key); return undefined; }
  return e.val;
}
function _cacheSet(map, key, val) {
  if (process.env.NODE_ENV === "test") return;
  map.set(key, { at: Date.now(), val });
}

// Resolve a place name → { lat, lng, name } via Nominatim. null on miss.
async function geocode(text, ax = axios) {
  if (!text || !String(text).trim()) return null;
  const q = String(text).trim();
  const cached = _cacheGet(_geoCache, q.toLowerCase());
  if (cached !== undefined) return cached;
  const resp = await ax.get(`${NOMINATIM()}/search`, {
    params: { q, format: "json", limit: 1 },
    headers: { "User-Agent": UA(), Accept: "application/json" },
    timeout: TIMEOUT_MS,
  });
  const arr = Array.isArray(resp && resp.data) ? resp.data : [];
  const hit = arr.length ? { lat: num(arr[0].lat), lng: num(arr[0].lon), name: arr[0].display_name || q } : null;
  const val = hit && hit.lat != null && hit.lng != null ? hit : null;
  _cacheSet(_geoCache, q.toLowerCase(), val);
  return val;
}

// Real driving distance (km) + duration (min) between two coords via OSRM.
async function drivingRoute(from, to, ax = axios) {
  const key = `${from.lat},${from.lng};${to.lat},${to.lng}`;
  const cached = _cacheGet(_routeCache, key);
  if (cached !== undefined) return cached;
  // OSRM expects lng,lat order.
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const resp = await ax.get(`${OSRM()}/route/v1/driving/${path}`, {
    params: { overview: "false" },
    headers: { "User-Agent": UA() },
    timeout: TIMEOUT_MS,
  });
  const data = resp && resp.data;
  const route = data && Array.isArray(data.routes) && data.routes[0];
  const val = route
    ? { km: Math.round((route.distance / 1000) * 10) / 10, minutes: Math.round(route.duration / 60) }
    : null;
  _cacheSet(_routeCache, key, val);
  return val;
}

// Build the per-vehicle transfer options from a resolved route. Returns
// normalizeTransfer-input objects (currency-correct: priced in q.currency).
function buildOptions(route, q) {
  const cards = rateCards();
  const cur = (q.currency || "INR").toUpperCase();
  const card = cards[cur];
  if (!card || !Array.isArray(card) || !card.length) return []; // no rate card for this currency → fall to LLM
  const km = route.km;
  const hrs = route.minutes != null ? Math.round((route.minutes / 60) * 10) / 10 : null;
  return card.map((v) => {
    const base = num(v.base) || 0;
    const perKm = num(v.perKm) || 0;
    const price = Math.round(base + perKm * km);
    const capNote = v.cap ? `up to ${v.cap} pax` : null;
    const note = [
      `~${km} km`,
      hrs != null ? `~${hrs}h drive` : null,
      capNote,
      `est. @ ${cur} ${perKm}/km — confirm with supplier`,
    ].filter(Boolean).join(" · ");
    return {
      mode: "road",
      vehicle: v.vehicle,
      from: q.from,
      to: q.to,
      durationMinutes: route.minutes,
      price,
      pax: q.pax,
      note,
    };
  });
}

// q is tboClient's normalizeTransferQuery output ({ from, to, date, pax, currency }).
async function searchTransfers(q = {}, ax = axios) {
  if (!isConfigured()) {
    console.log("[osmTransfers] disabled via OSM_TRANSFERS_DISABLED — skipping");
    return null;
  }
  if (!q.from || !q.to) return null;
  console.log(`[osmTransfers] geocoding "${q.from}" → "${q.to}"`);
  const [from, to] = await Promise.all([
    module.exports.geocode(q.from, ax),
    module.exports.geocode(q.to, ax),
  ]);
  if (!from || !to) {
    console.log(`[osmTransfers] could not geocode ${!from ? `origin "${q.from}"` : `destination "${q.to}"`} — falling through to LLM`);
    return null;
  }
  const route = await module.exports.drivingRoute(from, to, ax);
  if (!route) {
    console.log(`[osmTransfers] no driving route ${q.from}→${q.to} — falling through to LLM`);
    return null;
  }
  const options = buildOptions(route, q);
  console.log(`[osmTransfers] ${q.from}→${q.to}: ${route.km} km / ${route.minutes} min → ${options.length} priced option(s) (${(q.currency || "INR").toUpperCase()})`);
  return options;
}

module.exports = {
  isConfigured,
  geocode,
  drivingRoute,
  searchTransfers,
  // internals exported for the CJS self-mock seam (vi.spyOn in tests)
  buildOptions,
};
