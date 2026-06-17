const express = require("express");
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
const { formatMoney } = require("../utils/formatMoney");
// #464: field-level permission enforcement. The fieldFilter middleware
// existed since v3.x but was never wired into any route — rules saved via
// the FieldPermissions UI had zero effect on read/write payloads. The
// helpers below strip fields the caller's role isn't permitted to read or
// write, based on rows in the FieldPermission table (per-tenant, per-role).
// Default (no rule in DB) is full access.
const { filterReadFields, filterWriteFields } = require("../middleware/fieldFilter");

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

// ─── Helper: audit log (delegates to shared lib/audit.js — issue #179) ──
async function audit(action, entityId, userId, tenantId, details) {
  return writeAudit("Deal", action, entityId, userId, tenantId, details);
}

// ─── GET / — list deals with filters ─────────────────────────────────
// #167: soft-deleted deals are hidden by default. Pass ?includeDeleted=true
// for admin/audit views. The /stats endpoint and aggregations are NOT yet
// filtered (see follow-up note at end of file).
router.get("/", async (req, res) => {
  try {
    const { stage, ownerId, pipelineId, contactId, subBrand, from, to } = req.query;
    const where = { tenantId: req.user.tenantId };

    if (stage) where.stage = stage;
    if (ownerId) where.ownerId = parseInt(ownerId);
    if (pipelineId) where.pipelineId = parseInt(pipelineId);
    if (contactId) where.contactId = parseInt(contactId);
    // Travel-vertical filter (v3.9.0 added Deal.subBrand). Tolerant of
    // missing column on legacy tenants — Prisma matches by exact value.
    if (subBrand) where.subBrand = String(subBrand);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    if (req.query.includeDeleted !== "true") where.deletedAt = null;
    // #588: USER role sees only their own deals; ADMIN/MANAGER see full
    // tenant. An explicit ?ownerId= from a USER is overridden by their own
    // userId — a sales rep cannot probe a colleague's pipeline by URL.
    if (req.user.role === "USER") where.ownerId = req.user.userId;

    // #172: pagination support (was ignored entirely pre-fix).
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    // #920 slice 2 — PII reduction via opt-in slim shape. Mirrors the
    // contacts.js pattern shipped in slice 1 (f7790241). When the caller
    // passes ?fields=summary the response drops the heavy nested includes
    // (contact + owner) AND the heavy/sensitive flat columns (currency,
    // probability, expectedClose, lostReason, winLossReasonId, diagnosticId,
    // subBrand, deletedAt) by switching to an explicit Prisma `select`.
    // ADDITIVE — when ?fields is absent or any other value, the existing
    // full-shape `include` is preserved so no existing consumer (Pipeline,
    // DealModal, Dashboard, CommandPalette, etc.) needs to change.
    // filterReadFields() still applies on the slim shape (no-op for fields
    // not present) so the #464 field-permission layer keeps composing.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where, take: limit, skip: offset,
      orderBy: { createdAt: "desc" },
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        title: true,
        amount: true,
        stage: true,
        ownerId: true,
        contactId: true,
        tenantId: true,
        createdAt: true,
      };
    } else {
      findManyArgs.include = { contact: true, owner: true };
    }
    const deals = await prisma.deal.findMany(findManyArgs);
    // #464: strip fields the caller's role can't read (e.g. amount hidden
    // for USER if FieldPermission rule says canRead=false on Deal.amount).
    const filtered = await filterReadFields(deals, req.user.role, "Deal", req.user.tenantId);
    res.json(filtered);
  } catch (error) {
    console.error("[deals] list error:", error.message);
    res.status(500).json({ error: "Failed to fetch deals" });
  }
});

