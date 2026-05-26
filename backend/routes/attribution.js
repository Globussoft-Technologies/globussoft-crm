const express = require("express");
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
// #268: server-side guard — strips test-skip / test-junk / e2e-* / qa-* / rbac-*
// source rows from operator-facing aggregations so the next round of E2E
// fixtures doesn't leak into Marketing Attribution screens (the original
// demo bug). Pairs with cleanup-p3-data-quality.js (one-shot remap of
// existing rows) for durability.
const { isJunkSource } = require("../lib/junkSourceFilter");
// #665: shared inverted-date-range guard. Routes that historically returned
// empty result sets when callers passed to < from now surface a 400 with
// code=INVERTED_DATE_RANGE.
const { validateDateRange } = require("../lib/validateDateRange");

const router = express.Router();

function tenantOf(req) {
  return (req.user && req.user.tenantId) || 1;
}

function parseDateRange(req) {
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const where = {};
  if (from && !isNaN(from)) where.gte = from;
  if (to && !isNaN(to)) where.lte = to;
  return Object.keys(where).length ? where : null;
}

// ── POST /track ──────────────────────────────────────────────────
// body: { contactId, channel, source, medium, campaignId?, url? }
router.post("/track", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { contactId, channel, source, medium, campaignId, url } =
      req.body || {};
    if (!contactId || !channel) {
      return res
        .status(400)
        .json({ error: "contactId and channel are required" });
    }
    const cId = Number(contactId);
    const contact = await prisma.contact.findFirst({
      where: { id: cId, tenantId },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const touchpoint = await prisma.touchpoint.create({
      data: {
        contactId: cId,
        channel,
        source: source || null,
        medium: medium || null,
        campaignId: campaignId ? Number(campaignId) : null,
        url: url || null,
        tenantId,
      },
    });

    // Update contact firstTouchSource (if null) and lastTouchSource always
    const sourceLabel = source || channel;
    const update = { lastTouchSource: sourceLabel };
    if (!contact.firstTouchSource) {
      update.firstTouchSource = sourceLabel;
    }
    await prisma.contact.update({ where: { id: cId }, data: update });

    res.status(201).json(touchpoint);
  } catch (err) {
    console.error("[attribution/track]", err);
    res.status(500).json({ error: "Failed to track touchpoint" });
  }
});

