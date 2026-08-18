/**
 * Lead Reports cluster (generic vertical) — mounted at /api/lead-reports.
 *
 * One route module covering the reporting surfaces the generic CRM was
 * missing. Every endpoint is read-only, tenant-scoped, and derived from
 * models that already exist (Contact / Deal / Task / Activity / CallLog /
 * EmailMessage / SequenceEnrollment) — no new tables, so nothing that
 * currently works can regress.
 *
 *   GET  /productivity            Daily · weekly · monthly productivity report
 *   GET  /lead-quality            Lead quality performance report
 *   GET  /follow-up-tracking      Follow-up tracking report
 *   GET  /source-analysis         Lead source analysis report
 *   GET  /stages                  Funnel builder — read lead-stage config
 *   PUT  /stages                  Funnel builder — write lead-stage config
 *   GET  /stage-funnel            Lead-stage funnel (built from the config)
 *   GET  /visits                  Daily meetings & site-visits follow-up
 *   GET  /visit-done-not-booked   Visited-but-not-booked follow-up + nurturing
 *
 * ADMIN/MANAGER only — these are coaching / oversight surfaces, matching the
 * gate on /api/lead-sla and the `managerOnly` sidebar links for Reports,
 * Funnel and Agent Reports.
 *
 * Route order note: `/stages` and `/stage-funnel` are literal paths and this
 * module declares no parametric `/:id` route, so no mount-order hazard.
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const M = require("../lib/leadReportMetrics");

router.use(verifyRole(["ADMIN", "MANAGER"]));

const STAGES_SETTING_KEY = "leads.funnel.stages";

// Row caps. These reports aggregate in JS (MySQL date-bucketing isn't
// expressible through Prisma groupBy), so every fetch is bounded and every
// response says whether it hit the ceiling — a silently-truncated report is
// worse than an honest one.
const MAX_ROWS = 20000;
const MAX_LIST_ROWS = 500;

// ─── Shared request parsing ──────────────────────────────────────────

/**
 * Resolve ?from / ?to into a concrete window. Defaults to the trailing
 * `defaultDays` days so a bare call still returns something meaningful.
 * Returns `{ error }` on an inverted or unparseable range — mirrors the
 * #117 contract already used by /api/reports.
 */
function resolveRange(req, defaultDays = 30) {
  const now = new Date();
  const rawFrom = req.query.from || req.query.startDate;
  const rawTo = req.query.to || req.query.endDate;

  let to = rawTo ? new Date(`${rawTo}T23:59:59.999Z`) : now;
  let from = rawFrom
    ? new Date(`${rawFrom}T00:00:00.000Z`)
    : new Date(M.startOfUtcDay(now).getTime() - (defaultDays - 1) * 86400000);

  if (rawTo && Number.isNaN(to.getTime())) {
    return { error: { status: 400, error: "endDate is not a valid date", code: "INVALID_DATE" } };
  }
  if (rawFrom && Number.isNaN(from.getTime())) {
    return { error: { status: 400, error: "startDate is not a valid date", code: "INVALID_DATE" } };
  }
  if (from > to) {
    return { error: { status: 400, error: "startDate must be on or before endDate", code: "INVERTED_RANGE" } };
  }
  return { from, to };
}

function parseOwnerId(req) {
  const raw = req.query.ownerId;
  if (raw === undefined || raw === "" || raw === "all") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Tenant users, keyed by id, for owner-attribution rollups. */
async function loadUsers(tenantId) {
  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { id: "asc" },
  });
  return { users, byId: new Map(users.map((u) => [u.id, u])) };
}

function ownerLabel(byId, userId) {
  if (!userId) return "Unassigned";
  const u = byId.get(userId);
  return u ? u.name || u.email : `User #${userId}`;
}

// ─── Funnel-builder stage config ─────────────────────────────────────

async function loadStages(tenantId) {
  try {
    const row = await prisma.tenantSetting.findFirst({
      where: { tenantId, key: STAGES_SETTING_KEY },
      select: { value: true },
    });
    if (!row || !row.value) return { stages: M.DEFAULT_LEAD_STAGES, isCustom: false };
    const parsed = JSON.parse(row.value);
    const stages = M.sanitizeStages(parsed);
    return { stages, isCustom: true };
  } catch (_err) {
    // A corrupt / hand-edited setting must degrade to the shipped defaults
    // rather than 500 every funnel read.
    return { stages: M.DEFAULT_LEAD_STAGES, isCustom: false };
  }
}

// GET /stages — current lead-stage funnel definition
router.get("/stages", async (req, res) => {
  try {
    const { stages, isCustom } = await loadStages(req.user.tenantId);
    res.json({ stages, isCustom, defaults: M.DEFAULT_LEAD_STAGES });
  } catch (err) {
    console.error("[lead-reports/stages]", err);
    res.status(500).json({ error: "Failed to load lead stages", code: "STAGES_READ_FAILED" });
  }
});

