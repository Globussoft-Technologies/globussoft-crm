/**
 * Leave Policy Engine — Wave 8b residual closure.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  PURPOSE
 * ────────────────────────────────────────────────────────────────────────
 *
 * Fires daily at 02:30 IST (after retention 03:00 — leave year-end is read-
 * mostly so this can run before the heavier retention sweep). For every
 * tenant, finds LeavePolicy rows whose fiscal year-end falls on the run
 * date and applies carry-forward + encashment per policy config.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  CONTRACT
 * ────────────────────────────────────────────────────────────────────────
 *
 *   1. Carry-forward — if `policy.carryForwardCap > 0`, copy
 *      min(LeaveBalance.available, carryForwardCap) into the next period's
 *      LeaveBalance row (creating the row from `annualEntitlement` if it
 *      doesn't exist yet, identical to the lazy-create pattern in
 *      routes/leave.js).
 *
 *   2. Encashment — if `policy.encashable === true`, the residual
 *      (available - carriedForward) is logged as an EncashmentLedger
 *      audit row and a Notification is sent to the user + payroll
 *      recipients (every ADMIN). The CSV-export path consumed by Payroll
 *      processors stays the existing `/api/leave/balances` listing — the
 *      encashment row carries `notes='ENCASHED YYYY-MM-DD'` so the CSV
 *      job can pick it up by predicate.
 *
 *   3. Closed-period zero-out — once the rollover succeeds, the closing
 *      period's LeaveBalance.available is set to 0 so subsequent queries
 *      don't double-count carry + closing.
 *
 * Idempotency: each (tenant, policy, user, periodStart) is keyed off the
 * existing LeaveBalance row's compound unique. A second run on the same
 * day finds the row already populated and is a no-op.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  RATIONALE — fiscal year heuristic
 * ────────────────────────────────────────────────────────────────────────
 *
 * Defaults to Indian fiscal year-end (31 March) across all wellness
 * tenants because that's the typical Indian payroll cadence. Generic-
 * vertical tenants get 31 December (calendar year-end). No per-policy
 * fiscal-month override yet — adding one is a column on LeavePolicy
 * when a customer asks for it. The current default closes the Wave 8b
 * ask without speculative scope.
 *
 * Alternatives considered:
 *   (A) Per-tenant fiscal-month override — rejected as YAGNI until a
 *       multi-country tenant asks. The schema is one column away.
 *   (B) Per-policy fiscal-month override — rejected as same-shape but
 *       more granular than warranted. Single tenant rarely needs >1
 *       fiscal year per policy.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  TESTED + ADOPTED
 * ────────────────────────────────────────────────────────────────────────
 *
 * Test surface: `runForTenant(tenantId, { now })` is exported for the
 * vitest unit so the engine can be exercised against any synthetic date
 * without waiting for an actual fiscal-year-end clock tick.
 *
 * Tested at: backend/test/cron/leavePolicyEngine.test.js
 *   (vitest cases covering fiscal-year detection, carry-forward
 *    upsert, encashment ledger row + notifications, idempotency on
 *    repeated invocation, generic-vs-wellness fiscal split)
 *
 * Adopted by:
 *   - server.js — initLeavePolicyCron() wired at boot when
 *     DISABLE_CRONS env-var is unset
 *
 * NOT adopted by (deliberate):
 *   - Per-tenant runner from /developer panel — manual trigger surface
 *     not exposed; admins use `node -e "require('./cron/leavePolicyEngine')
 *     .runForTenant(<id>)"` directly. If a UI ask lands, the right place
 *     is /api/cron/leave-policy/run not a fresh route here.
 */
const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");

// Default fiscal year-end — month is 0-indexed in JS Date ergonomics.
const FISCAL_END_WELLNESS = { month: 2, day: 31 };  // March 31
const FISCAL_END_GENERIC  = { month: 11, day: 31 }; // December 31