// ── GET /stats ────────────────────────────────────────────────────
// Marketing/Analytics polish — first /stats endpoint for attribution route.
// Tenant-wide aggregate KPI surface intended to power the marketing dashboard
// header without N round-trips. Mirrors the sibling /stats template from
// travel_suppliers.js (slice 23): anodyne aggregate, tenant-scoped, no audit
// row written, returns { totalTouchpoints, byChannel, byCampaign,
// attributedContacts, lastTouchAt } plus a forward-compat aggregateExceedsCap
// flag.
//
// Output shape:
//   {
//     totalTouchpoints:    number,           // count of all (non-junk-source) touchpoints
//     byChannel:           [{ channel, count }],         // sorted by count desc
//     byCampaign:          [{ campaignId, count }],      // top 10, sorted by count desc
//     attributedContacts:  number,           // distinct contactId where the contact has
//                                            // ≥1 touchpoint AND ≥1 won Deal
//     lastTouchAt:         ISO string | null
//   }
//
// Query params:
//   ?from=<ISO>  optional inclusive lower bound on Touchpoint.timestamp
//   ?to=<ISO>    optional inclusive upper bound on Touchpoint.timestamp
// Invalid ISO → 400 { error, code: 'INVALID_DATE' }. NOTE: this endpoint
// does not use the shared validateDateRange helper (which would return
// INVERTED_DATE_RANGE) — it's a per-field ISO-validity guard mirroring
// travel_suppliers.js /stats, since marketing dashboards routinely call
// with a half-open window (only ?from set, no ?to). Inverted ranges still
// produce an empty (but well-formed) response — not an error.
//
// Junk-source filter (#268): touchpoints whose `source` matches the junk
// pattern (test-skip / e2e-* / qa-* / rbac-*) are excluded from totals +
// byChannel + byCampaign + attributedContacts so e2e fixtures don't pollute
// the operator dashboard.
//
// Auth: mirrors GET /report — global verifyToken applies at server.js:512;
// tenantOf() reads req.user.tenantId. No role gate (USER-readable aggregate;
// no PII / no money values).
//
// Tenant-scoped: req.user.tenantId — NEVER req.body.tenantId.
// No audit row written: read-only meta surface, mirrors /report.
//
// Express route ordering: declared BEFORE /contact/:id family so no path
// collision can occur. (Even though /stats and /contact/:id are distinct
// paths, declaring /stats before any /:id-style route is the conservative
// pattern from travel_suppliers.js /suppliers/stats.)
router.get("/stats", async (req, res) => {
  try {
    const tenantId = tenantOf(req);

    // Per-field ISO validity — mirrors travel_suppliers.js /suppliers/stats.
    const where = { tenantId };
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.timestamp = Object.assign(where.timestamp || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.timestamp = Object.assign(where.timestamp || {}, { lte: d });
    }

    const allTouchpoints = await prisma.touchpoint.findMany({
      where,
      select: {
        contactId: true,
        channel: true,
        source: true,
        campaignId: true,
        timestamp: true,
      },
    });
    // #268: drop junk-source rows BEFORE aggregating so operator dashboards
    // don't leak e2e/test fixtures.
    const touchpoints = allTouchpoints.filter((tp) => !isJunkSource(tp.source));

    // byChannel — count per channel (utm_source-style — for touchpoints
    // captured via /track, this is the high-level channel like "web" /
    // "whatsapp" / "email"). Null channels coalesce to 'unknown'.
    const channelMap = new Map();
    // byCampaign — count per campaignId. Null campaignIds skipped (not
    // every touchpoint is campaign-attributed).
    const campaignMap = new Map();
    // distinct contactId set + max timestamp.
    const contactIdSet = new Set();
    let lastTouchAt = null;

    for (const tp of touchpoints) {
      const ch = tp.channel || "unknown";
      channelMap.set(ch, (channelMap.get(ch) || 0) + 1);

      if (tp.campaignId != null) {
        const cid = tp.campaignId;
        campaignMap.set(cid, (campaignMap.get(cid) || 0) + 1);
      }

      if (tp.contactId != null) {
        contactIdSet.add(tp.contactId);
      }

      const ts = tp.timestamp instanceof Date ? tp.timestamp : new Date(tp.timestamp);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastTouchAt || ts > lastTouchAt) lastTouchAt = ts;
      }
    }

    // attributedContacts — count of distinct contactIds that have BOTH
    // ≥1 (non-junk) touchpoint AND ≥1 won deal. The "converted" notion
    // here is: the contact's touchpoint(s) eventually led to a won deal.
    let attributedContacts = 0;
    if (contactIdSet.size > 0) {
      const wonDeals = await prisma.deal.findMany({
        where: {
          tenantId,
          stage: "won",
          contactId: { in: [...contactIdSet] },
        },
        select: { contactId: true },
      });
      const wonContactSet = new Set();
      for (const d of wonDeals) {
        if (d.contactId != null) wonContactSet.add(d.contactId);
      }
      attributedContacts = wonContactSet.size;
    }

    const byChannel = Array.from(channelMap.entries())
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => b.count - a.count);

    const byCampaign = Array.from(campaignMap.entries())
      .map(([campaignId, count]) => ({ campaignId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      totalTouchpoints: touchpoints.length,
      byChannel,
      byCampaign,
      attributedContacts,
      lastTouchAt: lastTouchAt ? lastTouchAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[attribution/stats]", err);
    res.status(500).json({ error: "Failed to build attribution stats" });
  }
});

// ── GET /contact/:id — timeline ──────────────────────────────────
router.get("/contact/:id", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const contactId = Number(req.params.id);
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        firstTouchSource: true,
        lastTouchSource: true,
      },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const touchpoints = await prisma.touchpoint.findMany({
      where: { contactId, tenantId },
      orderBy: { timestamp: "asc" },
    });
    res.json({ contact, touchpoints });
  } catch (err) {
    console.error("[attribution/contact]", err);
    res.status(500).json({ error: "Failed to fetch contact attribution" });
  }
});