// PUT /stages — replace the lead-stage funnel definition (ADMIN only)
router.put("/stages", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    let stages;
    try {
      stages = M.sanitizeStages(req.body?.stages);
    } catch (validationErr) {
      return res.status(400).json({
        error: validationErr.message,
        code: validationErr.code || "INVALID_STAGES",
      });
    }

    const tenantId = req.user.tenantId;
    const value = JSON.stringify(stages);
    const existing = await prisma.tenantSetting.findFirst({
      where: { tenantId, key: STAGES_SETTING_KEY },
      select: { id: true },
    });
    if (existing) {
      await prisma.tenantSetting.update({ where: { id: existing.id }, data: { value } });
    } else {
      await prisma.tenantSetting.create({
        data: { tenantId, key: STAGES_SETTING_KEY, value, category: "leads" },
      });
    }
    res.json({ stages, isCustom: true });
  } catch (err) {
    console.error("[lead-reports/stages:put]", err);
    res.status(500).json({ error: "Failed to save lead stages", code: "STAGES_WRITE_FAILED" });
  }
});

// ─── 1. Productivity report (daily / weekly / monthly) ───────────────

router.get("/productivity", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const period = M.normalizePeriod(req.query.period);
    const defaultDays = period === "monthly" ? 365 : period === "weekly" ? 84 : 14;
    const range = resolveRange(req, defaultDays);
    if (range.error) return res.status(range.error.status).json(range.error);
    const { from, to } = range;
    const ownerId = parseOwnerId(req);

    const window = { gte: from, lte: to };
    const { users, byId } = await loadUsers(tenantId);

    const [leads, activities, calls, emails, tasks, deals] = await Promise.all([
      prisma.contact.findMany({
        where: { tenantId, createdAt: window, deletedAt: null },
        select: { id: true, createdAt: true, assignedToId: true, status: true },
        take: MAX_ROWS,
      }),
      prisma.activity.findMany({
        where: { tenantId, createdAt: window },
        select: { id: true, type: true, userId: true, createdAt: true },
        take: MAX_ROWS,
      }),
      prisma.callLog.findMany({
        where: { tenantId, createdAt: window },
        select: { id: true, userId: true, createdAt: true, duration: true },
        take: MAX_ROWS,
      }),
      prisma.emailMessage.findMany({
        where: { tenantId, createdAt: window, direction: "OUTBOUND" },
        select: { id: true, userId: true, createdAt: true },
        take: MAX_ROWS,
      }),
      prisma.task.findMany({
        where: { tenantId, createdAt: window, deletedAt: null },
        select: { id: true, userId: true, createdAt: true, status: true, title: true, type: true },
        take: MAX_ROWS,
      }),
      prisma.deal.findMany({
        where: { tenantId, createdAt: window, deletedAt: null },
        select: { id: true, ownerId: true, createdAt: true, stage: true, amount: true },
        take: MAX_ROWS,
      }),
    ]);

    const skeleton = M.buildBuckets(from, to, period);
    const blank = () => ({
      leadsCreated: 0,
      activities: 0,
      calls: 0,
      emails: 0,
      meetings: 0,
      tasksCreated: 0,
      tasksCompleted: 0,
      dealsCreated: 0,
      dealsWon: 0,
      revenue: 0,
    });
    const buckets = new Map(
      skeleton.map((b) => [b.key, { key: b.key, label: M.bucketLabel(b.key, period), ...blank() }]),
    );

    // Per-user totals for the whole window (the "who did what" half of the
    // report) alongside the per-period buckets (the "when" half).
    const perUser = new Map();
    const userRow = (uid) => {
      const key = uid || 0;
      if (!perUser.has(key)) {
        perUser.set(key, {
          userId: uid || null,
          name: ownerLabel(byId, uid),
          role: uid && byId.get(uid) ? byId.get(uid).role : null,
          ...blank(),
        });
      }
      return perUser.get(key);
    };

    const bump = (date, uid, field, amount = 1) => {
      if (ownerId !== null && uid !== ownerId) return;
      const key = M.bucketKey(date, period);
      const bucket = key ? buckets.get(key) : null;
      if (bucket) bucket[field] += amount;
      userRow(uid)[field] += amount;
    };

    for (const l of leads) bump(l.createdAt, l.assignedToId, "leadsCreated");
    for (const a of activities) {
      bump(a.createdAt, a.userId, "activities");
      if (String(a.type || "").toLowerCase() === "meeting") bump(a.createdAt, a.userId, "meetings");
    }
    for (const c of calls) bump(c.createdAt, c.userId, "calls");
    for (const e of emails) bump(e.createdAt, e.userId, "emails");
    for (const t of tasks) {
      bump(t.createdAt, t.userId, "tasksCreated");
      if (String(t.status || "").toLowerCase() === "completed") bump(t.createdAt, t.userId, "tasksCompleted");
      if (M.isVisitTask(t)) bump(t.createdAt, t.userId, "meetings");
    }
    for (const d of deals) {
      bump(d.createdAt, d.ownerId, "dealsCreated");
      if (String(d.stage || "").toLowerCase() === "won") {
        bump(d.createdAt, d.ownerId, "dealsWon");
        bump(d.createdAt, d.ownerId, "revenue", Number(d.amount) || 0);
      }
    }

    const series = Array.from(buckets.values());
    const totals = series.reduce((acc, b) => {
      for (const k of Object.keys(blank())) acc[k] = (acc[k] || 0) + b[k];
      return acc;
    }, blank());
    totals.revenue = M.round(totals.revenue);

    const byUser = Array.from(perUser.values())
      .map((u) => ({
        ...u,
        revenue: M.round(u.revenue),
        touches: u.calls + u.emails + u.activities,
        taskCompletionRate: M.rate(u.tasksCompleted, u.tasksCreated),
      }))
      .sort((a, b) => b.touches - a.touches || b.revenue - a.revenue);

    res.json({
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      series: series.map((b) => ({ ...b, revenue: M.round(b.revenue) })),
      byUser,
      totals,
      users: users.map((u) => ({ id: u.id, name: u.name || u.email })),
      truncated: [leads, activities, calls, emails, tasks, deals].some((r) => r.length >= MAX_ROWS),
    });
  } catch (err) {
    console.error("[lead-reports/productivity]", err);
    res.status(500).json({ error: "Failed to build productivity report", code: "PRODUCTIVITY_FAILED" });
  }
});

