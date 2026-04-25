const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

router.use(verifyToken);

// #188: short-circuit non-numeric :id so requests like GET /api/deals/funnel
// return 400 cleanly instead of crashing the by-id handler with a 500.
// Until literal analytics routes (/funnel, /leaderboard, etc.) are
// implemented, treating them as "bad id" is the correct disposition.
router.param("id", (req, res, next, id) => {
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n < 1) {
    return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
  }
  next();
});

// ─── Helper: audit log ───────────────────────────────────────────────
async function audit(action, entityId, userId, tenantId, details) {
  try {
    await prisma.auditLog.create({
      data: { action, entity: "Deal", entityId, userId, tenantId, details: typeof details === "string" ? details : JSON.stringify(details) },
    });
  } catch (_) { /* non-critical */ }
}

// ─── GET / — list deals with filters ─────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { stage, ownerId, pipelineId, contactId, from, to } = req.query;
    const where = { tenantId: req.user.tenantId };

    if (stage) where.stage = stage;
    if (ownerId) where.ownerId = parseInt(ownerId);
    if (pipelineId) where.pipelineId = parseInt(pipelineId);
    if (contactId) where.contactId = parseInt(contactId);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    // #172: pagination support (was ignored entirely pre-fix).
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const deals = await prisma.deal.findMany({
      where, take: limit, skip: offset,
      include: { contact: true, owner: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(deals);
  } catch (error) {
    console.error("[deals] list error:", error.message);
    res.status(500).json({ error: "Failed to fetch deals" });
  }
});

// ─── GET /stats — pipeline statistics ────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const deals = await prisma.deal.findMany({ where: { tenantId: tid } });

    const totalDeals = deals.length;
    const totalValue = deals.reduce((s, d) => s + (d.amount || 0), 0);
    const avgDealSize = totalDeals ? totalValue / totalDeals : 0;

    const won = deals.filter((d) => d.stage === "won").length;
    const closed = deals.filter((d) => d.stage === "won" || d.stage === "lost").length;
    const winRate = closed ? Math.round((won / closed) * 100) : 0;

    // Group by stage
    const stageMap = {};
    deals.forEach((d) => {
      if (!stageMap[d.stage]) stageMap[d.stage] = { stage: d.stage, count: 0, value: 0 };
      stageMap[d.stage].count++;
      stageMap[d.stage].value += d.amount || 0;
    });
    const byStage = Object.values(stageMap);

    // Closed this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const closedThisMonth = deals.filter(
      (d) => (d.stage === "won" || d.stage === "lost") && d.createdAt >= monthStart
    ).length;

    res.json({ totalDeals, totalValue, avgDealSize, winRate, byStage, closedThisMonth });
  } catch (error) {
    console.error("[deals] stats error:", error.message);
    res.status(500).json({ error: "Failed to compute deal stats" });
  }
});

// ─── GET /:id — single deal with full relations ─────────────────────
router.get("/:id", async (req, res) => {
  try {
    const deal = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
      include: {
        contact: true,
        owner: true,
        attachments: true,
        invoices: true,
        quotes: { include: { lineItems: true } },
        contracts: true,
        estimates: { include: { lineItems: true } },
        projects: true,
      },
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    // Fetch activities linked to this deal's contact
    let activities = [];
    if (deal.contactId) {
      activities = await prisma.activity.findMany({
        where: { contactId: deal.contactId, tenantId: req.user.tenantId },
        orderBy: { createdAt: "desc" },
      });
    }

    res.json({ ...deal, activities });
  } catch (error) {
    console.error("[deals] get-by-id error:", error.message);
    res.status(500).json({ error: "Failed to fetch deal" });
  }
});

// #162 #173: stages used as a closed enum across pipeline analytics. Match the
// values seeded in pipeline_stages + already used in code: lead, contacted,
// proposal, negotiation, won, lost. Lowercase matches existing seed data.
const ALLOWED_DEAL_STAGES = new Set(["lead", "contacted", "proposal", "negotiation", "won", "lost"]);
const { ensureNumberInRange, ensureEnum } = require("../lib/validators");

function validateDealInput(body, { isUpdate = false } = {}) {
  if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
    const e = ensureNumberInRange(body.amount, { min: 0, max: 1e12, field: "amount", code: "INVALID_AMOUNT" });
    if (e) return e;
  }
  if (body.probability !== undefined && body.probability !== null && body.probability !== "") {
    const e = ensureNumberInRange(body.probability, { min: 0, max: 100, field: "probability", code: "INVALID_PROBABILITY" });
    if (e) return e;
  }
  if (body.stage !== undefined && body.stage !== null && body.stage !== "") {
    const e = ensureEnum(body.stage, ALLOWED_DEAL_STAGES, { field: "stage", code: "INVALID_STAGE" });
    if (e) return e;
  }
  return null;
}