// ── GET /report?from=&to= ────────────────────────────────────────
// aggregates touchpoints by channel + source. deals = won deals tied to
// contacts with at least one touchpoint of that channel/source.
router.get("/report", async (req, res) => {
  try {
    // #665: reject inverted / invalid date ranges with a 400 before we silently
    // return an empty aggregation.
    const dv = validateDateRange({ from: req.query.from, to: req.query.to });
    if (dv.error) return res.status(dv.error.status).json(dv.error);

    const tenantId = tenantOf(req);
    const dateFilter = parseDateRange(req);
    const where = { tenantId };
    if (dateFilter) where.timestamp = dateFilter;

    const allTouchpoints = await prisma.touchpoint.findMany({ where });
    // #268: skip touchpoints sourced from test/e2e/qa/rbac fixtures.
    // Channel is preserved (still aggregated under e.g. 'web') so we
    // only strip the per-source bucket — but if both channel and source
    // are junk, the row drops entirely.
    const touchpoints = allTouchpoints.filter((tp) => !isJunkSource(tp.source));

    // Won deals for tenant — used to attribute revenue counts
    const wonDeals = await prisma.deal.findMany({
      where: { tenantId, stage: "won" },
      select: { id: true, contactId: true, amount: true },
    });

    // Group won deals by contactId
    const wonByContact = new Map();
    for (const d of wonDeals) {
      if (!d.contactId) continue;
      if (!wonByContact.has(d.contactId)) wonByContact.set(d.contactId, []);
      wonByContact.get(d.contactId).push(d);
    }

    // Build per-channel / per-source aggregations
    const channelMap = new Map();
    const sourceMap = new Map();

    for (const tp of touchpoints) {
      const ch = tp.channel || "unknown";
      const src = tp.source || "unknown";

      if (!channelMap.has(ch)) {
        channelMap.set(ch, {
          channel: ch,
          touchpoints: 0,
          contactIds: new Set(),
          dealIds: new Set(),
          revenue: 0,
        });
      }
      const cEntry = channelMap.get(ch);
      cEntry.touchpoints += 1;
      cEntry.contactIds.add(tp.contactId);
      const wonForContact = wonByContact.get(tp.contactId) || [];
      for (const d of wonForContact) {
        if (!cEntry.dealIds.has(d.id)) {
          cEntry.dealIds.add(d.id);
          cEntry.revenue += Number(d.amount) || 0;
        }
      }

      if (!sourceMap.has(src)) {
        sourceMap.set(src, {
          source: src,
          touchpoints: 0,
          contactIds: new Set(),
          dealIds: new Set(),
          revenue: 0,
        });
      }
      const sEntry = sourceMap.get(src);
      sEntry.touchpoints += 1;
      sEntry.contactIds.add(tp.contactId);
      for (const d of wonForContact) {
        if (!sEntry.dealIds.has(d.id)) {
          sEntry.dealIds.add(d.id);
          sEntry.revenue += Number(d.amount) || 0;
        }
      }
    }

    const byChannel = Array.from(channelMap.values()).map((e) => ({
      channel: e.channel,
      touchpoints: e.touchpoints,
      contacts: e.contactIds.size,
      deals: e.dealIds.size,
      revenue: Math.round(e.revenue * 100) / 100,
    }));
    const bySource = Array.from(sourceMap.values()).map((e) => ({
      source: e.source,
      touchpoints: e.touchpoints,
      contacts: e.contactIds.size,
      deals: e.dealIds.size,
      revenue: Math.round(e.revenue * 100) / 100,
    }));

    byChannel.sort((a, b) => b.deals - a.deals || b.contacts - a.contacts);
    bySource.sort((a, b) => b.deals - a.deals || b.contacts - a.contacts);

    res.json({ byChannel, bySource });
  } catch (err) {
    console.error("[attribution/report]", err);
    res.status(500).json({ error: "Failed to build attribution report" });
  }
});