// ─── 2. Lead quality performance report ──────────────────────────────

router.get("/lead-quality", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const range = resolveRange(req, 90);
    if (range.error) return res.status(range.error.status).json(range.error);
    const { from, to } = range;
    const { byId } = await loadUsers(tenantId);

    const contacts = await prisma.contact.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to }, deletedAt: null },
      select: {
        id: true,
        status: true,
        source: true,
        aiScore: true,
        assignedToId: true,
        callifiedLeadStatus: true,
        createdAt: true,
      },
      take: MAX_ROWS,
    });

    const isConverted = (c) => ["customer", "prospect"].includes(String(c.status || "").toLowerCase());

    const totals = {
      totalLeads: contacts.length,
      qualified: 0,
      junk: 0,
      dnp: 0,
      connected: 0,
      untouched: 0,
      converted: 0,
      scoreSum: 0,
    };

    const bandRows = new Map(
      M.SCORE_BANDS.map((b) => [b.band, { band: b.band, count: 0, qualified: 0, converted: 0 }]),
    );
    const sourceRows = new Map();
    const ownerRows = new Map();

    for (const c of contacts) {
      const call = M.normalizeCallStatus(c.callifiedLeadStatus);
      const converted = isConverted(c);
      const score = Number(c.aiScore) || 0;

      if (call === M.CALL_STATUS.QUALIFIED) totals.qualified += 1;
      else if (call === M.CALL_STATUS.JUNK) totals.junk += 1;
      else if (call === M.CALL_STATUS.DNP) totals.dnp += 1;
      else if (call === M.CALL_STATUS.CONNECTED) totals.connected += 1;
      else totals.untouched += 1;
      if (converted) totals.converted += 1;
      totals.scoreSum += score;

      const band = bandRows.get(M.scoreBand(score));
      if (band) {
        band.count += 1;
        if (call === M.CALL_STATUS.QUALIFIED) band.qualified += 1;
        if (converted) band.converted += 1;
      }

      const srcKey = c.source || "Unknown";
      if (!sourceRows.has(srcKey)) {
        sourceRows.set(srcKey, { source: srcKey, total: 0, qualified: 0, junk: 0, converted: 0, scoreSum: 0 });
      }
      const src = sourceRows.get(srcKey);
      src.total += 1;
      src.scoreSum += score;
      if (call === M.CALL_STATUS.QUALIFIED) src.qualified += 1;
      if (call === M.CALL_STATUS.JUNK) src.junk += 1;
      if (converted) src.converted += 1;

      const ownerKey = c.assignedToId || 0;
      if (!ownerRows.has(ownerKey)) {
        ownerRows.set(ownerKey, {
          userId: c.assignedToId || null,
          name: ownerLabel(byId, c.assignedToId),
          total: 0,
          qualified: 0,
          junk: 0,
          converted: 0,
          scoreSum: 0,
        });
      }
      const own = ownerRows.get(ownerKey);
      own.total += 1;
      own.scoreSum += score;
      if (call === M.CALL_STATUS.QUALIFIED) own.qualified += 1;
      if (call === M.CALL_STATUS.JUNK) own.junk += 1;
      if (converted) own.converted += 1;
    }

    const withRates = (row) => ({
      ...row,
      avgScore: M.round(row.total > 0 ? row.scoreSum / row.total : 0, 1),
      qualificationRate: M.rate(row.qualified, row.total),
      junkRate: M.rate(row.junk, row.total),
      conversionRate: M.rate(row.converted, row.total),
      scoreSum: undefined,
    });

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        totalLeads: totals.totalLeads,
        qualified: totals.qualified,
        junk: totals.junk,
        dnp: totals.dnp,
        connected: totals.connected,
        untouched: totals.untouched,
        converted: totals.converted,
        avgScore: M.round(totals.totalLeads > 0 ? totals.scoreSum / totals.totalLeads : 0, 1),
        qualificationRate: M.rate(totals.qualified, totals.totalLeads),
        junkRate: M.rate(totals.junk, totals.totalLeads),
        conversionRate: M.rate(totals.converted, totals.totalLeads),
      },
      scoreBands: Array.from(bandRows.values()).map((b) => ({
        ...b,
        conversionRate: M.rate(b.converted, b.count),
        qualificationRate: M.rate(b.qualified, b.count),
      })),
      bySource: Array.from(sourceRows.values()).map(withRates).sort((a, b) => b.total - a.total),
      byOwner: Array.from(ownerRows.values()).map(withRates).sort((a, b) => b.total - a.total),
      truncated: contacts.length >= MAX_ROWS,
    });
  } catch (err) {
    console.error("[lead-reports/lead-quality]", err);
    res.status(500).json({ error: "Failed to build lead quality report", code: "LEAD_QUALITY_FAILED" });
  }
});

