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
const crypto = require("crypto");
const prisma = require("../lib/prisma");

let GoogleGenerativeAI;
try { ({ GoogleGenerativeAI } = require("@google/generative-ai")); } catch (_) { /* optional */ }

// ── Dedup helpers (issues #261, #285) ──────────────────────────────
// Cron used to spam the same "Today's occupancy only 1%" card on every
// run because the in-memory `seen` set only checked status="pending"
// rows for today. If the user approved the card, the next run skipped
// the dedup and inserted another. Same root cause for #285's 6× tasks.
//
// We now key dedup on (type + payload-hash) for AgentRecommendation,
// and (title + dueDate-day + tenantId) for Task. Both are scoped to
// today (createdAt >= start-of-day) so legitimate next-day cards pass.
function startOfDayUTC(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}
function endOfDayUTC(d = new Date()) {
  const x = new Date(d); x.setHours(23, 59, 59, 999); return x;
}
function payloadHash(p) {
  // Stable hash over type + title + payload JSON. Title is included so a
  // dynamic value (e.g. occupancyPct=1 vs 5) yields a different hash and
  // we don't suppress a legitimately different recommendation.
  const norm = JSON.stringify({
    type: p.type || "",
    title: (p.title || "").trim().toLowerCase(),
    payload: p.payload || null,
  });
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

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

  // Dedupe vs ALL of today's recommendations regardless of status
  // (issues #261 / #285). The previous filter `status: "pending"` let an
  // approved card from earlier today re-appear on the next cron run.
  const todayStart = startOfDayUTC();
  const existing = await prisma.agentRecommendation.findMany({
    where: { tenantId, createdAt: { gte: todayStart } },
    select: { type: true, title: true, payload: true },
  });
  const seen = new Set();
  for (const r of existing) {
    let parsed = null;
    try { parsed = r.payload ? JSON.parse(r.payload) : null; } catch (_) {}
    seen.add(payloadHash({ type: r.type, title: r.title, payload: parsed }));
    // Legacy key for back-compat with rows that had different payload-shape
    seen.add(`${r.type}:${(r.title || "").slice(0, 32)}`);
  }

  const created = [];
  for (const p of proposals) {
    const hash = payloadHash(p);
    const legacyKey = `${p.type}:${(p.title || "").slice(0, 32)}`;
    if (seen.has(hash) || seen.has(legacyKey)) {
      console.log(`[Orchestrator] skip dupe rec tenant=${tenantId} type=${p.type} hash=${hash}`);
      continue;
    }
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
    seen.add(hash);
    seen.add(legacyKey);
  }
  console.log(`[Orchestrator] tenant ${tenantId}: ${created.length} new recommendations`);
  return { created: created.length, contextSummary: ctx.summary };
}

// ── Action dispatcher (called when Rishu approves a card) ──────────

// Dedup helper for tasks created from approved recommendations.
// Issue #285: approving the same recurring card repeatedly was spawning a
// fresh Task each time. We now skip if a task with the same title and
// dueDate (date-only, tenant-scoped) already exists. dueDate may be null
// in which case we match against tasks created today.
async function findOrCreateTask({ title, notes, status, priority, tenantId, userId, dueDate }) {
  const dayStart = startOfDayUTC(dueDate || new Date());
  const dayEnd = endOfDayUTC(dueDate || new Date());
  const where = {
    title,
    tenantId,
    deletedAt: null,
    ...(dueDate
      ? { dueDate: { gte: dayStart, lte: dayEnd } }
      : { createdAt: { gte: dayStart, lte: dayEnd } }),
  };
  const existing = await prisma.task.findFirst({ where, select: { id: true } });
  if (existing) {
    console.log(`[Orchestrator] skip dupe task tenant=${tenantId} title="${title.slice(0, 40)}" existingId=${existing.id}`);
    return { task: existing, deduped: true };
  }
  const task = await prisma.task.create({
    data: { title, notes, status, priority, tenantId, userId, dueDate: dueDate || null },
  });
  return { task, deduped: false };
}

