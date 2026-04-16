const express = require("express");
const prisma = require("../lib/prisma");

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
    const tenantId = tenantOf(req);
    const dateFilter = parseDateRange(req);
    const where = { tenantId };
    if (dateFilter) where.timestamp = dateFilter;

    const touchpoints = await prisma.touchpoint.findMany({ where });

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

module.exports = router;