// ─── 3. Follow-up tracking report ────────────────────────────────────

router.get("/follow-up-tracking", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const range = resolveRange(req, 30);
    if (range.error) return res.status(range.error.status).json(range.error);
    const { from, to } = range;
    const now = new Date();
    const staleDays = Math.max(1, Math.min(365, parseInt(req.query.staleDays, 10) || 7));
    const { byId } = await loadUsers(tenantId);

    // Open tasks are fetched regardless of the window (an overdue follow-up
    // from two months ago is exactly what this report exists to surface);
    // completed tasks are windowed so the "done" counter stays period-scoped.
    const [openTasks, completedTasks, slaPending, staleLeads] = await Promise.all([
      prisma.task.findMany({
        where: { tenantId, deletedAt: null, status: { not: "Completed" } },
        select: {
          id: true, title: true, dueDate: true, status: true, priority: true,
          userId: true, contactId: true, type: true, createdAt: true,
          contact: { select: { id: true, name: true, phone: true, email: true, status: true } },
        },
        orderBy: { dueDate: "asc" },
        take: MAX_ROWS,
      }),
      prisma.task.count({
        where: { tenantId, deletedAt: null, status: "Completed", createdAt: { gte: from, lte: to } },
      }),
      prisma.contact.findMany({
        where: { tenantId, deletedAt: null, status: "Lead", firstResponseAt: null },
        select: {
          id: true, name: true, phone: true, email: true, source: true, aiScore: true,
          assignedToId: true, createdAt: true, firstResponseDueAt: true, slaBreached: true,
        },
        orderBy: { createdAt: "asc" },
        take: MAX_LIST_ROWS,
      }),
      prisma.contact.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: { in: ["Lead", "Prospect"] },
          activities: { none: { createdAt: { gte: new Date(now.getTime() - staleDays * 86400000) } } },
        },
        select: {
          id: true, name: true, phone: true, email: true, source: true, aiScore: true,
          assignedToId: true, createdAt: true,
          activities: { select: { createdAt: true, type: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
        orderBy: { createdAt: "asc" },
        take: MAX_LIST_ROWS,
      }),
    ]);

    const summary = {
      openFollowUps: openTasks.length,
      overdue: 0,
      dueToday: 0,
      upcoming: 0,
      undated: 0,
      completedInPeriod: completedTasks,
      awaitingFirstResponse: slaPending.length,
      slaBreached: slaPending.filter((l) => l.slaBreached).length,
      staleLeads: staleLeads.length,
      staleDays,
    };

    const ownerRows = new Map();
    const ownerRow = (uid) => {
      const key = uid || 0;
      if (!ownerRows.has(key)) {
        ownerRows.set(key, {
          userId: uid || null,
          name: ownerLabel(byId, uid),
          open: 0,
          overdue: 0,
          dueToday: 0,
          upcoming: 0,
          undated: 0,
          overdueDaysSum: 0,
        });
      }
      return ownerRows.get(key);
    };

    const overdueList = [];
    const dueTodayList = [];

    for (const t of openTasks) {
      const state = M.followUpState(t, now);
      const row = ownerRow(t.userId);
      row.open += 1;
      if (state === "overdue") {
        summary.overdue += 1;
        row.overdue += 1;
        const late = M.daysBetween(t.dueDate, now) || 0;
        row.overdueDaysSum += late;
        if (overdueList.length < MAX_LIST_ROWS) {
          overdueList.push({
            taskId: t.id,
            title: t.title,
            type: t.type || null,
            priority: t.priority,
            dueDate: t.dueDate,
            overdueDays: late,
            owner: ownerLabel(byId, t.userId),
            ownerId: t.userId || null,
            contactId: t.contact?.id || t.contactId || null,
            contactName: t.contact?.name || null,
            contactPhone: t.contact?.phone || null,
            contactStatus: t.contact?.status || null,
          });
        }
      } else if (state === "due_today") {
        summary.dueToday += 1;
        row.dueToday += 1;
        if (dueTodayList.length < MAX_LIST_ROWS) {
          dueTodayList.push({
            taskId: t.id,
            title: t.title,
            type: t.type || null,
            priority: t.priority,
            dueDate: t.dueDate,
            owner: ownerLabel(byId, t.userId),
            ownerId: t.userId || null,
            contactId: t.contact?.id || t.contactId || null,
            contactName: t.contact?.name || null,
            contactPhone: t.contact?.phone || null,
          });
        }
      } else if (state === "upcoming") {
        summary.upcoming += 1;
        row.upcoming += 1;
      } else {
        summary.undated += 1;
        row.undated += 1;
      }
    }

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      summary,
      byOwner: Array.from(ownerRows.values())
        .map((r) => ({
          ...r,
          avgOverdueDays: M.round(r.overdue > 0 ? r.overdueDaysSum / r.overdue : 0, 1),
          onTimeRate: M.rate(r.open - r.overdue, r.open),
          overdueDaysSum: undefined,
        }))
        .sort((a, b) => b.overdue - a.overdue || b.open - a.open),
      overdue: overdueList,
      dueToday: dueTodayList,
      awaitingFirstResponse: slaPending.map((l) => ({
        contactId: l.id,
        name: l.name,
        phone: l.phone,
        email: l.email,
        source: l.source,
        score: l.aiScore,
        owner: ownerLabel(byId, l.assignedToId),
        ownerId: l.assignedToId || null,
        createdAt: l.createdAt,
        dueAt: l.firstResponseDueAt,
        breached: Boolean(l.slaBreached),
        waitingDays: M.daysBetween(l.createdAt, now),
      })),
      stale: staleLeads.map((l) => ({
        contactId: l.id,
        name: l.name,
        phone: l.phone,
        email: l.email,
        source: l.source,
        score: l.aiScore,
        owner: ownerLabel(byId, l.assignedToId),
        ownerId: l.assignedToId || null,
        lastActivityAt: l.activities?.[0]?.createdAt || null,
        daysSinceLastActivity: l.activities?.[0]?.createdAt
          ? M.daysBetween(l.activities[0].createdAt, now)
          : M.daysBetween(l.createdAt, now),
      })),
      truncated: openTasks.length >= MAX_ROWS,
    });
  } catch (err) {
    console.error("[lead-reports/follow-up-tracking]", err);
    res.status(500).json({ error: "Failed to build follow-up tracking report", code: "FOLLOWUP_FAILED" });
  }
});

