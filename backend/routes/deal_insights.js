const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();
const { formatMoney } = require("../utils/formatMoney");

const GEMINI_KEY = process.env.GEMINI_API_KEY;
let aiModel = null;
if (GEMINI_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    console.log("[DealInsights] Gemini initialized");
  } catch (err) {
    console.warn("[DealInsights] Gemini init failed:", err.message);
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

router.use(verifyToken);

// ── GET / : list insights for tenant (filter by severity, dealId, isResolved) ─
//
// #572: prior shape returned bare DealInsight rows. Frontend at /deal-insights
// then fetched /api/deals?limit=100 in parallel and built a dealById lookup
// to resolve `Deal #1600` → `<title> · <stage> · <amount>`. On large tenants
// (5,381 demo deals, 498 insights) the newest-100 window only resolved ~20%
// of insights → 80% rendered the literal placeholder "Deal details unavailable".
//
// Fix: attach `dealContext` (title, amount, currency, stage, contactName,
// expectedClose, deletedAt) to every insight server-side via a single
// `findMany({ where: { id: { in: dealIds } } })` join. Soft-deleted deals
// are still returned (with `deletedAt` set) so the frontend can render
// "[archived] <title>" instead of the bare placeholder. Pure additive
// envelope change — existing top-level fields (id, dealId, type, severity,
// insight, isResolved, generatedAt, tenantId) preserved for legacy callers
// (specs, mobile, third-party integrations).
//
// Slim-shape opt-in (#920 slice 51): when called with ?fields=summary,
// the handler ships only the slim columns (id, dealId, type, severity,
// isResolved, generatedAt) — the heavy `insight` @db.Text body is
// dropped AND the dealContext enrichment join is skipped. Useful for
// the dashboard count-by-severity badge + the open-insights-by-deal
// picker that needs ids + severities only, NOT the full insight text
// or per-deal title/amount context. Existing callers (no ?fields, or
// any non-exact value) keep the full enriched envelope unchanged.
// Same strict opt-in pattern as routes/canned_responses.js +
// routes/service_categories.js (slices 1-48).
router.get("/", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.severity) where.severity = req.query.severity;
    if (req.query.dealId) where.dealId = parseInt(req.query.dealId);
    if (req.query.isResolved !== undefined) {
      where.isResolved = req.query.isResolved === "true";
    }
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: { generatedAt: "desc" },
      take: 500,
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        dealId: true,
        type: true,
        severity: true,
        isResolved: true,
        generatedAt: true,
      };
    }
    const insights = await prisma.dealInsight.findMany(findManyArgs);
    if (isSummary) {
      // Skip the dealContext enrichment join — picker callers don't need it.
      return res.json(insights);
    }
    const enriched = await attachDealContext(insights, req.user.tenantId);
    res.json(enriched);
  } catch (err) {
    console.error("[DealInsights GET /] ", err);
    res.status(500).json({ error: "Failed to fetch insights" });
  }
});

// ── GET /stats : count by type/severity for tenant ──
router.get("/stats", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    const [byType, bySeverity, openCount, resolvedCount] = await Promise.all([
      prisma.dealInsight.groupBy({ by: ["type"], where, _count: { _all: true } }),
      prisma.dealInsight.groupBy({ by: ["severity"], where, _count: { _all: true } }),
      prisma.dealInsight.count({ where: { ...where, isResolved: false } }),
      prisma.dealInsight.count({ where: { ...where, isResolved: true } }),
    ]);
    res.json({
      byType: byType.map(r => ({ type: r.type, count: r._count._all })),
      bySeverity: bySeverity.map(r => ({ severity: r.severity, count: r._count._all })),
      openCount,
      resolvedCount,
    });
  } catch (err) {
    console.error("[DealInsights GET /stats] ", err);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

// ── GET /deal/:dealId : list insights for a specific deal ──
router.get("/deal/:dealId", async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    if (isNaN(dealId)) return res.status(400).json({ error: "Invalid dealId" });
    // Verify deal belongs to tenant
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: req.user.tenantId },
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const insights = await prisma.dealInsight.findMany({
      where: { dealId, tenantId: req.user.tenantId },
      orderBy: { generatedAt: "desc" },
    });
    // #572: same dealContext enrichment as GET /. Cheap when scoped to a
    // single deal — one extra findMany to attach context across all rows.
    const enriched = await attachDealContext(insights, req.user.tenantId);
    res.json(enriched);
  } catch (err) {
    console.error("[DealInsights GET /deal/:id] ", err);
    res.status(500).json({ error: "Failed to fetch deal insights" });
  }
});

