/**
 * Appointment Reminders Engine (Wellness vertical)
 *
 * Runs every 15 minutes. For each tenant with vertical='wellness', finds Visit
 * rows with status='booked' whose visitDate falls inside the 24h window
 * [now+23h, now+25h] or the 1h window [now+50min, now+70min], and queues an
 * SMS reminder for each by creating an SmsMessage row with status='QUEUED'.
 *
 * Deduplication: checks the last 48h of SmsMessage rows for the same
 * contactId/phone containing a '24h' or '1h' marker in the body. The marker is
 * a hidden trailer appended to the message (after the opt-out line).
 *
 * The actual SMS dispatch is handled by the existing SMS provider worker —
 * queueing is sufficient for this iteration.
 */

const cron = require("node-cron");
const prisma = require("../lib/prisma");

const MARKER_24H = "[reminder:24h]";
const MARKER_1H = "[reminder:1h]";

function formatTime(date) {
  try {
    return new Date(date).toLocaleString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });
  } catch {
    return new Date(date).toISOString();
  }
}

function composeBody({ kind, patientName, serviceName, visitDate, clinicName }) {
  const time = formatTime(visitDate);
  const svc = serviceName || "appointment";
  const clinic = clinicName || "Enhanced Wellness";
  const when = kind === "24h" ? `tomorrow at ${time}` : "in 1 hour";
  const marker = kind === "24h" ? MARKER_24H : MARKER_1H;
  return `Hi ${patientName}, this is a reminder — your ${svc} appointment at ${clinic} is ${when}. Reply STOP to opt out. ${marker}`;
}

async function alreadySent({ kind, contactId, phone }) {
  const since = new Date(Date.now() - 48 * 3600 * 1000);
  const marker = kind === "24h" ? "%24h%" : "%1h%";
  const or = [];
  if (contactId) or.push({ contactId });
  if (phone) or.push({ to: phone });
  if (or.length === 0) return false;
  const found = await prisma.smsMessage.findFirst({
    where: {
      createdAt: { gte: since },
      body: { contains: kind === "24h" ? "24h" : "1h" },
      OR: or,
    },
    select: { id: true },
  });
  // Additional guard: also check explicit marker
  if (found) return true;
  const markerFound = await prisma.smsMessage.findFirst({
    where: {
      createdAt: { gte: since },
      body: { contains: marker.replace(/%/g, "") },
      OR: or,
    },
    select: { id: true },
  });
  return Boolean(markerFound);
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

  const handle = async (kind, visits, counter) => {
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

        const dup = await alreadySent({
          kind,
          contactId: patient.contactId || null,
          phone: patient.phone,
        });
        if (dup) { skipped++; continue; }

        const body = composeBody({
          kind,
          patientName: patient.name || "there",
          serviceName: v.service?.name,
          visitDate: v.visitDate,
          clinicName: tenant.name,
        });

        await prisma.smsMessage.create({
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

module.exports = {
  initAppointmentRemindersCron,
  tickAppointmentReminders,
  processTenant, // exported for manual testing
};