// ─── 4. Lead source analysis report ──────────────────────────────────

router.get("/source-analysis", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const range = resolveRange(req, 90);
    if (range.error) return res.status(range.error.status).json(range.error);
    const { from, to } = range;

    const contacts = await prisma.contact.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to }, deletedAt: null },
      select: {
        id: true,
        status: true,
        source: true,
        firstTouchSource: true,
        lastTouchSource: true,
        aiScore: true,
        callifiedLeadStatus: true,
        createdAt: true,
        deals: { select: { id: true, stage: true, amount: true, createdAt: true } },
      },
      take: MAX_ROWS,
    });

    const rows = new Map();
    const row = (source) => {
      const key = source || "Unknown";
      if (!rows.has(key)) {
        rows.set(key, {
          source: key,
          leads: 0,
          qualified: 0,
          junk: 0,
          converted: 0,
          deals: 0,
          dealsWon: 0,
          revenue: 0,
          scoreSum: 0,
          cycleDaysSum: 0,
          cycleSamples: 0,
        });
      }
      return rows.get(key);
    };

    const firstTouch = new Map();
    const lastTouch = new Map();
    const monthly = new Map();

    for (const c of contacts) {
      const r = row(c.source);
      const call = M.normalizeCallStatus(c.callifiedLeadStatus);
      const converted = ["customer", "prospect"].includes(String(c.status || "").toLowerCase());

      r.leads += 1;
      r.scoreSum += Number(c.aiScore) || 0;
      if (call === M.CALL_STATUS.QUALIFIED) r.qualified += 1;
      if (call === M.CALL_STATUS.JUNK) r.junk += 1;
      if (converted) r.converted += 1;

      for (const d of c.deals || []) {
        r.deals += 1;
        if (String(d.stage || "").toLowerCase() === "won") {
          r.dealsWon += 1;
          r.revenue += Number(d.amount) || 0;
          const cycle = M.daysBetween(c.createdAt, d.createdAt);
          if (cycle !== null && cycle >= 0) {
            r.cycleDaysSum += cycle;
            r.cycleSamples += 1;
          }
        }
      }

      const ft = c.firstTouchSource || c.source || "Unknown";
      firstTouch.set(ft, (firstTouch.get(ft) || 0) + 1);
      const lt = c.lastTouchSource || c.source || "Unknown";
      lastTouch.set(lt, (lastTouch.get(lt) || 0) + 1);

      const mk = M.bucketKey(c.createdAt, "monthly");
      if (mk) {
        if (!monthly.has(mk)) monthly.set(mk, { month: mk, label: M.bucketLabel(mk, "monthly"), total: 0, bySource: {} });
        const bucket = monthly.get(mk);
        bucket.total += 1;
        const sk = c.source || "Unknown";
        bucket.bySource[sk] = (bucket.bySource[sk] || 0) + 1;
      }
    }

    const sources = Array.from(rows.values())
      .map((r) => ({
        source: r.source,
        leads: r.leads,
        qualified: r.qualified,
        junk: r.junk,
        converted: r.converted,
        deals: r.deals,
        dealsWon: r.dealsWon,
        revenue: M.round(r.revenue),
        avgScore: M.round(r.leads > 0 ? r.scoreSum / r.leads : 0, 1),
        qualificationRate: M.rate(r.qualified, r.leads),
        conversionRate: M.rate(r.converted, r.leads),
        winRate: M.rate(r.dealsWon, r.deals),
        revenuePerLead: M.round(r.leads > 0 ? r.revenue / r.leads : 0),
        avgDaysToWin: M.round(r.cycleSamples > 0 ? r.cycleDaysSum / r.cycleSamples : 0, 1),
      }))
      .sort((a, b) => b.leads - a.leads);

    const totals = sources.reduce(
      (acc, s) => {
        acc.leads += s.leads;
        acc.qualified += s.qualified;
        acc.converted += s.converted;
        acc.dealsWon += s.dealsWon;
        acc.revenue += s.revenue;
        return acc;
      },
      { leads: 0, qualified: 0, converted: 0, dealsWon: 0, revenue: 0 },
    );
    totals.revenue = M.round(totals.revenue);
    totals.conversionRate = M.rate(totals.converted, totals.leads);
    totals.qualificationRate = M.rate(totals.qualified, totals.leads);
    totals.sourceCount = sources.length;

    const toPairs = (map) =>
      Array.from(map.entries())
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      sources,
      totals,
      firstTouch: toPairs(firstTouch),
      lastTouch: toPairs(lastTouch),
      monthly: Array.from(monthly.values()).sort((a, b) => a.month.localeCompare(b.month)),
      truncated: contacts.length >= MAX_ROWS,
    });
  } catch (err) {
    console.error("[lead-reports/source-analysis]", err);
    res.status(500).json({ error: "Failed to build source analysis report", code: "SOURCE_ANALYSIS_FAILED" });
  }
});

