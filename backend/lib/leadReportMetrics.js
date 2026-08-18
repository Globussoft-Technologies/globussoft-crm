/**
 * Pure metric helpers for the generic-vertical Lead Reports cluster
 * (`backend/routes/lead_reports.js`).
 *
 * Everything in here is deliberately side-effect free — no Prisma, no clock
 * reads that aren't passed in — so `backend/test/lib/leadReportMetrics.test.js`
 * can exercise the bucketing / classification / rate maths without a DB.
 *
 * Covers the report surfaces:
 *   - Daily / Weekly / Monthly productivity  → bucketKey / buildBuckets
 *   - Lead quality performance               → scoreBand / normalizeCallStatus
 *   - Follow-up tracking                     → followUpState
 *   - Lead source analysis                   → rate()
 *   - Funnel builder (lead stage)            → DEFAULT_LEAD_STAGES / matchesStage
 *   - Meetings & site visits                 → isVisitTask / normalizeVisitOutcome
 *   - Visit-done-not-booked                  → isBookedOutcome
 */

// ─── Call-status vocabulary ──────────────────────────────────────────
// Mirrors the CALL_STATUS map rendered by frontend/src/pages/Leads.jsx so the
// report buckets and the Leads grid agree on what "Qualified" means. Legacy
// "hot"/"cold" rows are folded forward exactly the same way the UI folds them.
const CALL_STATUS = {
  YET_TO_CALL: "yet_to_call",
  CONNECTED: "connected",
  DNP: "dnp",
  QUALIFIED: "qualified",
  JUNK: "junk",
};

function normalizeCallStatus(raw) {
  if (!raw) return CALL_STATUS.YET_TO_CALL;
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, "_");
  if (s === "hot" || s.includes("qualified")) return CALL_STATUS.QUALIFIED;
  if (s === "cold" || s.includes("junk")) return CALL_STATUS.JUNK;
  if (s.includes("dnp") || s.includes("not_picked") || s.includes("no_answer"))
    return CALL_STATUS.DNP;
  if (s.includes("connected") || s.includes("in_progress") || s.includes("calling"))
    return CALL_STATUS.CONNECTED;
  return CALL_STATUS.YET_TO_CALL;
}

// ─── Generic maths ───────────────────────────────────────────────────

/** Percentage with one decimal place. Returns 0 (never NaN/Infinity) on a zero denominator. */
function rate(numerator, denominator) {
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((Number(numerator) / d) * 1000) / 10;
}

/** Round to `places` decimals without the float-tail noise of toFixed→Number. */
function round(value, places = 2) {
  const f = Math.pow(10, places);
  return Math.round((Number(value) || 0) * f) / f;
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return round((b - a) / 86400000, 1);
}

// ─── Period bucketing (daily / weekly / monthly productivity) ────────

const PERIODS = ["daily", "weekly", "monthly"];

function normalizePeriod(raw) {
  const p = String(raw || "").toLowerCase().trim();
  return PERIODS.includes(p) ? p : "daily";
}

/** UTC start-of-day. Bucketing is UTC-stable so a report doesn't re-shard when the server TZ moves. */
function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Monday-anchored ISO week start (UTC). */
function startOfUtcWeek(date) {
  const d = startOfUtcDay(date);
  const dow = d.getUTCDay(); // 0=Sun
  const delta = dow === 0 ? 6 : dow - 1;
  return new Date(d.getTime() - delta * 86400000);
}