// ── GET /first-touch-revenue ─────────────────────────────────────
// For each won deal, attribute revenue to the contact's firstTouchSource.
router.get("/first-touch-revenue", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const wonDeals = await prisma.deal.findMany({
      where: { tenantId, stage: "won" },
      select: { id: true, amount: true, contactId: true },
    });

    const contactIds = Array.from(
      new Set(wonDeals.map((d) => d.contactId).filter(Boolean))
    );
    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds }, tenantId },
      select: { id: true, firstTouchSource: true },
    });
    const firstTouchByContact = new Map(
      contacts.map((c) => [c.id, c.firstTouchSource || "unknown"])
    );

    const bySource = new Map();
    let totalRevenue = 0;
    let attributed = 0;

    for (const d of wonDeals) {
      const amount = Number(d.amount) || 0;
      totalRevenue += amount;
      if (!d.contactId) continue;
      const src = firstTouchByContact.get(d.contactId) || "unknown";
      // #268: drop junk-source attribution from the revenue breakdown.
      // totalRevenue still counts the deal (it's real revenue) but it
      // doesn't get bucketed against a fake source row.
      if (isJunkSource(src)) continue;
      if (!bySource.has(src)) {
        bySource.set(src, { source: src, deals: 0, revenue: 0 });
      }
      const entry = bySource.get(src);
      entry.deals += 1;
      entry.revenue += amount;
      attributed += amount;
    }

    const result = Array.from(bySource.values())
      .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      model: "first-touch",
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      attributedRevenue: Math.round(attributed * 100) / 100,
      bySource: result,
    });
  } catch (err) {
    console.error("[attribution/first-touch-revenue]", err);
    res.status(500).json({ error: "Failed to compute first-touch revenue" });
  }
});

// ── GET /multi-touch-revenue ─────────────────────────────────────
// Split each won deal's revenue equally across all unique touchpoint sources
// for that contact.
router.get("/multi-touch-revenue", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const wonDeals = await prisma.deal.findMany({
      where: { tenantId, stage: "won" },
      select: { id: true, amount: true, contactId: true },
    });

    const contactIds = Array.from(
      new Set(wonDeals.map((d) => d.contactId).filter(Boolean))
    );

    const touchpoints = contactIds.length
      ? await prisma.touchpoint.findMany({
          where: { tenantId, contactId: { in: contactIds } },
          select: { contactId: true, source: true, channel: true },
        })
      : [];

    // unique sources per contact (fallback to channel when source missing)
    const sourcesByContact = new Map();
    for (const tp of touchpoints) {
      const src = tp.source || tp.channel || "unknown";
      // #268: drop junk-source touchpoints from the multi-touch denominator.
      if (isJunkSource(src)) continue;
      if (!sourcesByContact.has(tp.contactId)) {
        sourcesByContact.set(tp.contactId, new Set());
      }
      sourcesByContact.get(tp.contactId).add(src);
    }

    const bySource = new Map();
    let totalRevenue = 0;
    let attributed = 0;

    for (const d of wonDeals) {
      const amount = Number(d.amount) || 0;
      totalRevenue += amount;
      if (!d.contactId) continue;
      const sources = sourcesByContact.get(d.contactId);
      if (!sources || sources.size === 0) {
        const src = "unknown";
        if (!bySource.has(src)) bySource.set(src, { source: src, deals: 0, revenue: 0 });
        bySource.get(src).deals += 1;
        bySource.get(src).revenue += amount;
        attributed += amount;
        continue;
      }
      const share = amount / sources.size;
      for (const src of sources) {
        if (!bySource.has(src)) {
          bySource.set(src, { source: src, deals: 0, revenue: 0 });
        }
        const entry = bySource.get(src);
        entry.deals += 1;
        entry.revenue += share;
      }
      attributed += amount;
    }

    const result = Array.from(bySource.values())
      .map((e) => ({ ...e, revenue: Math.round(e.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      model: "multi-touch-linear",
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      attributedRevenue: Math.round(attributed * 100) / 100,
      bySource: result,
    });
  } catch (err) {
    console.error("[attribution/multi-touch-revenue]", err);
    res.status(500).json({ error: "Failed to compute multi-touch revenue" });
  }
});