// ─── GET /stats — pipeline statistics ────────────────────────────────
// #567: Dashboard.jsx KPIs were computing Closed Revenue / Expected Revenue /
// Total Deals client-side by reducing over `/api/deals?limit=100`. On large
// tenants (5,381 deals on demo, 375 won, $5B aggregate) the newest-100
// window contained only 1 won deal → "Closed Revenue $0" permanently. The
// frontend now reads these aggregates from /stats. Added: wonCount, wonValue,
// lostCount, lostValue, expectedValue (probability-weighted pipeline). Soft-
// deleted rows excluded (dashboard never shows them). Existing fields
// (totalDeals, totalValue, avgDealSize, winRate, byStage, closedThisMonth)
// preserved — additive change, doesn't break existing /stats consumers.
//
// #588: USER role gets own-deal scope (ownerId = req.user.userId);
// ADMIN/MANAGER continue to see full-tenant aggregates because they manage
// the org. Pre-fix, a sales rep saw the same $1.55M closed / 551 deals as
// the Admin — information disclosure that mirrored the wellness-tenant gap
// in #207. Mirrors the per-rep filter pattern already documented in the
// list endpoint's `?ownerId=` query support.
router.get("/stats", async (req, res) => {
  try {
    const tid = req.user.tenantId;
    const where = { tenantId: tid, deletedAt: null };
    if (req.user.role === "USER") where.ownerId = req.user.userId;
    const deals = await prisma.deal.findMany({ where });

    const totalDeals = deals.length;
    const totalValue = deals.reduce((s, d) => s + (d.amount || 0), 0);
    const avgDealSize = totalDeals ? totalValue / totalDeals : 0;

    const wonDeals = deals.filter((d) => d.stage === "won");
    const lostDeals = deals.filter((d) => d.stage === "lost");
    const won = wonDeals.length;
    const lost = lostDeals.length;
    const closed = won + lost;
    const winRate = closed ? Math.round((won / closed) * 100) : 0;

    const wonCount = won;
    const wonValue = wonDeals.reduce((s, d) => s + (d.amount || 0), 0);
    const lostCount = lost;
    const lostValue = lostDeals.reduce((s, d) => s + (d.amount || 0), 0);

    // #567: probability-weighted pipeline value. Mirrors the per-stage weights
    // Dashboard.jsx used pre-fix so the rendered "Expected Revenue" tile lines
    // up with what users saw before — but computed over the FULL population
    // server-side, not the newest 100 rows. Stages outside this map contribute
    // 0 (negotiation/lost have no expected uplift).
    const probs = { lead: 0.1, contacted: 0.3, proposal: 0.7, won: 1.0 };
    const expectedValue = deals.reduce(
      (s, d) => s + ((d.amount || 0) * (probs[d.stage] || 0)),
      0
    );

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

    res.json({
      totalDeals,
      totalValue,
      avgDealSize,
      winRate,
      byStage,
      closedThisMonth,
      wonCount,
      wonValue,
      lostCount,
      lostValue,
      expectedValue,
    });
  } catch (error) {
    console.error("[deals] stats error:", error.message);
    res.status(500).json({ error: "Failed to compute deal stats" });
  }
});

// ─── GET /:id — single deal with full relations ─────────────────────
router.get("/:id", async (req, res) => {
  try {
    const includeDeleted = req.query.includeDeleted === "true";
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
    // #167: 404 soft-deleted deals unless explicitly opted in.
    if (deal.deletedAt && !includeDeleted) return res.status(404).json({ error: "Deal not found" });

    // Fetch activities linked to this deal's contact
    let activities = [];
    if (deal.contactId) {
      activities = await prisma.activity.findMany({
        where: { contactId: deal.contactId, tenantId: req.user.tenantId },
        orderBy: { createdAt: "desc" },
      });
    }

    // #464: strip read-restricted fields per the caller's role.
    const filtered = await filterReadFields({ ...deal, activities }, req.user.role, "Deal", req.user.tenantId);
    res.json(filtered);
  } catch (error) {
    console.error("[deals] get-by-id error:", error.message);
    res.status(500).json({ error: "Failed to fetch deal" });
  }
});