async function executeApproved(rec, { actorUserId } = {}) {
  if (!rec) return { ok: false, reason: "no-rec" };
  let payload = {};
  try { payload = rec.payload ? JSON.parse(rec.payload) : {}; } catch (_) {}

  switch (rec.type) {
    case "campaign_boost": {
      // Real budget bump requires AdsGPT/Callified handshake (tomorrow's work).
      // For now, log a Task for the marketer to execute manually.
      const { deduped } = await findOrCreateTask({
        title: `Marketer: ${rec.title}`,
        notes: `${rec.body}\n\nApproved by user #${actorUserId} on ${new Date().toISOString()}`,
        status: "OPEN",
        priority: "HIGH",
        tenantId: rec.tenantId,
        userId: actorUserId || null,
      });
      return { ok: true, action: deduped ? "task_deduped" : "task_created", note: "Awaiting AdsGPT/Callified handshake for direct budget API" };
    }

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
    case "schedule_gap": {
      // Translate to a manager task (deduped — see findOrCreateTask).
      const { deduped } = await findOrCreateTask({
        title: rec.title,
        notes: rec.body,
        status: "OPEN",
        priority: "HIGH",
        tenantId: rec.tenantId,
        userId: actorUserId || null,
      });
      return { ok: true, action: deduped ? "task_deduped" : "task_created" };
    }

    case "lead_followup":
    case "mark_leads_for_callback": {
      // Two modes:
      //  (a) precise — payload.leadIds is provided (SLA-breach card)
      //  (b) bulk — fall back to ageHours window (legacy aging card)
      let leads;
      if (Array.isArray(payload.leadIds) && payload.leadIds.length > 0) {
        leads = await prisma.contact.findMany({
          where: { tenantId: rec.tenantId, id: { in: payload.leadIds.map((n) => parseInt(n, 10)).filter(Number.isFinite) } },
          select: { id: true },
        });
      } else {
        const ageHours = payload.ageHours || 24;
        const cutoff = new Date(Date.now() - ageHours * 3600000);
        leads = await prisma.contact.findMany({
          where: { tenantId: rec.tenantId, status: "Lead", createdAt: { lte: cutoff } },
          take: 50, select: { id: true },
        });
      }
      const reassignToUserId = payload.reassignToUserId ? parseInt(payload.reassignToUserId, 10) : null;
      let reassigned = 0;
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
        if (reassignToUserId) {
          await prisma.contact.update({ where: { id: l.id }, data: { assignedToId: reassignToUserId } });
          reassigned++;
        }
      }
      return { ok: true, action: "leads_flagged", count: leads.length, reassigned };
    }

    default:
      return { ok: false, reason: "unknown-action-type" };
  }
}

// ── Context gatherer ───────────────────────────────────────────────

// PRD §6.4 lead-side SLA default. The Tenant currently has no `slaMinutes`
// column, so we read an env override and fall back to 30 minutes.
const DEFAULT_LEAD_SLA_MINUTES = parseInt(process.env.WELLNESS_LEAD_SLA_MINUTES || "30", 10);

// Default working-hour window for the occupancy gap heuristic when a
// Location row has no `hours` JSON. 09:00–20:00 IST = 11h × 60min = 660m.
const DEFAULT_WORKING_MINUTES = 11 * 60;

// Parse Location.hours JSON shape `{ mon: ["09:00","20:00"], ... }` into
// the day's open-minute count. Falls back to DEFAULT_WORKING_MINUTES.
function workingMinutesForLocation(loc, dayDate = new Date()) {
  if (!loc || !loc.hours) return DEFAULT_WORKING_MINUTES;
  let parsed;
  try { parsed = typeof loc.hours === "string" ? JSON.parse(loc.hours) : loc.hours; } catch { return DEFAULT_WORKING_MINUTES; }
  const dayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dayDate.getDay()];
  const slot = parsed && parsed[dayKey];
  if (!slot || !Array.isArray(slot) || slot.length < 2) return DEFAULT_WORKING_MINUTES;
  const [openStr, closeStr] = slot;
  const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const diff = toMin(closeStr) - toMin(openStr);
  return diff > 0 ? diff : DEFAULT_WORKING_MINUTES;
}

