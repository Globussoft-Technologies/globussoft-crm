/**
 * workflowSchedule.js — time-based ("scheduled") workflow triggers.
 *
 * This is the half of the Freshsales workflow feature that was entirely
 * absent. Every trigger the CRM had was record-event driven: something had to
 * happen to a record for a rule to fire. There was no way to express
 *   "3 days BEFORE a deal's expected close date, remind the owner"
 *   "on a contact's birthday, send the greeting"
 *   "every Monday at 9am, chase every deal that has gone quiet"
 * because nothing was watching the clock.
 *
 * Two modes, both stored as JSON in AutomationRule.scheduleConfig:
 *
 *   date_field — anchored to a DateTime column on a record.
 *     { mode:"date_field", entity:"deal", field:"expectedClose",
 *       offsetDays:-3, timeOfDay:"09:00", annual:false, lookbackDays:2 }
 *     Fires once per record per occurrence. `annual:true` matches month+day
 *     only, which is what birthDate / anniversary need — otherwise a birthday
 *     rule would fire exactly once, in the year the contact was born.
 *
 *   recurring — a wall-clock cadence over every record matching the rule's
 *     conditions.
 *     { mode:"recurring", entity:"deal", frequency:"weekly",
 *       timeOfDay:"09:00", dayOfWeek:1, dayOfMonth:1, maxRecords:500 }
 *
 * Everything here is pure date arithmetic — the cron that actually queries and
 * fires lives in cron/workflowScheduler.js. Kept separate so the next-run
 * maths is unit-testable without a database.
 *
 * TIMEZONE: all arithmetic runs in the server's local timezone, matching every
 * other cron in this codebase (appointmentReminders, webCheckin, …). A
 * per-tenant timezone is a real gap but a cross-cutting one — introducing it
 * here alone would make workflow times disagree with reminder times.
 */

"use strict";

const SCHEDULE_ENTITIES = {
  contact: {
    model: "contact",
    idKey: "contactId",
    labelField: "name",
    softDelete: true,
    dateFields: [
      { value: "birthDate", label: "Birthday", annualDefault: true },
      { value: "anniversary", label: "Anniversary", annualDefault: true },
      { value: "createdAt", label: "Created date" },
      { value: "firstResponseDueAt", label: "First response due" },
      { value: "lastEnrichedAt", label: "Last enriched" },
    ],
  },
  deal: {
    model: "deal",
    idKey: "dealId",
    labelField: "title",
    softDelete: true,
    dateFields: [
      { value: "expectedClose", label: "Expected close date" },
      { value: "createdAt", label: "Created date" },
    ],
  },
  task: {
    model: "task",
    idKey: "taskId",
    labelField: "title",
    softDelete: true,
    dateFields: [
      { value: "dueDate", label: "Due date" },
      { value: "createdAt", label: "Created date" },
    ],
  },
  ticket: {
    model: "ticket",
    idKey: "ticketId",
    labelField: "subject",
    softDelete: false,
    dateFields: [
      { value: "slaResponseDue", label: "SLA response due" },
      { value: "slaResolveDue", label: "SLA resolution due" },
      { value: "createdAt", label: "Created date" },
    ],
  },
};

const FREQUENCIES = ["hourly", "daily", "weekly", "monthly"];

/** Trigger values the builder offers for scheduled rules. */
const SCHEDULE_TRIGGERS = [
  {
    value: "schedule.date_field",
    label: "Before / after a date field",
    description: "Runs once per record, a set number of days either side of a date on that record (expected close, birthday, due date…).",
  },
  {
    value: "schedule.recurring",
    label: "On a recurring schedule",
    description: "Runs hourly, daily, weekly, or monthly over every record that matches the conditions.",
  },
];

const SCHEDULE_TRIGGER_VALUES = SCHEDULE_TRIGGERS.map((t) => t.value);

function isScheduleTrigger(triggerType) {
  return SCHEDULE_TRIGGER_VALUES.includes(String(triggerType || ""));
}

/** "09:30" → {hours:9, minutes:30}; anything unparseable → midnight. */
function parseTimeOfDay(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw || "").trim());
  if (!match) return { hours: 0, minutes: 0 };
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return { hours, minutes };
}

function atTimeOfDay(date, timeOfDay) {
  const { hours, minutes } = parseTimeOfDay(timeOfDay);
  const out = new Date(date);
  out.setHours(hours, minutes, 0, 0);
  return out;
}

/**
 * When should a rule fire for a record whose anchor date is `anchor`?
 *
 * Returns the wall-clock instant, or null when the anchor is unusable. For
 * `annual` fields the year is projected onto the current year — and if that
 * projection already passed, onto the next one, so a January birthday
 * evaluated in December resolves forward rather than firing a year late.
 */