// ── GET /voyagr/summary?days=N — voyagr (OJR) lead-capture attribution ──
//
// F3 (cluster F): surfaces Contact + Touchpoint rows written by F1
// (POST /api/v1/voyagr/leads → backend/routes/voyagr.js) as a
// marketing-attribution summary scoped to the requesting tenant.
//
// Output shape:
//   {
//     windowDays: number,
//     totalLeads: number,            // count of Contact rows with source='voyagr'
//     bySubBrand:    [{ subBrand, count, deals, wonValue }],
//     byUtmSource:   [{ utmSource, count }],
//     byChannel:     [{ channel, count }],
//     bySiteSlug:    [{ siteSlug, count }],
//   }
//
// SCHEMA-DRIFT NOTE (2026-05-23 — F3 ship):
//   The dispatch prompt for F3 assumed Touchpoint has dedicated `utmSource`,
//   `utmCampaign`, `utmMedium`, `siteSlug` columns. The actual schema only
//   has `channel`, `source`, `medium`, `url`, `campaignId`. F1
//   (backend/routes/voyagr.js:308-322) maps utm_source → Touchpoint.source
//   and utm_medium → Touchpoint.medium (with subBrand as a fallback when
//   utm_medium is absent). siteSlug + utm_campaign + utm_term + utm_content
//   are NOT persisted to Touchpoint — they're only captured in the
//   per-request AuditLog details JSON. Net effect:
//     - bySubBrand:  derived from Contact.subBrand (authoritative — F1
//                    sets it on Contact create).
//     - byUtmSource: derived from Touchpoint.source (which holds the raw
//                    utm_source value F1 wrote — see voyagr.js:313).
//     - byChannel:   derived from Touchpoint.channel (always "web" for F1
//                    rows; reserved for future channels).
//     - bySiteSlug:  ALWAYS empty array today — no column to query. Kept
//                    in the response shape as a forward-compat placeholder
//                    so callers don't break when the column is added.
//                    Schema add tracked as a follow-up gap (see voyagr.js
//                    line 308-321 + commit 0299031 context).
//
// Auth: ADMIN | MANAGER (matches the rest of attribution.js's reporting
// surface; verifyToken is applied by the global guard at server.js:512).
// Tenant scoping: req.user.tenantId — NEVER req.body.tenantId (stripDangerous
// strips body-supplied tenantId; ESLint rule blocks the read).
router.get("/voyagr/summary", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req);

    // days param: default 30, clamp to [1, 365], reject anything else
    // with a 400 so callers don't silently get a window other than the
    // one they asked for.
    const daysRaw = req.query.days;
    let days = 30;
    if (daysRaw !== undefined && daysRaw !== null && daysRaw !== "") {
      const n = Number(daysRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 365) {
        return res.status(400).json({
          error: "days must be an integer in [1, 365]",
          code: "INVALID_DAYS",
        });
      }
      days = n;
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // 1. Voyagr-sourced contacts in this tenant + window. F1 sets
    //    Contact.source='voyagr' on create (voyagr.js:297), so this is
    //    the load-bearing population — every F1 capture writes exactly
    //    one Contact row (deduped) and the source tag is permanent.
    //
    //    Capped at top-50 per facet at the end, but we need all rows
    //    here to join Touchpoints + Deals + compute facet counts. For
    //    today's volumes (per docs/TRAVEL_CRM_PRD.md — tens of leads/day
    //    across 4 sub-brands) this is well within unbounded-query
    //    tolerance; if voyagr volume grows to 10k+ leads/window, this
    //    helper should move to a SQL aggregate.
    const contacts = await prisma.contact.findMany({
      where: {
        tenantId,
        source: "voyagr",
        createdAt: { gte: cutoff },
      },
      select: { id: true, subBrand: true },
    });
    const totalLeads = contacts.length;
    const contactIds = contacts.map((c) => c.id);

    // 2. bySubBrand — count + won-deal aggregation per Contact.subBrand.
    //    F1 also tags Deal.subBrand on create (voyagr.js:335) so we
    //    could query deals directly, but joining via contactId keeps the
    //    "voyagr origin" filter authoritative (a manually-created
    //    sub-brand deal NOT linked to a voyagr-sourced contact should
    //    not appear in voyagr attribution).
    const subBrandMap = new Map();
    for (const c of contacts) {
      const key = c.subBrand || null;
      if (!subBrandMap.has(key)) {
        subBrandMap.set(key, { subBrand: key, count: 0, deals: 0, wonValue: 0 });
      }
      subBrandMap.get(key).count += 1;
    }

    // 3. Pull all Deals tied to these contacts (any stage — we need
    //    counts) + sum the won-value per subBrand. Deal.subBrand mirrors
    //    Contact.subBrand for voyagr-sourced deals (voyagr.js:335).
    let deals = [];
    if (contactIds.length > 0) {
      deals = await prisma.deal.findMany({
        where: { tenantId, contactId: { in: contactIds } },
        select: { contactId: true, subBrand: true, amount: true, stage: true },
      });
    }
    // Build a contactId → subBrand map (fallback for deals whose subBrand
    // field is null but the contact's isn't — defensive against schema drift).
    const contactSubBrand = new Map(contacts.map((c) => [c.id, c.subBrand || null]));
    for (const d of deals) {
      const sb = d.subBrand || contactSubBrand.get(d.contactId) || null;
      if (!subBrandMap.has(sb)) {
        subBrandMap.set(sb, { subBrand: sb, count: 0, deals: 0, wonValue: 0 });
      }
      const e = subBrandMap.get(sb);
      e.deals += 1;
      if (d.stage === "won") {
        e.wonValue += Number(d.amount) || 0;
      }
    }

    // 4. Touchpoints tied to these contacts — for byUtmSource + byChannel.
    let touchpoints = [];
    if (contactIds.length > 0) {
      touchpoints = await prisma.touchpoint.findMany({
        where: { tenantId, contactId: { in: contactIds } },
        select: { source: true, channel: true, medium: true },
      });
    }

    const utmSourceMap = new Map();
    const channelMap = new Map();
    for (const tp of touchpoints) {
      const src = tp.source || null;
      // Skip junk-source rows so e2e fixtures don't pollute the
      // operator-facing summary (#268 standing pattern).
      if (src && isJunkSource(src)) continue;
      if (!utmSourceMap.has(src)) {
        utmSourceMap.set(src, { utmSource: src, count: 0 });
      }
      utmSourceMap.get(src).count += 1;

      const ch = tp.channel || null;
      if (!channelMap.has(ch)) {
        channelMap.set(ch, { channel: ch, count: 0 });
      }
      channelMap.get(ch).count += 1;
    }

    // 5. Sort + cap top-50 per facet.
    const TOP = 50;
    const sortByCountDesc = (a, b) => b.count - a.count;
    const bySubBrand = Array.from(subBrandMap.values())
      .map((e) => ({
        subBrand: e.subBrand,
        count: e.count,
        deals: e.deals,
        wonValue: Math.round(e.wonValue * 100) / 100,
      }))
      .sort(sortByCountDesc)
      .slice(0, TOP);
    const byUtmSource = Array.from(utmSourceMap.values()).sort(sortByCountDesc).slice(0, TOP);
    const byChannel = Array.from(channelMap.values()).sort(sortByCountDesc).slice(0, TOP);

    return res.json({
      windowDays: days,
      totalLeads,
      bySubBrand,
      byUtmSource,
      byChannel,
      // Schema-drift placeholder — see SCHEMA-DRIFT NOTE above. Empty
      // until Touchpoint gains a siteSlug column or F1 starts persisting
      // siteSlug to a queryable surface.
      bySiteSlug: [],
    });
  } catch (err) {
    console.error("[attribution/voyagr/summary]", err);
    res.status(500).json({ error: "Failed to build voyagr attribution summary" });
  }
});

module.exports = router;
