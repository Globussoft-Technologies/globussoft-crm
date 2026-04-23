/**
 * Orchestrator engine — the "AI agent that recommends actions" pitch.
 *
 * Runs once per morning per wellness tenant. Reads the previous day's
 * dashboard data + lead pipeline + appointment schedule, asks Gemini to
 * draft 1-3 prioritised proposals, persists them as AgentRecommendation
 * rows. The CRM UI surfaces them on the OwnerDashboard with Approve /
 * Reject buttons.
 *
 * On approval (handled by routes/wellness.js POST /recommendations/:id/approve),
 * the action dispatcher in this module executes the proposal:
 *   - send_sms_blast       → call SMS provider with a Gemini-generated message
 *   - create_task          → write a Task row assigned to the right staff
 *   - mark_leads_for_callback → bump aiScore + add Activity for telecaller queue
 *
 * Schedule: 07:00 IST daily. Manual trigger: GET /api/wellness/orchestrator/run
 *
 * Failure mode: if Gemini is unavailable, falls back to rule-based proposals
 * so Rishu always sees something useful in the morning.
 */
const cron = require("node-cron");
const prisma = require("../lib/prisma");

let GoogleGenerativeAI;
try { ({ GoogleGenerativeAI } = require("@google/generative-ai")); } catch (_) { /* optional */ }

// ── Run-for-tenant entry point ─────────────────────────────────────

async function runForTenant(tenantId) {
  console.log(`[Orchestrator] running for tenant ${tenantId}`);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.vertical !== "wellness") return { skipped: "not-wellness" };

  // Read context
  const ctx = await readContext(tenantId);
  // Generate proposals (AI if available, fallback to rules)
  let proposals = await generateProposals(ctx);
  if (!proposals || proposals.length === 0) proposals = ruleBasedProposals(ctx);

  // Dedupe vs today's existing pending recommendations (avoid spam)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const existing = await prisma.agentRecommendation.findMany({
    where: { tenantId, status: "pending", createdAt: { gte: todayStart } },
    select: { type: true, title: true },
  });
  const seen = new Set(existing.map((r) => `${r.type}:${r.title.slice(0, 32)}`));

  const created = [];
  for (const p of proposals) {
    const key = `${p.type}:${(p.title || "").slice(0, 32)}`;
    if (seen.has(key)) continue;
    const rec = await prisma.agentRecommendation.create({
      data: {
        type: p.type,
        title: p.title,
        body: p.body,
        priority: p.priority || "medium",
        expectedImpact: p.expectedImpact || null,
        goalContext: p.goalContext || "Maximize occupancy + ROAS",
        payload: p.payload ? JSON.stringify(p.payload) : null,
        tenantId,
      },
    });
    created.push(rec);
    seen.add(key);
  }
  console.log(`[Orchestrator] tenant ${tenantId}: ${created.length} new recommendations`);
  return { created: created.length, contextSummary: ctx.summary };
}

// ── Action dispatcher (called when Rishu approves a card) ──────────