function occurrenceFor(anchor, config, now = new Date()) {
  // `new Date(null)` is the Unix epoch, NOT an Invalid Date, so a null anchor
  // column would otherwise resolve to 1970-01-01 and be reported as an
  // occurrence rather than as "this record has no anchor date". Reject the
  // empty cases explicitly before constructing.
  if (anchor === null || anchor === undefined || anchor === "") return null;
  const date = anchor instanceof Date ? anchor : new Date(anchor);
  if (Number.isNaN(date.getTime())) return null;

  const offsetDays = Number(config.offsetDays) || 0;

  if (config.annual) {
    const build = (year) => {
      const projected = new Date(date);
      projected.setFullYear(year);
      // Feb 29 on a non-leap year rolls to Mar 1 via setFullYear; that is the
      // conventional choice and keeps the rule firing every year.
      projected.setDate(projected.getDate() + offsetDays);
      return atTimeOfDay(projected, config.timeOfDay);
    };
    const thisYear = build(now.getFullYear());
    // Give the current year's occurrence a grace window so a cron tick a few
    // hours late still fires it instead of skipping to next year.
    const lookbackMs = (Number(config.lookbackDays) || 1) * 24 * 60 * 60 * 1000;
    if (thisYear.getTime() >= now.getTime() - lookbackMs) return thisYear;
    return build(now.getFullYear() + 1);
  }

  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + offsetDays);
  return atTimeOfDay(shifted, config.timeOfDay);
}

/**
 * The window of anchor dates whose occurrence lands in [now-lookback, now].
 * Used to build a NARROW prisma `where` instead of scanning every record —
 * without this a daily rule on a 200k-contact tenant would read the whole
 * table every tick.
 *
 * Returns null for annual fields, where a date range on the stored column is
 * meaningless (a 1987 birthDate must still match today) — those are filtered
 * in JS against a month/day-bounded query instead.
 */
function anchorWindow(config, now = new Date()) {
  if (config.annual) return null;
  const offsetDays = Number(config.offsetDays) || 0;
  const lookbackDays = Number.isFinite(Number(config.lookbackDays)) ? Number(config.lookbackDays) : 2;

  // occurrence = anchor + offset  ⇒  anchor = occurrence - offset
  const latestOccurrence = now;
  const earliestOccurrence = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const toAnchor = (occurrence) => {
    const out = new Date(occurrence);
    out.setDate(out.getDate() - offsetDays);
    return out;
  };
  const lo = toAnchor(earliestOccurrence);
  const hi = toAnchor(latestOccurrence);
  // Widen by a day on each side: timeOfDay shifts the occurrence within its
  // day, so a strict boundary can drop a record that is genuinely due.
  lo.setDate(lo.getDate() - 1);
  hi.setDate(hi.getDate() + 1);
  return { gte: lo, lte: hi };
}

/**
 * Next wall-clock run for a `recurring` rule, strictly after `from`.
 * Persisted to AutomationRule.nextScheduledAt so the drainer selects on an
 * indexed column rather than recomputing every rule every minute.
 */
