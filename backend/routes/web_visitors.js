const router = require("express").Router();
const prisma = require("../lib/prisma");

// Safe JSON helpers
function parseJSON(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function getTenantId(req, fallback) {
  const t = req.body && req.body.tenantId;
  const n = parseInt(t, 10);
  if (!Number.isNaN(n) && n > 0) return n;
  return fallback || 1;
}

// ── PUBLIC: Track page view ────────────────────────────────────────
// POST /api/web-visitors/track
router.post("/track", async (req, res) => {
  try {
    const { sessionId, url, userAgent, ipAddress, country } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const tenantId = getTenantId(req, 1);
    const ip = ipAddress || req.ip || req.headers["x-forwarded-for"] || null;
    const ua = userAgent || req.headers["user-agent"] || null;
    const now = new Date();

    const existing = await prisma.webVisitor.findUnique({ where: { sessionId } });

    if (existing) {
      const pages = parseJSON(existing.pages, []);
      pages.push({ url: url || null, timestamp: now.toISOString() });
      // Cap pages to last 200 to avoid runaway growth
      const trimmed = pages.length > 200 ? pages.slice(-200) : pages;
      const updated = await prisma.webVisitor.update({
        where: { sessionId },
        data: {
          pages: JSON.stringify(trimmed),
          lastSeen: now,
          ipAddress: ip || existing.ipAddress,
          userAgent: ua || existing.userAgent,
          country: country || existing.country,
        },
      });
      return res.json({ success: true, visitorId: updated.id, sessionId, pageCount: trimmed.length });
    }

    const created = await prisma.webVisitor.create({
      data: {
        sessionId,
        ipAddress: ip,
        userAgent: ua,
        country: country || null,
        pages: JSON.stringify([{ url: url || null, timestamp: now.toISOString() }]),
        identified: false,
        firstSeen: now,
        lastSeen: now,
        tenantId,
      },
    });
    res.json({ success: true, visitorId: created.id, sessionId, pageCount: 1 });
  } catch (err) {
    console.error("[web-visitors/track]", err);
    res.status(500).json({ error: "Tracking failed" });
  }
});

// ── PUBLIC: Identify visitor (link to contact via email) ───────────
// POST /api/web-visitors/identify
router.post("/identify", async (req, res) => {
  try {
    const { sessionId, email } = req.body || {};
    if (!sessionId || !email) return res.status(400).json({ error: "sessionId and email required" });

    const tenantId = getTenantId(req, 1);

    const visitor = await prisma.webVisitor.findUnique({ where: { sessionId } });
    if (!visitor) return res.status(404).json({ error: "Visitor not found" });

    const contact = await prisma.contact.findFirst({
      where: { email: email.toLowerCase().trim(), tenantId: visitor.tenantId || tenantId },
    });

    if (!contact) {
      return res.json({ success: true, identified: false, message: "No matching contact" });
    }

    const updated = await prisma.webVisitor.update({
      where: { sessionId },
      data: { contactId: contact.id, identified: true },
    });

    res.json({ success: true, identified: true, contactId: contact.id, visitorId: updated.id });
  } catch (err) {
    console.error("[web-visitors/identify]", err);
    res.status(500).json({ error: "Identify failed" });
  }
});

// ── AUTHENTICATED: Stats ───────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const now = new Date();
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const startWeek = new Date(now); startWeek.setDate(startWeek.getDate() - 7);
    const startMonth = new Date(now); startMonth.setDate(startMonth.getDate() - 30);

    const [today, week, month, identified, total] = await Promise.all([
      prisma.webVisitor.count({ where: { tenantId, lastSeen: { gte: startToday } } }),
      prisma.webVisitor.count({ where: { tenantId, lastSeen: { gte: startWeek } } }),
      prisma.webVisitor.count({ where: { tenantId, lastSeen: { gte: startMonth } } }),
      prisma.webVisitor.count({ where: { tenantId, identified: true } }),
      prisma.webVisitor.count({ where: { tenantId } }),
    ]);

    const pctIdentified = total > 0 ? Math.round((identified / total) * 1000) / 10 : 0;
    res.json({ today, week, month, identified, total, pctIdentified });
  } catch (err) {
    console.error("[web-visitors/stats]", err);
    res.status(500).json({ error: "Stats failed" });
  }
});

// ── AUTHENTICATED: List visitors (default last 7 days) ─────────────
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const days = parseInt(req.query.days, 10) || 7;
    const since = new Date(); since.setDate(since.getDate() - days);

    const visitors = await prisma.webVisitor.findMany({
      where: { tenantId, lastSeen: { gte: since } },
      orderBy: { lastSeen: "desc" },
      take: 200,
    });

    // Hydrate contact info for identified visitors
    const contactIds = visitors.filter(v => v.contactId).map(v => v.contactId);
    const contacts = contactIds.length
      ? await prisma.contact.findMany({
          where: { id: { in: contactIds }, tenantId },
          select: { id: true, name: true, email: true, company: true },
        })
      : [];
    const contactById = Object.fromEntries(contacts.map(c => [c.id, c]));

    const result = visitors.map(v => {
      const pages = parseJSON(v.pages, []);
      return {
        id: v.id,
        sessionId: v.sessionId,
        ipAddress: v.ipAddress,
        userAgent: v.userAgent,
        country: v.country,
        city: v.city,
        identified: v.identified,
        contactId: v.contactId,
        contact: v.contactId ? contactById[v.contactId] || null : null,
        pageCount: pages.length,
        firstUrl: pages[0] ? pages[0].url : null,
        lastUrl: pages.length ? pages[pages.length - 1].url : null,
        firstSeen: v.firstSeen,
        lastSeen: v.lastSeen,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("[web-visitors/list]", err);
    res.status(500).json({ error: "List failed" });
  }
});

// ── AUTHENTICATED: Visitor detail ──────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const v = await prisma.webVisitor.findFirst({ where: { id, tenantId } });
    if (!v) return res.status(404).json({ error: "Not found" });

    let contact = null;
    if (v.contactId) {
      contact = await prisma.contact.findFirst({
        where: { id: v.contactId, tenantId },
        select: { id: true, name: true, email: true, company: true, phone: true },
      });
    }

    res.json({
      id: v.id,
      sessionId: v.sessionId,
      ipAddress: v.ipAddress,
      userAgent: v.userAgent,
      country: v.country,
      city: v.city,
      identified: v.identified,
      contactId: v.contactId,
      contact,
      pages: parseJSON(v.pages, []),
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
    });
  } catch (err) {
    console.error("[web-visitors/detail]", err);
    res.status(500).json({ error: "Detail failed" });
  }
});

module.exports = router;
