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

function safeJsonParse(value, fallback = {}) {
  if (!value || typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch (_e) { return fallback; }
}

function paymentDateWhere(dateRange) {
  if (!dateRange) return {};
  return { OR: [{ paidAt: dateRange }, { createdAt: dateRange }] };
}

async function travelQuotePayments(tenantId, dateRange = null) {
  let payments = [];
  try {
    payments = prisma.payment?.findMany
      ? await Promise.resolve(prisma.payment.findMany({
        where: {
          tenantId,
          status: "SUCCESS",
          ...paymentDateWhere(dateRange),
        },
        select: { id: true, invoiceId: true, amount: true, paidAt: true, createdAt: true, metadata: true, description: true },
      })).catch(() => [])
      : [];
  } catch (_e) {
    payments = [];
  }

  const refs = payments.map((payment) => {
    const meta = safeJsonParse(payment.metadata, {});
    const quoteId = Number(meta.quoteId);
    const metaInvoiceId = Number(meta.travelInvoiceId);
    const looksTravel = Boolean(
      meta.quoteId ||
      meta.travelInvoiceId ||
      String(meta.type || meta.kind || "").startsWith("travel-") ||
      /^Quote #\d+/i.test(String(payment.description || ""))
    );
    return {
      payment,
      meta,
      quoteId: Number.isFinite(quoteId) ? quoteId : null,
      travelInvoiceId: Number.isFinite(metaInvoiceId) ? metaInvoiceId : (looksTravel && payment.invoiceId ? Number(payment.invoiceId) : null),
      subBrand: meta.subBrand || null,
    };
  });

  const invoiceIds = [...new Set(refs.map((r) => r.travelInvoiceId).filter((id) => Number.isFinite(id)))];
  let invoices = [];
  if (invoiceIds.length) {
    try {
      invoices = prisma.travelInvoice?.findMany
        ? await Promise.resolve(prisma.travelInvoice.findMany({
          where: { tenantId, id: { in: invoiceIds } },
          select: { id: true, quoteId: true, subBrand: true },
        })).catch(() => [])
        : [];
    } catch (_e) {
      invoices = [];
    }
  }
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  return refs
    .map((ref) => {
      const invoice = ref.travelInvoiceId ? invoiceById.get(ref.travelInvoiceId) : null;
      const quoteId = ref.quoteId || (invoice?.quoteId ? Number(invoice.quoteId) : null);
      if (!Number.isFinite(quoteId)) return null;
      return {
        paymentId: ref.payment.id,
        quoteId,
        travelInvoiceId: ref.travelInvoiceId || invoice?.id || null,
        subBrand: ref.subBrand || invoice?.subBrand || null,
        amount: Number(ref.payment.amount || 0),
        paidAt: ref.payment.paidAt || ref.payment.createdAt,
        description: ref.payment.description || null,
      };
    })
    .filter(Boolean);
}

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
function reportPeriodLabel(dateRange) {
  if (!dateRange) return "All time";
  const from = dateRange.gte ? new Date(dateRange.gte).toLocaleDateString("en-IN") : null;
  const to = dateRange.lte ? new Date(dateRange.lte).toLocaleDateString("en-IN") : null;
  if (from && to) return `${from} - ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return "All time";
}

function reportDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function reportHumanize(value) {
  return String(value || "Unknown")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase()) || "Unknown";
}

function ensurePdfSpace(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - 54) doc.addPage();
}

function drawPdfHeader(doc, { title, subtitle, tenantName, period }) {
  const pageW = doc.page.width;
  doc.save();
  doc.rect(0, 0, pageW, 118).fill("#132238");
  doc.rect(0, 118, pageW, 8).fill("#5c7cfa");
  doc.restore();
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text(title, 50, 36, { width: pageW - 100 });
  doc.font("Helvetica").fontSize(11).fillColor("#d7def5").text(subtitle, 50, 67, { width: pageW - 100 });
  doc.fontSize(9).fillColor("#aeb9d8").text(`${tenantName || "Travel CRM"}  |  Period: ${period}  |  Generated: ${new Date().toLocaleString("en-IN")}`, 50, 92, { width: pageW - 100 });
  doc.y = 150;
}

function drawPdfSection(doc, label, note = "") {
  ensurePdfSpace(doc, 46);
  doc.x = 50;
  doc.moveDown(0.7);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#132238").text(label, 50, doc.y, { width: doc.page.width - 100 });
  doc.moveTo(50, doc.y + 3).lineTo(doc.page.width - 50, doc.y + 3).lineWidth(0.8).strokeColor("#d8deea").stroke();
  doc.moveDown(0.45);
  if (note) {
    doc.font("Helvetica").fontSize(8.5).fillColor("#5f6b7a").text(note, 50, doc.y, { width: doc.page.width - 100 });
    doc.moveDown(0.25);
  }
  doc.x = 50;
  doc.fillColor("#111827");
}

function drawPdfMetricCards(doc, metrics) {
  const cols = 3;
  const gap = 10;
  const w = (doc.page.width - 100 - gap * (cols - 1)) / cols;
  const h = 56;
  let x = 50;
  let y = doc.y;
  metrics.forEach((metric, i) => {
    if (i > 0 && i % cols === 0) {
      x = 50;
      y += h + gap;
    }
    if (y + h > doc.page.height - 60) {
      doc.addPage();
      x = 50;
      y = 54;
    }
    doc.save();
    doc.roundedRect(x, y, w, h, 6).fillAndStroke("#f7f9fc", "#d8deea");
    doc.restore();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#5f6b7a").text(String(metric.label).toUpperCase(), x + 10, y + 10, { width: w - 20, lineBreak: false, ellipsis: true });
    doc.font("Helvetica-Bold").fontSize(15).fillColor(metric.negative ? "#dc2626" : "#132238").text(String(metric.value), x + 10, y + 27, { width: w - 20, lineBreak: false, ellipsis: true });
    x += w + gap;
  });
  doc.y = y + h + 10;
}

function drawPdfFooters(doc, tenantName) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - 48;
    const oldX = doc.x;
    const oldY = doc.y;
    doc.save();
    doc.moveTo(50, y - 7).lineTo(doc.page.width - 50, y - 7).lineWidth(0.4).strokeColor("#d8deea").stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor("#7a8493")
      .text(tenantName || "Travel CRM", 50, y, { width: 220, lineBreak: false, ellipsis: true })
      .text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - 170, y, { width: 120, align: "right", lineBreak: false });
    doc.restore();
    doc.x = oldX;
    doc.y = oldY;
  }
}

// Render a bordered, columnar table into a pdfkit doc (shared by the travel
// report PDF export). columns: [{ header, width, align? }]; rows: cell-string
// arrays. Header fill + per-cell ellipsis clipping + zebra + page-break.
function drawTravelTable(doc, columns, rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return doc.y;

  const x = opts.x || 50;
  const baseRowH = opts.rowHeight || 20;
  const pad = 5;
  const totalW = columns.reduce((sum, c) => sum + c.width, 0);
  const bottom = doc.page.height - 62;
  let y = opts.startY != null ? opts.startY : doc.y;

  const drawHeader = () => {
    if (y + baseRowH > bottom) { doc.addPage(); y = 54; }
    doc.save();
    doc.roundedRect(x, y, totalW, baseRowH, 3).fill("#132238");
    doc.restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    let cx = x;
    for (const c of columns) {
      doc.text(String(c.header), cx + pad, y + 6, { width: c.width - pad * 2, align: c.align || "left", lineBreak: false, ellipsis: true });
      cx += c.width;
    }
    y += baseRowH;
  };

  const cellHeight = (value, column) => {
    const text = value == null ? "" : String(value);
    const width = column.width - pad * 2;
    if (column.nowrap) return 8;
    return doc.heightOfString(text, { width, align: column.align || "left" });
  };

  drawHeader();
  doc.font("Helvetica").fontSize(7.8);
  rows.forEach((row, i) => {
    const contentH = Math.max(...columns.map((column, ci) => cellHeight(row[ci], column)));
    const rowH = Math.max(baseRowH, Math.ceil(contentH + 12));
    if (y + rowH > bottom) {
      doc.addPage();
      y = 54;
      drawHeader();
      doc.font("Helvetica").fontSize(7.8);
    }
    doc.save();
    doc.rect(x, y, totalW, rowH).fill(i % 2 ? "#f7f9fc" : "#ffffff");
    doc.restore();
    doc.fillColor("#1f2937");
    let cx = x;
    for (let ci = 0; ci < columns.length; ci += 1) {
      const c = columns[ci];
      const text = row[ci] == null ? "" : String(row[ci]);
      doc.text(text, cx + pad, y + 6, {
        width: c.width - pad * 2,
        align: c.align || "left",
        lineBreak: !c.nowrap,
        ellipsis: Boolean(c.nowrap),
      });
      cx += c.width;
    }
    doc.save();
    doc.moveTo(x, y + rowH).lineTo(x + totalW, y + rowH).lineWidth(0.25).strokeColor("#e5eaf1").stroke();
    doc.restore();
    y += rowH;
  });
  doc.x = 50;
  doc.y = y + 8;
  return doc.y;
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

async function quoteAgentActivityBySubBrand(tenantId, subBrand, dateRange = null) {
  const quoteActions = [
    "CREATE", "UPDATE", "QUOTE_SHARE", "TRAVEL_QUOTE_ACCEPTED",
    "TRAVEL_QUOTE_DECLINED", "TRAVEL_QUOTE_DUPLICATED", "TRAVEL_QUOTE_EXTENDED",
    "TRAVEL_QUOTE_CONVERTED", "TRAVEL_QUOTE_PDF_DOWNLOADED",
  ];
  const auditWhere = { tenantId, entity: "TravelQuote", userId: { not: null }, action: { in: quoteActions } };
  if (dateRange) auditWhere.createdAt = dateRange;

  let auditPromise = Promise.resolve([]);
  try {
    auditPromise = prisma.auditLog?.findMany
      ? Promise.resolve(prisma.auditLog.findMany({
        where: auditWhere,
        orderBy: { createdAt: "asc" },
        select: { userId: true, action: true, entityId: true, createdAt: true },
      })).catch(() => [])
      : Promise.resolve([]);
  } catch (_e) {
    auditPromise = Promise.resolve([]);
  }
  let snapshotPromise = Promise.resolve([]);
  try {
    snapshotPromise = prisma.travelQuoteSnapshot?.findMany
      ? Promise.resolve(prisma.travelQuoteSnapshot.findMany({
        where: { tenantId, changedBy: "customer", statusAfter: { in: ["Accepted", "Rejected"] }, ...(dateRange ? { createdAt: dateRange } : {}) },
        orderBy: { createdAt: "asc" },
        select: { quoteId: true, statusAfter: true, createdAt: true },
      })).catch(() => [])
      : Promise.resolve([]);
  } catch (_e) {
    snapshotPromise = Promise.resolve([]);
  }
  const [auditRows, decisionSnapshots] = await Promise.all([auditPromise, snapshotPromise]);
  const paymentRows = (await travelQuotePayments(tenantId, dateRange))
    .filter((row) => row.subBrand === subBrand || !row.subBrand);

  const quoteIds = [...new Set([
    ...auditRows.map((r) => r.entityId).filter((id) => id != null),
    ...decisionSnapshots.map((s) => s.quoteId).filter((id) => id != null),
    ...paymentRows.map((p) => p.quoteId).filter((id) => id != null),
  ])];
  let scopedQuotes = [];
  if (quoteIds.length) {
    try {
      scopedQuotes = prisma.travelQuote?.findMany
        ? await Promise.resolve(prisma.travelQuote.findMany({
          where: { tenantId, id: { in: quoteIds }, subBrand },
          select: { id: true, status: true, totalAmount: true, currency: true, contactId: true },
        })).catch(() => [])
        : [];
    } catch (_e) {
      scopedQuotes = [];
    }
  }
  const scopedQuoteIds = new Set(scopedQuotes.map((q) => q.id));
  const quoteById = new Map(scopedQuotes.map((q) => [q.id, q]));
  const scopedAuditRows = auditRows.filter((row) => scopedQuoteIds.has(row.entityId));
  const scopedDecisionSnapshots = decisionSnapshots.filter((row) => scopedQuoteIds.has(row.quoteId));

  const createdByQuote = new Map();
  const lastShareByQuote = new Map();
  const existingDecisionKeys = new Set();
  for (const row of scopedAuditRows) {
    if (row.entityId == null || row.userId == null) continue;
    if (row.action === "CREATE" && !createdByQuote.has(row.entityId)) createdByQuote.set(row.entityId, row.userId);
    if (row.action === "QUOTE_SHARE") lastShareByQuote.set(row.entityId, row.userId);
    if (row.action === "TRAVEL_QUOTE_ACCEPTED" || row.action === "TRAVEL_QUOTE_DECLINED") existingDecisionKeys.add(`${row.entityId}:${row.userId}:${row.action}`);
  }

  const attributedRows = [];
  for (const snap of scopedDecisionSnapshots) {
    const action = snap.statusAfter === "Accepted" ? "TRAVEL_QUOTE_ACCEPTED" : "TRAVEL_QUOTE_DECLINED";
    const userId = lastShareByQuote.get(snap.quoteId) || createdByQuote.get(snap.quoteId) || null;
    if (!userId) continue;
    const key = `${snap.quoteId}:${userId}:${action}`;
    if (!existingDecisionKeys.has(key)) attributedRows.push({ userId, action, entityId: snap.quoteId, createdAt: snap.createdAt });
  }

  const scopedPaymentRows = paymentRows.filter((row) => scopedQuoteIds.has(row.quoteId));
  for (const payment of scopedPaymentRows) {
    const userId = lastShareByQuote.get(payment.quoteId) || createdByQuote.get(payment.quoteId) || null;
    if (!userId) continue;
    attributedRows.push({
      userId,
      action: "TRAVEL_QUOTE_PAYMENT_COLLECTED",
      entityId: payment.quoteId,
      createdAt: payment.paidAt,
      amount: payment.amount,
      paymentId: payment.paymentId,
      travelInvoiceId: payment.travelInvoiceId,
      description: payment.description,
    });
  }

  const rows = [...scopedAuditRows, ...attributedRows];
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id) => id != null))];
  let users = [];
  if (userIds.length) {
    try {
      users = prisma.user?.findMany
        ? await Promise.resolve(prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })).catch(() => [])
        : [];
    } catch (_e) {
      users = [];
    }
  }
  const userById = Object.fromEntries(users.map((u) => [u.id, u]));
  const agents = {};
  for (const row of rows) {
    const id = row.userId;
    const user = userById[id];
    agents[id] ||= { userId: id, name: user?.name || user?.email || `User #${id}`, totalActions: 0, createdQuotes: 0, sentQuotes: 0, acceptedQuotes: 0, declinedQuotes: 0, updatedQuotes: 0, paidQuotes: 0, paymentAmount: 0 };
    agents[id].totalActions += 1;
    if (row.action === "CREATE") agents[id].createdQuotes += 1;
    if (row.action === "QUOTE_SHARE") agents[id].sentQuotes += 1;
    if (row.action === "TRAVEL_QUOTE_ACCEPTED") agents[id].acceptedQuotes += 1;
    if (row.action === "TRAVEL_QUOTE_DECLINED") agents[id].declinedQuotes += 1;
    if (row.action === "UPDATE") agents[id].updatedQuotes += 1;
    if (row.action === "TRAVEL_QUOTE_PAYMENT_COLLECTED") {
      agents[id].paidQuotes += 1;
      agents[id].paymentAmount += Number(row.amount || 0);
    }
  }
  const paymentDetails = rows
    .filter((row) => row.action === "TRAVEL_QUOTE_PAYMENT_COLLECTED")
    .map((row) => {
      const quote = quoteById.get(row.entityId);
      const user = userById[row.userId];
      return {
        paymentId: row.paymentId || null,
        travelInvoiceId: row.travelInvoiceId || null,
        userId: row.userId,
        agentName: user?.name || user?.email || `User #${row.userId}`,
        quoteId: row.entityId,
        quoteStatus: quote?.status || null,
        quoteTotal: quote?.totalAmount != null ? Number(quote.totalAmount) : null,
        currency: quote?.currency || "INR",
        contactId: quote?.contactId || null,
        amount: Number(row.amount || 0),
        paidAt: row.createdAt || null,
        description: row.description || null,
      };
    })
    .sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));
  return { agents: Object.values(agents).sort((a, b) => b.totalActions - a.totalActions).slice(0, 10), payments: paymentDetails };
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
          tripCode: true,
          destination: true,
          status: true,
          departDate: true,
          returnDate: true,
          pricePerStudent: true,
          schoolContactId: true,
          updatedAt: true,
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
    const schoolContactIds = [...new Set(activeTrips.map((trip) => trip.schoolContactId).filter((id) => id != null))];
    let schoolContacts = [];
    if (schoolContactIds.length) {
      try {
        schoolContacts = prisma.contact?.findMany
          ? await Promise.resolve(prisma.contact.findMany({
            where: { tenantId, id: { in: schoolContactIds } },
            select: { id: true, name: true, email: true },
          })).catch(() => [])
          : [];
      } catch (_e) {
        schoolContacts = [];
      }
    }
    const schoolById = new Map(schoolContacts.map((school) => [school.id, school]));
    const revenueRows = activeTrips
      .map((trip) => {
        const participants = participantByTrip[trip.id] || 0;
        const pricePerStudent = trip.pricePerStudent ? Number(trip.pricePerStudent) : 0;
        return {
          id: trip.id,
          tripCode: trip.tripCode || null,
          destination: trip.destination,
          status: trip.status,
          schoolContactId: trip.schoolContactId || null,
          schoolName: schoolById.get(trip.schoolContactId)?.name || schoolById.get(trip.schoolContactId)?.email || null,
          departDate: trip.departDate,
          returnDate: trip.returnDate,
          participants,
          pricePerStudent,
          revenue: pricePerStudent * participants,
          updatedAt: trip.updatedAt,
        };
      })
      .sort((a, b) => Number(b.revenue || 0) - Number(a.revenue || 0));
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
        rows: revenueRows,
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
      rfuItineraryRows,
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
      prisma.itinerary.findMany({
        where: itinWhere,
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: {
          id: true,
          destination: true,
          status: true,
          totalAmount: true,
          currency: true,
          pax: true,
          contactId: true,
          createdAt: true,
          updatedAt: true,
          contact: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const customers = itinByContact.length;
    const repeatCustomers = itinByContact.filter((r) => (r._count?._all ?? 0) >= 2).length;
    const [quotes, agentProductivity] = await Promise.all([
      quoteFunnel(tenantId, "rfu", dateRange),
      quoteAgentActivityBySubBrand(tenantId, "rfu", dateRange),
    ]);

    return {
      quotes,
      agentProductivity,
      itineraries: {
        total: itinByStatus.reduce((s, r) => s + (r._count?._all ?? 0), 0),
        byStatus: flattenGroupCount(itinByStatus, "status"),
        amountByStatus: flattenGroupSum(itinAmountByStatus, "status", "totalAmount"),
      },
      revenueRows: rfuItineraryRows.map((row) => ({
        id: row.id,
        destination: row.destination,
        status: row.status,
        amount: row.totalAmount != null ? Number(row.totalAmount) : 0,
        currency: row.currency || "INR",
        pax: row.pax || 1,
        contactId: row.contactId || null,
        contactName: row.contact?.name || row.contact?.email || null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
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
        const accepted = Object.entries(c).reduce((sum, [status, count]) => sum + (isAcceptedQuoteStatus(status) ? count : 0), 0); const rejected = Object.entries(c).reduce((sum, [status, count]) => sum + (isRejectedQuoteStatus(status) ? count : 0), 0);
        subBrands[b].quotesTotal = total;
        subBrands[b].quotesAccepted = accepted;
        subBrands[b].quoteRevenue = Object.entries(rv).reduce((sum, [status, amount]) => sum + (isAcceptedQuoteStatus(status) ? Number(amount || 0) : 0), 0);
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
    const requestedTab = String(req.query.tab || "overview");
    const tab = ["overview", "tmc", "rfu", "cross-brand"].includes(requestedTab) ? requestedTab : "overview";
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const tenantId = req.travelTenant.id;
    const dateRange = parseDateRange(req);
    if (tab === "tmc" && !canAccessSubBrand(allowed, "tmc")) {
      return res.status(403).json({ error: "TMC sub-brand access required", code: "SUB_BRAND_DENIED" });
    }
    if (tab === "rfu" && !canAccessSubBrand(allowed, "rfu")) {
      return res.status(403).json({ error: "RFU sub-brand access required", code: "SUB_BRAND_DENIED" });
    }

    const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });
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

    const TITLES = { overview: "Complete Travel Report", tmc: "TMC - School Trips", rfu: "RFU - Umrah", "cross-brand": "Cross-brand Performance" };
    const tenantName = req.travelTenant?.name || req.travelTenant?.slug || "Travel CRM";
    const period = reportPeriodLabel(dateRange);
    drawPdfHeader(doc, {
      title: "Travel Reports",
      subtitle: TITLES[tab],
      tenantName,
      period,
    });

    const kpiTable = (pairs) => {
      drawPdfSection(doc, "Executive Summary");
      drawPdfMetricCards(doc, pairs.map(([label, value, negative]) => ({ label, value, negative })));
    };
    const tableSection = (label, columns, rows, note = "", opts = {}) => {
      if (!Array.isArray(rows) || rows.length === 0) return false;
      drawPdfSection(doc, label, note);
      drawTravelTable(doc, columns, rows, { startY: doc.y, ...opts });
      return true;
    };
    const countTable = (label, obj, keyHdr, labeler = reportHumanize) => {
      const entries = Object.entries(obj || {}).filter(([, v]) => Number(v || 0) !== 0);
      if (entries.length === 0) return false;
      return tableSection(label, [{ header: keyHdr, width: 350 }, { header: "Count", width: 145, align: "right" }],
        entries.map(([k, v]) => [labeler(k), String(v)]));
    };
    const amountTable = (label, keyHdr, byCount, byAmount, labeler = reportHumanize) => {
      const keys = new Set([...Object.keys(byCount || {}), ...Object.keys(byAmount || {})]);
      const entries = [...keys].filter((k) => Number((byCount || {})[k] || 0) !== 0 || Number((byAmount || {})[k] || 0) !== 0);
      if (entries.length === 0) return false;
      const totC = entries.reduce((sum, k) => sum + Number((byCount || {})[k] || 0), 0);
      const totA = entries.reduce((sum, k) => sum + Number((byAmount || {})[k] || 0), 0);
      const rows = entries.map((k) => [labeler(k), String((byCount || {})[k] || 0), inr((byAmount || {})[k] || 0)]);
      rows.push(["TOTAL", String(totC), inr(totA)]);
      return tableSection(label, [{ header: keyHdr, width: 210 }, { header: "Count", width: 95, align: "right" }, { header: "Amount", width: 190, align: "right" }], rows);
    };
    const agentRows = (agents = []) => agents.map((a) => [
      a.name || "Unassigned",
      String(a.totalActions || 0),
      String(a.createdQuotes || 0),
      String(a.sentQuotes || 0),
      String(a.acceptedQuotes || 0),
      String(a.paidQuotes || 0),
      inr(a.paymentAmount || 0),
    ]);
    const agentPerformanceTable = (label, agents, note = "Quote actions are attributed to the staff member who performed them; collections are attributed to the advisor who shared the paid quote, falling back to creator.") => tableSection(label, [
      { header: "Agent", width: 165 }, { header: "Actions", width: 55, align: "right" }, { header: "Created", width: 60, align: "right" },
      { header: "Sent", width: 50, align: "right" }, { header: "Accepted", width: 65, align: "right" }, { header: "Paid", width: 45, align: "right" }, { header: "Collected", width: 85, align: "right" },
    ], agentRows(agents), note);

    if (tab === "overview") {
      const [cross, agentProductivity, tmcData, rfuData] = await Promise.all([
        buildCrossBrandReport(tenantId, allowed, dateRange),
        agentProductivitySummary(req, allowed, dateRange),
        canAccessSubBrand(allowed, "tmc") ? buildTmcReport(tenantId, dateRange) : Promise.resolve(null),
        canAccessSubBrand(allowed, "rfu") ? buildRfuReport(tenantId, dateRange) : Promise.resolve(null),
      ]);
      const brands = Object.entries(cross.subBrands || {});
      const totalQuoteRevenue = brands.reduce((sum, [, m]) => sum + Number(m.quoteRevenue || 0), 0);
      const totalQuotes = brands.reduce((sum, [, m]) => sum + Number(m.quotesTotal || 0), 0);
      const totalAccepted = brands.reduce((sum, [, m]) => sum + Number(m.quotesAccepted || 0), 0);
      const totalDiagnostics = brands.reduce((sum, [, m]) => sum + Number(m.diagnostics || 0), 0);
      const totalCollected = (agentProductivity.agents || []).reduce((sum, a) => sum + Number(a.paymentAmount || 0), 0);
      kpiTable([
        ["Quote Revenue", inr(totalQuoteRevenue)],
        ["Collected", inr(totalCollected)],
        ["Quotes", String(totalQuotes)],
        ["Accepted Quotes", String(totalAccepted)],
        ["Quote Conversion", totalQuotes > 0 ? `${Number(((totalAccepted / totalQuotes) * 100).toFixed(2))}%` : "0%"],
        ["Diagnostics", String(totalDiagnostics)],
      ]);
      tableSection("Sub-brand Performance", [
        { header: "Sub-brand", width: 115 }, { header: "Quotes", width: 55, align: "right" }, { header: "Accepted", width: 65, align: "right" },
        { header: "Quote Revenue", width: 105, align: "right" }, { header: "Conversion", width: 75, align: "right" }, { header: "Diagnostics", width: 80, align: "right" },
      ], brands.map(([b, m]) => [
        SUB_BRAND_LABEL[b] || reportHumanize(b),
        String(m.quotesTotal || 0),
        String(m.quotesAccepted || 0),
        inr(m.quoteRevenue || 0),
        `${m.quoteConversionPct || 0}%`,
        String(m.diagnostics || 0),
      ]), "This is the org-level travel view. Revenue here is from travel quotes, not generic CRM deals.", { rowHeight: 22 });
      agentPerformanceTable("Agent Performance", (agentProductivity.agents || []).slice(0, 10), "Top 10 agents by report activity and successful collections.");
      if (tmcData) {
        tableSection("TMC Snapshot", [
          { header: "Metric", width: 300 }, { header: "Value", width: 195, align: "right" },
        ], [
          ["Trip revenue", inr(tmcData.revenue?.total || 0)],
          ["Active trips", String(tmcData.trips?.active || 0)],
          ["All trips", String(tmcData.trips?.total || 0)],
          ["Schools", String(tmcData.schools?.unique || 0)],
          ["Repeat schools", `${tmcData.schools?.repeat || 0} (${tmcData.schools?.repeatRatePct || 0}%)`],
        ], "Compact TMC summary. Full trip-level rows stay available in the TMC report tab and trip drill-downs.");
        amountTable("TMC Quote Pipeline", "Status", tmcData.quotes.byStatus, tmcData.quotes.amountByStatus);
        countTable("TMC Trip Status", tmcData.trips.byStatus, "Status");
      }
      if (rfuData) {
        const rfuItineraryRevenue = Object.values(rfuData.itineraries?.amountByStatus || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        const rfuCollections = (rfuData.agentProductivity?.payments || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        tableSection("RFU Snapshot", [
          { header: "Metric", width: 300 }, { header: "Value", width: 195, align: "right" },
        ], [
          ["Itinerary revenue", inr(rfuItineraryRevenue)],
          ["Collected", inr(rfuCollections)],
          ["Itineraries", String(rfuData.itineraries?.total || 0)],
          ["Customers", String(rfuData.customers?.unique || 0)],
          ["Repeat customers", `${rfuData.customers?.repeat || 0} (${rfuData.customers?.repeatRatePct || 0}%)`],
        ], "Compact RFU summary. Full itinerary and collection rows stay available in the RFU report tab and detailed screens.");
        amountTable("RFU Quote Pipeline", "Status", rfuData.quotes.byStatus, rfuData.quotes.amountByStatus);
        amountTable("RFU Itinerary Revenue by Status", "Status", rfuData.itineraries.byStatus, rfuData.itineraries.amountByStatus);
      }
    } else if (tab === "tmc") {
      const d = await buildTmcReport(tenantId, dateRange);
      kpiTable([
        ["Revenue", inr(d.revenue.total)],
        ["Active Trips", String(d.trips.active)],
        ["All Trips", String(d.trips.total)],
        ["Schools", String(d.schools.unique)],
        ["Repeat Schools", `${d.schools.repeat} (${d.schools.repeatRatePct}%)`],
        ["Top Destination", d.revenue.topDestinations[0]?.destination || "-"],
      ]);

      tableSection("Trip Revenue Source Detail", [
        { header: "Trip", width: 88 }, { header: "Destination", width: 92 }, { header: "School", width: 115 },
        { header: "Status", width: 62 }, { header: "Pax", width: 38, align: "right" }, { header: "Rate", width: 72, align: "right" }, { header: "Revenue", width: 78, align: "right" },
      ], (d.revenue.rows || []).map((r) => [
        r.tripCode || `Trip #${r.id}`,
        r.destination || "-",
        r.schoolName || (r.schoolContactId ? `Contact #${r.schoolContactId}` : "-"),
        reportHumanize(r.status),
        String(r.participants || 0),
        inr(r.pricePerStudent || 0),
        inr(r.revenue || 0),
      ]), "Revenue = price per student multiplied by participant count. Cancelled trips are excluded.", { rowHeight: 22 });

      tableSection("Top Destinations by Revenue", [{ header: "Destination", width: 360 }, { header: "Revenue", width: 135, align: "right" }],
        d.revenue.topDestinations.map((r) => [r.destination, inr(r.revenue)]));
      const tmcAgentProductivity = await quoteAgentActivityBySubBrand(tenantId, "tmc", dateRange);
      agentPerformanceTable("Agent Performance", tmcAgentProductivity.agents);
      amountTable("Quote Pipeline", "Status", d.quotes.byStatus, d.quotes.amountByStatus);
      countTable("Trip Status", d.trips.byStatus, "Status");
      amountTable("Deal Funnel", "Stage", d.deals.byStage, d.deals.amountByStage);
      countTable("Diagnostics by Lead Type", d.diagnostics.byClassification, "Lead type");
    } else if (tab === "rfu") {
      const d = await buildRfuReport(tenantId, dateRange);
      const itineraryRevenue = Object.values(d.itineraries.amountByStatus || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      const quoteRevenue = Object.entries(d.quotes.amountByStatus || {}).reduce((sum, [status, amount]) => sum + (isAcceptedQuoteStatus(status) ? Number(amount || 0) : 0), 0);
      const collected = (d.agentProductivity?.payments || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      kpiTable([
        ["Itinerary Revenue", inr(itineraryRevenue)],
        ["Accepted Quote Value", inr(quoteRevenue)],
        ["Collected", inr(collected)],
        ["Itineraries", String(d.itineraries.total)],
        ["Customers", String(d.customers.unique)],
        ["Repeat Customers", `${d.customers.repeat} (${d.customers.repeatRatePct}%)`],
      ]);

      tableSection("Itinerary Revenue Source Detail", [
        { header: "Itinerary", width: 70 }, { header: "Destination", width: 130 }, { header: "Customer", width: 105 },
        { header: "Status", width: 75 }, { header: "Pax", width: 38, align: "right" }, { header: "Revenue", width: 82, align: "right" },
      ], (d.revenueRows || []).map((r) => [
        `#${r.id}`,
        r.destination || "-",
        r.contactName || "-",
        reportHumanize(r.status),
        String(r.pax || 1),
        inr(r.amount || 0),
      ]), "Rows are tenant-scoped RFU itineraries behind the revenue total.", { rowHeight: 22 });

      tableSection("Advisor Collections", [
        { header: "Advisor", width: 130 }, { header: "Quote", width: 58 }, { header: "Status", width: 82 },
        { header: "Quote Total", width: 95, align: "right" }, { header: "Collected", width: 85, align: "right" }, { header: "Paid On", width: 80 },
      ], (d.agentProductivity?.payments || []).map((r) => [
        r.agentName || "Unassigned",
        r.quoteId ? `#${r.quoteId}` : "-",
        reportHumanize(r.quoteStatus),
        r.quoteTotal != null ? inr(r.quoteTotal) : "-",
        inr(r.amount || 0),
        reportDate(r.paidAt),
      ]), "Successful payment rows attributed to the advisor who shared the quote, falling back to quote creator.", { rowHeight: 22 });

      agentPerformanceTable("Advisor Activity Summary", d.agentProductivity?.agents || []);

      amountTable("Quote Pipeline", "Status", d.quotes.byStatus, d.quotes.amountByStatus);
      amountTable("Itinerary Revenue by Status", "Status", d.itineraries.byStatus, d.itineraries.amountByStatus);
      countTable("Diagnostics by Package Fit", d.diagnostics.byTier, "Package fit");
      countTable("Diagnostics by Lead Type", d.diagnostics.byClassification, "Lead type");
    } else {
      const d = await buildCrossBrandReport(tenantId, allowed, dateRange);
      const agentProductivity = await agentProductivitySummary(req, allowed, dateRange);
      const brands = Object.entries(d.subBrands || {});
      const totalLegacyDealRevenue = brands.reduce((sum, [, m]) => sum + Number(m.wonRevenue || 0), 0);
      const totalQuoteRevenue = brands.reduce((sum, [, m]) => sum + Number(m.quoteRevenue || 0), 0);
      const totalQuotes = brands.reduce((sum, [, m]) => sum + Number(m.quotesTotal || 0), 0);
      const totalAccepted = brands.reduce((sum, [, m]) => sum + Number(m.quotesAccepted || 0), 0);
      const totalDiagnostics = brands.reduce((sum, [, m]) => sum + Number(m.diagnostics || 0), 0);
      kpiTable([
        ["Quote Revenue", inr(totalQuoteRevenue)],
        ["Quotes", String(totalQuotes)],
        ["Accepted Quotes", String(totalAccepted)],
        ["Quote Conversion", totalQuotes > 0 ? `${Number(((totalAccepted / totalQuotes) * 100).toFixed(2))}%` : "0%"],
        ["Diagnostics", String(totalDiagnostics)],
        ["Legacy Deal Won Revenue", inr(totalLegacyDealRevenue)],
      ]);

      tableSection("Cross-brand Performance", [
        { header: "Sub-brand", width: 105 }, { header: "Quotes", width: 45, align: "right" }, { header: "Accepted", width: 55, align: "right" },
        { header: "Quote Rev.", width: 85, align: "right" }, { header: "Conv.", width: 45, align: "right" }, { header: "Diagnostics", width: 55, align: "right" },
        { header: "Legacy Rev.", width: 75, align: "right" }, { header: "Won", width: 35, align: "right" },
      ], brands.map(([b, m]) => [
        SUB_BRAND_LABEL[b] || reportHumanize(b),
        String(m.quotesTotal || 0),
        String(m.quotesAccepted || 0),
        inr(m.quoteRevenue || 0),
        `${m.quoteConversionPct || 0}%`,
        String(m.diagnostics || 0),
        inr(m.wonRevenue || 0),
        String(m.won || 0),
      ]), "Quote revenue is travel-native. Legacy deal columns come from generic CRM Deal rows when present.", { rowHeight: 22 });
      agentPerformanceTable("Agent Performance", agentProductivity.agents);

      for (const [b, m] of brands) {
        amountTable(`${SUB_BRAND_LABEL[b] || reportHumanize(b)} - Legacy Deals by Stage`, "Stage", m.dealsByStage, m.dealAmountByStage);
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

const ACCEPTED_QUOTE_STATUSES = new Set(["Accepted", "advance_paid", "fully_paid"]);
const REJECTED_QUOTE_STATUSES = new Set(["Rejected"]);

function isAcceptedQuoteStatus(status) {
  return ACCEPTED_QUOTE_STATUSES.has(String(status || ""));
}

function isRejectedQuoteStatus(status) {
  return REJECTED_QUOTE_STATUSES.has(String(status || ""));
}
function parseDateRange(req) {
  const range = {};
  if (req.query.from) {
    const d = new Date(String(req.query.from));
    if (!isNaN(d.getTime())) range.gte = d;
  }
  if (req.query.to) {
    const d = new Date(String(req.query.to));
    if (!isNaN(d.getTime())) {
      // Date-only strings (YYYY-MM-DD) should cover the full calendar day.
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) {
        d.setHours(23, 59, 59, 999);
      }
      range.lte = d;
    }
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


function allowedSubBrandArray(allowed) {
  return allowed === null ? null : [...allowed];
}

function applyAllowedSubBrands(where, allowed) {
  const list = allowedSubBrandArray(allowed);
  if (list !== null) where.subBrand = { in: list };
  return where;
}

function sumDecimal(value) {
  return value == null ? 0 : Number(value);
}

async function salesFunnelSummary(req, allowed, dateRange) {
  const tenantId = req.travelTenant.id;
  if (allowed !== null && allowed.size === 0) return null;
  const where = applyAllowedSubBrands({ tenantId }, allowed);
  if (dateRange) where.createdAt = dateRange;

  const [countRows, amountRows] = await Promise.all([
    prisma.travelQuote.groupBy({
      by: ["subBrand", "status"], where, _count: { _all: true },
    }),
    prisma.travelQuote.groupBy({
      by: ["subBrand", "status"], where, _sum: { totalAmount: true },
    }),
  ]);

  const byStatus = {};
  const bySubBrand = {};
  for (const row of countRows) {
    const count = row._count?._all ?? 0;
    byStatus[row.status] = (byStatus[row.status] || 0) + count;
    bySubBrand[row.subBrand] ||= { total: 0, accepted: 0, revenue: 0 };
    bySubBrand[row.subBrand].total += count;
    if (isAcceptedQuoteStatus(row.status)) bySubBrand[row.subBrand].accepted += count;
  }
  for (const row of amountRows) {
    const amount = sumDecimal(row._sum?.totalAmount);
    if (isAcceptedQuoteStatus(row.status)) {
      bySubBrand[row.subBrand] ||= { total: 0, accepted: 0, revenue: 0 };
      bySubBrand[row.subBrand].revenue += amount;
    }
  }
  const total = Object.values(byStatus).reduce((a, n) => a + n, 0);
  const accepted = Object.entries(byStatus).reduce((sum, [status, count]) => sum + (isAcceptedQuoteStatus(status) ? count : 0), 0);
  const rejected = Object.entries(byStatus).reduce((sum, [status, count]) => sum + (isRejectedQuoteStatus(status) ? count : 0), 0);
  return {
    total,
    accepted,
    rejected,
    conversionPct: accepted + rejected > 0 ? Number(((accepted / (accepted + rejected)) * 100).toFixed(2)) : 0,
    byStatus,
    bySubBrand,
    currency: "INR",
  };
}

async function subBrandPnlSummary(req, allowed, dateRange) {
  const tenantId = req.travelTenant.id;
  if (allowed !== null && allowed.size === 0) return null;
  const invoiceWhere = applyAllowedSubBrands({ tenantId, status: { in: ["Issued", "Partial", "Paid"] } }, allowed);
  const itemWhere = { itinerary: { tenantId } };
  const list = allowedSubBrandArray(allowed);
  if (list !== null) itemWhere.itinerary.subBrand = { in: list };
  if (dateRange) {
    invoiceWhere.createdAt = dateRange;
    itemWhere.createdAt = dateRange;
  }

  const [invoiceRows, costItems] = await Promise.all([
    prisma.travelInvoice.groupBy({
      by: ["subBrand"], where: invoiceWhere, _sum: { totalAmount: true }, _count: { _all: true },
    }),
    prisma.itineraryItem.findMany({
      where: itemWhere,
      select: { unitCost: true, quantity: true, itinerary: { select: { subBrand: true } } },
    }),
  ]);

  const rows = {};
  for (const row of invoiceRows) {
    rows[row.subBrand] ||= { revenue: 0, capturedCost: 0, invoiceCount: 0 };
    rows[row.subBrand].revenue += sumDecimal(row._sum?.totalAmount);
    rows[row.subBrand].invoiceCount += row._count?._all ?? 0;
  }
  for (const item of costItems) {
    const subBrand = item.itinerary?.subBrand || "unknown";
    rows[subBrand] ||= { revenue: 0, capturedCost: 0, invoiceCount: 0 };
    rows[subBrand].capturedCost += sumDecimal(item.unitCost) * (sumDecimal(item.quantity) || 1);
  }
  for (const row of Object.values(rows)) {
    row.grossProfit = row.revenue - row.capturedCost;
    row.marginPct = row.revenue > 0 ? Number(((row.grossProfit / row.revenue) * 100).toFixed(2)) : 0;
  }
  return { rows, currency: "INR" };
}
async function subBrandPnlDetail(req, allowed, dateRange) {
  const tenantId = req.travelTenant.id;
  if (allowed !== null && allowed.size === 0) {
    return { totals: { revenue: 0, capturedCost: 0, quoteValue: 0, grossProfit: 0, marginPct: 0 }, brands: [], revenueRows: [], costRows: [], quoteRows: [], currency: "INR" };
  }

  const invoiceWhere = applyAllowedSubBrands({ tenantId, status: { in: ["Issued", "Partial", "Paid"] } }, allowed);
  const itemWhere = { itinerary: { tenantId } };
  const list = allowedSubBrandArray(allowed);
  if (list !== null) itemWhere.itinerary.subBrand = { in: list };
  if (dateRange) {
    invoiceWhere.createdAt = dateRange;
    itemWhere.createdAt = dateRange;
  }

  const [invoices, costItems, quoteLines] = await Promise.all([
    prisma.travelInvoice.findMany({
      where: invoiceWhere,
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        invoiceNum: true,
        subBrand: true,
        status: true,
        totalAmount: true,
        currency: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
        contactId: true,
        quoteId: true,
        itineraryId: true,
      },
    }),
    prisma.itineraryItem.findMany({
      where: itemWhere,
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: {
        id: true,
        itemType: true,
        description: true,
        supplierId: true,
        unitCost: true,
        quantity: true,
        totalPrice: true,
        createdAt: true,
        itinerary: { select: { id: true, subBrand: true, destination: true, status: true, totalAmount: true, currency: true, startDate: true, endDate: true } },
      },
    }),
    prisma.travelQuoteLine.findMany({
      where: {
        tenantId,
        quote: {
          tenantId,
          status: { in: [...ACCEPTED_QUOTE_STATUSES] },
          ...(list !== null ? { subBrand: { in: list } } : {}),
        },
        ...(dateRange ? { createdAt: dateRange } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: {
        id: true,
        quoteId: true,
        lineType: true,
        description: true,
        quantity: true,
        unitPrice: true,
        amount: true,
        currency: true,
        supplierId: true,
        createdAt: true,
        quote: { select: { subBrand: true, status: true, totalAmount: true, currency: true } },
      },
    }),
  ]);

  const byBrand = {};
  const ensureBrand = (subBrand) => {
    const key = subBrand || "unknown";
    byBrand[key] ||= { subBrand: key, revenue: 0, capturedCost: 0, quoteValue: 0, grossProfit: 0, marginPct: 0, invoiceCount: 0, costLineCount: 0, quoteLineCount: 0 };
    return byBrand[key];
  };

  const revenueRows = invoices.map((invoice) => {
    const amount = sumDecimal(invoice.totalAmount);
    const brand = ensureBrand(invoice.subBrand);
    brand.revenue += amount;
    brand.invoiceCount += 1;
    return {
      id: invoice.id,
      invoiceNum: invoice.invoiceNum,
      subBrand: invoice.subBrand,
      status: invoice.status,
      amount,
      currency: invoice.currency || "INR",
      contactId: invoice.contactId,
      quoteId: invoice.quoteId,
      itineraryId: invoice.itineraryId,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      createdAt: invoice.createdAt,
    };
  });

  const costRows = costItems.map((item) => {
    const quantity = sumDecimal(item.quantity) || 1;
    const unitCost = sumDecimal(item.unitCost);
    const capturedCost = unitCost * quantity;
    const subBrand = item.itinerary?.subBrand || "unknown";
    const brand = ensureBrand(subBrand);
    brand.capturedCost += capturedCost;
    brand.costLineCount += 1;
    return {
      id: item.id,
      itineraryId: item.itinerary?.id || null,
      subBrand,
      destination: item.itinerary?.destination || "-",
      itineraryStatus: item.itinerary?.status || "-",
      itemType: item.itemType,
      description: item.description,
      supplierId: item.supplierId,
      unitCost,
      quantity,
      capturedCost,
      totalPrice: sumDecimal(item.totalPrice),
      currency: item.itinerary?.currency || "INR",
      startDate: item.itinerary?.startDate || null,
      endDate: item.itinerary?.endDate || null,
      createdAt: item.createdAt,
    };
  });

  const quoteRows = quoteLines.map((line) => {
    const quantity = sumDecimal(line.quantity) || 1;
    const unitPrice = sumDecimal(line.unitPrice);
    const amount = sumDecimal(line.amount) || (unitPrice * quantity);
    const subBrand = line.quote?.subBrand || "unknown";
    const brand = ensureBrand(subBrand);
    brand.quoteValue += amount;
    brand.quoteLineCount += 1;
    return {
      id: line.id,
      quoteId: line.quoteId,
      subBrand,
      quoteStatus: line.quote?.status || "-",
      lineType: line.lineType,
      description: line.description,
      supplierId: line.supplierId,
      unitPrice,
      quantity,
      amount,
      currency: line.currency || line.quote?.currency || "INR",
      createdAt: line.createdAt,
    };
  });
  const brands = Object.values(byBrand).map((brand) => ({
    ...brand,
    grossProfit: brand.revenue - brand.capturedCost,
    marginPct: brand.revenue > 0 ? Number((((brand.revenue - brand.capturedCost) / brand.revenue) * 100).toFixed(2)) : 0,
  })).sort((a, b) => b.grossProfit - a.grossProfit);

  const totals = brands.reduce((acc, brand) => {
    acc.revenue += brand.revenue;
    acc.capturedCost += brand.capturedCost;
    acc.invoiceCount += brand.invoiceCount;
    acc.costLineCount += brand.costLineCount;
    acc.quoteValue += brand.quoteValue;
    acc.quoteLineCount += brand.quoteLineCount;
    return acc;
  }, { revenue: 0, capturedCost: 0, quoteValue: 0, grossProfit: 0, marginPct: 0, invoiceCount: 0, costLineCount: 0, quoteLineCount: 0 });
  totals.grossProfit = totals.revenue - totals.capturedCost;
  totals.marginPct = totals.revenue > 0 ? Number(((totals.grossProfit / totals.revenue) * 100).toFixed(2)) : 0;

  return { totals, brands, revenueRows, costRows, quoteRows, currency: "INR", generatedAt: new Date().toISOString() };
}

async function visaApprovalSummary(req, dateRange) {
  const tenantId = req.travelTenant.id;
  const where = { tenantId };
  if (dateRange) where.createdAt = dateRange;
  const rows = await prisma.visaApplication.groupBy({
    by: ["status", "outcome"], where, _count: { _all: true },
  });
  let total = 0;
  let approved = 0;
  let rejected = 0;
  const byStatus = {};
  for (const row of rows) {
    const count = row._count?._all ?? 0;
    total += count;
    byStatus[row.status] = (byStatus[row.status] || 0) + count;
    if (row.outcome === "approved" || row.status === "approved") approved += count;
    if (row.outcome === "rejected" || row.status === "rejected") rejected += count;
  }
  const decided = approved + rejected;
  return {
    total,
    approved,
    rejected,
    decided,
    approvalRatePct: decided > 0 ? Number(((approved / decided) * 100).toFixed(2)) : 0,
    byStatus,
  };
}

async function checkinMissSummary(req, dateRange) {
  const tenantId = req.travelTenant.id;
  const where = { tenantId };
  if (dateRange) where.createdAt = dateRange;
  const rows = await prisma.webCheckin.groupBy({
    by: ["status"], where, _count: { _all: true },
  });
  const byStatus = flattenGroupCount(rows, "status");
  const total = Object.values(byStatus).reduce((a, n) => a + n, 0);
  const missed = (byStatus.failed || 0) + (byStatus["fallback-agent"] || 0);
  const completed = byStatus.done || 0;
  return {
    total,
    completed,
    missed,
    missRatePct: total > 0 ? Number(((missed / total) * 100).toFixed(2)) : 0,
    byStatus,
  };
}

async function agentProductivitySummary(req, allowed, dateRange) {
  const tenantId = req.travelTenant.id;
  const quoteActions = [
    "CREATE",
    "UPDATE",
    "QUOTE_SHARE",
    "TRAVEL_QUOTE_ACCEPTED",
    "TRAVEL_QUOTE_DECLINED",
    "TRAVEL_QUOTE_DUPLICATED",
    "TRAVEL_QUOTE_EXTENDED",
    "TRAVEL_QUOTE_CONVERTED",
    "TRAVEL_QUOTE_PDF_DOWNLOADED",
  ];
  if (allowed !== null && allowed.size === 0) return null;

  const auditWhere = {
    tenantId,
    entity: "TravelQuote",
    userId: { not: null },
    action: { in: quoteActions },
  };
  if (dateRange) auditWhere.createdAt = dateRange;

  const snapshotWhere = {
    tenantId,
    changedBy: "customer",
    statusAfter: { in: ["Accepted", "Rejected"] },
  };
  if (dateRange) snapshotWhere.createdAt = dateRange;

  const [auditRows, decisionSnapshots, paymentRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: auditWhere,
      orderBy: { createdAt: "asc" },
      select: { userId: true, action: true, entityId: true, createdAt: true },
    }),
    prisma.travelQuoteSnapshot.findMany({
      where: snapshotWhere,
      orderBy: { createdAt: "asc" },
      select: { quoteId: true, statusAfter: true, createdAt: true },
    }).catch(() => []),
    travelQuotePayments(tenantId, dateRange),
  ]);

  const allQuoteIds = [...new Set([
    ...auditRows.map((r) => r.entityId).filter((id) => id != null),
    ...decisionSnapshots.map((s) => s.quoteId).filter((id) => id != null),
    ...paymentRows.map((p) => p.quoteId).filter((id) => id != null),
  ])];

  let allowedQuoteIds = null;
  if (allowed !== null) {
    const scopedQuotes = allQuoteIds.length
      ? await prisma.travelQuote.findMany({
        where: { tenantId, id: { in: allQuoteIds }, subBrand: { in: allowedSubBrandArray(allowed) } },
        select: { id: true },
      })
      : [];
    allowedQuoteIds = new Set(scopedQuotes.map((q) => q.id));
  }

  const scopedAuditRows = allowedQuoteIds
    ? auditRows.filter((row) => allowedQuoteIds.has(row.entityId))
    : auditRows;
  const scopedDecisionSnapshots = allowedQuoteIds
    ? decisionSnapshots.filter((row) => allowedQuoteIds.has(row.quoteId))
    : decisionSnapshots;
  const scopedPaymentRows = allowedQuoteIds
    ? paymentRows.filter((row) => allowedQuoteIds.has(row.quoteId))
    : paymentRows;

  const createdByQuote = new Map();
  const lastShareByQuote = new Map();
  const existingDecisionKeys = new Set();
  for (const row of scopedAuditRows) {
    if (row.entityId == null || row.userId == null) continue;
    if (row.action === "CREATE" && !createdByQuote.has(row.entityId)) {
      createdByQuote.set(row.entityId, row.userId);
    }
    if (row.action === "QUOTE_SHARE") {
      lastShareByQuote.set(row.entityId, row.userId);
    }
    if (row.action === "TRAVEL_QUOTE_ACCEPTED" || row.action === "TRAVEL_QUOTE_DECLINED") {
      existingDecisionKeys.add(`${row.entityId}:${row.userId}:${row.action}`);
    }
  }

  const attributedDecisionRows = [];
  for (const snap of scopedDecisionSnapshots) {
    const action = snap.statusAfter === "Accepted" ? "TRAVEL_QUOTE_ACCEPTED" : "TRAVEL_QUOTE_DECLINED";
    const userId = lastShareByQuote.get(snap.quoteId) || createdByQuote.get(snap.quoteId) || null;
    if (!userId) continue;
    const key = `${snap.quoteId}:${userId}:${action}`;
    if (existingDecisionKeys.has(key)) continue;
    attributedDecisionRows.push({
      userId,
      action,
      entityId: snap.quoteId,
      createdAt: snap.createdAt,
      attributedFromCustomerDecision: true,
    });
  }

  for (const payment of scopedPaymentRows) {
    const userId = lastShareByQuote.get(payment.quoteId) || createdByQuote.get(payment.quoteId) || null;
    if (!userId) continue;
    attributedDecisionRows.push({
      userId,
      action: "TRAVEL_QUOTE_PAYMENT_COLLECTED",
      entityId: payment.quoteId,
      createdAt: payment.paidAt,
      amount: payment.amount,
      paymentId: payment.paymentId,
      travelInvoiceId: payment.travelInvoiceId,
      description: payment.description,
    });
  }

  const scopedRows = [...scopedAuditRows, ...attributedDecisionRows];
  const userIds = [...new Set(scopedRows.map((r) => r.userId).filter((id) => id != null))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userById = Object.fromEntries(users.map((u) => [u.id, u]));
  const agents = {};
  for (const row of scopedRows) {
    const id = row.userId;
    const user = userById[id];
    agents[id] ||= {
      userId: id,
      name: user?.name || user?.email || `User #${id}`,
      totalActions: 0,
      createdQuotes: 0,
      sentQuotes: 0,
      acceptedQuotes: 0,
      declinedQuotes: 0,
      updatedQuotes: 0,
      paidQuotes: 0,
      paymentAmount: 0,
      byAction: {},
    };
    agents[id].totalActions += 1;
    agents[id].byAction[row.action] = (agents[id].byAction[row.action] || 0) + 1;
    if (row.action === "CREATE") agents[id].createdQuotes += 1;
    if (row.action === "QUOTE_SHARE") agents[id].sentQuotes += 1;
    if (row.action === "TRAVEL_QUOTE_ACCEPTED") agents[id].acceptedQuotes += 1;
    if (row.action === "TRAVEL_QUOTE_DECLINED") agents[id].declinedQuotes += 1;
    if (row.action === "UPDATE") agents[id].updatedQuotes += 1;
    if (row.action === "TRAVEL_QUOTE_PAYMENT_COLLECTED") {
      agents[id].paidQuotes += 1;
      agents[id].paymentAmount += Number(row.amount || 0);
    }
  }
  const paymentDetails = scopedRows
    .filter((row) => row.action === "TRAVEL_QUOTE_PAYMENT_COLLECTED")
    .map((row) => {
      const quote = null;
      const user = userById[row.userId];
      return {
        paymentId: row.paymentId || null,
        travelInvoiceId: row.travelInvoiceId || null,
        userId: row.userId,
        agentName: user?.name || user?.email || `User #${row.userId}`,
        quoteId: row.entityId,
        quoteStatus: quote?.status || null,
        quoteTotal: quote?.totalAmount != null ? Number(quote.totalAmount) : null,
        currency: quote?.currency || "INR",
        contactId: quote?.contactId || null,
        amount: Number(row.amount || 0),
        paidAt: row.createdAt || null,
        description: row.description || null,
      };
    })
    .sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));
  return { agents: Object.values(agents).sort((a, b) => b.totalActions - a.totalActions).slice(0, 10), payments: paymentDetails };
}
router.get("/reports/pnl", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const dateRange = parseDateRange(req);
    res.json(await subBrandPnlDetail(req, allowed, dateRange));
  } catch (e) {
    console.error("[travel-reports] pnl error:", e.message);
    res.status(500).json({ error: "Failed to load P&L report" });
  }
});
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

    const [tmc, rfu, crossBrand, salesFunnel, agentProductivity, subBrandPnl, visaApproval, checkinMiss] = await Promise.all([
      wrap("tmc", () => tmcSummary(req, allowed, dateRange)),
      wrap("rfu", () => rfuSummary(req, allowed, dateRange)),
      wrap("crossBrand", () => crossBrandSummary(req, allowed, dateRange)),
      wrap("salesFunnel", () => salesFunnelSummary(req, allowed, dateRange)),
      wrap("agentProductivity", () => agentProductivitySummary(req, allowed, dateRange)),
      wrap("subBrandPnl", () => subBrandPnlSummary(req, allowed, dateRange)),
      wrap("visaApproval", () => visaApprovalSummary(req, dateRange)),
      wrap("checkinMiss", () => checkinMissSummary(req, dateRange)),
    ]);

    res.json({
      tmc,
      rfu,
      crossBrand,
      salesFunnel,
      agentProductivity,
      subBrandPnl,
      visaApproval,
      checkinMiss,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-reports] summary error:", e.message);
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

module.exports = router;
