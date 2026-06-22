// Travel CRM — Flight Quotation plugin endpoint.
//
// PRD_FLIGHT_PLUGIN_CHROME_EXTENSION FR-5 + FR-6. The CRM-side receiver for
// the (separate-repo) Chrome flight plugin: the plugin scrapes a fare off an
// airline site and POSTs the RAW fare here; this endpoint applies per-tenant +
// per-sub-brand markup via lib/travelPricing and persists a flight
// ItineraryItem. The plugin NEVER computes markup client-side — pricing math
// has a single source of truth (FR-6 / §2.3).
//
// Mounted at /api/v1/flight-plugin (server.js), authed with X-API-Key via
// middleware/externalAuth — the same partner-API pattern as /api/v1/external.
// The key must be scoped to the flight plugin (ApiKey.purpose === "flight-plugin")
// OR be a legacy tenant-wide key (purpose === null) for back-compat.
//
// Endpoints:
//   POST /api/v1/flight-plugin/quotes        (X-API-Key — Chrome plugin)
//     body { airline, fareClass?, pricePerPax, currency?, departAt?, returnAt?,
//            route: { from, to }, fareUrl?, screenshotUrl?, itineraryId, advisorId? }
//     201  { itineraryItemId, totalWithMarkup, currency }
//
//   POST /api/v1/flight-plugin/agent-quotes  (JWT — in-CRM fallback, PRD §7)
//     The authed in-CRM variant for FlightQuoteAgent.jsx (/travel/flights/quote):
//     until the Chrome plugin ships, an advisor manually enters up to 4 flight
//     options; markup is applied through the SAME pickMarkup code path and the
//     SAME ItineraryItem persist shape as the plugin endpoint, then the response
//     adds the branded-PDF URL (GET /api/travel/itineraries/:id/pdf) so the
//     advisor can share immediately. Lives in this file (not a new route file)
//     because the two endpoints must never drift on pricing math; the
//     /api/v1/flight-plugin mount is reused because server.js is owned by a
//     sibling wave — `agent-quotes` re-asserts verifyToken + requireTravelTenant
//     at the route level (the mount prefix is in server.js openPaths, so the
//     global guard does not pre-authenticate it).
//     body { contactId, subBrand?, itineraryId?, currency?, markupRuleId?,
//            options: [ { airline, flightNumber?, fareClass?, pricePerPax,
//                         route: { from, to }, departAt?, arriveAt?, baggage? } ] }
//     201  { itineraryId, items: [ { itineraryItemId, totalWithMarkup, currency } ],
//            totalWithMarkup, currency, pdfUrl }
//
// Sub-brand-scoped keys are enforced via req.requireSubBrandMatchOrSend (a key
// scoped to 'tmc' can't add an item to an 'rfu' itinerary → 403). ItineraryItem
// has no `currency` column, so the fare currency is stored in detailsJson.

const express = require("express");
const router = express.Router();
const externalAuth = require("../middleware/externalAuth");
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { pickMarkup } = require("../lib/travelPricing");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
} = require("../middleware/travelGuards");

// Hard cap on manually-entered options per quote (PRD §7 — "up to 4 flight
// options"). Mirrored client-side in FlightQuoteAgent.jsx.
const MAX_AGENT_OPTIONS = 4;

const FLIGHT_PLUGIN_PURPOSE = "flight-plugin";

// Gate: only a flight-plugin-scoped key (or a legacy tenant-wide key with no
// purpose set) may post flight quotes. A partner key minted for a different
// purpose is rejected so a leaked key can't fabricate itinerary items.
function requireFlightPluginKey(req, res, next) {
  const purpose = req.apiKey?.purpose || null;
  if (purpose !== null && purpose !== FLIGHT_PLUGIN_PURPOSE) {
    return res.status(403).json({ error: "API key is not scoped for the flight plugin", code: "WRONG_KEY_PURPOSE" });
  }
  next();
}

