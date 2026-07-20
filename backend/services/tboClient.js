// Travel supplier SEARCH data (flights + hotels) for the quote / proposal
// builder. DATA ONLY — this never books anything; it only fetches options the
// advisor drops into a quote.
//
// Three-tier provider, all best-effort (NEVER throws — every failure degrades
// to the next tier, finally to stub data so the UI + tests always work):
//   1. TBO API  — when TBO_* env creds are set (the real inventory). The exact
//                 request/response mapping is wired against TBO's documented
//                 Air/Hotel search shape; until the keys + live spec land it's
//                 inert (no creds → skipped), so it can't break anything.
//   2. LLM web  — else, when an LLM key is set: asks a web-grounded model
//                 (llmRouter "flight-search" / "hotel-search" tasks) for current
//                 options as STRICT JSON. Lets the builder produce real-ish data
//                 BEFORE the TBO keys arrive (the user's requested backup).
//   3. Stub     — else canned sample data so dev / CI / no-keys still render.
//
// The `provider` field on every response says which tier answered
// ("tbo" | "llm-web" | "stub") and `stub`/`note` flag non-authoritative data so
// the UI can warn "verify before quoting".
//
// Keys are the ONLY runtime dependency — drop TBO_* (or an LLM key) into the
// env and the same code returns live data with zero changes here.

const axios = require("axios");
const llmRouter = require("../lib/llmRouter");
const serpApiClient = require("./serpApiClient");
// TripGo is UNWIRED — verified it doesn't cover India or Saudi Arabia for
// routing ("Origin lies outside covered area"), which are the core markets, and
// its geocoder can't resolve Indian city names. Kept on disk in case coverage
// expands. Replaced by osmTransfersClient (Nominatim + OSRM, worldwide, key-free).
// const tripGoClient = require("./tripGoClient");
const osmTransfers = require("./osmTransfersClient");

const TBO_FLIGHT_URL = () => process.env.TBO_FLIGHT_SEARCH_URL || "";
const TBO_HOTEL_URL = () => process.env.TBO_HOTEL_SEARCH_URL || "";
const TBO_TRANSFER_URL = () => process.env.TBO_TRANSFER_SEARCH_URL || "";
const TBO_USERNAME = () => process.env.TBO_USERNAME || "";
const TBO_PASSWORD = () => process.env.TBO_PASSWORD || "";
const TIMEOUT_MS = Number(process.env.TBO_TIMEOUT_MS || 12000);

