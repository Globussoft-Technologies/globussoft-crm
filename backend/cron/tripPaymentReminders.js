// Travel CRM - TMC payment reminders cron (PRD 4.4 + 6.3).
//
// Daily 07:13 IST. For each travel tenant, scans TripInstalmentPayment
// rows that fall into one of two reminder windows:
//
//   pre-due  - dueDate in [now, now + reminderDays] AND status in
//              {pending, partial}
//   overdue  - dueDate < now AND status in {pending, partial} AND
//              dueDate >= 30 days ago (don't pester ancient instalments)
//
// reminderDays comes from the parent TripPaymentPlan.instalmentsJson.
// Defaults to 7 days if missing.
//
// Idempotency: the Notification model carries entityType + entityId +
// type. We use entityType='TripInstalmentPayment', entityId=<id>,
// type='info' for pre-due alerts and type='warning' for overdue alerts.
// The dedup check looks for an existing notification with that composite
// key. So each instalment can have at most ONE pre-due notification and
// ONE overdue notification across its lifecycle.
//
// Dispatch: this pass creates the Notification row, sends a best-effort
// email reminder, and logs a dispatch line. WhatsApp dispatch remains
// best-effort via the existing Web client.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
const { sendEmail } = require("../lib/emailSender");
const watiClient = require("../services/whatsappWebClient");

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

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  const tmcCfg = resolveForSubBrand(tenant, "tmc");

  let participantById = {};
  try {
    const participantIds = [...new Set(instalments.map((i) => i.participantId).filter(Boolean))];
    const participants = participantIds.length
      ? await prisma.tripParticipant.findMany({
          where: { id: { in: participantIds } },
          select: {
            id: true,
            parentPhone: true,
            parentName: true,
            parentEmail: true,
            fullName: true,
            applicationStatus: true,
          },
        })
      : [];
    participantById = Object.fromEntries(participants.map((p) => [p.id, p]));
  } catch (e) {
    console.error(`[TripPaymentReminders] participant lookup failed: ${e.message}`);
  }

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

    const participant = inst.participantId ? participantById[inst.participantId] : null;
    if (participant && participant.applicationStatus !== "approved") continue;
    const portalLink = `${PORTAL_BASE}/pay/trip/${inst.tripId}/installment/${inst.instalmentIndex + 1}`;

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

      console.log(
        `[TripPaymentReminders] tenant ${tenantId} inst ${inst.id} (${phaseType}) -> notification created; admin link: ${PORTAL_BASE}/travel/trips/${inst.tripId} ` +
          `subBrand=tmc wabaId=${tmcCfg.wabaId || "(no-config)"}`,
      );

      if (participant && participant.parentEmail) {
        const subject = isOverdue
          ? `Payment overdue: instalment #${inst.instalmentIndex + 1}`
          : `Payment due soon: instalment #${inst.instalmentIndex + 1}`;
        const reminderText = [
          `Hello ${participant.parentName || participant.fullName || "there"},`,
          "",
          messageBody,
          "",
          `Pay now: ${portalLink}`,
        ].join("\n");
        await sendEmail({
          to: participant.parentEmail,
          subject,
          text: reminderText,
          html: reminderText.replace(/\n/g, "<br>"),
        });
      }

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
          fallbackText: `${messageBody}\n\nPay here: ${portalLink}`,
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
  cronRegistry.register({
    name: "tripPaymentReminders",
    description: "TripInstalmentPayment pre-due/overdue reminder notifications (daily 07:13 IST)",
    defaultSchedule: "13 7 * * *",
    tickFn: runPaymentRemindersForAllTravelTenants,
  }).catch((e) => console.error("[TripPaymentReminders] cronRegistry registration failed:", e.message));
}

module.exports = {
  initTripPaymentRemindersCron,
  runPaymentRemindersForTenant,
  runPaymentRemindersForAllTravelTenants,
};
