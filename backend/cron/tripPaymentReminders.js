// Travel CRM — TMC payment reminders cron (PRD §4.4 + §6.3).
//
// Daily 07:13 IST. For each travel tenant, scans TripInstalmentPayment
// rows that fall into one of two reminder windows:
//
//   pre-due  — dueDate ∈ [now, now + reminderDays] AND status ∈
//              {pending, partial}
//   overdue  — dueDate < now AND status ∈ {pending, partial} AND
//              dueDate ≥ 30 days ago (don't pester ancient instalments)
//
// `reminderDays` comes from the parent TripPaymentPlan.instalmentsJson —
// the JSON shape is `[{ dueDate, amount, reminderDays }]` indexed by
// instalmentIndex. Defaults to 7 days if missing.
//
// Idempotency: the Notification model carries entityType + entityId +
// type. We use `entityType='TripInstalmentPayment'`, `entityId=<id>`,
// `type='info'` for pre-due alerts and `type='warning'` for overdue
// alerts. The dedup check looks for an existing notification with that
// composite key. So each instalment can have at most ONE pre-due
// notification AND ONE overdue notification across its lifecycle.
//
// Dispatch: this Phase 1 ship creates the Notification row + logs a
// dispatch line. WhatsApp/email send slots in once Wati BSP creds (Q9)
// land — the WhatsAppMessage row creation goes in the same loop.

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
const watiClient = require("../services/watiClient");

const DEFAULT_REMINDER_DAYS = 7;
const OVERDUE_LOOKBACK_DAYS = 30;
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

/**
 * Run the payment-reminders sweep for one travel tenant.
 * @param {number} tenantId
 * @returns {Promise<{ dueSoon: number, overdue: number }>}
 */