// ── #572 / #587: deal-context enrichment for GET / and GET /deal/:id ─────
//
// Hydrates each insight row with a `dealContext` object so the frontend can
// render the deal header without a second /api/deals fetch. Tenant-checked
// (we only fetch deals where tenantId === insight tenantId and id ∈
// insight.dealIds). Soft-deleted deals surface with `deletedAt` set + the
// derived `isArchived: true` flag so the UI can show "[archived] <title>".
//
// #587 hardening — `dealContext` is ALWAYS a non-null object. The prior
// shape (`byId[i.dealId] || null`) returned `dealContext: null` when the
// underlying Deal row was hard-deleted (legacy data, predating the #167
// soft-delete column). The frontend's fallback chain (server dealContext →
// /api/deals?limit=100 client-side dealById) then collapsed to the
// "Deal details unavailable" placeholder for any insight whose dealId
// wasn't in the newest-100 window — which is the exact regression #587
// reopened against #572. By guaranteeing a populated envelope with an
// explicit `isMissing: true` flag for orphan dealIds, the frontend can
// render "Deal #<id> (no longer available)" instead of the bare
// placeholder, and the join contract becomes "every row has dealContext"
// rather than the brittle "if-this-then-fallback" chain.
//
// Insights with `dealId === null` (defensive — no current code path emits
// these, but the column is nullable upstream of any historical schema
// change) get `dealContext: null` so callers can distinguish "missing
// deal" (orphan FK, isMissing=true) from "no deal linked" (no row, null).
async function attachDealContext(insights, tenantId) {
  if (!Array.isArray(insights) || insights.length === 0) return insights;
  const dealIds = [...new Set(insights.map(i => i.dealId).filter(Boolean))];
  if (dealIds.length === 0) {
    return insights.map(i => ({
      ...i,
      dealContext: i.dealId ? buildMissingDealContext(i.dealId) : null,
    }));
  }
  const deals = await prisma.deal.findMany({
    where: { id: { in: dealIds }, tenantId },
    select: {
      id: true,
      title: true,
      amount: true,
      currency: true,
      stage: true,
      probability: true,
      expectedClose: true,
      deletedAt: true,
      contact: { select: { name: true, company: true } },
    },
  });
  const byId = Object.create(null);
  for (const d of deals) {
    byId[d.id] = {
      id: d.id,
      title: d.title,
      amount: d.amount,
      currency: d.currency,
      stage: d.stage,
      probability: d.probability,
      expectedClose: d.expectedClose,
      deletedAt: d.deletedAt,
      contactName: d.contact ? d.contact.name : null,
      contactCompany: d.contact ? d.contact.company : null,
      isArchived: !!d.deletedAt,
      isMissing: false,
    };
  }
  return insights.map(i => {
    if (!i.dealId) return { ...i, dealContext: null };
    return { ...i, dealContext: byId[i.dealId] || buildMissingDealContext(i.dealId) };
  });
}

// Sentinel envelope returned when a DealInsight references a dealId that no
// longer resolves to a Deal row in the current tenant (hard-deleted, or a
// cross-tenant id that the where-clause filters out). Same key set as a
// resolved deal so the frontend never sees `undefined` reads.
function buildMissingDealContext(dealId) {
  return {
    id: dealId,
    title: null,
    amount: null,
    currency: null,
    stage: null,
    probability: null,
    expectedClose: null,
    deletedAt: null,
    contactName: null,
    contactCompany: null,
    isArchived: false,
    isMissing: true,
  };
}

