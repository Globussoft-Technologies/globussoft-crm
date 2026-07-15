/**
 * Payment-Schedule Reminder Engine — C8 (PRD_TRAVEL_BILLING UC-2.4).
 *
 * Daily 09:00 IST sweep. For each TravelPaymentSchedule milestone whose
 * dueDate falls in the T-7 / T-3 / T-1 UTC-midnight window and whose
 * status ∈ {pending, partial}, fires:
 *   - SMS reminder to the invoice's contact phone (real send via inject-
 *     able notify callback; STUB log when no notify provided)
 *   - Email reminder to the invoice's contact email (same callback)
 *   - WhatsApp leg is currently a STUB pending Q9 (Wati BSP creds) — the
 *     dispatch payload is logged inside the notify callback so an operator
 *     can confirm what would have been sent.
 *
 * Companion to:
 *   - backend/cron/travelMilestoneRemindersEngine.js (#901 slice 7) — that
 *     engine writes a Notification row + audit only; this engine adds the
 *     SMS+email outbound leg AND increments per-schedule reminder counters
 *     on the TravelPaymentSchedule row itself (remindersSentCount /
 *     lastReminderSentAt). The two engines coexist by design: the older
 *     one drives the operator dashboard surface; this one drives the
 *     customer outbound surface.
 *   - backend/cron/supplierPayableRemindersEngine.js (#903) — same shape
 *     applied to the supplier (A/P) side.
 *
 * Idempotency:
 *   The engine skips any schedule where `remindersSentCount >= 3`. Under
 *   normal operation the T-7 / T-3 / T-1 windows each fire once → max 3
 *   sends per schedule. A re-run within the same UTC day will re-find the
 *   same milestone in its window, but the counter guard prevents a 4th
 *   send. Operators wanting to force a re-chase reset the counter via the
 *   future operator-action route (out of scope for C8).
 *
 * Status filter:
 *   Only `pending` and `partial` milestones trigger reminders. `paid`,
 *   `overdue`, `waived`, `cancelled` are excluded — paid/waived/cancelled
 *   have nothing to chase; overdue is a future slice's (different copy +
 *   different cadence) responsibility.
 *
 * Per-row isolation:
 *   Each milestone is wrapped in its own try/catch — one notify failure
 *   never stops the sweep. Failed rows surface in the returned `errors[]`
 *   array; the next tick re-finds them via the same window query and
 *   tries again (the counter only advances on successful send).
 *
 * Tenant scoping:
 *   The sweep is multi-tenant in one pass — each row carries its own
 *   tenantId (and inherits the invoice's tenantId), and the result
 *   envelope groups counts by tenant via `tenantsProcessed`. The notify
 *   callback receives the invoice context so per-tenant from-address /
 *   from-number / language selection happens at the notifier level.
 *
 * Schedule:
 *   Daily 09:13 IST via server.js cron init (`13 9 * * *`). The off-minute
 *   convention spreads the daily cron herd across the wall clock.
 */

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

// Reminder windows in days from "now" — schedules whose dueDate is exactly
// this many UTC days away trigger a reminder this run. T+0 (due-today) is
// intentionally NOT included here — the overdue-cron slice owns that cadence
// per the PRD.
const REMINDER_WINDOWS_DAYS = [7, 3, 1];

// Per-schedule send cap. Under normal operation the T-7 / T-3 / T-1 windows
// each fire once → max 3 sends per schedule. The cap is the idempotency
// backstop against same-day re-runs within a single window.
const MAX_REMINDERS_PER_SCHEDULE = 3;

// PRD_TRAVEL_BILLING G026 (FR-3.2.g) — overdue escalation chain.
//
// When a schedule's status ∈ {pending, partial} and dueDate < now, the
// engine fires escalation messages at T+3 / T+7 / T+14 days past dueDate.
// Each tier bumps the schedule's `escalationLevel` so the next tier can
// fire without re-firing the previous one. Level 0 = no escalation fired;
// 1 = T+3; 2 = T+7; 3 = T+14 (final).
//
// Each tier has its own audience copy stored as a metadata tuple. The
// notify callback receives the tier (level, label, audience hint) so the
// downstream notifier can route SMS/email/CC to the right recipients.
const ESCALATION_TIERS = [
  { level: 1, daysOverdue: 3, label: "T+3", audience: "customer+ops" },
  { level: 2, daysOverdue: 7, label: "T+7", audience: "customer+manager" },
  { level: 3, daysOverdue: 14, label: "T+14", audience: "credit-control+accountant" },
];
const MAX_ESCALATION_LEVEL = 3;

