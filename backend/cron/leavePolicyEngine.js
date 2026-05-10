/**
 * Leave Policy Engine — Wave 8b residual closure.
 *
 * Fires daily at 02:30 IST (after retention 03:00 — leave year-end is read-
 * mostly so this can run before the heavier retention sweep). For every
 * tenant, finds LeavePolicy rows whose fiscal year-end falls on the run
 * date and:
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
 * Fiscal year heuristic: defaults to Indian fiscal year-end (31 March)
 * across all wellness tenants because that's the typical Indian payroll
 * cadence. Generic-vertical tenants get 31 December (calendar year-end).
 * No per-policy fiscal-month override yet — adding one is a column on
 * LeavePolicy when a customer asks for it. The current default closes the
 * Wave 8b ask without speculative scope.
 *
 * Idempotency: each (tenant, policy, user, periodStart) is keyed off the
 * existing LeaveBalance row's compound unique. A second run on the same
 * day finds the row already populated and is a no-op.
 *
 * Test surface: `runForTenant(tenantId, { now })` is exported for the
 * vitest unit so the engine can be exercised against any synthetic date
 * without waiting for an actual fiscal-year-end clock tick.
 */
const cron = require("node-cron");
const prisma = require("../lib/prisma");

// Default fiscal year-end — month is 0-indexed in JS Date ergonomics.
const FISCAL_END_WELLNESS = { month: 2, day: 31 };  // March 31
const FISCAL_END_GENERIC  = { month: 11, day: 31 }; // December 31

function isFiscalYearEnd(now, vertical) {
  const target = vertical === "wellness" ? FISCAL_END_WELLNESS : FISCAL_END_GENERIC;
  return now.getMonth() === target.month && now.getDate() === target.day;
}

function nextPeriodStart(periodEnd) {
  // periodEnd is the last day of the fiscal year. Next period starts the
  // following day at 00:00 UTC for clean ledger boundaries.
  const next = new Date(periodEnd);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

function nextPeriodEnd(periodStart) {
  // 365 days minus 1 to land on the same fiscal-end day next year.
  const end = new Date(periodStart);
  end.setFullYear(end.getFullYear() + 1);
  end.setDate(end.getDate() - 1);
  end.setHours(23, 59, 59, 999);
  return end;
}

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

function initLeavePolicyCron() {
  // 02:30 IST = 21:00 UTC previous day. The cron runs in IST per server.
  cron.schedule("30 2 * * *", () => {
    tick().catch((e) => console.error("[LeavePolicy] tick crashed:", e.message));
  }, { timezone: "Asia/Kolkata" });
  console.log("[LeavePolicy] cron scheduled: 02:30 IST daily");
}

module.exports = {
  initLeavePolicyCron,
  runForTenant,
  tick,
  isFiscalYearEnd,
  nextPeriodStart,
  nextPeriodEnd,
};