// ── Heuristic rules engine (shared with cron) ─────────────────────
async function runHeuristicRules(deal) {
  const insights = [];
  const now = new Date();

  // Combine activity-like signals
  const activities = deal.contact?.activities || [];
  const emails = deal.contact?.emails || [];
  const calls = deal.contact?.callLogs || [];

  const allTouchTimes = [
    ...activities.map(a => new Date(a.createdAt)),
    ...emails.map(e => new Date(e.createdAt)),
    ...calls.map(c => new Date(c.createdAt)),
  ].sort((a, b) => b - a);

  const lastTouch = allTouchTimes[0];
  const stage = (deal.stage || "").toLowerCase();

  // RISK: No activity in 30+ days
  if (!lastTouch || (now - lastTouch) > 30 * MS_PER_DAY) {
    insights.push({
      type: "RISK",
      severity: "WARNING",
      insight: lastTouch
        ? `No activity in ${Math.floor((now - lastTouch) / MS_PER_DAY)} days. Deal may be going cold.`
        : "No activity recorded for this deal. Initiate outreach immediately.",
    });
  }

  // RISK: Past expected close date
  // #582: prior implementation fired CRITICAL whenever expectedClose < now,
  // including the (now − expectedClose) < 24h case where Math.floor → 0 ("Deal
  // is 0 day(s) past expected close"). That was noise — half the demo's 22
  // CRITICAL alerts were 0-day or null-derived, eroding trust in the badge.
  // Fix: explicit null guard + minimum-days threshold + severity split:
  //   - daysOverdue < 1   → no insight (closes today / not yet due / null)
  //   - daysOverdue 1-6   → WARNING (modestly late; rep should follow up)
  //   - daysOverdue >= 7  → CRITICAL (materially late; needs intervention)
  if (deal.expectedClose && stage !== "won" && stage !== "lost") {
    const expectedCloseTs = new Date(deal.expectedClose).getTime();
    if (Number.isFinite(expectedCloseTs)) {
      const daysOverdue = Math.floor((now.getTime() - expectedCloseTs) / MS_PER_DAY);
      if (daysOverdue >= 7) {
        insights.push({
          type: "RISK",
          severity: "CRITICAL",
          insight: `Deal is ${daysOverdue} day(s) past expected close date and still in "${deal.stage}" stage.`,
        });
      } else if (daysOverdue >= 1) {
        insights.push({
          type: "RISK",
          severity: "WARNING",
          insight: `Deal is ${daysOverdue} day(s) past expected close date and still in "${deal.stage}" stage.`,
        });
      }
      // daysOverdue <= 0: closes today or in the future → emit nothing.
    }
  }

  // RISK: Low engagement
  if (emails.length === 0 && calls.length === 0) {
    insights.push({
      type: "RISK",
      severity: "WARNING",
      insight: "Low engagement: no emails or calls logged with this contact yet.",
    });
  }

  // OPPORTUNITY: Multiple decision makers engaged (>3 distinct email addresses)
  const distinctEmailParticipants = new Set();
  emails.forEach(e => {
    if (e.from) distinctEmailParticipants.add(String(e.from).toLowerCase());
    if (e.to) distinctEmailParticipants.add(String(e.to).toLowerCase());
  });
  if (distinctEmailParticipants.size > 3) {
    insights.push({
      type: "OPPORTUNITY",
      severity: "INFO",
      insight: `Multiple decision makers engaged (${distinctEmailParticipants.size} distinct participants). Strong buying signal.`,
    });
  }

  // NEXT_BEST_ACTION: Send follow-up if last email was 7-14 days ago
  const lastEmail = emails
    .map(e => new Date(e.createdAt))
    .sort((a, b) => b - a)[0];
  if (lastEmail) {
    const daysSinceEmail = (now - lastEmail) / MS_PER_DAY;
    if (daysSinceEmail >= 7 && daysSinceEmail <= 14) {
      insights.push({
        type: "NEXT_BEST_ACTION",
        severity: "INFO",
        insight: `Last email was ${Math.floor(daysSinceEmail)} days ago — ideal window to send a follow-up.`,
      });
    }
  }

  return insights;
}

// ── Persist insights with dedup (don't recreate same type+insight if unresolved exists) ──
async function persistInsights(dealId, tenantId, candidates) {
  const saved = [];
  for (const c of candidates) {
    const existing = await prisma.dealInsight.findFirst({
      where: {
        dealId,
        tenantId,
        type: c.type,
        insight: c.insight,
        isResolved: false,
      },
    });
    if (existing) continue;
    const created = await prisma.dealInsight.create({
      data: {
        dealId,
        tenantId,
        type: c.type,
        severity: c.severity || "INFO",
        insight: c.insight,
      },
    });
    saved.push(created);
  }
  return saved;
}

