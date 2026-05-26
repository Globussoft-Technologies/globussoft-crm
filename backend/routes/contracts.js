const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

// GET /api/contracts — list with optional status filter
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;

    const contracts = await prisma.contract.findMany({
      where,
      include: { contact: true, deal: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(contracts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contracts" });
  }
});

// GET /api/contracts/stats — tenant-wide aggregate KPI surface.
//
// CRM polish — first /stats endpoint for the Contract CRUD route.
// Read-only KPI surface for the sales/legal dashboard. Mirrors
// estimates/stats + travel-suppliers/stats posture. Without this, the
// frontend has to fire {list, count-by-status×5, sum-value,
// filter+sum-active, filter-expiring-soon} — N+1 round-trips for a single
// visual surface.
//
// Behaviour:
//   - Tenant-scoped via req.user.tenantId.
//   - ?from / ?to (optional ISO date bounds on createdAt); invalid → 400 INVALID_DATE.
//   - byStatus: groupBy status across the Contract enum
//     (Draft / Sent / Active / Expired / Terminated — PascalCase per
//     schema.prisma Contract.status default + comment).
//   - totalValue: sum of value across all rows (half-up 2dp).
//   - signedValue: sum of value where status='Active' (half-up 2dp).
//     ("Active" is the equivalent terminal-active state; "Signed" is not
//     in the Contract enum per the schema's status default comment).
//   - activeCount: rows where status='Active' AND (endDate IS NULL OR
//     endDate >= now). Open-ended contracts with no endDate stay active.
//   - expiringSoonCount: rows where status='Active' AND endDate is within
//     the next 30 days (endDate >= now AND endDate <= now+30d).
//   - lastCreatedAt: max(createdAt) ISO, or null.
//   - NO audit row written — anodyne aggregate.
//
// Express route ordering: literal /stats MUST be declared BEFORE the /:id
// family or `:id="stats"` would parseInt → NaN and 400 Invalid contract
// ID before reaching this handler. Mirrors estimates/stats convention.
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };

    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "from must be a valid ISO date", code: "INVALID_DATE" });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "to must be a valid ISO date", code: "INVALID_DATE" });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    const rows = await prisma.contract.findMany({
      where,
      select: { status: true, value: true, endDate: true, createdAt: true },
    });

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const now = new Date();
    const thirtyDaysOut = new Date(now.getTime() + 30 * 86400000);

    const byStatus = {};
    let totalValue = 0;
    let signedValue = 0;
    let activeCount = 0;
    let expiringSoonCount = 0;
    let lastCreatedAt = null;

    for (const r of rows) {
      const st = r.status || "Draft";
      byStatus[st] = (byStatus[st] || 0) + 1;
      const amt = Number(r.value) || 0;
      totalValue += amt;

      if (st === "Active") {
        signedValue += amt;
        // Open-ended (endDate null) OR not-yet-past endDate → active.
        const ed = r.endDate ? new Date(r.endDate) : null;
        if (!ed || ed >= now) {
          activeCount += 1;
        }
        // Expiring within next 30 days: must have an endDate, must be in
        // the [now, now+30d] window.
        if (ed && ed >= now && ed <= thirtyDaysOut) {
          expiringSoonCount += 1;
        }
      }

      if (r.createdAt) {
        const ca = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt);
        if (!lastCreatedAt || ca > lastCreatedAt) lastCreatedAt = ca;
      }
    }

    res.json({
      total: rows.length,
      byStatus,
      totalValue: round2(totalValue),
      signedValue: round2(signedValue),
      activeCount,
      expiringSoonCount,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[contracts] stats error:", err.message);
    res.status(500).json({ error: "Failed to compute contract stats" });
  }
});

// GET /api/contracts/:id — single contract with relations
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contract ID" });

    const contract = await prisma.contract.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { contact: true, deal: true },
    });
    if (!contract) return res.status(404).json({ error: "Contract not found" });
    res.json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contract" });
  }
});

// POST /api/contracts — create contract
router.post("/", async (req, res) => {
  try {
    const { title, status, startDate, endDate, value, terms, contactId, dealId } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const contract = await prisma.contract.create({
      data: {
        title,
        status: status || "Draft",
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        value: value ? parseFloat(value) : 0.0,
        terms: terms || null,
        contactId: contactId ? parseInt(contactId) : null,
        dealId: dealId ? parseInt(dealId) : null,
        tenantId: req.user.tenantId,
      },
      include: { contact: true, deal: true },
    });
    res.status(201).json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create contract" });
  }
});

// PUT /api/contracts/:id — update contract fields
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contract ID" });

    const existing = await prisma.contract.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Contract not found" });

    const { title, status, startDate, endDate, value, terms, contactId, dealId } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (status !== undefined) data.status = status;
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
    if (value !== undefined) data.value = parseFloat(value);
    if (terms !== undefined) data.terms = terms;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const contract = await prisma.contract.update({
      where: { id: existing.id },
      data,
      include: { contact: true, deal: true },
    });
    res.json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update contract" });
  }
});

// DELETE /api/contracts/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contract ID" });
    const existing = await prisma.contract.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Contract not found" });
    await prisma.contract.delete({ where: { id: existing.id } });
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete contract" });
  }
});

module.exports = router;