// ─── POST / — create deal ────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { title, amount, probability, stage, contactId, pipelineId, expectedClose, currency } = req.body;
    if (!title) return res.status(400).json({ error: "Title is required" });
    // #162: validate amount, probability, stage so bad inputs return 400.
    const inputErr = validateDealInput(req.body, { isUpdate: false });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const data = {
      title,
      amount: parseFloat(amount) || 0,
      probability: parseInt(probability) || 50,
      stage: stage || "lead",
      ownerId: req.user.userId,
      tenantId: req.user.tenantId,
    };
    if (contactId) data.contactId = parseInt(contactId);
    if (pipelineId) data.pipelineId = parseInt(pipelineId);
    if (expectedClose) data.expectedClose = new Date(expectedClose);
    if (currency) {
      data.currency = currency;
    } else {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { defaultCurrency: true } });
      data.currency = tenant?.defaultCurrency || "USD";
    }

    const deal = await prisma.deal.create({ data, include: { contact: true, owner: true } });

    // Activity for the associated contact
    if (deal.contactId) {
      try {
        await prisma.activity.create({
          data: {
            type: "Deal",
            description: `Deal created: "${deal.title}" (${deal.currency} ${deal.amount})`,
            contactId: deal.contactId,
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (_) { /* non-critical */ }
    }

    await audit("CREATE", deal.id, req.user.userId, req.user.tenantId, { title: deal.title, amount: deal.amount, stage: deal.stage });
    try { require("../lib/eventBus").emitEvent("deal.created", { dealId: deal.id, title: deal.title, amount: deal.amount, stage: deal.stage, contactId: deal.contactId, userId: req.user.userId }, req.user.tenantId, req.io); } catch(e) {}

    if (req.io) req.io.emit("deal_updated", deal);
    res.status(201).json(deal);
  } catch (error) {
    console.error("[deals] create error:", error.message);
    res.status(500).json({ error: "Failed to create deal" });
  }
});

// ─── PUT /:id — full update ──────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    const { title, amount, probability, stage, contactId, pipelineId, expectedClose, currency, lostReason, winLossReasonId } = req.body;
    // #168 #173: same validation as POST — PUT can no longer accept negative
    // amount / out-of-range probability / unknown stage.
    const inputErr = validateDealInput(req.body, { isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    const data = {};

    if (title !== undefined) data.title = title;
    if (amount !== undefined) data.amount = parseFloat(amount);
    if (probability !== undefined) data.probability = parseInt(probability);
    if (stage !== undefined) data.stage = stage;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (pipelineId !== undefined) data.pipelineId = pipelineId ? parseInt(pipelineId) : null;
    if (expectedClose !== undefined) data.expectedClose = expectedClose ? new Date(expectedClose) : null;
    if (currency !== undefined) data.currency = currency;
    if (lostReason !== undefined) data.lostReason = lostReason;
    if (winLossReasonId !== undefined) data.winLossReasonId = parseInt(winLossReasonId);

    // Track stage transition
    const stageChanged = stage !== undefined && stage !== existing.stage;
    if (stageChanged && (stage === "won" || stage === "lost")) {
      if (stage === "won") data.probability = 100;
      if (stage === "lost") data.probability = 0;
    }

    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data,
      include: { contact: true, owner: true },
    });

    // Stage-change activity
    if (stageChanged && deal.contactId) {
      try {
        await prisma.activity.create({
          data: {
            type: "Deal",
            description: `Deal "${deal.title}" moved from ${existing.stage} to ${deal.stage}`,
            contactId: deal.contactId,
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (_) { /* non-critical */ }
    }

    await audit("UPDATE", deal.id, req.user.userId, req.user.tenantId, { from: existing.stage, to: deal.stage, fields: Object.keys(data) });

    if (req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    console.error("[deals] update error:", error.message);
    res.status(500).json({ error: "Failed to update deal" });
  }
});

// ─── PUT /:id/stage — backwards-compatible stage update ──────────────
router.put("/:id/stage", async (req, res) => {
  try {
    const { stage, lostReason } = req.body;
    if (!stage) return res.status(400).json({ error: "Stage is required" });

    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    const data = { stage };
    if (stage === "lost" && lostReason) data.lostReason = lostReason;
    if (stage === "won") data.probability = 100;
    if (stage === "lost") data.probability = 0;

    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data,
      include: { contact: true, owner: true },
    });

    if (existing.stage !== stage && deal.contactId) {
      try {
        await prisma.activity.create({
          data: {
            type: "Deal",
            description: `Deal "${deal.title}" stage changed: ${existing.stage} → ${stage}`,
            contactId: deal.contactId,
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (_) { /* non-critical */ }
    }

    await audit("UPDATE", deal.id, req.user.userId, req.user.tenantId, { action: "stage_change", from: existing.stage, to: stage });

    if (req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    console.error("[deals] stage-update error:", error.message);
    res.status(500).json({ error: "Stage transition error" });
  }
});

// ─── POST /:id/won — mark deal as won ───────────────────────────────
router.post("/:id/won", async (req, res) => {
  try {
    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data: { stage: "won", probability: 100 },
      include: { contact: true, owner: true },
    });

    if (deal.contactId) {
      try {
        await prisma.activity.create({
          data: {
            type: "Deal",
            description: `Deal won: "${deal.title}" ($${deal.amount})`,
            contactId: deal.contactId,
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (_) { /* non-critical */ }
    }

    await audit("UPDATE", deal.id, req.user.userId, req.user.tenantId, { action: "won", from: existing.stage });
    try { require("../lib/eventBus").emitEvent("deal.won", { dealId: deal.id, title: deal.title, amount: deal.amount, contactId: deal.contactId, userId: req.user.userId }, req.user.tenantId, req.io); } catch(e) {}

    if (req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    console.error("[deals] mark-won error:", error.message);
    res.status(500).json({ error: "Failed to mark deal as won" });
  }
});

// ─── POST /:id/lost — mark deal as lost ─────────────────────────────
router.post("/:id/lost", async (req, res) => {
  try {
    const { lostReason, winLossReasonId } = req.body;
    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    const data = { stage: "lost", probability: 0 };
    if (lostReason) data.lostReason = lostReason;
    if (winLossReasonId) data.winLossReasonId = parseInt(winLossReasonId);

    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data,
      include: { contact: true, owner: true },
    });

    if (deal.contactId) {
      try {
        await prisma.activity.create({
          data: {
            type: "Deal",
            description: `Deal lost: "${deal.title}"${lostReason ? ` — ${lostReason}` : ""}`,
            contactId: deal.contactId,
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (_) { /* non-critical */ }
    }

    await audit("UPDATE", deal.id, req.user.userId, req.user.tenantId, { action: "lost", from: existing.stage, lostReason });
    try { require("../lib/eventBus").emitEvent("deal.lost", { dealId: deal.id, title: deal.title, amount: deal.amount, lostReason, contactId: deal.contactId, userId: req.user.userId }, req.user.tenantId, req.io); } catch(e) {}

    if (req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    console.error("[deals] mark-lost error:", error.message);
    res.status(500).json({ error: "Failed to mark deal as lost" });
  }
});

// ─── DELETE /:id ─────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });

    await prisma.deal.delete({ where: { id: existing.id } });

    await audit("DELETE", existing.id, req.user.userId, req.user.tenantId, { title: existing.title });

    if (req.io) req.io.emit("deal_deleted", existing.id);
    res.json({ success: true });
  } catch (error) {
    console.error("[deals] delete error:", error.message);
    res.status(500).json({ error: "Failed to delete deal" });
  }
});

// ─── GET /:id/timeline — merged activity timeline ───────────────────
router.get("/:id/timeline", async (req, res) => {
  try {
    const deal = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const tid = req.user.tenantId;
    const cid = deal.contactId;
    const timeline = [];

    // Activities
    if (cid) {
      const activities = await prisma.activity.findMany({
        where: { contactId: cid, tenantId: tid },
      });
      activities.forEach((a) => timeline.push({ type: "activity", subtype: a.type, description: a.description, createdAt: a.createdAt, id: a.id }));
    }

    // Emails
    if (cid) {
      const emails = await prisma.emailMessage.findMany({
        where: { contactId: cid, tenantId: tid },
      });
      emails.forEach((e) => timeline.push({ type: "email", subtype: e.direction, description: e.subject, createdAt: e.createdAt, id: e.id }));
    }

    // Calls
    if (cid) {
      const calls = await prisma.callLog.findMany({
        where: { contactId: cid, tenantId: tid },
      });
      calls.forEach((c) => timeline.push({ type: "call", subtype: c.direction, description: `${c.direction} call (${c.duration}s)`, createdAt: c.createdAt, id: c.id }));
    }

    // Tasks
    if (cid) {
      const tasks = await prisma.task.findMany({
        where: { contactId: cid, tenantId: tid },
      });
      tasks.forEach((t) => timeline.push({ type: "task", subtype: t.status, description: t.title, createdAt: t.createdAt, id: t.id }));
    }

    // Sort descending by date
    timeline.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(timeline);
  } catch (error) {
    console.error("[deals] timeline error:", error.message);
    res.status(500).json({ error: "Failed to fetch deal timeline" });
  }
});

module.exports = router;
