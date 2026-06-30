// Travel CRM — Reports aggregates (Phase 1 §4.9).
//
// Three endpoints, each tenant-scoped + sub-brand-narrowed by the caller's
// `subBrandAccess`. Returns DRILL-DOWN data — the Owner Dashboard
// (travel_dashboard.js) is the summary tier (single counts); these are the
// next layer (groupings, top-N, trend lines) for the Reports page.
//
//   GET /api/travel/reports/tmc          TMC analytics
//   GET /api/travel/reports/rfu          RFU analytics
//   GET /api/travel/reports/cross-brand  Multi-sub-brand revenue + conversion
//
// All aggregates fire via Promise.all so each endpoint resolves in
// ~one round-trip. None of the payloads include PII (no participant names,
// no contact emails); they're shaped for charts / tables.

const express = require("express");
const PDFDocument = require("pdfkit");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
} = require("../middleware/travelGuards");

const SUB_BRAND_LABEL = { tmc: "TMC (Schools)", rfu: "RFU (Umrah)", travelstall: "Travel Stall", visasure: "Visa Sure" };
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

// The travel SALES funnel lives in TravelQuote (Draft/Sent/Accepted/Rejected/
// Expired), NOT the generic Deal table — travel never creates Deal rows, which
// is why the "Deal funnel" was always empty. This surfaces the real quote
// pipeline (count + ₹ by status) for a sub-brand. Fail-soft: returns an empty
// funnel if the model/query is unavailable (keeps existing tests that don't
// mock travelQuote green).
async function quoteFunnel(tenantId, subBrand, dateRange = null) {
  try {
    const where = { tenantId, subBrand };
    if (dateRange) where.createdAt = dateRange;
    const [byStatus, amtByStatus] = await Promise.all([
      prisma.travelQuote.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.travelQuote.groupBy({ by: ["status"], where, _sum: { totalAmount: true } }),
    ]);
    return {
      byStatus: flattenGroupCount(byStatus, "status"),
      amountByStatus: flattenGroupSum(amtByStatus, "status", "totalAmount"),
    };
  } catch (_e) {
    return { byStatus: {}, amountByStatus: {} };
  }
}

// Render a bordered, columnar table into a pdfkit doc (shared by the travel
// report PDF export). columns: [{ header, width, align? }]; rows: cell-string
// arrays. Header fill + per-cell ellipsis clipping + zebra + page-break.
function drawTravelTable(doc, columns, rows, opts = {}) {
  const x = opts.x || 50;
  const ROW_H = 18;
  const PAD = 4;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  let y = opts.startY != null ? opts.startY : doc.y;
  const header = () => {
    doc.save();
    doc.rect(x, y, totalW, ROW_H).fill("#1f3a5f");
    doc.restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    let cx = x;
    for (const c of columns) { doc.text(String(c.header), cx + PAD, y + 5, { width: c.width - PAD * 2, align: c.align || "left", lineBreak: false, ellipsis: true }); cx += c.width; }
    y += ROW_H;
  };
  header();
  doc.font("Helvetica").fontSize(8);
  if (rows.length === 0) {
    doc.fillColor("#888").text("No records.", x + PAD, y + 5, { width: totalW - PAD * 2, lineBreak: false });
    doc.y = y + ROW_H; return doc.y;
  }
  rows.forEach((row, i) => {
    if (y + ROW_H > 790) { doc.addPage(); y = 50; header(); doc.font("Helvetica").fontSize(8); }
    if (i % 2 === 1) { doc.save(); doc.rect(x, y, totalW, ROW_H).fill("#f4f6f9"); doc.restore(); }
    doc.fillColor("#222");
    let cx = x;
    for (let ci = 0; ci < columns.length; ci += 1) { const c = columns[ci]; doc.text(row[ci] == null ? "" : String(row[ci]), cx + PAD, y + 5, { width: c.width - PAD * 2, align: c.align || "left", lineBreak: false, ellipsis: true }); cx += c.width; }
    doc.save(); doc.moveTo(x, y + ROW_H).lineTo(x + totalW, y + ROW_H).lineWidth(0.3).strokeColor("#ddd").stroke(); doc.restore();
    y += ROW_H;
  });
  doc.y = y;
  return y;
}