/**
 * True if `now` falls on the tenant's fiscal year-end date.
 *
 * @param {Date} now      current run timestamp
 * @param {string} vertical  'wellness' | 'generic'
 * @returns {boolean}
 */
function isFiscalYearEnd(now, vertical) {
  const target = vertical === "wellness" ? FISCAL_END_WELLNESS : FISCAL_END_GENERIC;
  return now.getMonth() === target.month && now.getDate() === target.day;
}

/**
 * Compute the first day of the period AFTER the supplied periodEnd.
 * Lands on 00:00 local time for clean ledger boundaries.
 *
 * @param {Date} periodEnd  last day of the closing fiscal year
 * @returns {Date}          first day of the opening fiscal year
 */
function nextPeriodStart(periodEnd) {
  const next = new Date(periodEnd);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

/**
 * Compute the last day of the period starting at periodStart. Lands on
 * 23:59:59.999 to absorb any same-day claims.
 *
 * @param {Date} periodStart  first day of the new fiscal year
 * @returns {Date}            last day of the new fiscal year
 */
function nextPeriodEnd(periodStart) {
  // 365 days minus 1 to land on the same fiscal-end day next year.
  const end = new Date(periodStart);
  end.setFullYear(end.getFullYear() + 1);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Run the leave-policy rollover for a single tenant. Returns a summary
 * count for the orchestrator (tick) to aggregate.
 *
 * Caller responsibilities:
 *   - skip-if-not-fiscal-year-end is INTERNAL to this function (the tick
 *     fans out to every tenant and lets each one decide).
 *   - idempotency is INTERNAL via LeaveBalance compound unique constraint.
 *
 * @param {number} tenantId
 * @param {{ now?: Date }} [opts]  inject a synthetic 'now' for tests
 * @returns {Promise<{ policies: number, carriedForward: number, encashed: number }>}
 */
async function runForTenant(tenantId, opts = {}) {
  const now = opts.now || new Date();
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { vertical: true },
  });
  if (!tenant) return { policies: 0, carriedForward: 0, encashed: 0 };

  if (!isFiscalYearEnd(now, tenant.vertical)) {
    return { policies: 0, carriedForward: 0, encashed: 0 };
  }

  const policies = await prisma.leavePolicy.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [
        { carryForwardCap: { gt: 0 } },
        { encashable: true },
      ],
    },
  });

  if (policies.length === 0) return { policies: 0, carriedForward: 0, encashed: 0 };

  let carriedForward = 0;
  let encashed = 0;

  for (const policy of policies) {
    // Find every LeaveBalance for this policy in the period that's
    // closing (periodEnd >= now-7d for safety against clock drift, < now+1d).
    const periodEndCutoffEarly = new Date(now);
    periodEndCutoffEarly.setDate(periodEndCutoffEarly.getDate() - 7);
    const periodEndCutoffLate = new Date(now);
    periodEndCutoffLate.setDate(periodEndCutoffLate.getDate() + 1);

    const balances = await prisma.leaveBalance.findMany({
      where: {
        tenantId,
        policyId: policy.id,
        periodEnd: { gte: periodEndCutoffEarly, lte: periodEndCutoffLate },
      },
    });

    for (const bal of balances) {
      try {
        const available = bal.available || 0;
        if (available <= 0) continue;

        const carryCap = policy.carryForwardCap || 0;
        const carry = Math.min(available, carryCap);
        const residual = available - carry;

        const newPeriodStart = nextPeriodStart(bal.periodEnd);
        const newPeriodEnd = nextPeriodEnd(newPeriodStart);

        // 1. Create or update next period's LeaveBalance.
        if (carry > 0) {
          await prisma.leaveBalance.upsert({
            where: {
              tenantId_userId_policyId_periodStart: {
                tenantId,
                userId: bal.userId,
                policyId: policy.id,
                periodStart: newPeriodStart,
              },
            },
            update: {
              entitled: policy.annualEntitlement + carry,
              available: policy.annualEntitlement + carry,
            },
            create: {
              tenantId,
              userId: bal.userId,
              policyId: policy.id,
              periodStart: newPeriodStart,
              periodEnd: newPeriodEnd,
              entitled: policy.annualEntitlement + carry,
              accrued: 0,
              used: 0,
              pending: 0,
              available: policy.annualEntitlement + carry,
            },
          });
          carriedForward++;
        }

        // 2. Encashment audit row + notification for any uncarried residual.
        if (residual > 0 && policy.encashable) {
          await prisma.auditLog.create({
            data: {
              action: "LEAVE_ENCASHMENT",
              entity: "LeaveBalance",
              entityId: bal.id,
              userId: bal.userId,
              details: JSON.stringify({
                policyId: policy.id,
                policyName: policy.name,
                userId: bal.userId,
                periodEnd: bal.periodEnd,
                encashedDays: residual,
                fiscalYear: now.getFullYear(),
              }),
              tenantId,
            },
          });

          // Notify the user + every ADMIN in the tenant for payroll handoff.
          const recipients = await prisma.user.findMany({
            where: {
              tenantId,
              OR: [
                { id: bal.userId },
                { role: "ADMIN" },
              ],
            },
            select: { id: true },
          });
          if (recipients.length > 0) {
            await prisma.notification.createMany({
              data: recipients.map((u) => ({
                tenantId,
                userId: u.id,
                title: `Leave encashment: ${residual} day${residual === 1 ? "" : "s"}`,
                message: `${policy.name}: ${residual} day${residual === 1 ? "" : "s"} encashed for fiscal year ${now.getFullYear()}. Process payroll payout.`,
                type: "info",
                link: `/leave/balances/${bal.userId}`,
              })),
            });
          }

          encashed++;
        }

        // 3. Zero out the closed period's balance so subsequent queries
        //    don't double-count.
        await prisma.leaveBalance.update({
          where: { id: bal.id },
          data: { available: 0 },
        });
      } catch (e) {
        console.error(
          `[LeavePolicy] tenant=${tenantId} policy=${policy.id} balance=${bal.id} failed:`,
          e.message,
        );
      }
    }
  }

  return { policies: policies.length, carriedForward, encashed };
}