/**
 * Default STUB notifier — logs the intent + returns. Replaced by the
 * wire-in slice (Q9 cred-drop) with real Wati/SMS/email dispatchers.
 *
 * Exposed on module.exports so tests can self-spy via the CJS-self-mocking-
 * seam pattern (cron-learnings entry, 2026-05-24 ~01:43 UTC).
 */
async function defaultStubNotifier(schedule, invoice, windowDays) {
  // Channels: SMS+email are "real" once a real notify is wired in;
  // WA is a TODO pending Q9 (Wati BSP creds).
  console.log(
    `[payment-schedule-reminder STUB] invoice=${invoice.invoiceNum} milestone=${schedule.milestoneOrder} ` +
      `window=T-${windowDays}d amount=${schedule.expectedAmount} ${schedule.expectedCurrency} ` +
      `[sms:stub, email:stub, wa:Q9-blocked]`,
  );
}

/**
 * Default STUB escalation notifier — logs the intent + returns. Replaced
 * by the wire-in slice with real dispatch (SMS to customer + email to ops,
 * stronger copy at T+7 with manager CC, credit-control + accountant route
 * at T+14). Exposed via module.exports for the test seam.
 */
async function defaultStubEscalationNotifier(schedule, invoice, tier) {
  console.log(
    `[payment-schedule-escalation STUB] invoice=${invoice.invoiceNum} milestone=${schedule.milestoneOrder} ` +
      `tier=${tier.label} audience=${tier.audience} ` +
      `daysOverdue=${tier.daysOverdue} amount=${schedule.expectedAmount} ${schedule.expectedCurrency} ` +
      `[sms:stub, email:stub, wa:Q9-blocked]`,
  );
}

/**
 * Fire-and-forget audit wrapper. Mirrors travelMilestoneRemindersEngine /
 * supplierPayableRemindersEngine shape. Exposed via module.exports so the
 * per-schedule loop can be self-spied in tests without touching audit.js's
 * real chain logic.
 */
function writeAuditSafe(...args) {
  return writeAudit(...args).catch((err) => {
    console.warn(`[payment-schedule-reminder] audit failed: ${err.message}`);
  });
}

/**
 * Compute the half-open UTC-midnight window [target, next) for `days`
 * from `now`. Pure function; exported for direct unit testing.
 *
 * @param {Date} now
 * @param {number} days
 * @returns {{ target: Date, next: Date }}
 */
function computeWindow(now, days) {
  const target = new Date(now);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() + days);
  const next = new Date(target);
  next.setUTCDate(next.getUTCDate() + 1);
  return { target, next };
}

/**
 * Run one pass of the reminder engine.
 *
 * @param {object} [options]
 * @param {Function} [options.notify] async (schedule, invoice, windowDays) => void
 *   Real notifier injection point. When omitted, the STUB logger runs and
 *   the audit row carries `stub: true`.
 * @param {Date} [options.now] Override for testability — defaults to new Date().
 * @param {object} [options.prisma] Prisma client override for tests.
 * @returns {Promise<{
 *   tenantsProcessed: number,
 *   schedulesEvaluated: number,
 *   remindersSent: number,
 *   byWindow: Record<number, number>,
 *   errors: Array<{ scheduleId: number, error: string }>
 * }>}
 */
