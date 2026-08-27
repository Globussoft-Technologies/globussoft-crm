/**
 * workflowScheduler.js — the clock side of the workflow engine.
 *
 * Everything the event-driven engine in lib/eventBus.js cannot do, because
 * nothing happened to a record:
 *
 *   1. `schedule.date_field` rules — "3 days before a deal's expected close",
 *      "on a contact's birthday", "2 days after a task's due date".
 *   2. `schedule.recurring` rules — "every Monday at 9am, over every deal
 *      matching these conditions".
 *   3. The `wait` action's resume queue. A wait parks the remaining actions in
 *      WorkflowScheduledAction; this drains them when runAt arrives.
 *   4. `invoice.overdue` — a trigger the builder advertised for months with
 *      zero emit sites anywhere in the repo. Rules built on it never ran.
 *
 * Runs every 15 minutes. That bounds worst-case lateness for an hourly
 * recurring rule while keeping the scan cheap; the dedupe key is what makes
 * the overlap between ticks harmless.
 *
 * ── No silent caps ───────────────────────────────────────────────────
 * A recurring rule with a loose condition is the one place this feature can
 * generate unbounded work — 200k contacts times send_email is a self-inflicted
 * outage. Each rule carries a `maxRecords` ceiling (default 500, hard cap
 * 5000). When a tick truncates, it LOGS the truncation and writes a SKIPPED
 * WorkflowExecution row, so a capped run can never be mistaken for a complete
 * one.
 */

"use strict";

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const {
  SCHEDULE_ENTITIES,
  isScheduleTrigger,
  occurrenceFor,
  anchorWindow,
  nextRecurringRun,
  occurrenceRecordKey,
} = require("../lib/workflowSchedule");

const DAY_MS = 24 * 60 * 60 * 1000;

// A deferred action that has failed this many times is abandoned. Without a
// ceiling a permanently-broken action (dead webhook, deleted contact) would be
// retried by every tick forever.
const MAX_DEFERRED_ATTEMPTS = 3;

// Identifies this process in the pessimistic lock, mirroring the
// SequenceEnrollment lockedBy convention.
const WORKER_ID = `wf-sched-${process.pid}`;

// A lock older than this is treated as abandoned (process died mid-action).
const LOCK_STALE_MS = 10 * 60 * 1000;

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// ── 1. Scheduled rules ────────────────────────────────────────────────

/**
 * Build the Prisma `where` that narrows a scheduled rule's candidate records.
 *
 * For a dated (non-annual) anchor this is a real range on the anchor column,
 * so the scan stays indexed. For an annual anchor (birthday, anniversary) a
 * range is meaningless — a 1987 birthDate must still match today — so we only
 * require the column to be non-null and month/day match in JS.
 */
function candidateWhere(rule, config, entityConfig, now) {
  const where = { tenantId: rule.tenantId };
  if (entityConfig.softDelete) where.deletedAt = null;

  if (config.mode === "date_field") {
    const window = anchorWindow(config, now);
    where[config.field] = window ? { ...window } : { not: null };
  }
  return where;
}

/** Does this record's anchor date fall due in the current window? */
function isDueNow(record, config, now) {
  const anchor = record[config.field];
  if (!anchor) return null;
  const occurrence = occurrenceFor(anchor, config, now);
  if (!occurrence) return null;

  const lookbackMs = (Number.isFinite(Number(config.lookbackDays)) ? Number(config.lookbackDays) : 2) * DAY_MS;
  const due = occurrence.getTime() <= now.getTime()
    && occurrence.getTime() >= now.getTime() - lookbackMs;
  return due ? occurrence : null;
}

/**
 * Run one scheduled rule.
 *
 * Returns {fired, skipped, truncated, examined} — the caller aggregates these
 * into the tick's log line.
 */
