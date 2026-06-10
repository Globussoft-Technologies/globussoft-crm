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
// Endpoint:
//   POST /api/v1/flight-plugin/quotes
//     body { airline, fareClass?, pricePerPax, currency?, departAt?, returnAt?,
//            route: { from, to }, fareUrl?, screenshotUrl?, itineraryId, advisorId? }
//     201  { itineraryItemId, totalWithMarkup, currency }
//
// Sub-brand-scoped keys are enforced via req.requireSubBrandMatchOrSend (a key
// scoped to 'tmc' can't add an item to an 'rfu' itinerary → 403). ItineraryItem
// has no `currency` column, so the fare currency is stored in detailsJson.

const express = require("express");
const router = express.Router();
const externalAuth = require("../middleware/externalAuth");
const prisma = require("../lib/prisma");
const { pickMarkup } = require("../lib/travelPricing");

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

module.exports = router;