// #162 #173: stages were originally a closed generic-CRM enum (lead, contacted,
// proposal, negotiation, won, lost). The travel vertical seeds 8 stages with
// different slugs (new, diagnostic-complete, qualifying, quoted, negotiating,
// won, lost, dormant) so the static set silently 400'd valid stage drops. The
// validator now resolves the allowed slug set from the tenant's own
// PipelineStage rows; terminal "won" / "lost" are always honored as a
// backstop for tenants whose stage list hasn't been seeded yet.
const LEGACY_DEAL_STAGES = ["lead", "contacted", "proposal", "negotiation", "won", "lost"];
const slugifyStageName = (name) =>
  String(name || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

async function getAllowedStagesForTenant(tenantId) {
  const rows = await prisma.pipelineStage.findMany({
    where: { tenantId },
    select: { name: true },
  });
  const allowed = new Set(rows.map((r) => slugifyStageName(r.name)).filter(Boolean));
  // Legacy generic slugs stay accepted so existing deals + tests don't break
  // on tenants whose stage list got customized without renaming legacy rows.
  for (const s of LEGACY_DEAL_STAGES) allowed.add(s);
  return allowed;
}

const { ensureNumberInRange, ensureEnum, httpFromPrismaError } = require("../lib/validators");

async function validateDealInput(body, { tenantId, isUpdate: _isUpdate = false } = {}) {
  if (body.amount !== undefined && body.amount !== null && body.amount !== "") {
    const e = ensureNumberInRange(body.amount, { min: 0, max: 1e12, field: "amount", code: "INVALID_AMOUNT" });
    if (e) return e;
  }
  if (body.probability !== undefined && body.probability !== null && body.probability !== "") {
    const e = ensureNumberInRange(body.probability, { min: 0, max: 100, field: "probability", code: "INVALID_PROBABILITY" });
    if (e) return e;
  }
  if (body.stage !== undefined && body.stage !== null && body.stage !== "") {
    const allowed = await getAllowedStagesForTenant(tenantId);
    const e = ensureEnum(body.stage, allowed, { field: "stage", code: "INVALID_STAGE" });
    if (e) return e;
  }
  return null;
}

// ─── POST / — create deal ────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    // #464: strip write-restricted fields BEFORE destructuring so a USER
    // who has canWrite=false on Deal.amount can't push a value through.
    req.body = await filterWriteFields(req.body, req.user.role, "Deal", req.user.tenantId);
    const { title, amount, probability, stage, contactId, pipelineId, expectedClose, currency, subBrand, lostReason, winLossReasonId } = req.body;
    if (!title) return res.status(400).json({ error: "Title is required" });
    // #162: validate amount, probability, stage so bad inputs return 400.
    const inputErr = await validateDealInput(req.body, { tenantId: req.user.tenantId, isUpdate: false });
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
    if (subBrand) data.subBrand = String(subBrand);
    // #977: POST was previously dropping lostReason / winLossReasonId on the
    // floor (destructure didn't include them), so a deal created directly in
    // the 'lost' stage with a free-text reason had no reason persisted —
    // GET /api/win-loss/analysis byReason then silently omitted the row.
    // Mirror PUT's thread-through (line 357-358) so create + update agree.
    if (lostReason !== undefined) data.lostReason = lostReason;
    if (winLossReasonId !== undefined) data.winLossReasonId = parseInt(winLossReasonId);
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
    try { require("../lib/eventBus").emitEvent("deal.created", { dealId: deal.id, title: deal.title, amount: deal.amount, stage: deal.stage, contactId: deal.contactId, userId: req.user.userId }, req.user.tenantId, req.io); } catch(_e) {}

    if (req.io) req.io.emit("deal_updated", deal);
    res.status(201).json(deal);
  } catch (error) {
    console.error("[deals] create error:", error.message);
    // #165: surface Prisma validation errors as 400, not 500.
    const mapped = httpFromPrismaError(error);
    if (mapped) return res.status(mapped.status).json(mapped);
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

    // #464: strip write-restricted fields per the caller's role.
    req.body = await filterWriteFields(req.body, req.user.role, "Deal", req.user.tenantId);
    const { title, amount, probability, stage, contactId, pipelineId, expectedClose, currency, lostReason, winLossReasonId } = req.body;
    // #168 #173: same validation as POST — PUT can no longer accept negative
    // amount / out-of-range probability / unknown stage.
    const inputErr = await validateDealInput(req.body, { tenantId: req.user.tenantId, isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    // #173: terminal-stage state machine. Once a deal is `won` or
    // `lost`, the stage is closed — re-opening or flipping to the
    // other terminal stage corrupts forecasting (Closed-Won pipeline
    // counts) and audit history. Reject 422 with the same shape the
    // billing route uses.
    if (stage !== undefined && stage !== existing.stage) {
      const terminalStages = new Set(["won", "lost"]);
      if (terminalStages.has(existing.stage)) {
        return res.status(422).json({
          error: `Cannot transition deal from ${existing.stage} to ${stage}`,
          code: "INVALID_DEAL_TRANSITION",
          currentStage: existing.stage,
        });
      }
    }

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

    // #16: PUT was previously silent — emit deal.updated so workflow rules
    // listening on generic deal updates can fire. Additionally emit
    // deal.stage_changed when the stage actually moved (separate from /won
    // and /lost which have their own dedicated emissions).
    try {
      const { emitEvent } = require("../lib/eventBus");
      await emitEvent("deal.updated", {
        dealId: deal.id, title: deal.title, amount: deal.amount, stage: deal.stage,
        contactId: deal.contactId, userId: req.user.userId,
      }, req.user.tenantId, req.io);
      if (stageChanged) {
        await emitEvent("deal.stage_changed", {
          dealId: deal.id, title: deal.title, amount: deal.amount,
          fromStage: existing.stage, toStage: deal.stage,
          contactId: deal.contactId, userId: req.user.userId,
        }, req.user.tenantId, req.io);
      }
    } catch (_) { /* event bus failures must not break the update */ }

    if (req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    console.error("[deals] update error:", error.message);
    // #168 #165: bad amount / probability that slipped past the validator
    // (e.g. a Prisma decimal-overflow) returns 400, not 500.
    const mapped = httpFromPrismaError(error);
    if (mapped) return res.status(mapped.status).json(mapped);
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
        // #286/#330: format the won-deal amount through the tenant currency,
        // not a hardcoded `$`, so wellness/INR activity descriptions read ₹.
        const amountStr = formatMoney(deal.amount, deal.currency || "USD");
        await prisma.activity.create({
          data: {
            type: "Deal",
            description: `Deal won: "${deal.title}" (${amountStr})`,
            contactId: deal.contactId,
            tenantId: req.user.tenantId,
            userId: req.user.userId,
          },
        });
      } catch (_) { /* non-critical */ }
    }

    await audit("UPDATE", deal.id, req.user.userId, req.user.tenantId, { action: "won", from: existing.stage });
    try { await require("../lib/eventBus").emitEvent("deal.won", { dealId: deal.id, title: deal.title, amount: deal.amount, contactId: deal.contactId, userId: req.user.userId }, req.user.tenantId, req.io); } catch(_e) {}

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
    try { require("../lib/eventBus").emitEvent("deal.lost", { dealId: deal.id, title: deal.title, amount: deal.amount, lostReason, contactId: deal.contactId, userId: req.user.userId }, req.user.tenantId, req.io); } catch(_e) {}

    if (req.io) req.io.emit("deal_updated", deal);
    res.json(deal);
  } catch (error) {
    console.error("[deals] mark-lost error:", error.message);
    res.status(500).json({ error: "Failed to mark deal as lost" });
  }
});

