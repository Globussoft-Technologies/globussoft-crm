// TripGo (SkedGo) provider for ground-TRANSFER search — the real-data source
// for local/inter-city transportation (taxi, car, public transit, coach) that
// replaces the LLM estimate for transfers when TRIPGO_API_KEY is set.
//
//   https://developer.tripgo.com/  (api.tripgo.com/v1)
//
// DATA ONLY — like tboClient/serpApiClient this never books; it returns route
// options the advisor drops into a quote as a transfer line. The agent books
// offline.
//
// FLOW — TripGo routes between COORDINATES, and the quote builder passes free-
// text place names ("Makkah", "Jeddah Airport"), so we:
//   1. geocode the from + to names → lat/lng (geocode.json)
//   2. routing.json between the two points across taxi/car/transit modes
//   3. map each returned trip → tboClient's normalizeTransfer input shape
// Returns an ARRAY (price-bearing trips) or null (no key / un-geocodable /
// error) so tboClient falls through to the LLM → stub tiers. NEVER throws.
//
// CURRENCY — TripGo fares come in the route's LOCAL currency (SAR, AED, …), NOT
// necessarily the quote currency. We keep the numeric fare but ALWAYS stamp the
// native currency into the `note` ("≈ SAR 320 via TripGo — confirm/convert") so
// the operator is never shown a mislabeled figure. They confirm transfer fares
// before quoting anyway.

const axios = require("axios");

const BASE = "https://api.tripgo.com/v1";
const KEY = () => process.env.TRIPGO_API_KEY || "";
const TIMEOUT_MS = Number(process.env.TRIPGO_TIMEOUT_MS || 15000);

// Point-to-point transport modes worth offering for a transfer: public
// transport, taxi, and self-drive/car. (Walking/cycling are excluded — a
// transfer line is a paid hop.)
const MODES = ["pt_pub", "ps_tax", "me_car"];