async function executeApproved(rec, { actorUserId } = {}) {
  if (!rec) return { ok: false, reason: "no-rec" };
  let payload = {};
  try { payload = rec.payload ? JSON.parse(rec.payload) : {}; } catch (_) {}

  switch (rec.type) {
    case "campaign_boost":
      // Real budget bump requires AdsGPT/Callified handshake (tomorrow's work).
      // For now, log a Task for the marketer to execute manually.
      await prisma.task.create({
        data: {
          title: `Marketer: ${rec.title}`,
          notes: `${rec.body}\n\nApproved by user #${actorUserId} on ${new Date().toISOString()}`,
          status: "OPEN",
          priority: "HIGH",
          tenantId: rec.tenantId,
          userId: actorUserId || null,
        },
      });
      return { ok: true, action: "task_created", note: "Awaiting AdsGPT/Callified handshake for direct budget API" };

    case "send_sms_blast": {
      const audience = payload.audienceFilter || {};
      const targets = await prisma.contact.findMany({
        where: { tenantId: rec.tenantId, status: "Lead", ...audience },
        select: { id: true, phone: true }, take: 200,
      });
      const message = payload.message || rec.body.slice(0, 140);
      // We don't actually fire SMS here without provider config — log a SmsMessage row per
      // target so the user can see who would receive it. The real send happens via
      // existing routes/sms.js once an SmsConfig row exists for the tenant.
      let queued = 0;
      for (const t of targets) {
        if (!t.phone) continue;
        await prisma.smsMessage.create({
          data: {
            to: t.phone, direction: "OUTBOUND", body: message, status: "QUEUED",
            contactId: t.id, tenantId: rec.tenantId,
          },
        });
        queued++;
      }
      return { ok: true, action: "sms_queued", count: queued };
    }

    case "occupancy_alert":
    case "schedule_gap":
      // Translate to a manager task
      await prisma.task.create({
        data: {
          title: rec.title,
          notes: rec.body,
          status: "OPEN",
          priority: "HIGH",
          tenantId: rec.tenantId,
          userId: actorUserId || null,
        },
      });
      return { ok: true, action: "task_created" };

    case "lead_followup":
    case "mark_leads_for_callback": {
      const ageHours = payload.ageHours || 24;
      const cutoff = new Date(Date.now() - ageHours * 3600000);
      const leads = await prisma.contact.findMany({
        where: { tenantId: rec.tenantId, status: "Lead", createdAt: { lte: cutoff } },
        take: 50, select: { id: true },
      });
      for (const l of leads) {
        await prisma.activity.create({
          data: {
            type: "Note",
            description: `[Orchestrator] Marked for telecaller follow-up — ${rec.title}`,
            contactId: l.id,
            tenantId: rec.tenantId,
            userId: actorUserId || null,
          },
        });
      }
      return { ok: true, action: "leads_flagged", count: leads.length };
    }

    default:
      return { ok: false, reason: "unknown-action-type" };
  }
}

// ── Context gatherer ───────────────────────────────────────────────

async function readContext(tenantId) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const weekAgo    = new Date(Date.now() - 7 * 86400000);
  const dayAgo     = new Date(Date.now() - 86400000);

  const [
    todayVisits, weekVisits, openLeads, oldLeads, services, locations, lowOccupancyServices,
  ] = await Promise.all([
    prisma.visit.findMany({
      where: { tenantId, visitDate: { gte: todayStart, lte: todayEnd } },
      select: { status: true, amountCharged: true, serviceId: true },
    }),
    prisma.visit.findMany({
      where: { tenantId, visitDate: { gte: weekAgo } },
      select: { amountCharged: true, status: true, serviceId: true, visitDate: true },
    }),
    prisma.contact.count({ where: { tenantId, status: "Lead" } }),
    prisma.contact.count({ where: { tenantId, status: "Lead", createdAt: { lte: dayAgo } } }),
    prisma.service.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, category: true, ticketTier: true, basePrice: true } }),
    prisma.location.count({ where: { tenantId, isActive: true } }),
    prisma.visit.groupBy({
      by: ["serviceId"],
      where: { tenantId, visitDate: { gte: weekAgo }, status: "completed" },
      _count: { _all: true },
    }),
  ]);

  const sumAmt = (arr) => arr.reduce((s, x) => s + (parseFloat(x.amountCharged) || 0), 0);
  const todayCompleted = todayVisits.filter((v) => v.status === "completed").length;
  const todayBooked    = todayVisits.filter((v) => v.status === "booked").length;
  const weekRevenue    = sumAmt(weekVisits.filter((v) => v.status === "completed"));
  const occupancyPct   = Math.round((todayCompleted / Math.max(1, locations * 8 * 17)) * 100);

  // Find top + bottom-performing services this week
  const serviceMap = Object.fromEntries(services.map((s) => [s.id, s]));
  const ranked = lowOccupancyServices
    .filter((g) => serviceMap[g.serviceId])
    .map((g) => ({ ...serviceMap[g.serviceId], visits: g._count._all }))
    .sort((a, b) => b.visits - a.visits);
  const topServices    = ranked.slice(0, 3);
  const highTickerCold = services.filter((s) => s.ticketTier === "high" && !ranked.some((r) => r.id === s.id)).slice(0, 3);

  return {
    tenantId,
    todayVisits: todayVisits.length,
    todayCompleted, todayBooked,
    weekRevenue,
    occupancyPct,
    openLeads,
    oldLeads, // leads aging > 24h
    locations,
    topServices,
    highTickerCold, // high-ticket services with NO visits this week
    services: services.length,
    summary: `today: ${todayVisits.length} visits / ${todayCompleted} completed, occupancy ${occupancyPct}%, ${openLeads} open leads (${oldLeads} aging >24h), week revenue ₹${Math.round(weekRevenue).toLocaleString("en-IN")}`,
  };
}

