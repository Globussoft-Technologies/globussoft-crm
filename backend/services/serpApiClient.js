// SerpApi provider for travel SEARCH data (flights + hotels) — the temporary
// real-data source that replaces TBO until the TBO supplier contract lands.
//
// It wraps SerpApi's Google Flights + Google Hotels engines:
//   https://serpapi.com/google-flights-api
//   https://serpapi.com/google-hotels-api
//
// DATA ONLY — like tboClient, this never books anything; it returns options the
// advisor drops into a quote. The agent handles the actual booking offline.
//
// CONTRACT — each search returns an ARRAY of plain objects shaped for
// tboClient's normalizeFlightOption / normalizeHotel (so the route + frontend
// see the identical shape regardless of provider), or `null` when SerpApi can't
// answer (no key, missing required dates, HTTP/parse error). tboClient treats a
// null/empty as "fall through to the next tier" (LLM → stub). NEVER throws.
//
// Google Hotels has NO transfer/ground-transport engine, so transfers are NOT
// handled here — tboClient keeps routing those to the LLM → stub tiers (i.e.
// "let the LLM manage local transportation").
//
// Runtime dependency is the ONE env var: SERP_API_KEY. Drop it in and the same
// code returns live results with zero changes here.

const axios = require("axios");

const SERP_URL = "https://serpapi.com/search.json";
const SERP_KEY = () => process.env.SERP_API_KEY || "";
const TIMEOUT_MS = Number(process.env.SERP_API_TIMEOUT_MS || 15000);

function isConfigured() {
  return Boolean(SERP_KEY());
}

// ── quota-saving cache ───────────────────────────────────────────────
// SerpApi free/dev plans are small (≈250 calls), and the quote builder fires
// several searches per "Suggest" click (outbound + return flights, a hotel per
// city) plus repeats whenever the operator re-runs a panel. An in-memory cache
// keyed on the exact query collapses those duplicates so identical searches
// within the TTL cost ZERO extra calls. Bypassed under test (tests inject a
// mock axios and must stay deterministic across cases).
const CACHE_TTL_MS = Number(process.env.SERP_API_CACHE_TTL_MS || 10 * 60 * 1000);
const _cache = new Map(); // key → { at:number, data:Array }
function _cacheGet(key) {
  if (process.env.NODE_ENV === "test") return undefined;
  const e = _cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) { _cache.delete(key); return undefined; }
  return e.data;
}
function _cacheSet(key, data) {
  if (process.env.NODE_ENV === "test") return;
  // Cache successful arrays only (incl. empty — a confirmed "no results" is
  // worth not re-asking); never cache a null (error/no-key) so it can retry.
  if (Array.isArray(data)) _cache.set(key, { at: Date.now(), data });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── API Analytics logging ───────────────────────────────────────────
// Fire-and-forget ApiCallLog row per SerpApi search — mirrors llmRouter.js's
// LlmCallLog pattern but for a flat-rate (non-token) provider. Must NEVER
// throw or await-block the caller; this module's whole contract is
// "never throws" (callers fall through to the next tier on any hiccup).
function logApiCall({ endpoint, status, durationMs, errorMessage }) {
  if (process.env.NODE_ENV === "test") return; // keep existing test suites deterministic
  try {
    const prisma = require("../lib/prisma");
    const { estimateFlatCost } = require("../lib/apiPricing");
    const cost = estimateFlatCost("serpapi");
    prisma.apiCallLog
      .create({
        data: {
          tenantId: 1,
          provider: "serpapi",
          endpoint,
          status,
          costEstimate: cost || 0,
          durationMs,
          surface: "serpApiClient",
          errorMessage: errorMessage || null,
        },
      })
      .catch((e) => console.error(`[serpApiClient] ApiCallLog persist failed (non-fatal): ${e.message}`));
  } catch (e) {
    console.error(`[serpApiClient] ApiCallLog require failed (non-fatal): ${e.message}`);
  }
}

// ── Google Flights ───────────────────────────────────────────────────
// SerpApi groups results into `best_flights` + `other_flights`; each group has
// a `flights` array of legs (one per hop), `total_duration` (minutes), `price`,
// and `layovers`. We collapse a group to one option: first leg = departure,
// last leg = arrival, stops = layover count.
function mapFlights(data, q) {
  const groups = [
    ...(Array.isArray(data.best_flights) ? data.best_flights : []),
    ...(Array.isArray(data.other_flights) ? data.other_flights : []),
  ];
  return groups
    .map((g) => {
      const legs = Array.isArray(g.flights) ? g.flights : [];
      if (!legs.length) return null;
      const first = legs[0];
      const last = legs[legs.length - 1];
      // SerpApi flight_number is like "6E 2341" / "AI 302" — the leading token
      // is the IATA airline code; the whole string is the human flight number.
      const fnum = first.flight_number ? String(first.flight_number) : null;
      const code = fnum ? fnum.split(/[\s-]/)[0] : null;
      const stops = Array.isArray(g.layovers)
        ? g.layovers.length
        : Math.max(0, legs.length - 1);
      return {
        airline: code,
        airlineName: first.airline || null,
        flightNumber: fnum,
        from: (first.departure_airport && first.departure_airport.id) || q.from,
        to: (last.arrival_airport && last.arrival_airport.id) || q.to,
        departAt: (first.departure_airport && first.departure_airport.time) || null,
        arriveAt: (last.arrival_airport && last.arrival_airport.time) || null,
        durationMinutes: num(g.total_duration),
        stops,
        fare: num(g.price),
        fareClass: first.travel_class || q.cabinClass,
        // SerpApi doesn't reliably expose checked-baggage or seat counts.
        baggage: null,
        seatsAvailable: null,
      };
    })
    .filter((o) => o && o.fare != null);
}

// q is tboClient's normalizeFlightQuery output (from/to already IATA codes).
async function searchFlights(q = {}, ax = axios) {
  if (!isConfigured()) return null;
  // Google Flights requires an outbound date + both endpoints.
  if (!q.from || !q.to || !q.departDate) return null;
  const params = {
    engine: "google_flights",
    departure_id: q.from,
    arrival_id: q.to,
    outbound_date: q.departDate,
    currency: q.currency || "INR",
    adults: q.adults || 1,
    gl: "in",
    hl: "en",
    api_key: SERP_KEY(),
  };
  if (q.children) params.children = q.children;
  if (q.returnDate) {
    params.return_date = q.returnDate; // round trip (type defaults to 1)
  } else {
    params.type = 2; // one-way (else SerpApi demands a return_date)
  }
  const cacheKey = `F|${q.from}|${q.to}|${q.departDate}|${q.returnDate || ""}|${q.adults}|${q.children}|${q.currency}`;
  const hit = _cacheGet(cacheKey);
  if (hit) return hit;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await ax.get(SERP_URL, { params, timeout: TIMEOUT_MS });
  } catch (e) {
    logApiCall({ endpoint: "google_flights", status: "failed", durationMs: Date.now() - startedAt, errorMessage: e.message });
    console.error(`[serpApiClient] flights request failed: ${e.message}`);
    return null;
  }
  const data = resp && resp.data;
  if (!data || data.error) {
    const errMsg = (data && data.error) || "empty response";
    logApiCall({ endpoint: "google_flights", status: "failed", durationMs: Date.now() - startedAt, errorMessage: errMsg });
    if (data && data.error) console.error(`[serpApiClient] flights error: ${data.error}`);
    return null;
  }
  const mapped = mapFlights(data, q);
  _cacheSet(cacheKey, mapped);
  logApiCall({ endpoint: "google_flights", status: "success", durationMs: Date.now() - startedAt });
  return mapped;
}