function num(v) {
  // Number(null) is 0, which would make an unknown seat count look like a
  // sold-out flight in the UI. Preserve omitted supplier fields as null.
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function up(s) {
  return String(s || "").trim().toUpperCase();
}

// ── query normalization ──────────────────────────────────────────────
function normalizeFlightQuery(p = {}) {
  return {
    from: up(p.from),
    to: up(p.to),
    departDate: p.departDate ? String(p.departDate) : null,
    returnDate: p.returnDate ? String(p.returnDate) : null,
    adults: Math.max(1, parseInt(p.adults, 10) || 1),
    children: Math.max(0, parseInt(p.children, 10) || 0),
    infants: Math.max(0, parseInt(p.infants, 10) || 0),
    cabinClass: p.cabinClass || "Economy",
    currency: up(p.currency) || "INR",
  };
}
function normalizeHotelQuery(p = {}) {
  return {
    city: String(p.city || "").trim(),
    checkIn: p.checkIn ? String(p.checkIn) : null,
    checkOut: p.checkOut ? String(p.checkOut) : null,
    rooms: Math.max(1, parseInt(p.rooms, 10) || 1),
    adults: Math.max(1, parseInt(p.adults, 10) || 2),
    starRating: parseInt(p.starRating, 10) || null,
    currency: up(p.currency) || "INR",
  };
}
function normalizeTransferQuery(p = {}) {
  return {
    from: String(p.from || "").trim(),
    to: String(p.to || "").trim(),
    date: p.date ? String(p.date) : null,
    pax: Math.max(1, parseInt(p.pax, 10) || 2),
    currency: up(p.currency) || "INR",
  };
}

// ── normalized output shapes (one place so all three tiers agree) ─────
// A flight option maps 1:1 onto the Flight quick-quote's blankOption() so the
// UI's "Use this" can populate a row directly.
function normalizeFlightOption(o = {}) {
  return {
    airline: up(o.airline) || null,
    airlineName: o.airlineName || null,
    flightNumber: o.flightNumber ? String(o.flightNumber) : null,
    from: up(o.from) || null,
    to: up(o.to) || null,
    departAt: o.departAt || null,
    arriveAt: o.arriveAt || null,
    durationMinutes: num(o.durationMinutes),
    stops: num(o.stops) ?? 0,
    fare: num(o.fare),
    fareClass: o.fareClass || "Economy",
    baggage: o.baggage || null,
    refundable: typeof o.refundable === "boolean" ? o.refundable : null,
    // Seats still bookable at this fare (airlines/GDS rarely expose >9). null
    // when the source doesn't report it — the UI shows "—" rather than guessing.
    seatsAvailable: num(o.seatsAvailable),
  };
}
function normalizeHotel(h = {}) {
  return {
    name: h.name || null,
    starRating: num(h.starRating),
    address: h.address || null,
    area: h.area || null,
    ratePerNight: num(h.ratePerNight),
    totalRate: num(h.totalRate),
    roomType: h.roomType || null,
    board: h.board || null, // Room Only / Breakfast / Half Board …
    refundable: typeof h.refundable === "boolean" ? h.refundable : null,
    thumbnail: h.thumbnail || null,
    // Optional extras carried by some providers (SerpApi/Google Hotels): a
    // guest review score + the public booking link the offline-booking agent
    // follows. Null for providers that don't expose them (TBO/stub).
    rating: num(h.rating),
    bookingLink: h.bookingLink || null,
  };
}
// A ground/road transfer option (airport↔hotel or inter-city).
function normalizeTransfer(t = {}) {
  return {
    mode: t.mode || "road", // road | rail
    vehicle: t.vehicle || null, // Private Sedan / SUV / Shared Coach …
    from: t.from || null,
    to: t.to || null,
    durationMinutes: num(t.durationMinutes),
    price: num(t.price),
    pax: num(t.pax),
    note: t.note || null,
  };
}

// ── tier 1: TBO ──────────────────────────────────────────────────────
// Structured against TBO's documented Air/Hotel search request shape. Kept
// defensive: any non-2xx / unexpected body throws so the caller falls through
// to the LLM/stub tier. Field mapping is best-effort and easy to adjust once
// the live TBO account + response samples are available.
async function _tboFlightSearch(q, ax = axios) {
  const resp = await ax.post(
    TBO_FLIGHT_URL(),
    {
      UserName: TBO_USERNAME(),
      Password: TBO_PASSWORD(),
      Origin: q.from,
      Destination: q.to,
      DepartureDate: q.departDate,
      ReturnDate: q.returnDate || undefined,
      AdultCount: q.adults,
      ChildCount: q.children,
      InfantCount: q.infants,
      CabinClass: q.cabinClass,
      PreferredCurrency: q.currency,
    },
    { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/json" } },
  );
  const results = resp?.data?.Results || resp?.data?.results || [];
  const flat = Array.isArray(results[0]) ? results.flat() : results;
  return flat.map((r) => {
    const seg = (r.Segments && r.Segments.flat && r.Segments.flat()[0]) || {};
    const fare = r.Fare || {};
    return normalizeFlightOption({
      airline: seg.Airline?.AirlineCode || seg.AirlineCode,
      airlineName: seg.Airline?.AirlineName,
      flightNumber: seg.Airline?.FlightNumber ? `${seg.Airline?.AirlineCode}-${seg.Airline?.FlightNumber}` : undefined,
      from: seg.Origin?.Airport?.AirportCode || q.from,
      to: seg.Destination?.Airport?.AirportCode || q.to,
      departAt: seg.Origin?.DepTime,
      arriveAt: seg.Destination?.ArrTime,
      durationMinutes: seg.Duration,
      stops: seg.StopOver ? 1 : 0,
      fare: fare.PublishedFare ?? fare.OfferedFare,
      fareClass: q.cabinClass,
      baggage: seg.Baggage,
      // TBO exposes remaining seats on the segment (NoOfSeatAvailable) or at the
      // result level (AvailableSeats); map whichever is present.
      seatsAvailable: seg.NoOfSeatAvailable ?? r.AvailableSeats ?? r.NoOfSeatAvailable,
    });
  }).filter((o) => o.fare != null);
}

async function _tboHotelSearch(q, ax = axios) {
  const resp = await ax.post(
    TBO_HOTEL_URL(),
    {
      UserName: TBO_USERNAME(),
      Password: TBO_PASSWORD(),
      CityName: q.city,
      CheckInDate: q.checkIn,
      CheckOutDate: q.checkOut,
      NoOfRooms: q.rooms,
      GuestNationality: "IN",
      PreferredCurrency: q.currency,
      StarRating: q.starRating || undefined,
    },
    { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/json" } },
  );
  const results = resp?.data?.HotelResults || resp?.data?.Results || [];
  return results.map((h) => normalizeHotel({
    name: h.HotelName,
    starRating: h.StarRating,
    address: h.HotelAddress,
    area: h.HotelLocation || h.Area,
    ratePerNight: h.Price?.PublishedPricePerNight ?? h.Price?.RoomPrice,
    totalRate: h.Price?.PublishedPrice ?? h.Price?.OfferedPrice,
    roomType: h.RoomDetails?.RoomTypeName,
    board: h.RoomDetails?.Inclusion,
    refundable: h.IsRefundable,
    thumbnail: h.HotelPicture,
  })).filter((h) => h.totalRate != null || h.ratePerNight != null);
}

// ── tier 2: LLM web grounding ────────────────────────────────────────
function parseJsonLoose(text) {
  if (!text) return null;
  // Models sometimes wrap JSON in ```json fences or prose — extract the first
  // balanced array/object.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) return null;
  const slice = raw.slice(start);
  try { return JSON.parse(slice); } catch { /* fall through */ }
  // Try trimming to the last bracket.
  const lastArr = slice.lastIndexOf("]");
  const lastObj = slice.lastIndexOf("}");
  const end = Math.max(lastArr, lastObj);
  if (end > 0) {
    try { return JSON.parse(slice.slice(0, end + 1)); } catch { /* give up */ }
  }
  return null;
}

async function _llmFlightSearch(q, tenantId) {
  const res = await llmRouter.routeRequest({
    task: "flight-search",
    payload: { from: q.from, to: q.to, departDate: q.departDate, returnDate: q.returnDate, adults: q.adults, children: q.children, infants: q.infants, cabinClass: q.cabinClass, currency: q.currency },
    tenantId,
  });
  if (!res || res.stub) return null; // stub LLM = no real data
  const parsed = parseJsonLoose(res.text);
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.options) ? parsed.options : null);
  if (!arr) return null;
  return arr.map(normalizeFlightOption).filter((o) => o.fare != null);
}

async function _llmHotelSearch(q, tenantId) {
  const res = await llmRouter.routeRequest({
    task: "hotel-search",
    payload: { city: q.city, checkIn: q.checkIn, checkOut: q.checkOut, rooms: q.rooms, adults: q.adults, starRating: q.starRating, currency: q.currency },
    tenantId,
  });
  if (!res || res.stub) return null;
  const parsed = parseJsonLoose(res.text);
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.hotels) ? parsed.hotels : null);
  if (!arr) return null;
  return arr.map(normalizeHotel).filter((h) => h.totalRate != null || h.ratePerNight != null);
}