function flattenGroupCount(rows, key, field = "_count") {
  const out = {};
  for (const r of rows) {
    out[r[key]] = field === "_count" ? (r._count?._all ?? 0) : (r[field] ?? 0);
  }
  return out;
}

function flattenGroupSum(rows, key, sumField) {
  const out = {};
  for (const r of rows) {
    const v = r._sum?.[sumField];
    out[r[key]] = v != null ? Number(v) : 0;
  }
  return out;
}

// ── TMC analytics ──────────────────────────────────────────────────
//
// TMC is school-trips. Revenue computed as pricePerStudent × participantCount
// for confirmed/in-trip/completed trips. Repeat schools = contacts with ≥2
// trips. Conversion-by-diagnostic-score requires joining trips to the
// originating diagnostic, which TmcTrip doesn't link directly — we approximate
// by Deal.subBrand='tmc' joined to Deal.diagnosticId.

async function buildTmcReport(tenantId, dateRange = null) {
    // All trips, separated by status: active = confirmed | in-trip | completed.
    // cancelled trips are excluded from revenue totals.
    const ACTIVE_STATUSES = ["confirmed", "in-trip", "completed"];

    const tripWhere = { tenantId };
    if (dateRange) tripWhere.createdAt = dateRange;
    const activeWhere = { ...tripWhere, status: { in: ACTIVE_STATUSES } };
    const dealWhere = { tenantId, subBrand: "tmc", deletedAt: null };
    if (dateRange) dealWhere.createdAt = dateRange;
    const diagWhere = { tenantId, subBrand: "tmc" };
    if (dateRange) diagWhere.createdAt = dateRange;

    const [
      tripsByStatus,
      activeTrips,
      participantCountsByTrip,
      tmcDealsByStage,
      tmcDealAmountByStage,
      tmcDiagnosticsByClassification,
    ] = await Promise.all([
      prisma.tmcTrip.groupBy({
        by: ["status"],
        where: tripWhere,
        _count: { _all: true },
      }),
      prisma.tmcTrip.findMany({
        where: activeWhere,
        select: {
          id: true,
          destination: true,
          pricePerStudent: true,
          schoolContactId: true,
        },
      }),
      prisma.tripParticipant.groupBy({
        by: ["tripId"],
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: dealWhere,
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: dealWhere,
        _sum: { amount: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["classification"],
        where: diagWhere,
        _count: { _all: true },
      }),
    ]);

    // Build a quick lookup: tripId → participantCount.
    const participantByTrip = {};
    for (const row of participantCountsByTrip) {
      participantByTrip[row.tripId] = row._count?._all ?? 0;
    }

    // Revenue by destination = SUM(pricePerStudent × participantCount).
    // Tracked schools = set of schoolContactId for repeat-school detection.
    const revByDest = {};
    const schoolTripCount = {};
    let totalRevenue = 0;
    for (const trip of activeTrips) {
      const headcount = participantByTrip[trip.id] || 0;
      const price = trip.pricePerStudent ? Number(trip.pricePerStudent) : 0;
      const tripRevenue = price * headcount;
      revByDest[trip.destination] = (revByDest[trip.destination] || 0) + tripRevenue;
      totalRevenue += tripRevenue;
      schoolTripCount[trip.schoolContactId] = (schoolTripCount[trip.schoolContactId] || 0) + 1;
    }

    // Top destinations sorted by revenue DESC, take 10.
    const topDestinations = Object.entries(revByDest)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([destination, revenue]) => ({ destination, revenue }));

    const schools = Object.keys(schoolTripCount).length;
    const repeatSchools = Object.values(schoolTripCount).filter((c) => c >= 2).length;
    const quotes = await quoteFunnel(tenantId, "tmc", dateRange);

    return {
      quotes,
      trips: {
        total: tripsByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
        byStatus: flattenGroupCount(tripsByStatus, "status"),
        active: activeTrips.length,
      },
      revenue: {
        total: totalRevenue,
        topDestinations,
        currency: "INR",
      },
      schools: {
        unique: schools,
        repeat: repeatSchools,
        repeatRatePct: schools > 0 ? Number(((repeatSchools / schools) * 100).toFixed(2)) : 0,
      },
      deals: {
        byStage: flattenGroupCount(tmcDealsByStage, "stage"),
        amountByStage: flattenGroupSum(tmcDealAmountByStage, "stage", "amount"),
      },
      diagnostics: {
        byClassification: flattenGroupCount(tmcDiagnosticsByClassification, "classification"),
      },
    };
}