// ── Google Hotels ────────────────────────────────────────────────────
// SerpApi returns `properties[]`; each has name, rate_per_night/total_rate
// (with `extracted_lowest` numeric forms), overall_rating (review score),
// extracted_hotel_class (stars), thumbnail/images, gps + a booking `link`.
function mapHotels(data, q) {
  const props = Array.isArray(data.properties) ? data.properties : [];
  return props
    .map((p) => {
      const star = num(p.extracted_hotel_class)
        ?? (typeof p.hotel_class === "string" ? num(parseInt(p.hotel_class, 10)) : null);
      const ratePerNight = p.rate_per_night ? num(p.rate_per_night.extracted_lowest) : null;
      const totalRate = p.total_rate ? num(p.total_rate.extracted_lowest) : null;
      const thumb = p.thumbnail
        || (Array.isArray(p.images) && p.images[0] && (p.images[0].thumbnail || p.images[0].original_image))
        || null;
      return {
        name: p.name || null,
        starRating: star,
        address: p.address || null,
        area: p.neighborhood || (p.nearby_places && p.nearby_places[0] && p.nearby_places[0].name) || null,
        ratePerNight,
        // Fall back to per-night × nights if SerpApi only gave a nightly rate.
        totalRate: totalRate ?? (ratePerNight != null ? ratePerNight * (q.nights || 1) : null),
        roomType: null,
        board: null,
        refundable: null,
        thumbnail: thumb,
        // Extra SerpApi fields the operator finds useful (additive — the
        // normalizer passes them through; the offline-booking agent uses the
        // bookingLink, the UI can show the review rating).
        rating: num(p.overall_rating),
        bookingLink: p.link || null,
      };
    })
    .filter((h) => h.totalRate != null || h.ratePerNight != null);
}

// q is tboClient's normalizeHotelQuery output (+ optional `nights`).
async function searchHotels(q = {}, ax = axios) {
  if (!isConfigured()) return null;
  // Google Hotels requires a location query + both dates.
  if (!q.city || !q.checkIn || !q.checkOut) return null;
  const params = {
    engine: "google_hotels",
    q: q.city,
    check_in_date: q.checkIn,
    check_out_date: q.checkOut,
    adults: q.adults || 2,
    currency: q.currency || "INR",
    gl: "in",
    hl: "en",
    api_key: SERP_KEY(),
  };
  const cacheKey = `H|${q.city}|${q.checkIn}|${q.checkOut}|${q.adults}|${q.currency}`;
  const hit = _cacheGet(cacheKey);
  if (hit) return hit;
  const startedAt = Date.now();
  let resp;
  try {
    resp = await ax.get(SERP_URL, { params, timeout: TIMEOUT_MS });
  } catch (e) {
    logApiCall({ endpoint: "google_hotels", status: "failed", durationMs: Date.now() - startedAt, errorMessage: e.message });
    console.error(`[serpApiClient] hotels request failed: ${e.message}`);
    return null;
  }
  const data = resp && resp.data;
  if (!data || data.error) {
    const errMsg = (data && data.error) || "empty response";
    logApiCall({ endpoint: "google_hotels", status: "failed", durationMs: Date.now() - startedAt, errorMessage: errMsg });
    if (data && data.error) console.error(`[serpApiClient] hotels error: ${data.error}`);
    return null;
  }
  const mapped = mapHotels(data, q);
  _cacheSet(cacheKey, mapped);
  logApiCall({ endpoint: "google_hotels", status: "success", durationMs: Date.now() - startedAt });
  return mapped;
}

module.exports = {
  isConfigured,
  searchFlights,
  searchHotels,
  // internals exported for the CJS self-mock seam (vi.spyOn in tests)
  mapFlights,
  mapHotels,
};