// ── tier 3: stub ─────────────────────────────────────────────────────
// Sample data only (no TBO/LLM keys). SEEDED by the route/city so different
// legs + cities get different airlines, flight numbers, hotels, prices and
// ratings — i.e. it doesn't look hard-coded — while staying deterministic
// (same query → same sample, so the UI is stable). Real airlines/hotels/photos
// arrive the moment TBO (or an LLM key) is configured.
function _seed(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function _nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 1;
  const a = new Date(checkIn); const b = new Date(checkOut);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.max(1, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}
const STUB_CARRIERS = [
  { airline: "AI", airlineName: "Air India" }, { airline: "6E", airlineName: "IndiGo" },
  { airline: "EK", airlineName: "Emirates" }, { airline: "SV", airlineName: "Saudia" },
  { airline: "QR", airlineName: "Qatar Airways" }, { airline: "UK", airlineName: "Vistara" },
  { airline: "GF", airlineName: "Gulf Air" }, { airline: "EY", airlineName: "Etihad Airways" },
];
function _stubFlights(q) {
  const seed = _seed(`${q.from}-${q.to}-${q.cabinClass}`);
  const cabinBase = q.cabinClass === "Business" ? 185000 : q.cabinClass === "First" ? 320000
    : q.cabinClass === "Premium Economy" ? 72000 : 42000;
  return [0, 1, 2].map((k) => {
    const c = STUB_CARRIERS[(seed + k * 3) % STUB_CARRIERS.length];
    const stops = (seed + k) % 3 === 0 ? 0 : 1;
    const fare = Math.round(cabinBase + (seed % 9) * 1600 + k * 3400 - (stops ? 0 : 2200));
    const depH = 6 + ((seed + k * 5) % 14);
    return normalizeFlightOption({
      airline: c.airline,
      airlineName: c.airlineName,
      flightNumber: `${c.airline}-${100 + ((seed + k * 17) % 800)}`,
      from: q.from || "DEL",
      to: q.to || "BOM",
      departAt: q.departDate ? `${q.departDate}T${String(depH).padStart(2, "0")}:${String((seed + k * 7) % 60).padStart(2, "0")}:00` : null,
      arriveAt: q.departDate ? `${q.departDate}T${String((depH + 3 + stops * 2) % 24).padStart(2, "0")}:${String((seed + k * 11) % 60).padStart(2, "0")}:00` : null,
      durationMinutes: 160 + k * 40 + stops * 130,
      stops,
      fare,
      fareClass: q.cabinClass,
      baggage: stops ? "25kg check-in + 7kg cabin" : "30kg check-in + 7kg cabin",
      refundable: k !== 1,
      // Deterministic 1-9 so the sample looks like real GDS seat availability.
      seatsAvailable: 1 + ((seed + k * 13) % 9),
    });
  });
}
const STUB_HOTEL_BRANDS = ["Grand", "Marriott", "Hilton", "Taj", "Radisson Blu", "Pullman", "Mövenpick", "Crowne Plaza"];
const STUB_ROOM_TYPES = ["Deluxe Room", "Twin Room, City View", "Premium King Room", "Executive Suite"];
const STUB_BOARDS = ["Room Only", "Breakfast", "Half Board"];
function _stubHotels(q) {
  const city = q.city || "City";
  const seed = _seed(`${city}-${q.starRating || 0}`);
  const nights = _nightsBetween(q.checkIn, q.checkOut);
  const roomCount = q.rooms || 1;
  return [0, 1, 2, 3].map((k) => {
    const star = q.starRating || (3 + ((seed + k) % 3)); // 3..5
    const brand = STUB_HOTEL_BRANDS[(seed + k * 2) % STUB_HOTEL_BRANDS.length];
    const perNight = 4500 + (seed % 6) * 900 + k * 2600 + star * 1200;
    return normalizeHotel({
      name: `${brand} ${city}`,
      starRating: star,
      address: `${city} city centre`,
      area: `${city} centre`,
      ratePerNight: perNight,
      totalRate: perNight * nights * roomCount,
      roomType: STUB_ROOM_TYPES[(seed + k) % STUB_ROOM_TYPES.length],
      board: STUB_BOARDS[(seed + k) % STUB_BOARDS.length],
      refundable: k % 2 === 0,
    });
  });
}

// ── public API ───────────────────────────────────────────────────────
async function searchFlights(params = {}) {
  const q = normalizeFlightQuery(params);
  // Tier 0 — SerpApi (Google Flights). The temporary real-data source while the
  // TBO supplier contract is pending. Maps SerpApi rows through the same
  // normalizer so the route/frontend contract is identical to TBO/stub.
  if (serpApiClient.isConfigured()) {
    try {
      const raw = await serpApiClient.searchFlights(q);
      const opts = (raw || []).map(module.exports.normalizeFlightOption).filter((o) => o.fare != null);
      if (opts.length) return { provider: "serpapi", currency: q.currency, options: opts, stub: false, note: "Live Google Flights via SerpApi — confirm fare/timing before ticketing." };
    } catch (e) { console.error(`[tboClient] SerpApi flight search failed (falling back): ${e.message}`); }
  }
  if (TBO_FLIGHT_URL() && TBO_USERNAME() && TBO_PASSWORD()) {
    try {
      const opts = await module.exports._tboFlightSearch(q);
      if (opts && opts.length) return { provider: "tbo", currency: q.currency, options: opts, stub: false };
    } catch (e) { console.error(`[tboClient] TBO flight search failed (falling back): ${e.message}`); }
  }
  try {
    const opts = await module.exports._llmFlightSearch(q, params.tenantId);
    if (opts && opts.length) {
      return { provider: "llm-web", currency: q.currency, options: opts, stub: false, note: "AI web estimate — verify fares/timings before quoting." };
    }
  } catch (e) { console.error(`[tboClient] LLM flight search failed (falling back): ${e.message}`); }
  return { provider: "stub", currency: q.currency, options: module.exports._stubFlights(q), stub: true, note: "Sample data — add TBO or AI keys for live results." };
}

async function searchHotels(params = {}) {
  const q = normalizeHotelQuery(params);
  // Tier 0 — SerpApi (Google Hotels). `nights` is passed so SerpApi's mapper can
  // derive a total rate when only a nightly rate is returned.
  if (serpApiClient.isConfigured()) {
    try {
      const nights = _nightsBetween(q.checkIn, q.checkOut);
      const raw = await serpApiClient.searchHotels({ ...q, nights });
      const hotels = (raw || []).map(module.exports.normalizeHotel).filter((h) => h.totalRate != null || h.ratePerNight != null);
      if (hotels.length) return { provider: "serpapi", currency: q.currency, hotels, stub: false, note: "Live Google Hotels via SerpApi — confirm rate/availability before booking." };
    } catch (e) { console.error(`[tboClient] SerpApi hotel search failed (falling back): ${e.message}`); }
  }
  if (TBO_HOTEL_URL() && TBO_USERNAME() && TBO_PASSWORD()) {
    try {
      const hotels = await module.exports._tboHotelSearch(q);
      if (hotels && hotels.length) return { provider: "tbo", currency: q.currency, hotels, stub: false };
    } catch (e) { console.error(`[tboClient] TBO hotel search failed (falling back): ${e.message}`); }
  }
  try {
    const hotels = await module.exports._llmHotelSearch(q, params.tenantId);
    if (hotels && hotels.length) {
      return { provider: "llm-web", currency: q.currency, hotels, stub: false, note: "AI web estimate — verify rates/availability before quoting." };
    }
  } catch (e) { console.error(`[tboClient] LLM hotel search failed (falling back): ${e.message}`); }
  return { provider: "stub", currency: q.currency, hotels: module.exports._stubHotels(q), stub: true, note: "Sample data — add TBO or AI keys for live results." };
}

// ── transfers (airport↔hotel + inter-city ground transport) ─────────
async function _tboTransferSearch(q, ax = axios) {
  const resp = await ax.post(
    TBO_TRANSFER_URL(),
    {
      UserName: TBO_USERNAME(),
      Password: TBO_PASSWORD(),
      PickUp: q.from,
      DropOff: q.to,
      TransferDate: q.date,
      PaxCount: q.pax,
      PreferredCurrency: q.currency,
    },
    { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/json" } },
  );
  const results = resp?.data?.Transfers || resp?.data?.Results || [];
  return results.map((t) => normalizeTransfer({
    mode: t.Mode || "road",
    vehicle: t.VehicleType || t.TransferName,
    from: q.from,
    to: q.to,
    durationMinutes: t.DurationMinutes,
    price: t.Price?.PublishedPrice ?? t.Price?.OfferedPrice ?? t.Fare,
    pax: q.pax,
    note: t.Note,
  })).filter((t) => t.price != null);
}
async function _llmTransferSearch(q, tenantId) {
  const res = await llmRouter.routeRequest({
    task: "transfer-search",
    payload: { from: q.from, to: q.to, date: q.date, pax: q.pax, currency: q.currency },
    tenantId,
  });
  if (!res || res.stub) return null;
  const parsed = parseJsonLoose(res.text);
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.transfers) ? parsed.transfers : null);
  if (!arr) return null;
  return arr.map(normalizeTransfer).filter((t) => t.price != null);
}
const STUB_VEHICLES = [
  { vehicle: "Private Sedan", cap: 3, mult: 1, perSeat: false },
  { vehicle: "Private SUV", cap: 6, mult: 1.55, perSeat: false },
  { vehicle: "Shared Coach (per seat)", cap: 1, mult: 0.4, perSeat: true },
];
function _stubTransfers(q) {
  const seed = _seed(`${q.from}-${q.to}`);
  const basePrice = 1600 + (seed % 7) * 650;
  const dur = 60 + (seed % 6) * 35;
  return STUB_VEHICLES.map((v, k) => {
    const price = v.perSeat
      ? Math.round(basePrice * v.mult * q.pax)
      : Math.round(basePrice * v.mult + k * 500);
    return normalizeTransfer({
      mode: "road",
      vehicle: v.vehicle,
      from: q.from || "Pickup",
      to: q.to || "Drop-off",
      durationMinutes: dur + k * 15,
      price,
      pax: q.pax,
      note: v.perSeat ? "Shared — price per person" : `Private — up to ${v.cap} pax`,
    });
  });
}
async function searchTransfers(params = {}) {
  const q = normalizeTransferQuery(params);
  // Tier 0 — OSM road transfers (Nominatim geocode + OSRM driving route). The
  // real-data source for ground transfers worldwide (covers India + Saudi, which
  // TripGo did not). Real distance/time; fare is a per-km estimate IN q.currency
  // (no foreign-currency mismatch). If it can't answer we fall through to TBO →
  // LLM → stub.
  if (osmTransfers.isConfigured()) {
    try {
      const raw = await osmTransfers.searchTransfers(q);
      const transfers = (raw || []).map(module.exports.normalizeTransfer).filter((t) => t.price != null);
      console.log(`[tboClient] OSM road-transfer tier produced ${transfers.length} option(s)`);
      if (transfers.length) return { provider: "osm-road", currency: q.currency, transfers, stub: false, note: "Real road distance/time (OpenStreetMap) with a per-km fare estimate — confirm the rate with your supplier." };
    } catch (e) {
      console.error(`[tboClient] OSM transfer search failed (falling back to LLM): ${e.message}`);
    }
  }
  if (TBO_TRANSFER_URL() && TBO_USERNAME() && TBO_PASSWORD()) {
    try {
      const t = await module.exports._tboTransferSearch(q);
      if (t && t.length) return { provider: "tbo", currency: q.currency, transfers: t, stub: false };
    } catch (e) { console.error(`[tboClient] TBO transfer search failed (falling back): ${e.message}`); }
  }
  try {
    const t = await module.exports._llmTransferSearch(q, params.tenantId);
    if (t && t.length) {
      return { provider: "llm-web", currency: q.currency, transfers: t, stub: false, note: "AI web estimate — verify before quoting." };
    }
  } catch (e) { console.error(`[tboClient] LLM transfer search failed (falling back): ${e.message}`); }
  return { provider: "stub", currency: q.currency, transfers: module.exports._stubTransfers(q), stub: true, note: "Sample data — add TBO or AI keys for live results." };
}

function isTboConfigured() {
  return Boolean(TBO_USERNAME() && TBO_PASSWORD() && (TBO_FLIGHT_URL() || TBO_HOTEL_URL() || TBO_TRANSFER_URL()));
}

module.exports = {
  searchFlights,
  searchHotels,
  isTboConfigured,
  // internals exported for the CJS self-mock seam (vi.spyOn in tests)
  normalizeFlightQuery,
  normalizeHotelQuery,
  normalizeTransferQuery,
  normalizeFlightOption,
  normalizeHotel,
  normalizeTransfer,
  parseJsonLoose,
  searchTransfers,
  _tboFlightSearch,
  _tboHotelSearch,
  _tboTransferSearch,
  _llmFlightSearch,
  _llmHotelSearch,
  _llmTransferSearch,
  _stubFlights,
  _stubHotels,
  _stubTransfers,
};