// ── POST /generate/:dealId : run rules + AI for this deal ─────────
router.post("/generate/:dealId", async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    if (isNaN(dealId)) return res.status(400).json({ error: "Invalid dealId" });

    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: req.user.tenantId },
      include: {
        contact: {
          include: {
            activities: { orderBy: { createdAt: "desc" }, take: 50 },
            emails: { orderBy: { createdAt: "desc" }, take: 50 },
            callLogs: { orderBy: { createdAt: "desc" }, take: 50 },
          },
        },
      },
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const candidates = await runHeuristicRules(deal);

    // Optional Gemini-generated insight
    if (aiModel) {
      try {
        const prompt = `You are a CRM sales analyst. Based on the following deal data, give EXACTLY ONE sentence (max 30 words) of actionable insight for the sales rep. No preamble, no quotes, no markdown — just one sentence.

Deal: "${deal.title}"
Amount: ${formatMoney(deal.amount, deal.currency || "USD")}
Stage: ${deal.stage}
Probability: ${deal.probability}%
Expected close: ${deal.expectedClose || "not set"}
Contact: ${deal.contact?.name || "Unknown"} at ${deal.contact?.company || "Unknown company"}
Status: ${deal.contact?.status || "unknown"}
Recent emails: ${(deal.contact?.emails || []).slice(0, 3).map(e => e.subject).join("; ") || "none"}
Recent calls: ${(deal.contact?.callLogs || []).length} call(s)
Recent activities: ${(deal.contact?.activities || []).slice(0, 3).map(a => `${a.type}: ${(a.description || "").slice(0, 60)}`).join("; ") || "none"}`;

        const result = await aiModel.generateContent(prompt);
        const aiText = (result.response.text() || "").trim().replace(/^["']|["']$/g, "");
        if (aiText) {
          candidates.push({
            type: "NEXT_BEST_ACTION",
            severity: "INFO",
            insight: `[AI] ${aiText}`,
          });
        }
      } catch (aiErr) {
        console.warn("[DealInsights] AI insight skipped:", aiErr.message);
      }
    }

    const saved = await persistInsights(dealId, req.user.tenantId, candidates);
    res.json({ generated: saved.length, insights: saved, evaluated: candidates.length });
  } catch (err) {
    console.error("[DealInsights POST /generate/:id] ", err);
    res.status(500).json({ error: "Failed to generate insights" });
  }
});

// ── POST /:id/resolve : mark insight as resolved ──
router.post("/:id/resolve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.dealInsight.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Insight not found" });
    const updated = await prisma.dealInsight.update({
      where: { id },
      data: { isResolved: true },
    });
    res.json(updated);
  } catch (err) {
    console.error("[DealInsights POST /:id/resolve] ", err);
    res.status(500).json({ error: "Failed to resolve insight" });
  }
});

// ── DELETE /:id (tenant-checked) ──
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.dealInsight.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Insight not found" });
    await prisma.dealInsight.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error("[DealInsights DELETE /:id] ", err);
    res.status(500).json({ error: "Failed to delete insight" });
  }
});

// ─── POST /run ─────────────────────────────────────────
// G-13: Manual trigger for the deal-insights cron engine. Mirrors
// POST /api/billing/recurring/run + /api/forecasting/snapshot/run.
//
// Drives the same heuristic-rule engine that cron/dealInsightsEngine.js
// invokes every 6 hours, but scoped to the requesting tenant only (the
// cron version is all-tenant). Reuses runHeuristicRules + persistInsights
// from this file so cron + manual paths can never drift on field
// semantics (dedup-by-(dealId,type,insight,isResolved=false), severity
// defaulting to INFO, etc.).
//
// Note: the cron engine does NOT call Gemini — only the heuristic rules.
// Gemini is invoked only by POST /generate/:dealId, which is a separate
// per-deal flow. This endpoint mirrors the cron's heuristic-only path.
//
// Gated to ADMIN — generating insights is a tenant-wide write.
//
// Returns { success, tenantId, scanned, generated, errors } where:
//   - scanned   = open deals walked (stage NOT IN [won, lost])
//   - generated = new DealInsight rows persisted (after dedup)
//   - errors    = per-deal failures (mirror engine's per-deal try/catch)
router.post("/run", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const openDeals = await prisma.deal.findMany({
      where: {
        tenantId,
        stage: { notIn: ["won", "lost"] },
        deletedAt: null,
      },
      include: {
        contact: {
          include: {
            activities: { orderBy: { createdAt: "desc" }, take: 50 },
            emails: { orderBy: { createdAt: "desc" }, take: 50 },
            callLogs: { orderBy: { createdAt: "desc" }, take: 50 },
          },
        },
      },
    });

    let generated = 0;
    const errors = [];
    for (const deal of openDeals) {
      try {
        const candidates = await runHeuristicRules(deal);
        const saved = await persistInsights(deal.id, tenantId, candidates);
        generated += saved.length;
      } catch (dealErr) {
        errors.push({ dealId: deal.id, error: dealErr.message });
      }
    }

    res.json({
      success: true,
      tenantId,
      scanned: openDeals.length,
      generated,
      errors,
    });
  } catch (err) {
    console.error("[deal-insights/run]", err);
    res.status(500).json({ error: "Failed to run deal-insights engine", detail: err.message });
  }
});

module.exports = router;
module.exports.runHeuristicRules = runHeuristicRules;
module.exports.persistInsights = persistInsights;
module.exports.attachDealContext = attachDealContext;
module.exports.buildMissingDealContext = buildMissingDealContext;
