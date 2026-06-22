// Airport / city → IATA resolver (2026-06-19).
//
// The flight search lets users type a CITY or AIRPORT NAME (e.g. "Delhi",
// "Bengaluru", "Jeddah") instead of memorising IATA codes. This resolves a
// free-text place to a 3-letter IATA code before the search hits TBO / the LLM
// (both of which speak IATA). Resolution order:
//   1. Already a 3-letter alpha code → use as-is (uppercased).
//   2. Static alias map — common cities/airports. Instant, no key; the demo path.
//   3. LLM fallback (llmRouter "airport-iata") when an LLM key is configured and
//      the map misses — covers any place name worldwide.
//   4. null → the search route returns a friendly "couldn't find that airport".
//
// Never throws — a resolution failure returns null so the route 400s cleanly
// instead of 500-ing.

// Common city/airport aliases → primary IATA. Lowercased keys. Extend freely;
// the LLM covers anything not listed (when an LLM key is configured).
const ALIASES = {
  // India
  "delhi": "DEL", "new delhi": "DEL",
  "mumbai": "BOM", "bombay": "BOM",
  "bangalore": "BLR", "bengaluru": "BLR",
  "chennai": "MAA", "madras": "MAA",
  "hyderabad": "HYD",
  "kolkata": "CCU", "calcutta": "CCU",
  "kochi": "COK", "cochin": "COK",
  "goa": "GOI", "ahmedabad": "AMD", "pune": "PNQ", "jaipur": "JAI",
  "lucknow": "LKO", "kozhikode": "CCJ", "calicut": "CCJ",
  "trivandrum": "TRV", "thiruvananthapuram": "TRV",
  "mangalore": "IXE", "nagpur": "NAG", "amritsar": "ATQ",
  "guwahati": "GAU", "varanasi": "VNS", "srinagar": "SXR",
  // Gulf / Umrah (RFU)
  "jeddah": "JED", "jedda": "JED", "makkah": "JED", "mecca": "JED",
  "madinah": "MED", "medina": "MED",
  "dubai": "DXB", "abu dhabi": "AUH", "sharjah": "SHJ",
  "doha": "DOH", "muscat": "MCT", "riyadh": "RUH", "dammam": "DMM",
  "kuwait": "KWI", "kuwait city": "KWI", "bahrain": "BAH", "manama": "BAH",
  // Common international
  "singapore": "SIN", "bangkok": "BKK", "kuala lumpur": "KUL",
  "london": "LHR", "new york": "JFK", "paris": "CDG",
  "istanbul": "IST", "colombo": "CMB", "kathmandu": "KTM", "male": "MLE",
  "bali": "DPS", "denpasar": "DPS", "tokyo": "NRT", "hong kong": "HKG",
};

function isIataCode(s) {
  return /^[A-Za-z]{3}$/.test(String(s || "").trim());
}

// Resolve a free-text place to { iata, source } or null. tenantId feeds the LLM
// router (per-tenant key resolution + budget attribution).
async function resolveToIata(input, { tenantId } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  // 1. Already an IATA-style code.
  if (isIataCode(raw)) return { iata: raw.toUpperCase(), source: "code" };
  // 2. Static alias map.
  const hit = ALIASES[raw.toLowerCase()];
  if (hit) return { iata: hit, source: "map" };
  // 3. LLM fallback — no-op in stub / no-key mode (result.stub true → falls
  //    through to null so the route asks the user to use the city or code).
  try {
    const llmRouter = require("./llmRouter");
    const result = await llmRouter.routeRequest({ task: "airport-iata", tenantId, payload: { place: raw } });
    if (result && !result.stub && result.text) {
      const m = String(result.text).toUpperCase().match(/\b([A-Z]{3})\b/);
      if (m) return { iata: m[1], source: "llm" };
    }
  } catch (e) {
    console.warn(`[airportResolver] LLM resolve failed for "${raw}": ${e.message}`);
  }
  return null;
}

module.exports = { resolveToIata, isIataCode, ALIASES };