async function processReminders({ notify, now = new Date(), prisma: prismaOverride } = {}) {
  const db = prismaOverride || prisma;
  const isStub = !notify;
  const send = notify || module.exports.defaultStubNotifier;

  const byWindow = { 7: 0, 3: 0, 1: 0 };
  const errors = [];
  const tenantsSeen = new Set();
  let schedulesEvaluated = 0;
  let remindersSent = 0;

  for (const days of REMINDER_WINDOWS_DAYS) {
    const { target, next } = computeWindow(now, days);

    const schedules = await db.travelPaymentSchedule.findMany({
      where: {
        status: { in: ["pending", "partial"] },
        dueDate: { gte: target, lt: next },
      },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNum: true,
            subBrand: true,
            contactId: true,
            tenantId: true,
            currency: true,
            totalAmount: true,
          },
        },
      },
    });

    for (const s of schedules) {
      schedulesEvaluated += 1;
      tenantsSeen.add(s.tenantId);

      // Idempotency guard — skip schedules that already hit the per-schedule
      // send cap. A null counter is treated as 0 (pre-C8 rows).
      const sentSoFar = Number(s.remindersSentCount || 0);
      if (sentSoFar >= MAX_REMINDERS_PER_SCHEDULE) {
        continue;
      }

      try {
        await send(s, s.invoice, days);
        // Bump the per-schedule counter + timestamp BEFORE the audit so
        // a subsequent same-tick re-run (operator-triggered) is correctly
        // gated even if the audit write is still in flight.
        await db.travelPaymentSchedule.update({
          where: { id: s.id },
          data: {
            remindersSentCount: sentSoFar + 1,
            lastReminderSentAt: now,
          },
        });
        await module.exports.writeAuditSafe(
          "TravelPaymentSchedule",
          "PAYMENT_SCHEDULE_REMINDER_SENT",
          s.id,
          null, // system actor — no User row
          s.tenantId,
          {
            invoiceId: s.invoiceId,
            invoiceNum: s.invoice.invoiceNum,
            milestoneOrder: s.milestoneOrder,
            windowDays: days,
            expectedAmount: String(s.expectedAmount),
            expectedCurrency: s.expectedCurrency,
            channels: { sms: !isStub, email: !isStub, wa: false /* Q9-blocked */ },
            stub: isStub,
          },
        );
        byWindow[days] += 1;
        remindersSent += 1;
      } catch (e) {
        console.error(
          `[payment-schedule-reminder] failed for schedule=${s.id} window=T-${days}d: ${e.message}`,
        );
        errors.push({ scheduleId: s.id, error: e.message });
      }
    }
  }

  return {
    tenantsProcessed: tenantsSeen.size,
    schedulesEvaluated,
    remindersSent,
    byWindow,
    errors,
  };
}

/**
 * PRD_TRAVEL_BILLING G026 (FR-3.2.g) — overdue escalation chain.
 *
 * Companion sweep that runs alongside processReminders(). For each
 * pending/partial schedule whose dueDate < now and whose
 * `escalationLevel` < `MAX_ESCALATION_LEVEL`, walks the ESCALATION_TIERS
 * ladder and fires every tier the schedule is overdue past but hasn't
 * yet fired.
 *
 * Idempotency: each tier bumps `escalationLevel` to its `level`. A schedule
 * at level=2 (T+7 already fired) and 16 days overdue will fire only T+14
 * this tick, not T+3/T+7 again. The persistence happens BEFORE the audit
 * write so a same-tick re-run is gated on the same level.
 *
 * Tier-firing order in a single tick: ascending — if a schedule is 20 days
 * overdue and at level=0, this method fires level=1 → level=2 → level=3 in
 * one pass. The downstream notifier may want to coalesce these into a
 * single "we sent you 3 reminders" payload; for now each tier issues its
 * own callback invocation.
 *
 * @param {object} [options]
 * @param {Function} [options.notify] async (schedule, invoice, tier) => void
 *   Tier shape: { level, daysOverdue, label, audience }. Receives the
 *   schedule + invoice + the tier being fired. STUB used when omitted.
 * @param {Date} [options.now]
 * @param {object} [options.prisma]
 * @returns {Promise<{
 *   tenantsProcessed: number,
 *   schedulesEvaluated: number,
 *   escalationsSent: number,
 *   byTier: Record<number, number>,
 *   errors: Array<{ scheduleId: number, error: string }>
 * }>}
 */