// ─── 5. Lead-stage funnel (funnel builder output) ────────────────────

router.get("/stage-funnel", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const range = resolveRange(req, 90);
    if (range.error) return res.status(range.error.status).json(range.error);
    const { from, to } = range;
    const ownerId = parseOwnerId(req);

    const { stages } = await loadStages(tenantId);
    const where = { tenantId, createdAt: { gte: from, lte: to }, deletedAt: null };
    if (ownerId !== null) where.assignedToId = ownerId;

    const contacts = await prisma.contact.findMany({
      where,
      select: {
        id: true,
        status: true,
        callifiedLeadStatus: true,
        aiScore: true,
        source: true,
        createdAt: true,
        assignedToId: true,
      },
      take: MAX_ROWS,
    });

    const counts = new Map(stages.map((s) => [s.key, 0]));
    let unclassified = 0;
    for (const c of contacts) {
      const key = M.resolveStage(c, stages);
      if (key && counts.has(key)) counts.set(key, counts.get(key) + 1);
      else unclassified += 1;
    }

    // Funnel maths: `entered` is cumulative — anyone sitting at stage N also
    // passed through every earlier flow stage. Drop-out ("leak") stages are
    // reported separately so they don't distort the conversion ladder.
    const flow = stages.filter((s) => !s.leak);
    const leaks = stages.filter((s) => s.leak);
    const flowCounts = flow.map((s) => counts.get(s.key) || 0);

    const funnel = flow.map((s, i) => {
      const entered = flowCounts.slice(i).reduce((a, n) => a + n, 0);
      const nextEntered = i + 1 < flow.length ? flowCounts.slice(i + 1).reduce((a, n) => a + n, 0) : null;
      return {
        key: s.key,
        label: s.label,
        current: flowCounts[i],
        entered,
        conversionToNext: nextEntered === null ? null : M.rate(nextEntered, entered),
        shareOfTop: M.rate(entered, flowCounts.reduce((a, n) => a + n, 0)),
      };
    });

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      stages: funnel,
      leaks: leaks.map((s) => ({ key: s.key, label: s.label, count: counts.get(s.key) || 0 })),
      totals: {
        totalLeads: contacts.length,
        inFunnel: flowCounts.reduce((a, n) => a + n, 0),
        leaked: leaks.reduce((a, s) => a + (counts.get(s.key) || 0), 0),
        unclassified,
        overallConversion: funnel.length > 1 ? M.rate(funnel[funnel.length - 1].entered, funnel[0].entered) : 0,
      },
      truncated: contacts.length >= MAX_ROWS,
    });
  } catch (err) {
    console.error("[lead-reports/stage-funnel]", err);
    res.status(500).json({ error: "Failed to build lead stage funnel", code: "STAGE_FUNNEL_FAILED" });
  }
});

// ─── 6. Daily meetings & site visits follow-up ───────────────────────

// Named windows the UI offers. `range` honours ?from/?to verbatim.
function visitWindow(scope, now) {
  const today = M.startOfUtcDay(now);
  const day = 86400000;
  if (scope === "tomorrow") return { from: new Date(today.getTime() + day), to: new Date(today.getTime() + 2 * day - 1) };
  if (scope === "week") return { from: today, to: new Date(today.getTime() + 7 * day - 1) };
  if (scope === "overdue") return { from: new Date(0), to: new Date(today.getTime() - 1) };
  return { from: today, to: new Date(today.getTime() + day - 1) }; // today
}