router.post("/quotes", externalAuth, requireFlightPluginKey, async (req, res) => {
  try {
    const b = req.body || {};
    const airline = typeof b.airline === "string" ? b.airline.trim() : "";
    const pricePerPax = Number(b.pricePerPax);
    const itineraryId = parseInt(b.itineraryId, 10);
    const from = b.route && b.route.from ? String(b.route.from).trim() : "";
    const to = b.route && b.route.to ? String(b.route.to).trim() : "";

    if (!airline) return res.status(400).json({ error: "airline is required", code: "MISSING_AIRLINE" });
    if (!Number.isFinite(pricePerPax) || pricePerPax < 0) {
      return res.status(400).json({ error: "pricePerPax must be a non-negative number", code: "INVALID_PRICE" });
    }
    if (!Number.isInteger(itineraryId)) {
      return res.status(400).json({ error: "itineraryId is required", code: "MISSING_ITINERARY" });
    }
    if (!from || !to) {
      return res.status(400).json({ error: "route.from and route.to are required", code: "MISSING_ROUTE" });
    }

    const currency = typeof b.currency === "string" && b.currency.trim() ? b.currency.trim().toUpperCase() : "INR";
    const fareClass = typeof b.fareClass === "string" ? b.fareClass.trim() : null;

    // The itinerary must belong to the key's tenant; its subBrand drives markup.
    const itin = await prisma.itinerary.findFirst({
      where: { id: itineraryId, tenantId: req.tenantId },
      select: { id: true, subBrand: true },
    });
    if (!itin) return res.status(404).json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });

    // Sub-brand-scoped key isolation (partner-API pattern). Tenant-wide keys pass.
    if (typeof req.requireSubBrandMatchOrSend === "function") {
      if (!req.requireSubBrandMatchOrSend(itin.subBrand, res)) return; // 403 already sent
    }

    // FR-6 — markup computed server-side (single source of truth). Fetch the
    // tenant's active markup rules; pickMarkup filters by subBrand + scope.
    const rules = await prisma.travelMarkupRule.findMany({
      where: { tenantId: req.tenantId, isActive: true },
    });
    const advisorId = b.advisorId != null ? parseInt(b.advisorId, 10) : (req.apiKey && req.apiKey.userId) || null;
    const { markupAmount } = pickMarkup(
      rules,
      itin.subBrand,
      "flight",
      pricePerPax,
      Number.isInteger(advisorId) ? advisorId : null,
    );
    const totalWithMarkup = Math.round((pricePerPax + markupAmount) * 100) / 100;

    const position = await prisma.itineraryItem.count({ where: { itineraryId: itin.id } });
    const detailsJson = JSON.stringify({
      airline,
      fareClass,
      route: { from, to },
      departAt: b.departAt || null,
      returnAt: b.returnAt || null,
      currency,
      fareUrl: b.fareUrl || null,
      screenshotUrl: b.screenshotUrl || null,
      source: "flight-plugin",
    });
    const description = `${airline} ${from}→${to}${fareClass ? ` (${fareClass})` : ""}`;

    const item = await prisma.itineraryItem.create({
      data: {
        itineraryId: itin.id,
        itemType: "flight",
        position,
        description,
        detailsJson,
        unitCost: pricePerPax,
        markup: markupAmount,
        totalPrice: totalWithMarkup,
        unit: "per_person",
        quantity: 1,
      },
    });

    // Touch the itinerary so the detail page surfaces the new item promptly.
    await prisma.itinerary
      .update({ where: { id: itin.id }, data: { updatedAt: new Date() } })
      .catch(() => {});

    return res.status(201).json({ itineraryItemId: item.id, totalWithMarkup, currency });
  } catch (e) {
    console.error("[flight-plugin] quote error:", e.message);
    res.status(500).json({ error: "Failed to record flight quote" });
  }
});