async function runScheduledRule(rule, now, io) {
  const eventBus = require("../lib/eventBus");
  const config = parseJson(rule.scheduleConfig, null);
  if (!config) {
    console.warn(`[WorkflowScheduler] rule ${rule.id} has trigger ${rule.triggerType} but no usable scheduleConfig`);
    return { fired: 0, skipped: 0, truncated: 0, examined: 0 };
  }

  const entityConfig = SCHEDULE_ENTITIES[config.entity];
  if (!entityConfig) {
    console.warn(`[WorkflowScheduler] rule ${rule.id} targets unknown entity "${config.entity}"`);
    return { fired: 0, skipped: 0, truncated: 0, examined: 0 };
  }

  // A recurring rule fires on the clock, not per-record-date, so gate the
  // whole rule on nextScheduledAt before touching the record table at all.
  if (config.mode === "recurring") {
    if (rule.nextScheduledAt && new Date(rule.nextScheduledAt) > now) {
      return { fired: 0, skipped: 0, truncated: 0, examined: 0 };
    }
  }

  const maxRecords = Number(config.maxRecords) || 500;
  const where = candidateWhere(rule, config, entityConfig, now);

  // Fetch one extra row purely to detect truncation honestly.
  const records = await prisma[entityConfig.model].findMany({
    where,
    take: maxRecords + 1,
    orderBy: { id: "asc" },
  });

  const truncated = records.length > maxRecords;
  const batch = truncated ? records.slice(0, maxRecords) : records;

  if (truncated) {
    console.warn(
      `[WorkflowScheduler] rule ${rule.id} ("${rule.name}") matched more than ${maxRecords} ${config.entity} records — processing the first ${maxRecords} only`,
    );
    // Surfaced in the history panel so a capped run is visible to the author,
    // not just to whoever reads the server log.
    await prisma.workflowExecution.create({
      data: {
        ruleId: rule.id,
        triggerType: rule.triggerType,
        actionType: "scheduler",
        status: "SKIPPED",
        error: `Matched more than ${maxRecords} records; only the first ${maxRecords} were processed this run.`,
        tenantId: rule.tenantId,
      },
    }).catch(() => { /* logging must not abort the run */ });
  }

  let fired = 0;
  let skipped = 0;

  for (const record of batch) {
    let occurrence = now;

    if (config.mode === "date_field") {
      const due = isDueNow(record, config, now);
      if (!due) { skipped += 1; continue; }
      occurrence = due;
    }

    const recordKey = occurrenceRecordKey(entityConfig.idKey, record.id, occurrence);

    // Dedupe on (rule, recordKey). For date_field the key carries the
    // occurrence date, so moving a deal's close date legitimately re-arms the
    // reminder while a re-run of the same tick does not double-fire.
    const already = await prisma.workflowExecution.findFirst({
      where: { tenantId: rule.tenantId, ruleId: rule.id, recordKey, status: "SUCCESS", isTest: false },
      select: { id: true },
    });
    if (already) { skipped += 1; continue; }

    const payload = {
      ...record,
      [entityConfig.idKey]: record.id,
      // Consumed by eventBus.workflowRecordKey so the occurrence-stamped key
      // survives into the execution log — recomputing it from the payload
      // would drop the date and collapse every occurrence into one slot.
      __recordKey: recordKey,
      scheduledFor: occurrence,
      // SCHEDULE_ENTITIES carries no assigneeField, so probe the four owner
      // columns the scheduled models actually use. Gives actions like
      // send_notification / create_task a sane default assignee.
      userId: record.ownerId || record.assignedToId || record.assigneeId || record.userId || null,
    };

    try {
      if (!eventBus.evaluateCondition(rule.condition, payload)) { skipped += 1; continue; }
      await eventBus.executeAction(rule, payload, rule.tenantId, io, 0);
      fired += 1;
    } catch (error) {
      console.error(`[WorkflowScheduler] rule ${rule.id} record ${record.id} failed:`, error.message);
      await eventBus.recordWorkflowExecution(rule, payload, rule.tenantId, { status: "FAILED", error });
      await eventBus.updateRuleHealth(rule, rule.tenantId, { failed: true, error, isTest: false });
    }
  }

  // Advance the clock pointer for recurring rules.
  if (config.mode === "recurring") {
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: { nextScheduledAt: nextRecurringRun(config, now) },
    }).catch((e) => console.error(`[WorkflowScheduler] nextScheduledAt update failed for rule ${rule.id}:`, e.message));
  }

  return { fired, skipped, truncated: truncated ? 1 : 0, examined: batch.length };
}

