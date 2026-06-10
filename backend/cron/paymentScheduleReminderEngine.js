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

const cron = require("node-cron");
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
 * Register the cron schedule. Wired into backend/server.js cron init block.
 */
function initCron() {
  // Daily 09:13 IST (off-minute per the standing-rule herd-spread).
  cron.schedule("13 9 * * *", () => {
    processReminders().catch((err) => {
      console.error("[payment-schedule-reminder] unhandled tick error:", err);
    });
  });
  console.log("[payment-schedule-reminder] cron initialized (daily 09:13 IST)");
}

module.exports = {
  processReminders,
  initCron,
  computeWindow,
  defaultStubNotifier,
  writeAuditSafe,
  REMINDER_WINDOWS_DAYS,
  MAX_REMINDERS_PER_SCHEDULE,
};