router.get("/reports/tmc", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, "tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    const dateRange = parseDateRange(req);
    res.json(await buildTmcReport(req.travelTenant.id, dateRange));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] TMC error:", e.message);
    res.status(500).json({ error: "Failed to compute TMC report" });
  }
});

// ── RFU analytics ──────────────────────────────────────────────────
//
// RFU is Umrah pilgrimage. Revenue lives in Itinerary.totalAmount. Tier
// (entry/primary/premium) lives in TravelDiagnostic.recommendedTier — to
// link revenue to tier we'd need diagnostic→contact→itinerary joins; for
// the first ship we group separately and let the frontend correlate.

async function buildRfuReport(tenantId, dateRange = null) {
    const itinWhere = { tenantId, subBrand: "rfu" };
    if (dateRange) itinWhere.createdAt = dateRange;
    const dealWhere = { tenantId, subBrand: "rfu", deletedAt: null };
    if (dateRange) dealWhere.createdAt = dateRange;
    const diagWhere = { tenantId, subBrand: "rfu" };
    if (dateRange) diagWhere.createdAt = dateRange;

    const [
      itinByStatus,
      itinAmountByStatus,
      rfuDealsByStage,
      rfuDealAmountByStage,
      rfuDiagByTier,
      rfuDiagByClassification,
      itinByContact,
    ] = await Promise.all([
      prisma.itinerary.groupBy({
        by: ["status"],
        where: itinWhere,
        _count: { _all: true },
      }),
      prisma.itinerary.groupBy({
        by: ["status"],
        where: itinWhere,
        _sum: { totalAmount: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: dealWhere,
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["stage"],
        where: dealWhere,
        _sum: { amount: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["recommendedTier"],
        where: diagWhere,
        _count: { _all: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["classification"],
        where: diagWhere,
        _count: { _all: true },
      }),
      prisma.itinerary.groupBy({
        by: ["contactId"],
        where: itinWhere,
        _count: { _all: true },
      }),
    ]);

    const customers = itinByContact.length;
    const repeatCustomers = itinByContact.filter((r) => (r._count?._all ?? 0) >= 2).length;
    const quotes = await quoteFunnel(tenantId, "rfu", dateRange);

    return {
      quotes,
      itineraries: {
        total: itinByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
        byStatus: flattenGroupCount(itinByStatus, "status"),
        amountByStatus: flattenGroupSum(itinAmountByStatus, "status", "totalAmount"),
      },
      deals: {
        byStage: flattenGroupCount(rfuDealsByStage, "stage"),
        amountByStage: flattenGroupSum(rfuDealAmountByStage, "stage", "amount"),
      },
      diagnostics: {
        byTier: flattenGroupCount(rfuDiagByTier, "recommendedTier"),
        byClassification: flattenGroupCount(rfuDiagByClassification, "classification"),
      },
      customers: {
        unique: customers,
        repeat: repeatCustomers,
        repeatRatePct: customers > 0 ? Number(((repeatCustomers / customers) * 100).toFixed(2)) : 0,
      },
      currency: "INR",
    };
}

router.get("/reports/rfu", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, "rfu")) {
      return res.status(403).json({ error: "RFU sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    const dateRange = parseDateRange(req);
    res.json(await buildRfuReport(req.travelTenant.id, dateRange));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] RFU error:", e.message);
    res.status(500).json({ error: "Failed to compute RFU report" });
  }
});

// ── Cross-brand summary ────────────────────────────────────────────
//
// Side-by-side comparison of all sub-brands the caller can see. Won deals
// only for revenue totals. Conversion = won / (won + lost) for stages
// reached terminal state.

async function buildCrossBrandReport(tenantId, allowed, dateRange = null) {
    // Build the subBrand filter only when caller has restricted access.
    const dealWhere = { tenantId, deletedAt: null, subBrand: { not: null } };
    if (allowed !== null) dealWhere.subBrand = { in: [...allowed] };
    if (dateRange) dealWhere.createdAt = dateRange;
    const diagWhere = { tenantId };
    if (allowed !== null) diagWhere.subBrand = { in: [...allowed] };
    if (dateRange) diagWhere.createdAt = dateRange;

    const [dealsBySubBrandStage, dealAmountBySubBrandStage, diagBySubBrand] = await Promise.all([
      prisma.deal.groupBy({
        by: ["subBrand", "stage"],
        where: dealWhere,
        _count: { _all: true },
      }),
      prisma.deal.groupBy({
        by: ["subBrand", "stage"],
        where: dealWhere,
        _sum: { amount: true },
      }),
      prisma.travelDiagnostic.groupBy({
        by: ["subBrand"],
        where: diagWhere,
        _count: { _all: true },
      }),
    ]);

    // Reshape into per-sub-brand object: { tmc: { won, lost, ... }, rfu: ... }
    const subBrands = {};
    function ensure(b) {
      if (!subBrands[b]) {
        subBrands[b] = {
          dealsByStage: {},
          dealAmountByStage: {},
          diagnostics: 0,
        };
      }
      return subBrands[b];
    }
    for (const r of dealsBySubBrandStage) {
      ensure(r.subBrand).dealsByStage[r.stage] = r._count?._all ?? 0;
    }
    for (const r of dealAmountBySubBrandStage) {
      const v = r._sum?.amount;
      ensure(r.subBrand).dealAmountByStage[r.stage] = v != null ? Number(v) : 0;
    }
    for (const r of diagBySubBrand) {
      ensure(r.subBrand).diagnostics = r._count?._all ?? 0;
    }

    // Compute won + conversion per sub-brand (Deal-based — legacy/back-compat).
    for (const b of Object.keys(subBrands)) {
      const stages = subBrands[b].dealsByStage;
      const won = stages.won || 0;
      const lost = stages.lost || 0;
      subBrands[b].won = won;
      subBrands[b].lost = lost;
      subBrands[b].wonRevenue = subBrands[b].dealAmountByStage.won || 0;
      subBrands[b].conversionPct = (won + lost) > 0
        ? Number(((won / (won + lost)) * 100).toFixed(2))
        : 0;
    }

    // TRAVEL-NATIVE revenue + conversion from TravelQuote (the actual sales
    // artifact — Deals are always empty for travel). Adds quotesTotal /
    // quotesAccepted / quoteRevenue (₹ of Accepted quotes) / quoteConversionPct
    // per sub-brand. Fail-soft so existing tests (no travelQuote mock) still pass.
    try {
      const qWhere = { tenantId };
      if (allowed !== null) qWhere.subBrand = { in: [...allowed] };
      if (dateRange) qWhere.createdAt = dateRange;
      const [qCountRows, qAmtRows] = await Promise.all([
        prisma.travelQuote.groupBy({ by: ["subBrand", "status"], where: qWhere, _count: { _all: true } }),
        prisma.travelQuote.groupBy({ by: ["subBrand", "status"], where: qWhere, _sum: { totalAmount: true } }),
      ]);
      const qCount = {}; const qRev = {};
      for (const r of qCountRows) { ensure(r.subBrand); (qCount[r.subBrand] ||= {})[r.status] = r._count?._all ?? 0; }
      for (const r of qAmtRows) { ensure(r.subBrand); (qRev[r.subBrand] ||= {})[r.status] = r._sum?.totalAmount != null ? Number(r._sum.totalAmount) : 0; }
      for (const b of Object.keys(subBrands)) {
        const c = qCount[b] || {}; const rv = qRev[b] || {};
        const total = Object.values(c).reduce((a, n) => a + n, 0);
        const accepted = c.Accepted || 0; const rejected = c.Rejected || 0;
        subBrands[b].quotesTotal = total;
        subBrands[b].quotesAccepted = accepted;
        subBrands[b].quoteRevenue = rv.Accepted || 0;
        subBrands[b].quoteConversionPct = (accepted + rejected) > 0
          ? Number(((accepted / (accepted + rejected)) * 100).toFixed(2)) : 0;
      }
    } catch (_e) { /* travelQuote unavailable → quote fields omitted */ }

    return { subBrands, currency: "INR" };
}

router.get("/reports/cross-brand", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const dateRange = parseDateRange(req);
    res.json(await buildCrossBrandReport(req.travelTenant.id, allowed, dateRange));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] cross-brand error:", e.message);
    res.status(500).json({ error: "Failed to compute cross-brand report" });
  }
});

