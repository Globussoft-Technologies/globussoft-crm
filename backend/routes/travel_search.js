// Travel supplier SEARCH endpoints (flights + hotels) for the quote / proposal
// builder. DATA ONLY — these never book anything; they fetch options the advisor
// drops into a quote.
//
// Both delegate to services/tboClient.js, which is a three-tier provider:
//   TBO API (when TBO_* env creds set) → LLM web-grounding (when an LLM key is
//   set) → canned stub data. tboClient NEVER throws — every response carries a
//   `provider` ("tbo" | "llm-web" | "stub") + `stub`/`note` so the UI can warn
//   when the data is a sample / AI estimate rather than live inventory.
//
// JWT + travel-tenant gated (same posture as the flight quick-quote). The
// tenantId is threaded through so the LLM tier can resolve a per-tenant key +
// charge the per-tenant LLM budget.

const express = require("express");

const router = express.Router();

const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const tboClient = require("../services/tboClient");
const { resolveToIata } = require("../lib/airportResolver");

// POST /api/travel/search/flights
// body { from, to, departDate, returnDate?, adults?, children?, infants?,
//        cabinClass?, currency? } → { provider, currency, options:[...], stub, note? }
router.post("/search/flights", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.from || !b.to) {
      return res.status(400).json({ error: "from and to are required", code: "MISSING_ROUTE" });
    }
    if (!b.departDate) {
      return res.status(400).json({ error: "departDate is required", code: "MISSING_DATE" });
    }
    // Accept a city/airport NAME ("Delhi", "Bengaluru") or an IATA code and
    // resolve both to IATA before the (IATA-speaking) search. Static map first,
    // LLM fallback when a key is configured; null → ask the user to refine.
    const [origin, dest] = await Promise.all([
      resolveToIata(b.from, { tenantId: req.travelTenant.id }),
      resolveToIata(b.to, { tenantId: req.travelTenant.id }),
    ]);
    if (!origin) {
      return res.status(400).json({ error: `Couldn't find an airport for "${b.from}". Try the city name or its 3-letter code.`, code: "ORIGIN_UNRESOLVED" });
    }
    if (!dest) {
      return res.status(400).json({ error: `Couldn't find an airport for "${b.to}". Try the city name or its 3-letter code.`, code: "DEST_UNRESOLVED" });
    }
    const result = await tboClient.searchFlights({
      from: origin.iata,
      to: dest.iata,
      departDate: b.departDate,
      returnDate: b.returnDate,
      adults: b.adults,
      children: b.children,
      infants: b.infants,
      cabinClass: b.cabinClass,
      currency: b.currency,
      tenantId: req.travelTenant.id,
    });
    // Echo what we resolved so the UI can reassure the user ("Delhi → DEL").
    res.json({ ...result, resolved: { from: { input: b.from, iata: origin.iata }, to: { input: b.to, iata: dest.iata } } });
  } catch (e) {
    console.error("[travel-search] flights error:", e.message);
    res.status(500).json({ error: "Failed to search flights", code: "SEARCH_FAILED" });
  }
});

// POST /api/travel/search/hotels
// body { city, checkIn, checkOut, rooms?, adults?, starRating?, currency? }
//   → { provider, currency, hotels:[...], stub, note? }
router.post("/search/hotels", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.city) {
      return res.status(400).json({ error: "city is required", code: "MISSING_CITY" });
    }
    if (!b.checkIn || !b.checkOut) {
      return res.status(400).json({ error: "checkIn and checkOut are required", code: "MISSING_DATES" });
    }
    const result = await tboClient.searchHotels({
      city: b.city,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      rooms: b.rooms,
      adults: b.adults,
      starRating: b.starRating,
      currency: b.currency,
      tenantId: req.travelTenant.id,
    });
    res.json(result);
  } catch (e) {
    console.error("[travel-search] hotels error:", e.message);
    res.status(500).json({ error: "Failed to search hotels", code: "SEARCH_FAILED" });
  }
});

// POST /api/travel/search/transfers
// body { from, to, date?, pax?, currency? }
//   → { provider, currency, transfers:[...], stub, note? }
// Road/ground transfers — airport↔hotel or inter-city (e.g. Makkah↔Madina by
// road, where there's no flight). from/to are free-text place names.
router.post("/search/transfers", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.from || !b.to) {
      return res.status(400).json({ error: "from and to are required", code: "MISSING_ROUTE" });
    }
    const result = await tboClient.searchTransfers({
      from: b.from,
      to: b.to,
      date: b.date,
      pax: b.pax,
      currency: b.currency,
      tenantId: req.travelTenant.id,
    });
    res.json(result);
  } catch (e) {
    console.error("[travel-search] transfers error:", e.message);
    res.status(500).json({ error: "Failed to search transfers", code: "SEARCH_FAILED" });
  }
});

module.exports = router;