// ─── DELETE /:id — soft-delete (#167) ────────────────────────────────
// Flips deletedAt instead of removing the row, so pipeline KPIs / forecasting
// /win-loss history don't silently shrink. Admin only. Idempotent.
router.delete("/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });
    if (existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, softDeleted: true });
    }

    await audit("SOFT_DELETE", existing.id, req.user.userId, req.user.tenantId, { title: existing.title, stage: existing.stage });

    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });

    if (req.io) req.io.emit("deal_deleted", existing.id);
    res.json({ ...deal, success: true, softDeleted: true });
  } catch (error) {
    console.error("[deals] delete error:", error.message);
    res.status(500).json({ error: "Failed to delete deal" });
  }
});

// ─── POST /:id/restore — undo a soft-delete (#167) ───────────────────
router.post("/:id/restore", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const existing = await prisma.deal.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Deal not found" });
    if (!existing.deletedAt) {
      return res.json({ ...existing, idempotent: true, restored: false });
    }
    await audit("RESTORE", existing.id, req.user.userId, req.user.tenantId, { title: existing.title });
    const deal = await prisma.deal.update({
      where: { id: existing.id },
      data: { deletedAt: null },
      include: { contact: true, owner: true },
    });
    if (req.io) req.io.emit("deal_updated", deal);
    res.json({ ...deal, restored: true });
  } catch (error) {
    console.error("[deals] restore error:", error.message);
    res.status(500).json({ error: "Failed to restore deal" });
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