function nextRecurringRun(config, from = new Date()) {
  const frequency = String(config.frequency || "daily").toLowerCase();
  const next = new Date(from);

  if (frequency === "hourly") {
    const { minutes } = parseTimeOfDay(config.timeOfDay);
    next.setMinutes(minutes, 0, 0);
    if (next <= from) next.setHours(next.getHours() + 1);
    return next;
  }

  if (frequency === "weekly") {
    const target = Number.isFinite(Number(config.dayOfWeek)) ? Number(config.dayOfWeek) : 1; // Mon
    let candidate = atTimeOfDay(from, config.timeOfDay);
    const delta = (target - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + delta);
    if (candidate <= from) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }

  if (frequency === "monthly") {
    const target = Math.min(28, Math.max(1, Number(config.dayOfMonth) || 1));
    // Capped at 28 deliberately: a rule set to the 31st must not silently skip
    // February. Freshsales solves this with "last day of month"; capping is
    // the honest simplification, and the builder says so.
    let candidate = atTimeOfDay(from, config.timeOfDay);
    candidate.setDate(target);
    if (candidate <= from) {
      candidate = atTimeOfDay(from, config.timeOfDay);
      candidate.setMonth(candidate.getMonth() + 1, target);
    }
    return candidate;
  }

  // daily
  const candidate = atTimeOfDay(from, config.timeOfDay);
  if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * Validate a scheduleConfig from the builder.
 * Returns {ok:true, value:<canonical object>} or {ok:false, error, code}.
 */
function validateScheduleConfig(raw, triggerType) {
  if (!isScheduleTrigger(triggerType)) {
    // Event-driven rules must not carry a schedule — silently ignoring one
    // would let a half-converted rule look scheduled in the UI and never run.
    if (raw != null && raw !== "" && Object.keys(typeof raw === "object" ? raw : {}).length > 0) {
      return { ok: false, error: "scheduleConfig is only valid for schedule.* triggers", code: "INVALID_SCHEDULE" };
    }
    return { ok: true, value: null };
  }

  let config = raw;
  if (typeof raw === "string") {
    try { config = JSON.parse(raw); } catch (_e) {
      return { ok: false, error: "scheduleConfig is not valid JSON", code: "INVALID_SCHEDULE" };
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, error: "scheduleConfig is required for a scheduled workflow", code: "INVALID_SCHEDULE" };
  }

  const entity = String(config.entity || "").toLowerCase();
  const entityConfig = SCHEDULE_ENTITIES[entity];
  if (!entityConfig) {
    return { ok: false, error: `scheduleConfig.entity must be one of: ${Object.keys(SCHEDULE_ENTITIES).join(", ")}`, code: "INVALID_SCHEDULE" };
  }
  if (config.timeOfDay && !/^\d{1,2}:\d{2}$/.test(String(config.timeOfDay))) {
    return { ok: false, error: "scheduleConfig.timeOfDay must be HH:MM", code: "INVALID_SCHEDULE" };
  }

  const mode = triggerType === "schedule.date_field" ? "date_field" : "recurring";

  if (mode === "date_field") {
    const field = String(config.field || "");
    const known = entityConfig.dateFields.find((f) => f.value === field);
    if (!known) {
      return {
        ok: false,
        error: `scheduleConfig.field must be one of: ${entityConfig.dateFields.map((f) => f.value).join(", ")}`,
        code: "INVALID_SCHEDULE",
      };
    }
    const offsetDays = Number(config.offsetDays || 0);
    if (!Number.isInteger(offsetDays) || Math.abs(offsetDays) > 365) {
      return { ok: false, error: "scheduleConfig.offsetDays must be a whole number between -365 and 365", code: "INVALID_SCHEDULE" };
    }
    const lookbackDays = Number.isFinite(Number(config.lookbackDays)) ? Number(config.lookbackDays) : 2;
    if (lookbackDays < 0 || lookbackDays > 30) {
      return { ok: false, error: "scheduleConfig.lookbackDays must be between 0 and 30", code: "INVALID_SCHEDULE" };
    }
    return {
      ok: true,
      value: {
        mode, entity, field, offsetDays, lookbackDays,
        timeOfDay: config.timeOfDay || "09:00",
        annual: config.annual !== undefined ? !!config.annual : !!known.annualDefault,
        maxRecords: clampMaxRecords(config.maxRecords),
      },
    };
  }

  const frequency = String(config.frequency || "daily").toLowerCase();
  if (!FREQUENCIES.includes(frequency)) {
    return { ok: false, error: `scheduleConfig.frequency must be one of: ${FREQUENCIES.join(", ")}`, code: "INVALID_SCHEDULE" };
  }
  const dayOfWeek = Number(config.dayOfWeek);
  if (frequency === "weekly" && (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) {
    return { ok: false, error: "scheduleConfig.dayOfWeek must be 0 (Sunday) to 6 (Saturday)", code: "INVALID_SCHEDULE" };
  }
  const dayOfMonth = Number(config.dayOfMonth);
  if (frequency === "monthly" && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
    return { ok: false, error: "scheduleConfig.dayOfMonth must be 1-28 (capped so the rule never skips February)", code: "INVALID_SCHEDULE" };
  }
  return {
    ok: true,
    value: {
      mode, entity, frequency,
      timeOfDay: config.timeOfDay || "09:00",
      ...(frequency === "weekly" ? { dayOfWeek } : {}),
      ...(frequency === "monthly" ? { dayOfMonth } : {}),
      maxRecords: clampMaxRecords(config.maxRecords),
    },
  };
}

/**
 * Hard ceiling on how many records one scheduled tick may touch.
 *
 * A recurring rule with a loose condition on a large tenant is the one place
 * this feature can generate unbounded work — 200k contacts × send_email is a
 * self-inflicted outage. The cron logs when it truncates so the cap is never
 * silent (see the "no silent caps" note in cron/workflowScheduler.js).
 */
function clampMaxRecords(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 500;
  return Math.min(5000, Math.floor(value));
}

/** Stable dedupe key: one fire per rule, per record, per occurrence. */
function occurrenceRecordKey(idKey, recordId, occurrence) {
  const stamp = occurrence instanceof Date && !Number.isNaN(occurrence.getTime())
    ? occurrence.toISOString().slice(0, 10)
    : "na";
  return `${idKey}:${recordId}@${stamp}`;
}

module.exports = {
  SCHEDULE_ENTITIES,
  SCHEDULE_TRIGGERS,
  SCHEDULE_TRIGGER_VALUES,
  FREQUENCIES,
  isScheduleTrigger,
  parseTimeOfDay,
  atTimeOfDay,
  occurrenceFor,
  anchorWindow,
  nextRecurringRun,
  validateScheduleConfig,
  occurrenceRecordKey,
  clampMaxRecords,
};