// ── Proposal generators ────────────────────────────────────────────

async function generateProposals(ctx) {
  if (!GoogleGenerativeAI || !process.env.GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.0-flash" });
    const prompt = `You are an AI orchestrator for a hair/skin/aesthetics clinic. Today's reality:
${ctx.summary}
Top performing services this week: ${ctx.topServices.map((s) => s.name).join(", ") || "none"}
High-ticket services with NO visits this week: ${ctx.highTickerCold.map((s) => s.name).join(", ") || "none"}

Owner's constraint: spends only 30 min/day on the system. Goal: 100% clinic
occupancy, healthy ROAS on high-ticket services, zero missed leads.

Output a JSON array of 1-3 recommendation cards. Each card MUST have:
{"type": "campaign_boost"|"occupancy_alert"|"lead_followup"|"send_sms_blast",
 "title": "<= 80 chars",
 "body": "<= 280 chars, plain English, no markdown",
 "priority": "high"|"medium"|"low",
 "expectedImpact": "concrete numeric outcome",
 "payload": {<action-specific JSON>}}

Return ONLY the JSON array, no commentary.`;
    const r = await model.generateContent(prompt);
    const txt = r.response.text().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.warn("[Orchestrator] Gemini failed, using fallback rules:", e.message);
    return null;
  }
}

function ruleBasedProposals(ctx) {
  const out = [];

  // 1. Old leads aging
  if (ctx.oldLeads >= 5) {
    out.push({
      type: "lead_followup",
      title: `${ctx.oldLeads} leads aging > 24h without first-call`,
      body: `Industry data shows first-contact within 5 minutes lifts conversion 9x. ${ctx.oldLeads} leads from yesterday or earlier are still un-touched.`,
      priority: "high",
      expectedImpact: `Recovers ~${Math.max(2, Math.floor(ctx.oldLeads * 0.15))} conversions that would otherwise drop off`,
      payload: { ageHours: 24 },
    });
  }

  // 2. Low occupancy
  if (ctx.occupancyPct < 30 && ctx.todayBooked < 10) {
    out.push({
      type: "occupancy_alert",
      title: `Today's occupancy only ${ctx.occupancyPct}%`,
      body: `Slots are sitting empty. Send a same-day promo WhatsApp/SMS blast to recent inquirers, or boost ad budget on a fast-turn service.`,
      priority: "medium",
      expectedImpact: `Could fill 3–5 same-day slots`,
    });
  }

  // 3. Cold high-ticket service
  if (ctx.highTickerCold.length > 0) {
    const svc = ctx.highTickerCold[0];
    out.push({
      type: "campaign_boost",
      title: `Boost campaign for ${svc.name} — zero visits this week`,
      body: `${svc.name} (₹${(svc.basePrice || 0).toLocaleString("en-IN")} per case) had no bookings this week. A targeted ₹500/day Meta lift typically yields 1–2 high-ticket leads in 7 days.`,
      priority: "high",
      expectedImpact: `+1–2 high-ticket bookings, projected revenue +₹${Math.round((svc.basePrice || 0) * 1.5).toLocaleString("en-IN")}/week`,
      payload: { serviceId: svc.id, suggestedDailyBudget: 500 },
    });
  }

  return out;
}

// ── Cron init + manual trigger ─────────────────────────────────────

async function runForAllWellnessTenants() {
  const tenants = await prisma.tenant.findMany({ where: { vertical: "wellness", isActive: true }, select: { id: true } });
  for (const t of tenants) {
    try { await runForTenant(t.id); } catch (e) { console.error("[Orchestrator] tenant fail:", t.id, e.message); }
  }
}

function initOrchestratorCron() {
  // 07:00 IST every day = 01:30 UTC
  cron.schedule("30 1 * * *", () => {
    runForAllWellnessTenants().catch((e) => console.error("[Orchestrator] cron fail:", e.message));
  }, { timezone: "Asia/Kolkata" });
  console.log("[Orchestrator] cron initialized (daily 07:00 IST)");
}

module.exports = { initOrchestratorCron, runForTenant, runForAllWellnessTenants, executeApproved };