async function processEscalations({ notify, now = new Date(), prisma: prismaOverride } = {}) {
  const db = prismaOverride || prisma;
  const isStub = !notify;
  const send = notify || module.exports.defaultStubEscalationNotifier;

  const byTier = { 1: 0, 2: 0, 3: 0 };
  const errors = [];
  const tenantsSeen = new Set();
  let schedulesEvaluated = 0;
  let escalationsSent = 0;

  // Find every pending/partial schedule whose dueDate is before now AND
  // hasn't yet hit the max escalation level. The cron herds per-tenant
  // via the (tenantId, status, escalationLevel) compound index.
  const schedules = await db.travelPaymentSchedule.findMany({
    where: {
      status: { in: ["pending", "partial"] },
      dueDate: { lt: now },
      escalationLevel: { lt: MAX_ESCALATION_LEVEL },
    },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNum: true,
          subBrand: true,
          contactId: true,
          tenantId: true,
          currency: true,
          totalAmount: true,
        },
      },
    },
  });

  for (const s of schedules) {
    schedulesEvaluated += 1;
    tenantsSeen.add(s.tenantId);

    const dueMs = s.dueDate ? new Date(s.dueDate).getTime() : null;
    if (dueMs == null) continue;
    const daysOverdue = Math.floor((now.getTime() - dueMs) / (1000 * 60 * 60 * 24));
    let currentLevel = Number(s.escalationLevel || 0);

    try {
      for (const tier of ESCALATION_TIERS) {
        // Skip tiers already fired (idempotency) and tiers the schedule
        // isn't yet overdue past.
        if (tier.level <= currentLevel) continue;
        if (daysOverdue < tier.daysOverdue) break; // tiers are ascending — once we're below, stop.

        await send(s, s.invoice, tier);
        // Persist BEFORE audit so a same-tick re-run is correctly gated
        // even if the audit write is still in flight.
        await db.travelPaymentSchedule.update({
          where: { id: s.id },
          data: {
            escalationLevel: tier.level,
            lastEscalationAt: now,
          },
        });
        await module.exports.writeAuditSafe(
          "TravelPaymentSchedule",
          "PAYMENT_SCHEDULE_ESCALATION_FIRED",
          s.id,
          null,
          s.tenantId,
          {
            invoiceId: s.invoiceId,
            invoiceNum: s.invoice ? s.invoice.invoiceNum : null,
            milestoneOrder: s.milestoneOrder,
            tierLabel: tier.label,
            tierLevel: tier.level,
            daysOverdue,
            audience: tier.audience,
            expectedAmount: String(s.expectedAmount),
            expectedCurrency: s.expectedCurrency,
            channels: { sms: !isStub, email: !isStub, wa: false /* Q9-blocked */ },
            stub: isStub,
          },
        );
        currentLevel = tier.level;
        byTier[tier.level] += 1;
        escalationsSent += 1;
      }
    } catch (e) {
      console.error(
        `[payment-schedule-escalation] failed for schedule=${s.id}: ${e.message}`,
      );
      errors.push({ scheduleId: s.id, error: e.message });
    }
  }

  return {
    tenantsProcessed: tenantsSeen.size,
    schedulesEvaluated,
    escalationsSent,
    byTier,
    errors,
  };
}

// One tick runs BOTH the T-7/T-3/T-1 pre-due reminders AND the T+3/T+7/T+14
// post-due escalation chain. allSettled (not a plain await sequence) so a
// failure on one side can never stop the other from running — matches the
// original two-independent-.catch()-chains isolation exactly.
async function tick() {
  const results = await Promise.allSettled([processReminders(), processEscalations()]);
  const [reminders, escalations] = results;
  if (reminders.status === "rejected") {
    console.error("[payment-schedule-reminder] unhandled tick error:", reminders.reason);
  }
  if (escalations.status === "rejected") {
    console.error("[payment-schedule-escalation] unhandled tick error:", escalations.reason);
  }
}

/**
 * Register the cron schedule. Wired into backend/server.js cron init block.
 */
function initCron() {
  // Daily 09:13 IST (off-minute per the standing-rule herd-spread).
  cronRegistry.register({
    name: "paymentScheduleReminderEngine",
    description: "TravelPaymentSchedule T-7/T-3/T-1 reminders + T+3/T+7/T+14 escalation (daily 09:13 IST)",
    defaultSchedule: "13 9 * * *",
    tickFn: tick,
  }).catch((e) => console.error("[payment-schedule-reminder] cronRegistry registration failed:", e.message));
}

module.exports = {
  processReminders,
  processEscalations,
  initCron,
  computeWindow,
  defaultStubNotifier,
  defaultStubEscalationNotifier,
  writeAuditSafe,
  REMINDER_WINDOWS_DAYS,
  MAX_REMINDERS_PER_SCHEDULE,
  ESCALATION_TIERS,
  MAX_ESCALATION_LEVEL,
};