router.get("/visits", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const now = new Date();
    const scope = String(req.query.scope || "today").toLowerCase();
    const ownerId = parseOwnerId(req);

    let from;
    let to;
    if (scope === "range") {
      const range = resolveRange(req, 7);
      if (range.error) return res.status(range.error.status).json(range.error);
      ({ from, to } = range);
    } else {
      ({ from, to } = visitWindow(scope, now));
    }

    const { byId } = await loadUsers(tenantId);
    const where = { tenantId, deletedAt: null, dueDate: { gte: from, lte: to } };
    if (ownerId !== null) where.userId = ownerId;

    const tasks = await prisma.task.findMany({
      where,
      select: {
        id: true, title: true, notes: true, dueDate: true, status: true, priority: true,
        type: true, outcome: true, userId: true, contactId: true, createdAt: true,
        contact: {
          select: { id: true, name: true, phone: true, email: true, status: true, source: true, assignedToId: true },
        },
      },
      orderBy: { dueDate: "asc" },
      take: MAX_ROWS,
    });

    const visits = tasks.filter(M.isVisitTask);

    const summary = {
      scheduled: visits.length,
      completed: 0,
      pending: 0,
      overdue: 0,
      booked: 0,
      noShow: 0,
      awaitingOutcome: 0,
    };
    const ownerRows = new Map();

    let inferredCount = 0;

    const rows = visits.map((t) => {
      const state = M.followUpState(t, now);
      const outcome = M.normalizeVisitOutcome(t.outcome);
      const done = state === "completed";
      const visitType = M.resolveVisitType(t);
      if (visitType.source === "inferred") inferredCount += 1;

      if (done) summary.completed += 1;
      else summary.pending += 1;
      if (state === "overdue") summary.overdue += 1;
      if (outcome === "booked") summary.booked += 1;
      if (outcome === "no_show") summary.noShow += 1;
      if (done && outcome === "pending") summary.awaitingOutcome += 1;

      const key = t.userId || 0;
      if (!ownerRows.has(key)) {
        ownerRows.set(key, {
          userId: t.userId || null,
          name: ownerLabel(byId, t.userId),
          scheduled: 0,
          completed: 0,
          booked: 0,
          overdue: 0,
        });
      }
      const o = ownerRows.get(key);
      o.scheduled += 1;
      if (done) o.completed += 1;
      if (outcome === "booked") o.booked += 1;
      if (state === "overdue") o.overdue += 1;

      return {
        taskId: t.id,
        title: t.title,
        visitType: visitType.label,
        // "inferred" means the row has no Type set and was matched on its
        // title — the UI flags it so the operator knows to set the Type.
        visitTypeSource: visitType.source,
        dueDate: t.dueDate,
        status: t.status,
        priority: t.priority,
        state,
        outcome,
        notes: t.notes || null,
        owner: ownerLabel(byId, t.userId),
        ownerId: t.userId || null,
        contactId: t.contact?.id || t.contactId || null,
        contactName: t.contact?.name || null,
        contactPhone: t.contact?.phone || null,
        contactEmail: t.contact?.email || null,
        contactStatus: t.contact?.status || null,
        contactSource: t.contact?.source || null,
      };
    });

    res.json({
      scope,
      from: from.toISOString(),
      to: to.toISOString(),
      summary: {
        ...summary,
        // How many rows in this window were matched on their title rather than
        // a set Type — surfaced so the operator can see the fallback is doing
        // work and go set the Type on those tasks.
        untyped: inferredCount,
        completionRate: M.rate(summary.completed, summary.scheduled),
        bookingRate: M.rate(summary.booked, summary.completed),
      },
      visits: rows.slice(0, MAX_LIST_ROWS),
      byOwner: Array.from(ownerRows.values())
        .map((o) => ({ ...o, bookingRate: M.rate(o.booked, o.completed) }))
        .sort((a, b) => b.scheduled - a.scheduled),
      truncated: tasks.length >= MAX_ROWS || rows.length > MAX_LIST_ROWS,
    });
  } catch (err) {
    console.error("[lead-reports/visits]", err);
    res.status(500).json({ error: "Failed to build visits report", code: "VISITS_FAILED" });
  }
});

// ─── 7. Visit done, not booked — follow-up + nurturing ───────────────