function isConfigured() {
  return Boolean(KEY());
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── API Analytics logging ───────────────────────────────────────────
// Fire-and-forget ApiCallLog row per TripGo request — mirrors
// serpApiClient.js's logApiCall. Must NEVER throw or block the caller;
// this module's contract is "never throws" (callers fall through to the
// LLM/stub tier on any hiccup).
function logApiCall({ endpoint, status, durationMs, errorMessage }) {
  if (process.env.NODE_ENV === "test") return;
  try {
    const prisma = require("../lib/prisma");
    const { estimateFlatCost } = require("../lib/apiPricing");
    const cost = estimateFlatCost("tripgo"); // null — no public flat rate; tracked as request count only
    prisma.apiCallLog
      .create({
        data: {
          tenantId: 1,
          provider: "tripgo",
          endpoint,
          status,
          costEstimate: cost || 0,
          durationMs,
          surface: "tripGoClient",
          errorMessage: errorMessage || null,
        },
      })
      .catch((e) => console.error(`[tripGoClient] ApiCallLog persist failed (non-fatal): ${e.message}`));
  } catch (e) {
    console.error(`[tripGoClient] ApiCallLog require failed (non-fatal): ${e.message}`);
  }
}

function headers() {
  return { "X-TripGo-Key": KEY(), Accept: "application/json" };
}

// Resolve a free-text place name → { lat, lng, name } (first/best choice) or
// null. Best-effort; never throws.
async function geocode(text, ax = axios) {
  if (!text || !String(text).trim()) return null;
  const resp = await ax.get(`${BASE}/geocode.json`, {
    params: { q: String(text).trim(), allowGoogle: "true" },
    headers: headers(),
    timeout: TIMEOUT_MS,
  });
  const choices = resp && resp.data && Array.isArray(resp.data.choices) ? resp.data.choices : [];
  if (!choices.length) {
    console.log(`[tripGoClient] geocode "${text}" → no match`);
    return null;
  }
  // choices are score-ranked; take the top with usable coords.
  for (const c of choices) {
    const lat = num(c.lat);
    const lng = num(c.lng);
    if (lat != null && lng != null) {
      const hit = { lat, lng, name: c.name || c.address || String(text) };
      console.log(`[tripGoClient] geocode "${text}" → ${hit.lat},${hit.lng} (${hit.name})`);
      return hit;
    }
  }
  console.log(`[tripGoClient] geocode "${text}" → choices had no coords`);
  return null;
}

// Pick the dominant transport segment of a trip (longest non-walking leg) and
// derive a human vehicle label + our coarse mode (road | rail).
function describeTrip(trip, templatesByHash) {
  const segs = Array.isArray(trip.segments) ? trip.segments : [];
  let best = null;
  let bestDur = -1;
  for (const s of segs) {
    const tpl = templatesByHash[s.segmentTemplateHashCode];
    if (!tpl) continue;
    const modeId = String(tpl.modeIdentifier || "");
    if (modeId.startsWith("wa_")) continue; // skip walking
    const dur = (num(s.endTime) || 0) - (num(s.startTime) || 0);
    if (dur > bestDur) { bestDur = dur; best = tpl; }
  }
  if (!best) return { vehicle: "Transfer", mode: "road" };
  const modeId = String(best.modeIdentifier || "");
  const alt = best.modeInfo && (best.modeInfo.alt || best.modeInfo.description);
  let vehicle = alt || "Transfer";
  let mode = "road";
  if (modeId.startsWith("ps_tax")) vehicle = alt || "Taxi";
  else if (modeId.startsWith("me_car")) vehicle = alt || "Car (self-drive)";
  else if (modeId.startsWith("pt_pub")) {
    vehicle = alt || "Public transport";
    // Rail-ish transit → mode "rail"; bus/other → "road".
    if (/train|rail|metro|subway|tram/i.test(`${alt || ""} ${modeId}`)) mode = "rail";
  }
  return { vehicle, mode };
}

// Map a TripGo routing response → normalizeTransfer input objects. q carries the
// human from/to labels + pax. Trips without a usable fare are dropped (so the
// caller can fall through to the LLM tier for a currency-correct estimate).
function mapTrips(data, q) {
  if (!data) return [];
  const templates = Array.isArray(data.segmentTemplates) ? data.segmentTemplates : [];
  const byHash = {};
  for (const t of templates) byHash[t.hashCode] = t;
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const out = [];
  for (const g of groups) {
    const trips = Array.isArray(g.trips) ? g.trips : [];
    // One representative trip per group (TripGo's first is the recommended one).
    const trip = trips[0];
    if (!trip) continue;
    const price = num(trip.moneyCost);
    if (price == null) continue; // no fare → let the LLM tier price it
    const cur = trip.currencyCode || trip.currencySymbol || null;
    const depart = num(trip.depart);
    const arrive = num(trip.arrive);
    const durationMinutes = depart != null && arrive != null ? Math.max(1, Math.round((arrive - depart) / 60)) : null;
    const { vehicle, mode } = describeTrip(trip, byHash);
    const curNote = cur ? `≈ ${cur} ${price} via TripGo — confirm/convert before quoting` : "Fare via TripGo — confirm before quoting";
    out.push({
      mode,
      vehicle,
      from: q.from,
      to: q.to,
      durationMinutes,
      price,
      pax: q.pax,
      note: curNote,
    });
  }
  return out;
}

// q is tboClient's normalizeTransferQuery output ({ from, to, date, pax, currency }).
async function searchTransfers(q = {}, ax = axios) {
  if (!isConfigured()) {
    console.log("[tripGoClient] searchTransfers: TRIPGO_API_KEY not set — skipping");
    return null;
  }
  if (!q.from || !q.to) return null;
  const startedAt = Date.now();
  console.log(`[tripGoClient] searchTransfers: geocoding "${q.from}" → "${q.to}"`);
  const [from, to] = await Promise.all([
    module.exports.geocode(q.from, ax),
    module.exports.geocode(q.to, ax),
  ]);
  if (!from || !to) {
    console.log(`[tripGoClient] searchTransfers: could not geocode ${!from ? `origin "${q.from}"` : `destination "${q.to}"`} — falling through to LLM`);
    logApiCall({ endpoint: "searchTransfers", status: "failed", durationMs: Date.now() - startedAt, errorMessage: "geocode failed for origin or destination" });
    return null; // couldn't resolve one endpoint → fall through
  }
  const params = {
    from: `(${from.lat},${from.lng})`,
    to: `(${to.lat},${to.lng})`,
    v: 11,
    bestReturnedTripOnly: "false",
    modes: MODES,
  };
  let resp;
  try {
    resp = await ax.get(`${BASE}/routing.json`, {
      params,
      headers: headers(),
      timeout: TIMEOUT_MS,
      // axios serializes array params as modes=a&modes=b (repeat key) — TripGo's
      // expected form.
      paramsSerializer: (p) => {
        const parts = [];
        for (const [k, val] of Object.entries(p)) {
          if (Array.isArray(val)) val.forEach((v) => parts.push(`${k}=${encodeURIComponent(v)}`));
          else parts.push(`${k}=${encodeURIComponent(val)}`);
        }
        return parts.join("&");
      },
    });
  } catch (e) {
    logApiCall({ endpoint: "searchTransfers", status: "failed", durationMs: Date.now() - startedAt, errorMessage: e.message });
    console.error(`[tripGoClient] routing request failed: ${e.message}`);
    return null;
  }
  const data = resp && resp.data;
  if (!data || data.error) {
    const errMsg = data && data.error ? JSON.stringify(data.error) : "empty response";
    logApiCall({ endpoint: "searchTransfers", status: "failed", durationMs: Date.now() - startedAt, errorMessage: errMsg });
    console.error(`[tripGoClient] routing error: ${errMsg}`);
    return null;
  }
  const groupCount = Array.isArray(data.groups) ? data.groups.length : 0;
  const mapped = module.exports.mapTrips(data, q);
  console.log(`[tripGoClient] routing ${q.from}→${q.to}: ${groupCount} group(s) from TripGo, ${mapped.length} with a usable fare`);
  if (groupCount > 0 && mapped.length === 0) {
    console.log("[tripGoClient] (TripGo routed it but no option had a moneyCost — falling through to LLM for a priced estimate)");
  }
  logApiCall({ endpoint: "searchTransfers", status: "success", durationMs: Date.now() - startedAt });
  return mapped;
}

module.exports = {
  isConfigured,
  geocode,
  searchTransfers,
  // internals exported for the CJS self-mock seam (vi.spyOn in tests)
  mapTrips,
  describeTrip,
};
