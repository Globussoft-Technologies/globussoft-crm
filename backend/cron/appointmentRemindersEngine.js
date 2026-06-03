/**
 * Appointment Reminders Engine (Wellness vertical)
 *
 * Runs every 15 minutes. For each tenant with vertical='wellness', finds Visit
 * rows with status='booked' whose visitDate falls inside the 24h window
 * [now+23h, now+25h] or the 1h window [now+50min, now+70min], and queues an
 * SMS reminder for each by creating an SmsMessage row with status='QUEUED'.
 *
 * Deduplication: checks the last 48h of SmsMessage rows for the same
 * contactId/phone whose body contains a kind-specific phrase that is unique
 * to this engine's output ("tomorrow at" for 24h, "in 1 hour" for 1h).
 *
 * The actual SMS dispatch is handled by the existing SMS provider worker —
 * queueing is sufficient for this iteration.
 *
 * #182 regression-class fixes (2026-05-04 reopen):
 *   1. composeBody no longer renders "appointment appointment" when serviceName
 *      is null — falls back to a single bare "appointment" phrase.
 *   2. The [reminder:24h] / [reminder:1h] debug markers were customer-visible
 *      in the persisted SmsMessage body and went out as part of the SMS.
 *      Dedup now anchors on the unique customer-friendly phrases
 *      ("tomorrow at" / "in 1 hour") that already appear in the body, so we
 *      can drop the visible markers entirely.
 */

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { getSetting, KEYS } = require("../lib/tenantSettings");

function formatTime(date, timezone = "Asia/Kolkata") {
  try {
    return new Date(date).toLocaleString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    });
  } catch {
    return new Date(date).toISOString();
  }
}

function composeBody({ kind, patientName, serviceName, visitDate, clinicName, dedupPhrase24h, dedupPhrase1h, timezone }) {
  const time = formatTime(visitDate, timezone);
  const svcPhrase = serviceName ? `${serviceName} appointment` : "appointment";
  const clinic = clinicName || "Enhanced Wellness";
  const when = kind === "24h"
    ? `${dedupPhrase24h || "tomorrow at"} ${time}`
    : (dedupPhrase1h || "in 1 hour");
  return `Hi ${patientName}, this is a reminder — your ${svcPhrase} at ${clinic} is ${when}. Reply STOP to opt out.`;
}

async function alreadySent({ kind, contactId, phone, dedupPhrase24h, dedupPhrase1h }) {
  const since = new Date(Date.now() - 48 * 3600 * 1000);
  const phrase = kind === "24h" ? (dedupPhrase24h || "tomorrow at") : (dedupPhrase1h || "in 1 hour");
  const or = [];
  if (contactId) or.push({ contactId });
  if (phone) or.push({ to: phone });
  if (or.length === 0) return false;
  const found = await prisma.smsMessage.findFirst({
    where: {
      createdAt: { gte: since },
      body: { contains: phrase },
      OR: or,
    },
    select: { id: true },
  });
  return Boolean(found);
}

async function findDueVisits(tenantId, windowStart, windowEnd) {
  return prisma.visit.findMany({
    where: {
      tenantId,
      status: "booked",
      visitDate: { gte: windowStart, lte: windowEnd },
    },
    include: {
      patient: true,
      service: { select: { id: true, name: true } },
      location: { select: { timezone: true } },
    },
  });
}

async function processTenant(tenant) {
  const now = new Date();
  const win24Start = new Date(now.getTime() + 23 * 3600 * 1000);
  const win24End = new Date(now.getTime() + 25 * 3600 * 1000);
  const win1Start = new Date(now.getTime() + 50 * 60 * 1000);
  const win1End = new Date(now.getTime() + 70 * 60 * 1000);

  const [visits24, visits1] = await Promise.all([
    findDueVisits(tenant.id, win24Start, win24End),
    findDueVisits(tenant.id, win1Start, win1End),
  ]);

  let queued24 = 0;
  let queued1 = 0;
  let skipped = 0;

  const handle = async (kind, visits, _counter) => {
    let q = 0;
    for (const v of visits) {
      try {
        const patient = v.patient;
        if (!patient) { skipped++; continue; }
        if (!patient.phone) { skipped++; continue; }

        // Junk-contact check (via optional Patient.contactId)
        if (patient.contactId) {
          const c = await prisma.contact.findUnique({
            where: { id: patient.contactId },
            select: { status: true },
          });
          if (c && c.status === "Junk") { skipped++; continue; }
        }

        const body = composeBody({
          kind,
          patientName: patient.name || "there",
          serviceName: v.service?.name,
          visitDate: v.visitDate,
          clinicName: tenant.name,
        });

        await prisma.$transaction(async (tx) => {
          const since = new Date(Date.now() - 48 * 3600 * 1000);
          const phrase = kind === "24h" ? DEDUP_PHRASE_24H : DEDUP_PHRASE_1H;
          const or = [];
          if (patient.contactId) or.push({ contactId: patient.contactId });
          if (patient.phone) or.push({ to: patient.phone });
          if (or.length > 0) {
            const count = await tx.smsMessage.count({
              where: {
                createdAt: { gte: since },
                body: { contains: phrase },
                OR: or,
              },
            });
            if (count > 0) { skipped++; return; }
          }

          await tx.smsMessage.create({
            data: {
              to: patient.phone,
              body,
              direction: "OUTBOUND",
              status: "QUEUED",
              tenantId: tenant.id,
              contactId: patient.contactId || null,
            },
          });
          q++;
        });
      } catch (err) {
        console.error(
          `[AppointmentReminders] visit ${v.id} (${kind}) failed:`,
          err.message,
        );
      }
    }
    return q;
  };

  queued24 = await handle("24h", visits24);
  queued1 = await handle("1h", visits1);

  return { tenant: tenant.slug || tenant.id, queued24, queued1, skipped };
}