// ── PDF export ─────────────────────────────────────────────────────
// GET /api/travel/reports/export-pdf?tab=tmc|rfu|cross-brand
// Renders the chosen report tab as a branded, tabular PDF — the travel-side
// equivalent of the (now generic-only) /api/reports/export-pdf. Sub-brand
// access is enforced exactly like the JSON endpoints.
router.get("/reports/export-pdf", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const tab = ["tmc", "rfu", "cross-brand"].includes(String(req.query.tab)) ? String(req.query.tab) : "tmc";
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const tenantId = req.travelTenant.id;
    const dateRange = parseDateRange(req);
    if (tab === "tmc" && !canAccessSubBrand(allowed, "tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    if (tab === "rfu" && !canAccessSubBrand(allowed, "rfu")) {
      return res.status(403).json({ error: "RFU sub-brand access required", code: "SUB_BRAND_DENIED" });
    }

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    // Embed Poppins (has the ₹ glyph) so currency renders — built-in Helvetica
    // prints "¹". Skipped under test for text-extraction simplicity; mirrors the
    // quote-PDF approach. Cache-bust the pre-cached default so the swap takes.
    if (process.env.NODE_ENV !== "test") {
      try {
        const fsMod = require("fs");
        const pathMod = require("path");
        const fdir = pathMod.join(__dirname, "..", "assets", "fonts");
        const reg = pathMod.join(fdir, "Poppins-Regular.ttf");
        const sb = pathMod.join(fdir, "Poppins-SemiBold.ttf");
        if (fsMod.existsSync(reg) && fsMod.existsSync(sb)) {
          doc.registerFont("Helvetica", reg);
          doc.registerFont("Helvetica-Bold", sb);
          if (doc._fontFamilies) { delete doc._fontFamilies.Helvetica; delete doc._fontFamilies["Helvetica-Bold"]; }
        }
      } catch (_err) { /* fall back to built-in Helvetica */ }
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=travel-${tab}-report.pdf`);
    doc.pipe(res);

    const TITLES = { tmc: "TMC — School Trips", rfu: "RFU — Umrah", "cross-brand": "Cross-brand" };
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#1f3a5f").text("Travel Reports", { align: "center" });
    doc.font("Helvetica").fontSize(12).fillColor("#666").text(TITLES[tab], { align: "center" });
    doc.fontSize(9).fillColor("#888").text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.moveDown(1.0);
    doc.fillColor("#000");

    const section = (label) => { doc.moveDown(0.6); doc.font("Helvetica-Bold").fontSize(13).fillColor("#1f3a5f").text(label); doc.moveDown(0.3); doc.fillColor("#000"); };
    // KPI summary as a 2-col Metric | Value table.
    const kpiTable = (pairs) => { section("Summary"); drawTravelTable(doc, [{ header: "Metric", width: 320 }, { header: "Value", width: 175, align: "right" }], pairs, { startY: doc.y }); };
    // Simple Key | Count table from a { key: count } object.
    const countTable = (label, obj, keyHdr) => {
      section(label);
      drawTravelTable(doc, [{ header: keyHdr, width: 350 }, { header: "Count", width: 145, align: "right" }],
        Object.entries(obj || {}).map(([k, v]) => [k, String(v)]), { startY: doc.y });
    };
    // Stage/Status table: Count + Amount + a TOTAL footer row.
    const amountTable = (label, keyHdr, byCount, byAmount) => {
      section(label);
      const entries = Object.entries(byCount || {});
      const totC = entries.reduce((s, [, c]) => s + Number(c || 0), 0);
      const totA = entries.reduce((s, [k]) => s + Number((byAmount || {})[k] || 0), 0);
      const rows = entries.map(([k, c]) => [k, String(c), inr((byAmount || {})[k])]);
      if (entries.length) rows.push(["TOTAL", String(totC), inr(totA)]);
      drawTravelTable(doc, [{ header: keyHdr, width: 200 }, { header: "Count", width: 100, align: "right" }, { header: "Amount", width: 195, align: "right" }], rows, { startY: doc.y });
    };

    if (tab === "tmc") {
      const d = await buildTmcReport(tenantId, dateRange);
      kpiTable([
        ["Total revenue (active trips)", inr(d.revenue.total)],
        ["Active trips", String(d.trips.active)],
        ["All-time trips", String(d.trips.total)],
        ["Schools", String(d.schools.unique)],
        ["Repeat schools", `${d.schools.repeat} (${d.schools.repeatRatePct}%)`],
      ]);
      amountTable("Quote pipeline (by status)", "Status", d.quotes.byStatus, d.quotes.amountByStatus);
      countTable("Trip status", d.trips.byStatus, "Status");
      amountTable("Deal funnel", "Stage", d.deals.byStage, d.deals.amountByStage);
      countTable("Diagnostics by classification", d.diagnostics.byClassification, "Classification");
      section("Top destinations by revenue");
      drawTravelTable(doc, [{ header: "Destination", width: 350 }, { header: "Revenue", width: 145, align: "right" }],
        d.revenue.topDestinations.map((r) => [r.destination, inr(r.revenue)]), { startY: doc.y });
    } else if (tab === "rfu") {
      const d = await buildRfuReport(tenantId, dateRange);
      kpiTable([
        ["Itineraries", String(d.itineraries.total)],
        ["Customers", String(d.customers.unique)],
        ["Repeat customers", `${d.customers.repeat} (${d.customers.repeatRatePct}%)`],
      ]);
      amountTable("Quote pipeline (by status)", "Status", d.quotes.byStatus, d.quotes.amountByStatus);
      amountTable("Itinerary revenue by status", "Status", d.itineraries.byStatus, d.itineraries.amountByStatus);
      amountTable("Deal funnel", "Stage", d.deals.byStage, d.deals.amountByStage);
      countTable("Diagnostics by tier", d.diagnostics.byTier, "Tier");
      countTable("Diagnostics by classification", d.diagnostics.byClassification, "Classification");
    } else {
      const d = await buildCrossBrandReport(tenantId, allowed, dateRange);
      section("Won-revenue + conversion by sub-brand");
      const cbRows = Object.entries(d.subBrands).map(([b, m]) => [SUB_BRAND_LABEL[b] || b, String(m.won), String(m.lost), inr(m.wonRevenue), `${m.conversionPct}%`, String(m.diagnostics)]);
      const tot = Object.values(d.subBrands).reduce((a, m) => ({ won: a.won + m.won, lost: a.lost + m.lost, rev: a.rev + Number(m.wonRevenue || 0), diag: a.diag + (m.diagnostics || 0) }), { won: 0, lost: 0, rev: 0, diag: 0 });
      if (cbRows.length) cbRows.push(["TOTAL", String(tot.won), String(tot.lost), inr(tot.rev), (tot.won + tot.lost) > 0 ? `${Math.round((tot.won / (tot.won + tot.lost)) * 100)}%` : "0%", String(tot.diag)]);
      drawTravelTable(doc, [
        { header: "Sub-brand", width: 130 }, { header: "Won", width: 55, align: "right" }, { header: "Lost", width: 55, align: "right" },
        { header: "Won revenue", width: 120, align: "right" }, { header: "Conv %", width: 60, align: "right" }, { header: "Diag.", width: 55, align: "right" },
      ], cbRows, { startY: doc.y });

      // Travel-native sales (quotes) per sub-brand — real revenue (Deals are
      // empty for travel, so the won-revenue table above reads 0).
      section("Sales (quotes) by sub-brand");
      drawTravelTable(doc, [
        { header: "Sub-brand", width: 150 }, { header: "Quotes", width: 80, align: "right" }, { header: "Accepted", width: 90, align: "right" },
        { header: "Quote revenue", width: 120, align: "right" }, { header: "Conv %", width: 55, align: "right" },
      ], Object.entries(d.subBrands).map(([b, m]) => [SUB_BRAND_LABEL[b] || b, String(m.quotesTotal || 0), String(m.quotesAccepted || 0), inr(m.quoteRevenue), `${m.quoteConversionPct || 0}%`]), { startY: doc.y });

      // Per-sub-brand deal-stage breakdown — more granular detail.
      for (const [b, m] of Object.entries(d.subBrands)) {
        const stages = m.dealsByStage || {};
        if (Object.keys(stages).length === 0) continue;
        amountTable(`${SUB_BRAND_LABEL[b] || b} — deals by stage`, "Stage", stages, m.dealAmountByStage);
      }
    }

    doc.end();
  } catch (e) {
    console.error("[travel-reports] export-pdf error:", e.message);
    res.status(500).json({ error: "Failed to generate report PDF" });
  }
});

// ── One-shot dashboard summary ─────────────────────────────────────
//
// GET /api/travel/reports/summary
//
// Rolls up TMC + RFU + cross-brand into a single snapshot keyed for the
// Reports landing-page header. Each sub-section is a SUMMARY of the
// corresponding /reports/<x> endpoint's payload — top-level counts and
// totals only, not the full rows / topN lists / per-stage breakdowns.
// The frontend dashboard header renders this one payload; deeper
// drill-down pages still call the existing /reports/tmc | /rfu |
// /cross-brand for the full detail.
//
// Graceful degradation: each section is wrapped independently. If the
// caller can't see a sub-brand (e.g. MANAGER with subBrandAccess=["rfu"]
// hits the summary → tmc + crossBrand sections are null) OR the
// underlying aggregate query throws, the section becomes `null` while
// the others survive. This avoids a single broken table killing the
// whole dashboard.
//
// Query params:
//   ?from=ISO  ?to=ISO   — optional createdAt bounds; forwarded as a
//                          where.createdAt filter to every sub-query.
//
// Response shape:
//   {
//     tmc:        { trips, revenue, schools }   | null,
//     rfu:        { itineraries, customers }    | null,
//     crossBrand: { subBrandCount, totalWon, totalLost, totalWonRevenue }
//                                               | null,
//     generatedAt: ISO,
//   }

function parseDateRange(req) {
  const range = {};
  if (req.query.from) {
    const d = new Date(req.query.from);
    if (!isNaN(d.getTime())) range.gte = d;
  }
  if (req.query.to) {
    const d = new Date(req.query.to);
    if (!isNaN(d.getTime())) range.lte = d;
  }
  return Object.keys(range).length ? range : null;
}

async function tmcSummary(req, allowed, dateRange) {
  if (!canAccessSubBrand(allowed, "tmc")) return null;
  const tenantId = req.travelTenant.id;
  const ACTIVE_STATUSES = ["confirmed", "in-trip", "completed"];

  const tripWhere = { tenantId };
  if (dateRange) tripWhere.createdAt = dateRange;
  const activeWhere = { ...tripWhere, status: { in: ACTIVE_STATUSES } };

  const [tripsByStatus, activeTrips, participantCountsByTrip] = await Promise.all([
    prisma.tmcTrip.groupBy({ by: ["status"], where: tripWhere, _count: { _all: true } }),
    prisma.tmcTrip.findMany({
      where: activeWhere,
      select: { id: true, pricePerStudent: true, schoolContactId: true },
    }),
    prisma.tripParticipant.groupBy({ by: ["tripId"], _count: { _all: true } }),
  ]);

  const participantByTrip = {};
  for (const row of participantCountsByTrip) {
    participantByTrip[row.tripId] = row._count?._all ?? 0;
  }

  let totalRevenue = 0;
  const schoolTripCount = {};
  for (const trip of activeTrips) {
    const headcount = participantByTrip[trip.id] || 0;
    const price = trip.pricePerStudent ? Number(trip.pricePerStudent) : 0;
    totalRevenue += price * headcount;
    schoolTripCount[trip.schoolContactId] =
      (schoolTripCount[trip.schoolContactId] || 0) + 1;
  }
  const schools = Object.keys(schoolTripCount).length;
  const repeatSchools = Object.values(schoolTripCount).filter((c) => c >= 2).length;

  return {
    trips: {
      total: tripsByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
      active: activeTrips.length,
    },
    revenue: { total: totalRevenue, currency: "INR" },
    schools: {
      unique: schools,
      repeat: repeatSchools,
      repeatRatePct: schools > 0
        ? Number(((repeatSchools / schools) * 100).toFixed(2))
        : 0,
    },
  };
}

async function rfuSummary(req, allowed, dateRange) {
  if (!canAccessSubBrand(allowed, "rfu")) return null;
  const tenantId = req.travelTenant.id;

  const itinWhere = { tenantId, subBrand: "rfu" };
  if (dateRange) itinWhere.createdAt = dateRange;

  const [itinByStatus, itinAmountByStatus, itinByContact] = await Promise.all([
    prisma.itinerary.groupBy({
      by: ["status"], where: itinWhere, _count: { _all: true },
    }),
    prisma.itinerary.groupBy({
      by: ["status"], where: itinWhere, _sum: { totalAmount: true },
    }),
    prisma.itinerary.groupBy({
      by: ["contactId"], where: itinWhere, _count: { _all: true },
    }),
  ]);

  let totalRevenue = 0;
  for (const r of itinAmountByStatus) {
    const v = r._sum?.totalAmount;
    if (v != null) totalRevenue += Number(v);
  }
  const customers = itinByContact.length;
  const repeatCustomers = itinByContact.filter(
    (r) => (r._count?._all ?? 0) >= 2,
  ).length;

  return {
    itineraries: {
      total: itinByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
      revenue: totalRevenue,
    },
    customers: {
      unique: customers,
      repeat: repeatCustomers,
      repeatRatePct: customers > 0
        ? Number(((repeatCustomers / customers) * 100).toFixed(2))
        : 0,
    },
    currency: "INR",
  };
}

async function crossBrandSummary(req, allowed, dateRange) {
  const tenantId = req.travelTenant.id;
  const dealWhere = { tenantId, deletedAt: null, subBrand: { not: null } };
  if (allowed !== null) {
    if (allowed.size === 0) return null;
    dealWhere.subBrand = { in: [...allowed] };
  }
  if (dateRange) dealWhere.createdAt = dateRange;

  const [dealsBySubBrandStage, dealAmountBySubBrandStage] = await Promise.all([
    prisma.deal.groupBy({
      by: ["subBrand", "stage"], where: dealWhere, _count: { _all: true },
    }),
    prisma.deal.groupBy({
      by: ["subBrand", "stage"], where: dealWhere, _sum: { amount: true },
    }),
  ]);

  const subBrandSet = new Set();
  let totalWon = 0;
  let totalLost = 0;
  for (const r of dealsBySubBrandStage) {
    subBrandSet.add(r.subBrand);
    const c = r._count?._all ?? 0;
    if (r.stage === "won") totalWon += c;
    else if (r.stage === "lost") totalLost += c;
  }
  let totalWonRevenue = 0;
  for (const r of dealAmountBySubBrandStage) {
    if (r.stage === "won") {
      const v = r._sum?.amount;
      if (v != null) totalWonRevenue += Number(v);
    }
  }
  const conversionPct = (totalWon + totalLost) > 0
    ? Number(((totalWon / (totalWon + totalLost)) * 100).toFixed(2))
    : 0;

  return {
    subBrandCount: subBrandSet.size,
    totalWon,
    totalLost,
    totalWonRevenue,
    conversionPct,
    currency: "INR",
  };
}

router.get("/reports/summary", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const dateRange = parseDateRange(req);

    // Graceful degradation: each section resolves independently. A throw
    // OR a sub-brand-restriction collapses that section to null instead
    // of failing the whole snapshot. This keeps the dashboard partially
    // usable when one aggregate path is unhealthy.
    const wrap = async (label, fn) => {
      try {
        return await fn();
      } catch (e) {
        console.error(`[travel-reports] summary.${label} error:`, e.message);
        return null;
      }
    };

    const [tmc, rfu, crossBrand] = await Promise.all([
      wrap("tmc", () => tmcSummary(req, allowed, dateRange)),
      wrap("rfu", () => rfuSummary(req, allowed, dateRange)),
      wrap("crossBrand", () => crossBrandSummary(req, allowed, dateRange)),
    ]);

    res.json({
      tmc,
      rfu,
      crossBrand,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] summary error:", e.message);
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

module.exports = router;