async function runPaymentRemindersForTenant(tenantId) {
  const now = Date.now();
  const cutoffFloor = new Date(now - OVERDUE_LOOKBACK_DAYS * 86400_000);
  // Future cutoff = max possible reminderDays (cap at 60d). The actual
  // filter happens per-instalment using its plan's reminderDays.
  const cutoffCeiling = new Date(now + 60 * 86400_000);

  const instalments = await prisma.tripInstalmentPayment.findMany({
    where: {
      trip: { tenantId },
      status: { in: ["pending", "partial"] },
      dueDate: { gte: cutoffFloor, lte: cutoffCeiling },
    },
    select: {
      id: true,
      tripId: true,
      participantId: true,
      instalmentIndex: true,
      dueDate: true,
      amount: true,
      paidAmount: true,
      status: true,
    },
    take: 500,
  });

  if (instalments.length === 0) return { dueSoon: 0, overdue: 0 };

  // One tenant row read per pass for the Q9 cut-over plumbing — the
  // wabaId is logged at notification-create time so operators can see
  // which WABA the dispatch WOULD route through once Wati creds land.
  // Instalments here belong to TmcTrips → subBrand=tmc by construction.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  const tmcCfg = resolveForSubBrand(tenant, "tmc");

  // Batch-fetch participant parent phones for the WhatsApp dispatch leg.
  // Best-effort: a lookup failure only skips the WA leg — the notification
  // loop below must keep running regardless (mirrors the advisor-alerts
  // cron's tolerate-missing-table posture).
  let participantById = {};
  try {
    const participantIds = [...new Set(instalments.map((i) => i.participantId).filter(Boolean))];
    const participants = participantIds.length
      ? await prisma.tripParticipant.findMany({
          where: { id: { in: participantIds } },
          select: { id: true, parentPhone: true, parentName: true, fullName: true },
        })
      : [];
    participantById = Object.fromEntries(participants.map((p) => [p.id, p]));
  } catch (e) {
    console.error(`[TripPaymentReminders] participant phone lookup failed (WA leg skipped): ${e.message}`);
  }

  // Batch-fetch parent plans so we can look up reminderDays per instalment.
  const tripIds = [...new Set(instalments.map((i) => i.tripId))];
  const plans = await prisma.tripPaymentPlan.findMany({
    where: { tripId: { in: tripIds } },
    select: { tripId: true, instalmentsJson: true },
  });
  const planByTrip = {};
  for (const p of plans) {
    try {
      planByTrip[p.tripId] = JSON.parse(p.instalmentsJson || "[]");
    } catch {
      planByTrip[p.tripId] = [];
    }
  }

  let dueSoon = 0;
  let overdue = 0;
  for (const inst of instalments) {
    const dueAt = new Date(inst.dueDate).getTime();
    if (Number.isNaN(dueAt)) continue;

    const planEntry = (planByTrip[inst.tripId] || [])[inst.instalmentIndex] || {};
    const reminderDays = Number.isFinite(Number(planEntry.reminderDays))
      ? Number(planEntry.reminderDays)
      : DEFAULT_REMINDER_DAYS;

    const isOverdue = dueAt < now;
    const reminderWindowStart = dueAt - reminderDays * 86400_000;
    const inPreDueWindow = !isOverdue && now >= reminderWindowStart && now <= dueAt;

    if (!isOverdue && !inPreDueWindow) continue;

    const phaseType = isOverdue ? "warning" : "info";
    const existing = await prisma.notification.findFirst({
      where: {
        tenantId,
        entityType: "TripInstalmentPayment",
        entityId: inst.id,
        type: phaseType,
      },
      select: { id: true },
    });
    if (existing) continue;

    const dueIso = new Date(inst.dueDate).toISOString().slice(0, 10);
    const amountStr = Number(inst.amount).toLocaleString("en-IN");
    const titleLabel = isOverdue
      ? `Instalment overdue: ₹${amountStr}`
      : `Instalment due soon: ₹${amountStr}`;
    const messageBody = isOverdue
      ? `Trip instalment #${inst.instalmentIndex + 1} (₹${amountStr}) was due ${dueIso} and is unpaid. Status: ${inst.status}.`
      : `Trip instalment #${inst.instalmentIndex + 1} (₹${amountStr}) is due ${dueIso} (in ${Math.max(0, Math.ceil((dueAt - now) / 86400_000))} days).`;

    try {
      await prisma.notification.create({
        data: {
          tenantId,
          title: titleLabel,
          message: messageBody,
          type: phaseType,
          priority: isOverdue ? "high" : "normal",
          entityType: "TripInstalmentPayment",
          entityId: inst.id,
        },
      });
      const link = `${PORTAL_BASE}/travel/trips/${inst.tripId}`;
      console.log(
        `[TripPaymentReminders] tenant ${tenantId} inst ${inst.id} (${phaseType}) → notification created; ` +
          `admin link: ${link} — would-route subBrand=tmc wabaId=${tmcCfg.wabaId || "(no-config)"}`,
      );
      // WhatsApp dispatch via watiClient (Q9) — stub-logs + QUEUED row when
      // WATI creds are absent; real template send when they're set. Best-
      // effort: a send failure never blocks the notification loop.
      const participant = inst.participantId ? participantById[inst.participantId] : null;
      if (participant && participant.parentPhone) {
        await watiClient.sendBestEffort({
          tenantId,
          subBrand: "tmc",
          toPhone: participant.parentPhone,
          templateName: process.env.WATI_PAYMENT_REMINDER_TEMPLATE || "payment_reminder_t_minus_n",
          parameters: [
            { name: "name", value: participant.parentName || participant.fullName || "Parent" },
            { name: "amount", value: `₹${amountStr}` },
            { name: "due_date", value: dueIso },
          ],
          broadcastName: "travel-trip-payment-reminders",
          fallbackText: messageBody,
        });
      }
      if (isOverdue) overdue++;
      else dueSoon++;
    } catch (e) {
      console.error(
        `[TripPaymentReminders] tenant ${tenantId} inst ${inst.id} create error:`,
        e.message,
      );
    }
  }

  return { dueSoon, overdue };
}

async function runPaymentRemindersForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalDueSoon = 0;
  let totalOverdue = 0;
  for (const t of tenants) {
    try {
      const { dueSoon, overdue } = await runPaymentRemindersForTenant(t.id);
      totalDueSoon += dueSoon;
      totalOverdue += overdue;
      if (dueSoon || overdue) {
        console.log(
          `[TripPaymentReminders] tenant ${t.slug}: ${dueSoon} due-soon + ${overdue} overdue notifications`,
        );
      }
    } catch (e) {
      console.error("[TripPaymentReminders] tenant fail:", t.slug, e.message);
    }
  }
  return { dueSoon: totalDueSoon, overdue: totalOverdue };
}

function initTripPaymentRemindersCron() {
  // Daily 07:13 IST (off-minute per the standing rule). PRD §6.3 says
  // "daily 09:00 IST" — running earlier so the reminders are queued by
  // the time school finance teams open the system.
  cron.schedule("13 7 * * *", () => {
    runPaymentRemindersForAllTravelTenants().catch((e) =>
      console.error("[TripPaymentReminders] cron fail:", e.message),
    );
  });
  console.log("[TripPaymentReminders] cron initialized (daily 07:13 IST)");
}

module.exports = {
  initTripPaymentRemindersCron,
  runPaymentRemindersForTenant,
  runPaymentRemindersForAllTravelTenants,
};
