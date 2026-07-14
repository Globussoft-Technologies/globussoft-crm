/**
 * routes/super_admin_api_analytics.js — API Analytics module (Super Admin
 * Portal). Read-only aggregation + browsing over the two API-call log
 * tables: LlmCallLog (Gemini/OpenAI/Anthropic/Perplexity/Groq — token +
 * cost based) and ApiCallLog (SerpApi + future flat-rate providers).
 *
 * All routes require requireSuperAdmin (mounted with that middleware in
 * server.js), same as routes/super_admin_cron.js.
 *
 * Endpoint groups:
 *   GET /overview?days=<1-90, default 14> — totals, byDay, byProvider,
 *     byModel, top failures, all merged across BOTH tables. Optionally
 *     accepts ?from=<ISO date>&to=<ISO date> for an exact date/range instead
 *     of the day-count preset — when either is present, days/DEFAULT_DAYS
 *     is ignored entirely (from/to always wins, matching the UI's "custom
 *     range replaces the preset dropdown" behavior). A single ?from= with
 *     no ?to= is treated as "that one day" (to defaults to end-of-from-day).
 *   GET /calls?page&pageSize&provider&status&search&from&to — paginated
 *     browse of individual call rows (merged + tagged with `source`:
 *     "llm" | "api" so the UI can render provider-specific columns).
 *   GET/PUT /settings/log-retention — shares the SAME retention window as
 *     cron/apiCallLogRetentionEngine.js (SystemSetting key
 *     "api_call_log_retention_days").
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;
const RETENTION_SETTING_KEY = "api_call_log_retention_days";
const DEFAULT_RETENTION_DAYS = 30;

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function toNum(dec) {
  // Prisma Decimal fields deserialize as a Decimal.js-like object with
  // .toNumber(), or occasionally a plain string/number depending on driver
  // config — handle all three so the route never throws on a shape surprise.
  if (dec == null) return 0;
  if (typeof dec === "number") return dec;
  if (typeof dec.toNumber === "function") return dec.toNumber();
  return Number(dec) || 0;
}

// ── Overview (charts) ───────────────────────────────────────────────────

router.get("/overview", async (req, res) => {
  try {
    const { provider, model, from, to } = req.query;

    // An explicit ?from/?to date (or single-date) always overrides the
    // day-count preset — the UI's custom date picker replaces the dropdown
    // rather than combining with it.
    //
    // A bare date string ("2026-07-14") parses as UTC MIDNIGHT per the ES
    // spec (new Date("2026-07-14") -> 2026-07-14T00:00:00.000Z), but
    // Date#setHours mutates in LOCAL time — on a server running IST
    // (UTC+5:30) that shifted "end of day" back by 5.5 hours
    // (...T18:29:59.999Z instead of ...T23:59:59.999Z), silently clipping
    // the last few hours of real data from a "single day" filter. Using
    // setUTCHours keeps the whole boundary in UTC, matching how the date
    // string itself was parsed.
    let since, until, days;
    if (from || to) {
      if (from) {
        const fromDate = new Date(from);
        if (Number.isNaN(fromDate.getTime())) return res.status(400).json({ error: "invalid `from` date", code: "INVALID_DATE" });
        since = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        if (Number.isNaN(toDate.getTime())) return res.status(400).json({ error: "invalid `to` date", code: "INVALID_DATE" });
        // Bump to the end of that UTC calendar day so a single-day filter
        // actually includes every row from that day, not just midnight-exact.
        toDate.setUTCHours(23, 59, 59, 999);
        until = toDate;
      } else {
        // ?from with no ?to → "just that one day".
        until = new Date(since);
        until.setUTCHours(23, 59, 59, 999);
      }
      if (!since) {
        // ?to with no ?from → everything up to that date, uncapped at the start.
        since = new Date(0);
      }
      days = Math.max(1, Math.ceil((until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000)));
    } else {
      const daysRaw = parseInt(req.query.days, 10);
      days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, MAX_DAYS) : DEFAULT_DAYS;
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }

    const llmWhere = { createdAt: until ? { gte: since, lte: until } : { gte: since } };
    if (provider) llmWhere.provider = provider;
    if (model) llmWhere.model = model;

    const apiWhere = { createdAt: until ? { gte: since, lte: until } : { gte: since } };
    if (provider) apiWhere.provider = provider;
    // ApiCallLog has no `model` column (endpoint is its nearest analog) — a
    // ?model= filter narrows to LLM-only results, matching the "by model"
    // chart's own LLM-only scope rather than silently ignoring the filter.
    if (model) apiWhere.id = -1; // unsatisfiable — excludes all ApiCallLog rows

    const [llmLogs, apiLogs] = await Promise.all([
      prisma.llmCallLog.findMany({
        where: llmWhere,
        select: {
          provider: true,
          model: true,
          task: true,
          status: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          costEstimate: true,
          stub: true,
          errorMessage: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.apiCallLog.findMany({
        where: apiWhere,
        select: {
          provider: true,
          endpoint: true,
          status: true,
          costEstimate: true,
          errorMessage: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Normalize both tables into one shape for aggregation.
    const mergedAll = [
      ...llmLogs.map((l) => ({
        provider: l.provider || "unknown",
        model: l.model,
        status: l.status,
        tokens: l.totalTokens || 0,
        cost: toNum(l.costEstimate),
        stub: l.stub,
        errorMessage: l.errorMessage,
        createdAt: l.createdAt,
        source: "llm",
      })),
      ...apiLogs.map((a) => ({
        provider: a.provider || "unknown",
        model: a.endpoint || null,
        status: a.status,
        tokens: 0,
        cost: toNum(a.costEstimate),
        stub: false,
        errorMessage: a.errorMessage,
        createdAt: a.createdAt,
        source: "api",
      })),
    ];

    // Stub calls never hit a real API (no key configured — llmRouter.js's
    // synthetic-response fallback) and always cost $0 with heuristic
    // character-count "tokens", not real ones. Excluded entirely from this
    // dashboard — a provider with no configured key (e.g. anthropic/
    // perplexity) should never appear here at all, and there's no
    // "stub calls" concept surfaced to the operator.
    const merged = mergedAll.filter((c) => !c.stub);

    // Runs-over-time by day — call count + cost, split success/failed.
    const byDayMap = new Map();
    for (const c of merged) {
      const key = dayKey(c.createdAt);
      if (!byDayMap.has(key)) {
        byDayMap.set(key, { date: key, success: 0, failed: 0, total: 0, cost: 0, tokens: 0 });
      }
      const bucket = byDayMap.get(key);
      bucket.total += 1;
      bucket.cost += c.cost;
      bucket.tokens += c.tokens;
      if (c.status === "failed") bucket.failed += 1;
      else bucket.success += 1;
    }
    const byDay = [...byDayMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({ ...b, cost: Math.round(b.cost * 1e6) / 1e6 }));

    // Per-provider breakdown — calls, tokens, cost, failure count.
    const byProviderMap = new Map();
    for (const c of merged) {
      if (!byProviderMap.has(c.provider)) {
        byProviderMap.set(c.provider, { provider: c.provider, calls: 0, failures: 0, tokens: 0, cost: 0 });
      }
      const p = byProviderMap.get(c.provider);
      p.calls += 1;
      p.tokens += c.tokens;
      p.cost += c.cost;
      if (c.status === "failed") p.failures += 1;
    }
    const byProvider = [...byProviderMap.values()]
      .map((p) => ({ ...p, cost: Math.round(p.cost * 1e6) / 1e6 }))
      .sort((a, b) => b.calls - a.calls);

    // Per-model breakdown (LLM only — ApiCallLog has no model concept).
    // Built from `merged` (stub rows already excluded), not the raw llmLogs.
    const byModelMap = new Map();
    for (const c of merged) {
      if (c.source !== "llm") continue;
      const key = c.model || "unknown";
      if (!byModelMap.has(key)) {
        byModelMap.set(key, { model: key, provider: c.provider, calls: 0, tokens: 0, cost: 0, failures: 0 });
      }
      const m = byModelMap.get(key);
      m.calls += 1;
      m.tokens += c.tokens;
      m.cost += c.cost;
      if (c.status === "failed") m.failures += 1;
    }
    const byModel = [...byModelMap.values()]
      .map((m) => ({ ...m, cost: Math.round(m.cost * 1e6) / 1e6 }))
      .sort((a, b) => b.calls - a.calls);

    // Recent failures — the "if failure then why" surface, newest first.
    const recentFailures = merged
      .filter((c) => c.status === "failed")
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 25)
      .map((c) => ({
        provider: c.provider,
        model: c.model,
        source: c.source,
        errorMessage: c.errorMessage,
        createdAt: c.createdAt,
      }));

    const totals = merged.reduce(
      (acc, c) => {
        acc.calls += 1;
        acc.tokens += c.tokens;
        acc.cost += c.cost;
        if (c.status === "failed") acc.failures += 1;
        else acc.success += 1;
        return acc;
      },
      { calls: 0, success: 0, failures: 0, tokens: 0, cost: 0 },
    );
    totals.cost = Math.round(totals.cost * 1e6) / 1e6;

    res.json({
      days,
      since: since.toISOString(),
      until: until ? until.toISOString() : null,
      totals,
      byDay,
      byProvider,
      byModel,
      recentFailures,
    });
  } catch (e) {
    console.error("[super-admin-api-analytics] GET /overview failed:", e.message);
    res.status(500).json({ error: "Failed to load API analytics" });
  }
});

// ── Filter option lists ──────────────────────────────────────────────────
// Distinct provider/model values across ALL history (not scoped to the
// overview's ?days window) so the filter dropdowns stay stable and don't
// shrink to just whatever the current window happens to contain.

router.get("/filters", async (req, res) => {
  try {
    // stub:false — a provider/model with ONLY stub-mode rows (no API key ever
    // configured, llmRouter.js's synthetic fallback) shouldn't appear as a
    // filterable option; it's never actually been called for real.
    // ?provider= optionally scopes the model list to that provider's models
    // only, so picking "openai" never leaves a gemini model selected in the
    // second dropdown (which would silently return zero results).
    const { provider } = req.query;
    const modelWhere = { stub: false };
    if (provider) modelWhere.provider = provider;

    const [llmProviders, apiProviders, models] = await Promise.all([
      prisma.llmCallLog.findMany({ where: { stub: false }, distinct: ["provider"], select: { provider: true } }),
      prisma.apiCallLog.findMany({ distinct: ["provider"], select: { provider: true } }),
      prisma.llmCallLog.findMany({ where: modelWhere, distinct: ["model"], select: { model: true } }),
    ]);
    const providers = [...new Set([...llmProviders, ...apiProviders].map((r) => r.provider))].sort();
    const modelList = [...new Set(models.map((r) => r.model))].sort();
    res.json({ providers, models: modelList });
  } catch (e) {
    console.error("[super-admin-api-analytics] GET /filters failed:", e.message);
    res.status(500).json({ error: "Failed to load filter options" });
  }
});

// ── Individual call browsing ────────────────────────────────────────────

router.get("/calls", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const { provider, model, status, search, from, to } = req.query;

    const where = {};
    if (provider) where.provider = provider;
    if (model) where.model = model;
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) {
        const fromDate = new Date(from);
        if (Number.isNaN(fromDate.getTime())) return res.status(400).json({ error: "invalid `from` date", code: "INVALID_DATE" });
        where.createdAt.gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        if (Number.isNaN(toDate.getTime())) return res.status(400).json({ error: "invalid `to` date", code: "INVALID_DATE" });
        // Bump to end-of-UTC-day (see /overview's matching comment) so
        // ?to=2026-07-13 includes ALL of that day's rows, not just up to
        // its opening midnight.
        toDate.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }
    if (search) {
      where.OR = [
        { model: { contains: search } },
        { task: { contains: search } },
        { errorMessage: { contains: search } },
      ];
    }

    // LlmCallLog and ApiCallLog are separate tables with no shared PK space,
    // so true cross-table pagination would require a UNION the ORM doesn't
    // expose cleanly. Pragmatic approach: fetch both filtered sets bounded
    // to a sane cap, merge + sort by createdAt, then paginate in memory.
    // Acceptable at this data volume (observability logs, not transactional
    // data) — same tradeoff the cron logs endpoint doesn't have to make
    // because it only reads one table.
    const FETCH_CAP = 2000;
    const apiWhere = { ...where };
    // ApiCallLog has no `model`/`task` columns — a ?model= filter should
    // exclude ApiCallLog entirely (it's an LLM-only concept here), and a
    // search's OR narrows to the fields ApiCallLog actually has.
    delete apiWhere.model;
    if (model) apiWhere.id = -1; // unsatisfiable — excludes all ApiCallLog rows
    if (apiWhere.OR) {
      apiWhere.OR = [
        { endpoint: { contains: search } },
        { errorMessage: { contains: search } },
      ];
    }

    const [llmRows, apiRows] = await Promise.all([
      prisma.llmCallLog.findMany({ where, orderBy: { createdAt: "desc" }, take: FETCH_CAP }),
      prisma.apiCallLog.findMany({ where: apiWhere, orderBy: { createdAt: "desc" }, take: FETCH_CAP }),
    ]);

    const merged = [
      ...llmRows.map((l) => ({
        id: `llm-${l.id}`,
        source: "llm",
        provider: l.provider,
        model: l.model,
        task: l.task,
        status: l.status,
        promptTokens: l.promptTokens,
        completionTokens: l.completionTokens,
        totalTokens: l.totalTokens,
        cost: toNum(l.costEstimate),
        stub: l.stub,
        errorMessage: l.errorMessage,
        createdAt: l.createdAt,
      })),
      ...apiRows.map((a) => ({
        id: `api-${a.id}`,
        source: "api",
        provider: a.provider,
        model: a.endpoint,
        task: null,
        status: a.status,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: toNum(a.costEstimate),
        stub: false,
        errorMessage: a.errorMessage,
        createdAt: a.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = merged.length;
    const startIdx = (page - 1) * pageSize;
    const pageRows = merged.slice(startIdx, startIdx + pageSize);

    res.json({ calls: pageRows, total, page, pageSize, truncated: total >= FETCH_CAP * 2 });
  } catch (e) {
    console.error("[super-admin-api-analytics] GET /calls failed:", e.message);
    res.status(500).json({ error: "Failed to list API calls" });
  }
});

// ── Settings (retention) ────────────────────────────────────────────────

router.get("/settings/log-retention", async (req, res) => {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: RETENTION_SETTING_KEY } });
    const retainDays = setting ? parseInt(setting.value, 10) : DEFAULT_RETENTION_DAYS;
    res.json({ retainDays: Number.isFinite(retainDays) && retainDays > 0 ? retainDays : DEFAULT_RETENTION_DAYS });
  } catch (e) {
    console.error("[super-admin-api-analytics] GET /settings/log-retention failed:", e.message);
    res.status(500).json({ error: "Failed to load retention setting" });
  }
});

router.put("/settings/log-retention", async (req, res) => {
  try {
    const { retainDays } = req.body || {};
    const days = parseInt(retainDays, 10);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: "retainDays must be between 1 and 3650", code: "INVALID_RETENTION" });
    }
    await prisma.systemSetting.upsert({
      where: { key: RETENTION_SETTING_KEY },
      update: { value: String(days), updatedBy: (req.superAdmin && req.superAdmin.username) || null },
      create: {
        key: RETENTION_SETTING_KEY,
        value: String(days),
        category: "api-analytics",
        updatedBy: (req.superAdmin && req.superAdmin.username) || null,
      },
    });
    res.json({ retainDays: days });
  } catch (e) {
    console.error("[super-admin-api-analytics] PUT /settings/log-retention failed:", e.message);
    res.status(500).json({ error: "Failed to update retention setting" });
  }
});

module.exports = router;