async function tickAppointmentReminders() {
  const started = Date.now();
  let totalQueued24 = 0;
  let totalQueued1 = 0;
  let totalSkipped = 0;
  let tenantsProcessed = 0;

  try {
    const tenants = await prisma.tenant.findMany({
      where: { vertical: "wellness", isActive: true },
      select: { id: true, name: true, slug: true },
    });

    for (const t of tenants) {
      try {
        const res = await processTenant(t);
        totalQueued24 += res.queued24;
        totalQueued1 += res.queued1;
        totalSkipped += res.skipped;
        tenantsProcessed++;
      } catch (err) {
        console.error(
          `[AppointmentReminders] tenant ${t.slug || t.id} failed:`,
          err.message,
        );
      }
    }
  } catch (err) {
    console.error("[AppointmentReminders] top-level error:", err.message);
  }

  const ms = Date.now() - started;
  console.log(
    `[AppointmentReminders] tenants=${tenantsProcessed} queued24=${totalQueued24} queued1=${totalQueued1} skipped=${totalSkipped} (${ms}ms)`,
  );
  return { tenantsProcessed, totalQueued24, totalQueued1, totalSkipped };
}

function initAppointmentRemindersCron() {
  cron.schedule("*/15 * * * *", () => {
    tickAppointmentReminders().catch((e) =>
      console.error("[AppointmentReminders] tick crashed:", e.message),
    );
  });
  console.log(
    "Appointment Reminders Engine initialized (cron: */15 * * * *)",
  );
}

// ── PRD Gap §12 #4e — No-show risk Notification fan-out ──────────────
//
// Mirrors the dashboard's noShowRisk scorer (routes/wellness.js around
// line 3960) but runs as a cron job so high-risk visits surface on the
// owner/doctor's bell without requiring someone to load the dashboard.
// Idempotency: dedup by Notification metadata isn't structured (no
// metadata column), so we use the link path `/wellness/visits/:id` +
// type='warning' as the dedup key. One notification per (visit, doctor)
// per visit lifetime — repeat ticks find the existing row and skip.
//
// Threshold: NOSHOW_THRESHOLD (60) matches the dashboard's #289 fix bar
// so on-bell parity matches what the dashboard renders.

const NOSHOW_THRESHOLD = 60;
const NOSHOW_NOTIF_TYPE = "warning";

async function alreadyNotifiedNoShow(tenantId, visitId, userId) {
  const link = `/wellness/visits/${visitId}`;
  const existing = await prisma.notification.findFirst({
    where: {
      tenantId,
      userId,
      link,
      type: NOSHOW_NOTIF_TYPE,
    },
    select: { id: true },
  });
  return Boolean(existing);
}

async function scoreUpcomingVisit(tenantId, v, signals) {
  const istHour = new Date(v.visitDate.getTime() + 5.5 * 3600 * 1000).getUTCHours();
  const hoursOut = (v.visitDate.getTime() - Date.now()) / 3600000;
  let score = 0;
  if (signals.noShowSet.has(v.patientId)) score += 30;
  if (
    hoursOut <= 24 &&
    hoursOut >= 1 &&
    !signals.remindedPhones.has(v.patient?.phone)
  ) {
    score += 20;
  }
  if (!signals.visitedPatientSet.has(v.patientId)) score += 15;
  if (istHour < 10 || istHour >= 18) score += 10;
  if (signals.loyalSet.has(v.patientId)) score -= 10;
  return Math.max(0, Math.min(100, score));
}