// ─── Authed in-CRM variant (PRD §7 — FlightQuoteAgent fallback) ────────────
//
// POST /api/v1/flight-plugin/agent-quotes
//
// Same pricing/persist semantics as POST /quotes above, generalised to a
// multi-option payload and JWT auth:
//   - markup is computed via pickMarkup against the tenant's active
//     TravelMarkupRule rows (FR-6 single source of truth — never client-side);
//   - each option persists a flight ItineraryItem (identical column shape to
//     the plugin path; detailsJson.source = "agent-quick-quote");
//   - when no itineraryId is supplied a draft Itinerary is created for the
//     contact. NOTE: unlike POST /api/travel/itineraries this path does NOT
//     enforce the §4.1 diagnostic-first guard — the Flight quick-quote is the
//     manual fallback for a lead who already reached out directly (WhatsApp /
//     email), so the advisor sends a quote on the spot; requiring a completed
//     diagnostic first would block that legitimate flow.
//
// Optional markupRuleId pins a specific tenant rule instead of the priority
// auto-pick; the amount still flows through pickMarkup (single-element list)
// so the pct/flat math has one implementation.
router.post("/agent-quotes", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const b = req.body || {};
    const contactId = parseInt(b.contactId, 10);
    if (!Number.isInteger(contactId)) {
      return res.status(400).json({ error: "contactId is required", code: "MISSING_CONTACT" });
    }

    const options = Array.isArray(b.options) ? b.options : [];
    if (options.length === 0) {
      return res.status(400).json({ error: "options must contain at least 1 flight option", code: "MISSING_OPTIONS" });
    }
    if (options.length > MAX_AGENT_OPTIONS) {
      return res.status(400).json({
        error: `at most ${MAX_AGENT_OPTIONS} flight options per quote`,
        code: "TOO_MANY_OPTIONS",
      });
    }

    // Per-option validation up-front so nothing persists on a bad row —
    // same field rules + error codes as the plugin endpoint.
    const parsed = [];
    for (let i = 0; i < options.length; i++) {
      const o = options[i] || {};
      const airline = typeof o.airline === "string" ? o.airline.trim() : "";
      const pricePerPax = Number(o.pricePerPax);
      const from = o.route && o.route.from ? String(o.route.from).trim() : "";
      const to = o.route && o.route.to ? String(o.route.to).trim() : "";
      if (!airline) {
        return res.status(400).json({ error: `options[${i}]: airline is required`, code: "MISSING_AIRLINE" });
      }
      if (!Number.isFinite(pricePerPax) || pricePerPax < 0) {
        return res.status(400).json({ error: `options[${i}]: pricePerPax must be a non-negative number`, code: "INVALID_PRICE" });
      }
      if (!from || !to) {
        return res.status(400).json({ error: `options[${i}]: route.from and route.to are required`, code: "MISSING_ROUTE" });
      }
      parsed.push({
        airline,
        pricePerPax,
        from,
        to,
        flightNumber: typeof o.flightNumber === "string" && o.flightNumber.trim() ? o.flightNumber.trim() : null,
        fareClass: typeof o.fareClass === "string" && o.fareClass.trim() ? o.fareClass.trim() : null,
        departAt: o.departAt || null,
        arriveAt: o.arriveAt || null,
        baggage: typeof o.baggage === "string" && o.baggage.trim() ? o.baggage.trim() : null,
      });
    }

    const currency = typeof b.currency === "string" && b.currency.trim() ? b.currency.trim().toUpperCase() : "INR";
    const tenantId = req.travelTenant.id;

    // Contact must belong to the caller's tenant.
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true },
    });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found", code: "CONTACT_NOT_FOUND" });
    }

    // Resolve the target itinerary: attach to an existing one when supplied
    // (mirrors the plugin path — its subBrand drives markup), otherwise
    // create a fresh draft quote artifact for the contact.
    let itin = null;
    let subBrand;
    if (b.itineraryId != null && b.itineraryId !== "") {
      const itineraryId = parseInt(b.itineraryId, 10);
      if (!Number.isInteger(itineraryId)) {
        return res.status(400).json({ error: "itineraryId must be a number", code: "INVALID_ITINERARY_ID" });
      }
      itin = await prisma.itinerary.findFirst({
        where: { id: itineraryId, tenantId },
        select: { id: true, subBrand: true },
      });
      if (!itin) return res.status(404).json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
      subBrand = itin.subBrand;
    } else {
      subBrand = typeof b.subBrand === "string" ? b.subBrand.trim() : "";
      if (!subBrand) {
        return res.status(400).json({ error: "subBrand is required when itineraryId is not supplied", code: "MISSING_SUB_BRAND" });
      }
      assertValidSubBrand(subBrand); // throws 400 INVALID_SUB_BRAND
    }

    // Sub-brand entitlement — same policy as POST /api/travel/itineraries.
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    // FR-6 — markup computed server-side via the SAME rule set + math as the
    // plugin endpoint. Fetched once; applied per option below.
    const rules = await prisma.travelMarkupRule.findMany({
      where: { tenantId, isActive: true },
    });

    // Optional pinned rule: must be one of the tenant's active rules. The
    // amount still flows through pickMarkup (single-element list with the
    // rule's own subBrand/scope/owner so the filters always match) — one
    // implementation of the pct/flat math.
    let forcedRule = null;
    if (b.markupRuleId != null && b.markupRuleId !== "") {
      const markupRuleId = parseInt(b.markupRuleId, 10);
      forcedRule = Number.isInteger(markupRuleId) ? rules.find((r) => r.id === markupRuleId) || null : null;
      if (!forcedRule) {
        return res.status(404).json({ error: "Markup rule not found (must be an active rule of your tenant)", code: "MARKUP_RULE_NOT_FOUND" });
      }
    }

    if (!itin) {
      // No diagnostic-first guard here (see header note): the Flight
      // quick-quote answers a lead who already reached out directly, so the
      // advisor quotes on the spot without forcing a diagnostic first.
      const first = parsed[0];
      itin = await prisma.itinerary.create({
        data: {
          tenantId,
          subBrand,
          contactId,
          status: "draft",
          destination: `${first.from}→${first.to} flights`,
          currency,
        },
        select: { id: true, subBrand: true },
      });
    }

    const priceFor = (pricePerPax) =>
      forcedRule
        ? pickMarkup([forcedRule], forcedRule.subBrand, forcedRule.scope, pricePerPax, forcedRule.ownerUserId ?? null)
        : pickMarkup(rules, subBrand, "flight", pricePerPax, req.user.userId);

    let position = await prisma.itineraryItem.count({ where: { itineraryId: itin.id } });
    const items = [];
    let grandTotal = 0;
    for (const opt of parsed) {
      const { markupAmount } = priceFor(opt.pricePerPax);
      const totalWithMarkup = Math.round((opt.pricePerPax + markupAmount) * 100) / 100;
      const item = await prisma.itineraryItem.create({
        data: {
          itineraryId: itin.id,
          itemType: "flight",
          position: position++,
          description: `${opt.airline}${opt.flightNumber ? ` ${opt.flightNumber}` : ""} ${opt.from}→${opt.to}${opt.fareClass ? ` (${opt.fareClass})` : ""}`,
          detailsJson: JSON.stringify({
            airline: opt.airline,
            flightNumber: opt.flightNumber,
            fareClass: opt.fareClass,
            route: { from: opt.from, to: opt.to },
            departAt: opt.departAt,
            arriveAt: opt.arriveAt,
            baggage: opt.baggage,
            currency,
            source: "agent-quick-quote",
          }),
          unitCost: opt.pricePerPax,
          markup: markupAmount,
          totalPrice: totalWithMarkup,
          unit: "per_person",
          quantity: 1,
        },
      });
      grandTotal = Math.round((grandTotal + totalWithMarkup) * 100) / 100;
      items.push({ itineraryItemId: item.id, totalWithMarkup, currency });
    }

    // Touch the itinerary so detail/list surfaces pick up the new items
    // promptly (same best-effort as the plugin path).
    await prisma.itinerary
      .update({ where: { id: itin.id }, data: { updatedAt: new Date() } })
      .catch(() => {});

    return res.status(201).json({
      itineraryId: itin.id,
      items,
      totalWithMarkup: grandTotal,
      currency,
      // Branded itinerary PDF (services/pdfRenderer) — the frontend appends
      // ?_t=<jwt> for the new-tab plain-<a> open (see server.js promotion).
      pdfUrl: `/api/travel/itineraries/${itin.id}/pdf`,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[flight-plugin] agent quote error:", e.message);
    res.status(500).json({ error: "Failed to record flight quote" });
  }
});

module.exports = router;