async function processScheduledRules(now, io) {
  const rules = await prisma.automationRule.findMany({
    where: {
      isActive: true,
      triggerType: { in: ["schedule.date_field", "schedule.recurring"] },
    },
  });

  const totals = { rules: 0, fired: 0, skipped: 0, truncated: 0 };
  for (const rule of rules) {
    if (!isScheduleTrigger(rule.triggerType)) continue;
    totals.rules += 1;
    try {
      const result = await runScheduledRule(rule, now, io);
      totals.fired += result.fired;
      totals.skipped += result.skipped;
      totals.truncated += result.truncated;
    } catch (error) {
      console.error(`[WorkflowScheduler] rule ${rule.id} failed:`, error.message);
    }
  }
  return totals;
}

// ── 2. Deferred (`wait`) action queue ─────────────────────────────────

/**
 * Resume actions parked behind a `wait`.
 *
 * Claimed with a compare-and-set updateMany on (id, status, lock) so two app
 * instances draining concurrently cannot both pick up the same row — the
 * second one's update matches zero rows and it moves on.
 */
async function processDeferredActions(now, io) {
  const eventBus = require("../lib/eventBus");
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MS);

  const due = await prisma.workflowScheduledAction.findMany({
    where: {
      status: "PENDING",
      runAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    take: 200,
    orderBy: { runAt: "asc" },
    include: { rule: true },
  });

  let resumed = 0;
  let failed = 0;

  for (const row of due) {
    const claim = await prisma.workflowScheduledAction.updateMany({
      where: {
        id: row.id,
        status: "PENDING",
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      data: { lockedAt: now, lockedBy: WORKER_ID, attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue; // another worker got there first

    const rule = row.rule;
    // The rule may have been switched off (or auto-disabled) during the wait.
    // Honouring that is the whole point of a pause button.
    if (!rule || !rule.isActive) {
      await prisma.workflowScheduledAction.update({
        where: { id: row.id },
        data: { status: "CANCELLED", lastError: "Rule is no longer active", lockedAt: null, lockedBy: null },
      });
      continue;
    }

    const actions = parseJson(row.actionsJson, []);
    const payload = parseJson(row.payloadJson, {});
    if (!Array.isArray(actions) || actions.length === 0) {
      await prisma.workflowScheduledAction.update({
        where: { id: row.id },
        data: { status: "DONE", lockedAt: null, lockedBy: null },
      });
      continue;
    }

    try {
      // Reuse the ordinary list walker so a second `wait` inside the tail
      // parks another row rather than being silently ignored.
      const result = await eventBus.runActionList(rule, actions, payload, row.tenantId, io, 0);
      await prisma.workflowScheduledAction.update({
        where: { id: row.id },
        data: {
          status: result.failed > 0 ? "FAILED" : "DONE",
          lastError: result.failed > 0 ? `${result.failed} action(s) failed` : null,
          lockedAt: null,
          lockedBy: null,
        },
      });
      resumed += 1;
    } catch (error) {
      failed += 1;
      const exhausted = row.attempts + 1 >= MAX_DEFERRED_ATTEMPTS;
      await prisma.workflowScheduledAction.update({
        where: { id: row.id },
        data: {
          status: exhausted ? "FAILED" : "PENDING",
          lastError: String(error.message || error).slice(0, 2000),
          lockedAt: null,
          lockedBy: null,
          // Back off half an hour before the next attempt.
          runAt: exhausted ? row.runAt : new Date(now.getTime() + 30 * 60 * 1000),
        },
      });
      console.error(`[WorkflowScheduler] deferred action ${row.id} failed:`, error.message);
    }
  }

  return { resumed, failed, due: due.length };
}

// ── 3. invoice.overdue ────────────────────────────────────────────────

/**
 * Flip past-due UNPAID invoices to OVERDUE and emit `invoice.overdue`.
 *
 * The trigger has been in the builder's dropdown all along with no emitter
 * anywhere in the codebase, so every rule anyone built on it was inert.
 *
 * Idempotency comes from the status transition itself: only UNPAID rows past
 * their due date are selected, and each is flipped to OVERDUE before the emit,
 * so a given invoice fires exactly once. Selecting on status also means a
 * later payment (OVERDUE → PAID) takes it out of scope permanently.
 */
async function processOverdueInvoices(now, io) {
  const { emitEvent } = require("../lib/eventBus");

  const overdue = await prisma.invoice.findMany({
    where: { status: "UNPAID", dueDate: { lt: now } },
    select: {
      id: true, invoiceNum: true, amount: true, dueDate: true,
      contactId: true, dealId: true, tenantId: true,
    },
    take: 1000,
    orderBy: { dueDate: "asc" },
  });

  let emitted = 0;
  for (const invoice of overdue) {
    try {
      const flipped = await prisma.invoice.updateMany({
        where: { id: invoice.id, status: "UNPAID" },
        data: { status: "OVERDUE" },
      });
      // Zero rows ⇒ someone paid or voided it between the read and the write.
      if (flipped.count === 0) continue;

      await emitEvent(
        "invoice.overdue",
        {
          invoiceId: invoice.id,
          invoiceNum: invoice.invoiceNum,
          amount: invoice.amount,
          dueDate: invoice.dueDate,
          daysOverdue: Math.max(0, Math.floor((now.getTime() - new Date(invoice.dueDate).getTime()) / DAY_MS)),
          contactId: invoice.contactId,
          dealId: invoice.dealId,
          status: "OVERDUE",
          previous: { status: "UNPAID" },
        },
        invoice.tenantId,
        io,
      );
      emitted += 1;
    } catch (error) {
      console.error(`[WorkflowScheduler] invoice ${invoice.id} overdue emit failed:`, error.message);
    }
  }
  return { checked: overdue.length, emitted };
}

// ── Tick ──────────────────────────────────────────────────────────────

async function tickWorkflowScheduler() {
  const started = Date.now();
  const now = new Date();
  const io = require("../lib/eventBus").getIO();

  let scheduled = { rules: 0, fired: 0, skipped: 0, truncated: 0 };
  let deferred = { resumed: 0, failed: 0, due: 0 };
  let invoices = { checked: 0, emitted: 0 };

  // Each stage is independently guarded: a failure in one must not stop the
  // other two from running this tick.
  try {
    scheduled = await processScheduledRules(now, io);
  } catch (error) {
    console.error("[WorkflowScheduler] scheduled rules stage failed:", error.message);
  }
  try {
    deferred = await processDeferredActions(now, io);
  } catch (error) {
    console.error("[WorkflowScheduler] deferred action stage failed:", error.message);
  }
  try {
    invoices = await processOverdueInvoices(now, io);
  } catch (error) {
    console.error("[WorkflowScheduler] overdue invoice stage failed:", error.message);
  }

  const ms = Date.now() - started;
  console.log(
    `[WorkflowScheduler] rules=${scheduled.rules} fired=${scheduled.fired} skipped=${scheduled.skipped}`
    + ` truncated=${scheduled.truncated} deferred=${deferred.resumed}/${deferred.due}`
    + ` overdue=${invoices.emitted}/${invoices.checked} (${ms}ms)`,
  );

  return { scheduled, deferred, invoices, ms };
}

function initWorkflowScheduler() {
  cronRegistry.register({
    name: "workflowScheduler",
    description: "Time-based workflow triggers, the wait-action queue, and invoice.overdue (every 15 min)",
    defaultSchedule: "*/15 * * * *",
    tickFn: tickWorkflowScheduler,
  }).catch((e) => console.error("[WorkflowScheduler] cronRegistry registration failed:", e.message));
}

/** Manual-trigger runner for a single tenant, used by the workflows route. */
async function runForTenant(tenantId, now = new Date()) {
  const io = require("../lib/eventBus").getIO();
  const rules = await prisma.automationRule.findMany({
    where: {
      tenantId,
      isActive: true,
      triggerType: { in: ["schedule.date_field", "schedule.recurring"] },
    },
  });
  const totals = { rules: rules.length, fired: 0, skipped: 0, truncated: 0 };
  for (const rule of rules) {
    const result = await runScheduledRule(rule, now, io);
    totals.fired += result.fired;
    totals.skipped += result.skipped;
    totals.truncated += result.truncated;
  }
  return totals;
}

module.exports = {
  initWorkflowScheduler,
  tickWorkflowScheduler,
  processScheduledRules,
  processDeferredActions,
  processOverdueInvoices,
  runScheduledRule,
  runForTenant,
  candidateWhere,
  isDueNow,
  MAX_DEFERRED_ATTEMPTS,
};