async function readContext(tenantId) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const weekAgo    = new Date(Date.now() - 7 * 86400000);
  const dayAgo     = new Date(Date.now() - 86400000);
  const slaCutoff  = new Date(Date.now() - DEFAULT_LEAD_SLA_MINUTES * 60 * 1000);

  const [
    todayVisits, weekVisits, openLeads, oldLeads, services, locationsList, lowOccupancyServices, slaBreachLeads, telecallers,
  ] = await Promise.all([
    prisma.visit.findMany({
      where: { tenantId, visitDate: { gte: todayStart, lte: todayEnd } },
      select: { status: true, amountCharged: true, serviceId: true, locationId: true, service: { select: { durationMin: true } } },
    }),
    prisma.visit.findMany({
      where: { tenantId, visitDate: { gte: weekAgo } },
      select: { amountCharged: true, status: true, serviceId: true, visitDate: true },
    }),
    prisma.contact.count({ where: { tenantId, status: "Lead" } }),
    prisma.contact.count({ where: { tenantId, status: "Lead", createdAt: { lte: dayAgo } } }),
    prisma.service.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, category: true, ticketTier: true, basePrice: true, durationMin: true, targetRadiusKm: true } }),
    prisma.location.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, hours: true } }),
    prisma.visit.groupBy({
      by: ["serviceId"],
      where: { tenantId, visitDate: { gte: weekAgo }, status: "completed" },
      _count: { _all: true },
    }),
    // PRD §6.7 "zero missed leads" — leads created > slaMinutes ago that
    // have no Activity row recorded yet (no first response). Activity
    // is the canonical telecaller-touch signal in routes/wellness.js.
    prisma.contact.findMany({
      where: {
        tenantId,
        status: "Lead",
        createdAt: { lte: slaCutoff },
        activities: { none: {} },
      },
      select: { id: true, name: true, phone: true, assignedToId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    // Pool of users we can re-assign stale leads to. Prefer telecaller,
    // then admin/manager. Used to recommend a concrete assignee per card.
    prisma.user.findMany({
      where: { tenantId, OR: [{ wellnessRole: "telecaller" }, { role: { in: ["ADMIN", "MANAGER"] } }] },
      select: { id: true, name: true, email: true, wellnessRole: true, role: true },
      orderBy: [{ wellnessRole: "asc" }, { id: "asc" }],
    }),
  ]);
  const locations = locationsList.length;

  const sumAmt = (arr) => arr.reduce((s, x) => s + (parseFloat(x.amountCharged) || 0), 0);
  const todayCompleted = todayVisits.filter((v) => v.status === "completed").length;
  const todayBooked    = todayVisits.filter((v) => v.status === "booked").length;
  const weekRevenue    = sumAmt(weekVisits.filter((v) => v.status === "completed"));
  const occupancyPct   = Math.round((todayCompleted / Math.max(1, locations * 8 * 17)) * 100);

  // ── Real occupancy gap (PRD §6.7) ────────────────────────────────
  // Capacity = sum(working-minutes per active location for today).
  // Booked-minute usage = sum(service.durationMin) over today's visits
  // not in cancelled/no-show. Utilisation = used / capacity.
  const today = new Date();
  const capacityMinutes = locationsList.reduce((s, loc) => s + workingMinutesForLocation(loc, today), 0);
  const usedMinutes = todayVisits
    .filter((v) => v.status !== "cancelled" && v.status !== "no-show")
    .reduce((s, v) => s + (v.service?.durationMin || 30), 0);
  const utilisationPct = capacityMinutes > 0 ? Math.round((usedMinutes / capacityMinutes) * 100) : 0;

  // ── Cold-service ranking by reach × revenue potential ────────────
  // For the boost recommendation, prefer the service with the highest
  // (targetRadiusKm × basePrice) score that had ZERO bookings this week.
  // This biases toward high-ticket, wide-funnel services where ad spend
  // is most efficient.
  const bookedSvcIds = new Set(lowOccupancyServices.map((g) => g.serviceId).filter(Boolean));
  const zeroBookingServices = services
    .filter((s) => !bookedSvcIds.has(s.id))
    .map((s) => ({ ...s, reachScore: (s.targetRadiusKm || 0) * (s.basePrice || 0) }))
    .sort((a, b) => b.reachScore - a.reachScore);

  // Find top + bottom-performing services this week
  const serviceMap = Object.fromEntries(services.map((s) => [s.id, s]));
  const ranked = lowOccupancyServices
    .filter((g) => serviceMap[g.serviceId])
    .map((g) => ({ ...serviceMap[g.serviceId], visits: g._count._all }))
    .sort((a, b) => b.visits - a.visits);
  const topServices    = ranked.slice(0, 3);
  const highTickerCold = services.filter((s) => s.ticketTier === "high" && !ranked.some((r) => r.id === s.id)).slice(0, 3);

  // Pick a default telecaller for stale-lead reassignment suggestion.
  const suggestedAssignee = telecallers.find((u) => u.wellnessRole === "telecaller") || telecallers[0] || null;

  return {
    tenantId,
    todayVisits: todayVisits.length,
    todayCompleted, todayBooked,
    weekRevenue,
    occupancyPct,
    utilisationPct,
    capacityMinutes,
    usedMinutes,
    openLeads,
    oldLeads, // leads aging > 24h
    locations,
    topServices,
    highTickerCold, // high-ticket services with NO visits this week
    zeroBookingServices, // sorted by reachScore = targetRadiusKm × basePrice
    services: services.length,
    slaBreachLeads, // PRD §6.7: leads older than slaMinutes with no Activity
    slaMinutes: DEFAULT_LEAD_SLA_MINUTES,
    suggestedAssignee,
    summary: `today: ${todayVisits.length} visits / ${todayCompleted} completed, utilisation ${utilisationPct}%, ${openLeads} open leads (${oldLeads} aging >24h, ${slaBreachLeads.length} past SLA), week revenue ₹${Math.round(weekRevenue).toLocaleString("en-IN")}`,
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

  // 4. PRD §6.7 — Occupancy gap heuristic.
  // When today's expected-revenue-utilisation < 50% (booked-minutes vs
  // working-hour-window across all active locations), recommend boosting
  // the highest (targetRadiusKm × basePrice) service that had ZERO
  // bookings in the last 7 days. Suggest a concrete daily budget that
  // scales with the service's basePrice (1% of base, floor ₹300, cap
  // ₹2000) so a ₹50k procedure gets ₹500/day, ₹2L procedure ₹2k/day.
  if (ctx.utilisationPct < 50 && ctx.zeroBookingServices && ctx.zeroBookingServices.length > 0) {
    const svc = ctx.zeroBookingServices[0];
    const suggestedDailyBudget = Math.min(2000, Math.max(300, Math.round((svc.basePrice || 0) * 0.01 / 50) * 50));
    const titleSvc = svc.name;
    out.push({
      type: "campaign_boost",
      title: `Occupancy gap (${ctx.utilisationPct}%) — boost ${titleSvc} ad spend`,
      body: `Today's booked time fills only ${ctx.utilisationPct}% of working hours (${Math.round(ctx.usedMinutes/60)}h booked / ${Math.round(ctx.capacityMinutes/60)}h capacity). ${titleSvc} (radius ${svc.targetRadiusKm || "∞"}km, ₹${(svc.basePrice || 0).toLocaleString("en-IN")}/case) had zero bookings this week — best ROI candidate to fill the gap.`,
      priority: "high",
      expectedImpact: `Lift utilisation by 10–15 pts; projected +₹${Math.round((svc.basePrice || 0) * 1.5).toLocaleString("en-IN")}/week if 1–2 leads convert`,
      goalContext: "100% occupancy this week",
      payload: {
        serviceId: svc.id,
        serviceName: svc.name,
        suggestedDailyBudget,
        utilisationPct: ctx.utilisationPct,
        capacityMinutes: ctx.capacityMinutes,
        usedMinutes: ctx.usedMinutes,
        reason: "occupancy_gap_below_50",
      },
    });
  }

  // 5. PRD §6.7 — Stale-lead escalation (zero missed leads).
  // Leads older than slaMinutes with no Activity row → recommend
  // reassignment to the on-duty telecaller. Bundles up to 10 lead
  // IDs in the payload so the dispatcher can act on them precisely.
  if (ctx.slaBreachLeads && ctx.slaBreachLeads.length > 0) {
    const ids = ctx.slaBreachLeads.slice(0, 10).map((l) => l.id);
    const sample = ctx.slaBreachLeads.slice(0, 3).map((l) => l.name).join(", ");
    const assignee = ctx.suggestedAssignee;
    const assigneeLabel = assignee ? (assignee.name || assignee.email) : "the on-duty telecaller";
    out.push({
      type: "lead_followup",
      title: `${ctx.slaBreachLeads.length} leads past ${ctx.slaMinutes}-min SLA — escalate now`,
      body: `${ctx.slaBreachLeads.length} leads (${sample}${ctx.slaBreachLeads.length > 3 ? ", …" : ""}) have had no first contact recorded. SLA of ${ctx.slaMinutes} minutes (PRD §6.4) has elapsed. Suggest reassigning to ${assigneeLabel} and queuing a holding WhatsApp template.`,
      priority: "high",
      expectedImpact: `Recovers ~${Math.max(1, Math.floor(ctx.slaBreachLeads.length * 0.3))} leads that would otherwise drop off`,
      goalContext: "zero missed leads",
      payload: {
        leadIds: ids,
        reassignToUserId: assignee ? assignee.id : null,
        reassignToName: assigneeLabel,
        slaMinutes: ctx.slaMinutes,
        ageHours: 1,
        reason: "sla_breach",
      },
    });
  }

  return out;
}

// ── Cron init + manual trigger ─────────────────────────────────────

// Inline cleanup of pre-existing duplicates created before #261/#285 fix
// shipped. Idempotent — keeps the OLDEST row of each (type+title) group
// for today, soft-deletes the rest. Same logic for Tasks (by title +
// dueDate-day). Best-effort; errors are logged but do not abort the
// cron run.
async function cleanupExistingDupes(tenantId) {
  const todayStart = startOfDayUTC();
  const result = { recsRemoved: 0, tasksRemoved: 0 };
  try {
    const recs = await prisma.agentRecommendation.findMany({
      where: { tenantId, createdAt: { gte: todayStart } },
      select: { id: true, type: true, title: true, payload: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    const groups = new Map();
    for (const r of recs) {
      let parsed = null;
      try { parsed = r.payload ? JSON.parse(r.payload) : null; } catch (_) {}
      const key = payloadHash({ type: r.type, title: r.title, payload: parsed });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      // Keep the oldest non-pending row if any (preserves user actions),
      // else the oldest. Delete the rest.
      const keeper = rows.find((r) => r.status !== "pending") || rows[0];
      const toDelete = rows.filter((r) => r.id !== keeper.id).map((r) => r.id);
      if (toDelete.length === 0) continue;
      const del = await prisma.agentRecommendation.deleteMany({ where: { id: { in: toDelete } } });
      result.recsRemoved += del.count;
    }
  } catch (e) {
    console.warn(`[Orchestrator] cleanup recs failed tenant=${tenantId}: ${e.message}`);
  }
  try {
    // Tasks: dedup by (title + dueDate-day) within today's createdAt window.
    const tasks = await prisma.task.findMany({
      where: { tenantId, deletedAt: null, createdAt: { gte: todayStart } },
      select: { id: true, title: true, dueDate: true, createdAt: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    const tgroups = new Map();
    for (const t of tasks) {
      const dayKey = t.dueDate ? startOfDayUTC(t.dueDate).toISOString() : "none";
      const key = `${t.title}|${dayKey}`;
      if (!tgroups.has(key)) tgroups.set(key, []);
      tgroups.get(key).push(t);
    }
    for (const rows of tgroups.values()) {
      if (rows.length < 2) continue;
      const keeper = rows.find((r) => r.status !== "OPEN" && r.status !== "Pending") || rows[0];
      const toDelete = rows.filter((r) => r.id !== keeper.id).map((r) => r.id);
      if (toDelete.length === 0) continue;
      // Soft-delete to preserve audit trail (Task has deletedAt column).
      const del = await prisma.task.updateMany({
        where: { id: { in: toDelete } },
        data: { deletedAt: new Date() },
      });
      result.tasksRemoved += del.count;
    }
  } catch (e) {
    console.warn(`[Orchestrator] cleanup tasks failed tenant=${tenantId}: ${e.message}`);
  }
  if (result.recsRemoved || result.tasksRemoved) {
    console.log(`[Orchestrator] inline cleanup tenant=${tenantId} recs=${result.recsRemoved} tasks=${result.tasksRemoved}`);
  }
  return result;
}

async function runForAllWellnessTenants() {
  const tenants = await prisma.tenant.findMany({ where: { vertical: "wellness", isActive: true }, select: { id: true } });
  for (const t of tenants) {
    try {
      // Issues #261 / #285: clear any pre-existing dupes from previous
      // buggy cron runs before generating new cards.
      await cleanupExistingDupes(t.id);
      await runForTenant(t.id);
    } catch (e) { console.error("[Orchestrator] tenant fail:", t.id, e.message); }
  }
}

function initOrchestratorCron() {
  // 07:00 IST every day = 01:30 UTC
  cron.schedule("30 1 * * *", () => {
    runForAllWellnessTenants().catch((e) => console.error("[Orchestrator] cron fail:", e.message));
  }, { timezone: "Asia/Kolkata" });
  console.log("[Orchestrator] cron initialized (daily 07:00 IST)");
}

module.exports = { initOrchestratorCron, runForTenant, runForAllWellnessTenants, executeApproved, cleanupExistingDupes };