router.get("/visit-done-not-booked", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const range = resolveRange(req, 90);
    if (range.error) return res.status(range.error.status).json(range.error);
    const { from, to } = range;
    const now = new Date();
    const { byId } = await loadUsers(tenantId);

    // Completed visit-shaped tasks in the window. `type` is null on legacy
    // rows, so the keyword fallback in isVisitTask() is what keeps this report
    // populated for tenants that were using plain tasks before this shipped.
    const doneTasks = await prisma.task.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: "Completed",
        dueDate: { gte: from, lte: to },
        contactId: { not: null },
      },
      select: {
        id: true, title: true, dueDate: true, type: true, outcome: true, userId: true, contactId: true,
      },
      orderBy: { dueDate: "desc" },
      take: MAX_ROWS,
    });

    const visits = doneTasks.filter(M.isVisitTask);
    const contactIds = Array.from(new Set(visits.map((t) => t.contactId).filter(Boolean)));

    if (contactIds.length === 0) {
      return res.json({
        from: from.toISOString(),
        to: to.toISOString(),
        summary: {
          visitsDone: 0, booked: 0, notBooked: 0, bookingRate: 0,
          inNurture: 0, notNurtured: 0, noFollowUpScheduled: 0,
        },
        leads: [],
        byOwner: [],
        truncated: false,
      });
    }

    const [contacts, openTasks, enrollments] = await Promise.all([
      prisma.contact.findMany({
        where: { tenantId, id: { in: contactIds }, deletedAt: null },
        select: {
          id: true, name: true, phone: true, email: true, status: true, source: true,
          aiScore: true, assignedToId: true,
          deals: { select: { id: true, stage: true, amount: true } },
          activities: { select: { createdAt: true, type: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      prisma.task.findMany({
        where: {
          tenantId, deletedAt: null, contactId: { in: contactIds }, status: { not: "Completed" },
        },
        select: { id: true, contactId: true, dueDate: true, title: true, type: true },
        orderBy: { dueDate: "asc" },
      }),
      prisma.sequenceEnrollment.findMany({
        where: { tenantId, contactId: { in: contactIds } },
        select: { id: true, contactId: true, status: true, sequence: { select: { name: true } } },
      }),
    ]);

    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const nextTaskByContact = new Map();
    for (const t of openTasks) {
      if (!nextTaskByContact.has(t.contactId)) nextTaskByContact.set(t.contactId, t);
    }
    const nurtureByContact = new Map();
    for (const e of enrollments) {
      const active = String(e.status || "").toLowerCase() === "active";
      const prev = nurtureByContact.get(e.contactId);
      if (!prev || (active && !prev.active)) {
        nurtureByContact.set(e.contactId, { active, name: e.sequence?.name || null, status: e.status });
      }
    }

    // Latest visit per contact wins — a lead who visited three times is one row.
    const latestVisit = new Map();
    for (const v of visits) {
      const prev = latestVisit.get(v.contactId);
      if (!prev || new Date(v.dueDate) > new Date(prev.dueDate)) latestVisit.set(v.contactId, v);
    }

    const summary = {
      visitsDone: latestVisit.size,
      booked: 0,
      notBooked: 0,
      inNurture: 0,
      notNurtured: 0,
      noFollowUpScheduled: 0,
    };
    const ownerRows = new Map();
    const leads = [];

    for (const [contactId, visit] of latestVisit.entries()) {
      const c = contactById.get(contactId);
      if (!c) continue;

      const wonDeal = (c.deals || []).find((d) => String(d.stage || "").toLowerCase() === "won");
      const booked =
        M.isBookedOutcome(visit.outcome) ||
        Boolean(wonDeal) ||
        String(c.status || "").toLowerCase() === "customer";

      const ownerId = visit.userId || c.assignedToId || null;
      const key = ownerId || 0;
      if (!ownerRows.has(key)) {
        ownerRows.set(key, { userId: ownerId, name: ownerLabel(byId, ownerId), visits: 0, booked: 0, notBooked: 0 });
      }
      const o = ownerRows.get(key);
      o.visits += 1;

      if (booked) {
        summary.booked += 1;
        o.booked += 1;
        continue; // booked clients are counted, not listed — the list is the work queue
      }

      summary.notBooked += 1;
      o.notBooked += 1;

      const nurture = nurtureByContact.get(contactId) || null;
      if (nurture?.active) summary.inNurture += 1;
      else summary.notNurtured += 1;

      const nextTask = nextTaskByContact.get(contactId) || null;
      if (!nextTask) summary.noFollowUpScheduled += 1;

      leads.push({
        contactId,
        name: c.name,
        phone: c.phone,
        email: c.email,
        status: c.status,
        source: c.source,
        score: c.aiScore,
        owner: ownerLabel(byId, ownerId),
        ownerId,
        lastVisitAt: visit.dueDate,
        daysSinceVisit: M.daysBetween(visit.dueDate, now),
        visitOutcome: M.normalizeVisitOutcome(visit.outcome),
        visitTitle: visit.title,
        openDealCount: (c.deals || []).filter((d) => !["won", "lost"].includes(String(d.stage || "").toLowerCase())).length,
        lastActivityAt: c.activities?.[0]?.createdAt || null,
        nextFollowUpAt: nextTask?.dueDate || null,
        nextFollowUpTitle: nextTask?.title || null,
        inNurture: Boolean(nurture?.active),
        nurtureSequence: nurture?.name || null,
      });
    }

    leads.sort((a, b) => (b.daysSinceVisit || 0) - (a.daysSinceVisit || 0));

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      summary: {
        ...summary,
        bookingRate: M.rate(summary.booked, summary.visitsDone),
        nurtureCoverage: M.rate(summary.inNurture, summary.notBooked),
      },
      leads: leads.slice(0, MAX_LIST_ROWS),
      byOwner: Array.from(ownerRows.values())
        .map((o) => ({ ...o, bookingRate: M.rate(o.booked, o.visits) }))
        .sort((a, b) => b.notBooked - a.notBooked),
      truncated: doneTasks.length >= MAX_ROWS || leads.length > MAX_LIST_ROWS,
    });
  } catch (err) {
    console.error("[lead-reports/visit-done-not-booked]", err);
    res.status(500).json({ error: "Failed to build visit-not-booked report", code: "VISIT_NOT_BOOKED_FAILED" });
  }
});

module.exports = router;