async function runNoShowRiskForTenant(tenantId) {
  const now = new Date();
  // Window: next 48h of booked visits (one notification covers the
  // T-24h + T-1h reminder cadence comfortably).
  const upcomingEnd = new Date(now.getTime() + 48 * 3600 * 1000);
  const upcomingVisits = await prisma.visit.findMany({
    where: {
      tenantId,
      status: "booked",
      visitDate: { gte: now, lte: upcomingEnd },
    },
    include: {
      patient: { select: { id: true, name: true, phone: true } },
      doctor: { select: { id: true } },
      location: { select: { timezone: true } },
    },
    take: 200,
  });

  if (upcomingVisits.length === 0) {
    return { scored: 0, flagged: 0, notified: 0 };
  }

  const patientIds = upcomingVisits.map((v) => v.patientId);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000);
  const thirtyDaysAgoLoyalty = new Date(now.getTime() - 30 * 86400000);

  const [pastNoShows, anyVisits, smsSent, loyaltyRecent] = await Promise.all([
    prisma.visit.findMany({
      where: {
        tenantId,
        status: "no-show",
        patientId: { in: patientIds },
        visitDate: { gte: ninetyDaysAgo },
      },
      select: { patientId: true },
    }),
    prisma.visit.findMany({
      where: {
        tenantId,
        patientId: { in: patientIds },
        id: { notIn: upcomingVisits.map((v) => v.id) },
      },
      select: { patientId: true },
    }),
    prisma.smsMessage.findMany({
      where: {
        tenantId,
        direction: "OUTBOUND",
        status: { in: ["SENT", "DELIVERED"] },
        createdAt: { gte: new Date(now.getTime() - 48 * 3600 * 1000) },
        to: { in: upcomingVisits.map((v) => v.patient?.phone).filter(Boolean) },
        OR: [{ body: { contains: "reminder" } }, { body: { contains: "appointment" } }],
      },
      select: { to: true },
    }),
    // LoyaltyTransaction may not be enabled on every tenant install; guard.
    (async () => {
      try {
        return await prisma.loyaltyTransaction.findMany({
          where: { tenantId, patientId: { in: patientIds }, createdAt: { gte: thirtyDaysAgoLoyalty } },
          select: { patientId: true },
        });
      } catch {
        return [];
      }
    })(),
  ]);

  const signals = {
    noShowSet: new Set(pastNoShows.map((v) => v.patientId)),
    visitedPatientSet: new Set(anyVisits.map((v) => v.patientId)),
    remindedPhones: new Set(smsSent.map((s) => s.to)),
    loyalSet: new Set(loyaltyRecent.map((l) => l.patientId)),
  };

  const owners = await prisma.user.findMany({
    where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });

  let flagged = 0;
  let notified = 0;

  for (const v of upcomingVisits) {
    const score = await scoreUpcomingVisit(tenantId, v, signals);
    if (score < NOSHOW_THRESHOLD) continue;
    flagged++;

    // Recipients: doctor (if assigned) + every ADMIN/MANAGER. Dedup at
    // the per-(visit, user) level so a doctor who is also an ADMIN
    // receives one notification, not two.
    const recipients = new Set();
    if (v.doctor?.id) recipients.add(v.doctor.id);
    for (const u of owners) recipients.add(u.id);

    const title = `High no-show risk: ${v.patient?.name || `Patient #${v.patientId}`}`;
    const timezone = v.location?.timezone || "Asia/Kolkata";
    const message = `Booked ${v.visitDate.toLocaleString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone })} — risk score ${score}/100. Consider a confirmation call.`;
    const link = `/wellness/visits/${v.id}`;

    for (const userId of recipients) {
      try {
        if (await alreadyNotifiedNoShow(tenantId, v.id, userId)) continue;
        await prisma.notification.create({
          data: {
            tenantId,
            userId,
            title,
            message,
            type: NOSHOW_NOTIF_TYPE,
            link,
          },
        });
        notified++;
      } catch (e) {
        console.error(
          `[NoShowRisk] tenant=${tenantId} visit=${v.id} user=${userId} failed:`,
          e.message,
        );
      }
    }
  }

  return { scored: upcomingVisits.length, flagged, notified };
}

async function runNoShowRiskForAllWellnessTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "wellness", isActive: true },
    select: { id: true, slug: true },
  });
  for (const t of tenants) {
    try {
      const r = await runNoShowRiskForTenant(t.id);
      if (r.flagged > 0) {
        console.log(
          `[NoShowRisk] tenant ${t.slug}: scored=${r.scored} flagged=${r.flagged} notified=${r.notified}`,
        );
      }
    } catch (e) {
      console.error("[NoShowRisk] tenant fail:", t.slug, e.message);
    }
  }
}

function initNoShowRiskCron() {
  // Daily 08:30 IST — early enough for owners to act on the day's risks
  // before patients leave for work.
  cron.schedule(
    "30 8 * * *",
    () => {
      runNoShowRiskForAllWellnessTenants().catch((e) =>
        console.error("[NoShowRisk] cron fail:", e.message),
      );
    },
    { timezone: process.env.CRON_TIMEZONE || "Asia/Kolkata" },
  );
  console.log("[NoShowRisk] cron initialized (daily 08:30 IST)");
}

module.exports = {
  initAppointmentRemindersCron,
  tickAppointmentReminders,
  processTenant, // exported for manual testing
  // PRD Gap §12 #4e — no-show risk fan-out
  initNoShowRiskCron,
  runNoShowRiskForTenant,
  runNoShowRiskForAllWellnessTenants,
};