function startOfUtcMonth(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Canonical bucket key for a timestamp at the given period.
 *   daily   → "2026-08-17"
 *   weekly  → "2026-W34" (ISO-ish: Monday-anchored, labelled by the week start)
 *   monthly → "2026-08"
 * Returns null for an unparseable date so callers can skip the row rather
 * than silently landing it in an "Invalid Date" bucket.
 */
function bucketKey(date, period = "daily") {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = normalizePeriod(period);
  if (p === "monthly") {
    const m = startOfUtcMonth(d);
    return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (p === "weekly") {
    const w = startOfUtcWeek(d);
    return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}-${String(w.getUTCDate()).padStart(2, "0")}`;
  }
  const s = startOfUtcDay(d);
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}-${String(s.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Ordered, gap-free bucket skeleton spanning [from, to] at the given period.
 * Reports render zero rows rather than dropping empty days — an empty Tuesday
 * is a real signal for a productivity report, not a row to hide.
 */
function buildBuckets(from, to, period = "daily", { maxBuckets = 400 } = {}) {
  const p = normalizePeriod(period);
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  const out = [];
  let cursor =
    p === "monthly" ? startOfUtcMonth(start) : p === "weekly" ? startOfUtcWeek(start) : startOfUtcDay(start);

  while (cursor <= end && out.length < maxBuckets) {
    out.push({ key: bucketKey(cursor, p), start: new Date(cursor) });
    if (p === "monthly") {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    } else if (p === "weekly") {
      cursor = new Date(cursor.getTime() + 7 * 86400000);
    } else {
      cursor = new Date(cursor.getTime() + 86400000);
    }
  }
  return out;
}

/** Human label for a bucket key. Weekly keys read as "Week of 11 Aug". */
function bucketLabel(key, period = "daily") {
  const p = normalizePeriod(period);
  if (!key) return "";
  if (p === "monthly") {
    const [y, m] = key.split("-");
    const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
    return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${y}`;
  }
  const [y, m, dd] = key.split("-");
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, Number(dd)));
  const short = `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
  return p === "weekly" ? `Week of ${short}` : short;
}

// ─── Lead quality ────────────────────────────────────────────────────

const SCORE_BANDS = [
  { band: "0-20", min: 0, max: 20 },
  { band: "21-40", min: 21, max: 40 },
  { band: "41-60", min: 41, max: 60 },
  { band: "61-80", min: 61, max: 80 },
  { band: "81-100", min: 81, max: 100 },
];

/** Band label for a lead score. Out-of-range / non-numeric scores clamp into the end bands. */
function scoreBand(score) {
  const n = Number(score);
  const safe = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  const hit = SCORE_BANDS.find((b) => safe >= b.min && safe <= b.max);
  return hit ? hit.band : SCORE_BANDS[0].band;
}

// ─── Funnel builder — lead stages ────────────────────────────────────
//
// Stages are tenant-configurable (persisted in TenantSetting under
// `leads.funnel.stages`) so an operator can model their own lead journey
// without a schema migration. Each stage matches a Contact on any of:
//   statuses[]     → Contact.status      (case-insensitive)
//   callStatuses[] → Contact.callifiedLeadStatus, normalised
//   minScore       → Contact.aiScore >= n
//
// Resolution rule: a contact lands in the LAST stage it matches, so stages
// must be declared shallow → deep with drop-out buckets at the end. Two
// signals routinely disagree on one row and last-match-wins is what settles
// them the way an operator expects:
//   - {status: Lead, call: junk} → "junk", not "new". A junked lead still
//     carries status=Lead forever; the call disposition is the newer signal.
//   - {status: Customer, call: connected} → "converted", not "contacted". A
//     converted customer's stale call status is history.
//
// `leak: true` marks a drop-out bucket (Junk / DNP / Churned) reported beside
// the funnel rather than inside its conversion ladder.

const DEFAULT_LEAD_STAGES = [
  { key: "new", label: "New", statuses: ["lead"], callStatuses: ["yet_to_call"] },
  { key: "contacted", label: "Contacted", callStatuses: ["connected"] },
  { key: "qualified", label: "Qualified", callStatuses: ["qualified"] },
  { key: "prospect", label: "Prospect", statuses: ["prospect"] },
  { key: "converted", label: "Converted", statuses: ["customer"] },
  { key: "junk", label: "Junk", callStatuses: ["junk"], leak: true },
  { key: "dnp", label: "DNP / Unreachable", callStatuses: ["dnp"], leak: true },
  { key: "churned", label: "Churned", statuses: ["churned"], leak: true },
];

/** Does this contact match the stage definition? */
function matchesStage(contact, stage) {
  if (!contact || !stage) return false;
  const status = String(contact.status || "").toLowerCase().trim();
  const call = normalizeCallStatus(contact.callifiedLeadStatus);

  if (Array.isArray(stage.statuses) && stage.statuses.length) {
    if (stage.statuses.some((s) => String(s).toLowerCase().trim() === status)) return true;
  }
  if (Array.isArray(stage.callStatuses) && stage.callStatuses.length) {
    if (stage.callStatuses.some((s) => normalizeCallStatus(s) === call)) return true;
  }
  if (Number.isFinite(Number(stage.minScore))) {
    if (Number(contact.aiScore || 0) >= Number(stage.minScore)) return true;
  }
  return false;
}

/**
 * Resolve a contact to a single stage key — the LAST stage in the declared
 * order that it matches (see the ordering note above), or null when it matches
 * nothing so the caller can report it as unclassified rather than silently
 * inflating the top of the funnel.
 */
function resolveStage(contact, stages = DEFAULT_LEAD_STAGES) {
  const list = Array.isArray(stages) && stages.length ? stages : DEFAULT_LEAD_STAGES;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (matchesStage(contact, list[i])) return list[i].key;
  }
  return null;
}

/**
 * Validate + normalise an operator-supplied stage list before it is persisted.
 * Throws an Error with a `.code` the route turns into a 400 — a malformed
 * stage config must never land in TenantSetting and break every later read.
 */
function sanitizeStages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    const err = new Error("stages must be a non-empty array");
    err.code = "INVALID_STAGES";
    throw err;
  }
  if (input.length > 20) {
    const err = new Error("A lead funnel supports at most 20 stages");
    err.code = "TOO_MANY_STAGES";
    throw err;
  }

  const seen = new Set();
  const out = input.map((raw, i) => {
    const key = String(raw?.key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const label = String(raw?.label || "").trim();
    if (!key || !label) {
      const err = new Error(`Stage ${i + 1} needs both a key and a label`);
      err.code = "INVALID_STAGE";
      throw err;
    }
    if (seen.has(key)) {
      const err = new Error(`Duplicate stage key "${key}"`);
      err.code = "DUPLICATE_STAGE_KEY";
      throw err;
    }
    seen.add(key);

    const strArray = (v) =>
      Array.isArray(v)
        ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
        : [];

    const stage = {
      key,
      label: label.slice(0, 60),
      statuses: strArray(raw.statuses),
      callStatuses: strArray(raw.callStatuses),
      leak: Boolean(raw.leak),
    };
    if (Number.isFinite(Number(raw.minScore))) {
      stage.minScore = Math.max(0, Math.min(100, Math.round(Number(raw.minScore))));
    }
    if (!stage.statuses.length && !stage.callStatuses.length && stage.minScore === undefined) {
      const err = new Error(`Stage "${label}" has no match rule (statuses, call statuses, or minimum score)`);
      err.code = "EMPTY_STAGE_RULE";
      throw err;
    }
    return stage;
  });

  if (out.every((s) => s.leak)) {
    const err = new Error("At least one stage must be a funnel stage (not a drop-out bucket)");
    err.code = "NO_FLOW_STAGE";
    throw err;
  }
  return out;
}

// ─── Meetings & site visits ──────────────────────────────────────────
//
// A "visit" is a Task carrying `type` = Meeting / Site Visit. Tasks created
// before that column existed carry type=null, so we fall back to a title/notes
// keyword probe — that back-compat path is what makes the report useful on day
// one instead of only for tasks created after this ships.

const VISIT_TYPES = ["meeting", "site visit", "visit"];
const VISIT_TITLE_RE = /\b(site\s*visit|site-visit|visit|meeting|demo|walk[\s-]?in|viewing)\b/i;
// Narrower probe: phrases that mean a physical site visit rather than a
// generic meeting. Used only to label untyped rows.
const SITE_VISIT_TITLE_RE = /\b(site\s*visit|site-visit|walk[\s-]?in|viewing)\b/i;

function isVisitTask(task) {
  if (!task) return false;
  const type = String(task.type || "").toLowerCase().trim();
  if (type) return VISIT_TYPES.includes(type);
  // Legacy rows (type IS NULL): probe the title only. Notes are freeform and
  // routinely mention "meeting" in passing, which would over-collect.
  return VISIT_TITLE_RE.test(String(task.title || ""));
}

/**
 * Display label + provenance for a visit row.
 *
 * A row whose Type is set is reported verbatim. A row matched only on its
 * title gets a label guessed from that title — and `source: "inferred"` so the
 * UI can say so. Labelling a guess as though it were set is how a task called
 * "Site visit" ends up displayed as "Meeting", which reads like a bug to the
 * operator who typed the title.
 */
function resolveVisitType(task) {
  const explicit = String(task?.type || "").trim();
  if (explicit) return { label: explicit, source: "set" };
  const title = String(task?.title || "");
  return {
    label: SITE_VISIT_TITLE_RE.test(title) ? "Site Visit" : "Meeting",
    source: "inferred",
  };
}

const VISIT_OUTCOMES = [
  "booked",
  "interested",
  "not_interested",
  "reschedule",
  "no_show",
  "pending",
];

function normalizeVisitOutcome(raw) {
  if (!raw) return "pending";
  const s = String(raw).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (s.includes("book") || s.includes("won") || s.includes("closed")) return "booked";
  if (s.includes("not_interest") || s.includes("lost") || s.includes("reject")) return "not_interested";
  if (s.includes("interest")) return "interested";
  if (s.includes("reschedul") || s.includes("postpon")) return "reschedule";
  if (s.includes("no_show") || s.includes("noshow") || s.includes("absent")) return "no_show";
  return VISIT_OUTCOMES.includes(s) ? s : "pending";
}

function isBookedOutcome(raw) {
  return normalizeVisitOutcome(raw) === "booked";
}

// ─── Follow-up tracking ──────────────────────────────────────────────

/**
 * Classify one follow-up task relative to `now`.
 *   completed | overdue | due_today | upcoming | undated
 */
function followUpState(task, now = new Date()) {
  if (!task) return "undated";
  if (String(task.status || "").toLowerCase() === "completed") return "completed";
  if (!task.dueDate) return "undated";
  const due = new Date(task.dueDate);
  if (Number.isNaN(due.getTime())) return "undated";

  const today = startOfUtcDay(now).getTime();
  const dueDay = startOfUtcDay(due).getTime();
  if (dueDay < today) return "overdue";
  if (dueDay === today) return "due_today";
  return "upcoming";
}

module.exports = {
  CALL_STATUS,
  DEFAULT_LEAD_STAGES,
  PERIODS,
  SCORE_BANDS,
  VISIT_OUTCOMES,
  bucketKey,
  bucketLabel,
  buildBuckets,
  daysBetween,
  followUpState,
  isBookedOutcome,
  isVisitTask,
  matchesStage,
  normalizeCallStatus,
  normalizePeriod,
  normalizeVisitOutcome,
  rate,
  resolveStage,
  resolveVisitType,
  round,
  sanitizeStages,
  scoreBand,
  startOfUtcDay,
  startOfUtcMonth,
  startOfUtcWeek,
};