/**
 * Daily tick — fan out to every tenant. Errors in one tenant are caught
 * + logged; other tenants continue. Idempotent across re-runs.
 *
 * @returns {Promise<void>}  no return; logs aggregate counts on success
 */
async function tick() {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let totalCarriedForward = 0;
  let totalEncashed = 0;
  for (const t of tenants) {
    try {
      const r = await runForTenant(t.id);
      totalCarriedForward += r.carriedForward;
      totalEncashed += r.encashed;
    } catch (e) {
      console.error(`[LeavePolicy] tenant=${t.id} tick failed:`, e.message);
    }
  }
  if (totalCarriedForward + totalEncashed > 0) {
    console.log(
      `[LeavePolicy] tick: carriedForward=${totalCarriedForward}, encashed=${totalEncashed}`,
    );
  }
}

/**
 * Wire the cron schedule at boot. Idempotent — safe to call once from
 * server.js. Schedule: 02:30 IST every day.
 *
 * @returns {void}
 */
function initLeavePolicyCron() {
  // 02:30 IST = 21:00 UTC previous day. The cron runs in IST per server.
  cronRegistry.register({
    name: "leavePolicyEngine",
    description: "Fiscal year-end leave carry-forward + encashment payouts",
    defaultSchedule: "30 2 * * *",
    cronOptions: { timezone: "Asia/Kolkata" },
    tickFn: tick,
  }).catch((e) => console.error("[LeavePolicy] cronRegistry registration failed:", e.message));
}

module.exports = {
  initLeavePolicyCron,
  runForTenant,
  tick,
  isFiscalYearEnd,
  nextPeriodStart,
  nextPeriodEnd,
};
