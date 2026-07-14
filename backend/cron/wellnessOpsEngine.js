/**
 * Wellness ops engine — small recurring background jobs.
 *
 *   - NPS surveys: 3 days after a completed visit, queue an SMS with a survey link.
 *   - Retention: purge Junk-status contacts older than 90 days (per wellness tenant).
 *
 * Both jobs are idempotent and safe to re-run. Nothing is sent to a real
 * SMS provider here — we just queue an SmsMessage row that the existing
 * provider worker will pick up.
 */
const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { getSetting, KEYS } = require("../lib/tenantSettings");

const crypto = require("crypto");

const NPS_DELAY_HOURS = 72;       // 3 days post-visit
const JUNK_RETENTION_DAYS = 90;   // delete junk leads older than this
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";
const MEMBERSHIP_EXPIRY_WINDOW_DAYS = 7; // T-7 expiry notification

// Deep retention thresholds
const PATIENT_DORMANT_MONTHS = 24;  // anonymize patients with no visits in 24 months
const CONSENT_RETENTION_YEARS = 7;  // DPDP: hard-delete consent forms older than 7 years
const CALLLOG_RETENTION_MONTHS = 12; // hard-delete OUTBOUND CallLogs >12 months old with no notes

async function runNpsForTenant(tenantId) {
  const npsDelayHours = await getSetting(tenantId, KEYS.WELLNESS_NPS_DELAY_HOURS, { fallback: NPS_DELAY_HOURS, coerce: Number });
  const cutoff = new Date(Date.now() - npsDelayHours * 3600000);
  const visits = await prisma.visit.findMany({
    where: {
      tenantId,
      status: "completed",
      visitDate: { gte: new Date(Date.now() - 14 * 86400000), lte: cutoff },
    },
    select: {
      id: true, visitDate: true,
      patient: { select: { id: true, name: true, phone: true } },
      service: { select: { name: true } },
      doctor:  { select: { id: true, name: true } },
    },
    take: 200,
  });

  let sent = 0;
  for (const v of visits) {
    if (!v.patient?.phone) continue;
    // Have we already created a survey for this visit? We tag the survey title.
    const tag = `nps-visit-${v.id}`;
    const survey = await prisma.survey.upsert({
      where: { tenantId_name: { tenantId, name: tag } },
      update: {},
      create: {
        name: tag,
        type: "NPS",
        question: `How was your ${v.service?.name || "visit"} with us? Reply 0-10 (10 = loved it).`,
        tenantId,
      },
    });

    // Idempotency: skip SMS if one already exists for this visit.
    // Survey is upserted above, so survey.id is stable per visit.
    const existingSms = await prisma.smsMessage.findFirst({
      where: {
        to: v.patient.phone,
        body: { contains: `${PORTAL_BASE}/survey/${survey.id}` },
        direction: "OUTBOUND",
      },
    });
    if (existingSms) continue;

    const link = `${PORTAL_BASE}/survey/${survey.id}?p=${v.patient.id}`;
    await prisma.smsMessage.create({
      data: {
        to: v.patient.phone,
        body: `Hi ${v.patient.name}, hope you're doing well after your visit on ${v.visitDate.toLocaleDateString("en-IN")}. Quick 1-question survey: ${link} — Enhanced Wellness`,
        direction: "OUTBOUND",
        status: "QUEUED",
        contactId: null,
        tenantId,
      },
    });
    sent++;
  }
  return sent;
}

async function runRetentionForTenant(tenantId) {
  const junkRetentionDays = await getSetting(tenantId, KEYS.WELLNESS_JUNK_RETENTION_DAYS, { fallback: JUNK_RETENTION_DAYS, coerce: Number });
  const cutoff = new Date(Date.now() - junkRetentionDays * 86400000);
  const result = await prisma.contact.deleteMany({
    where: { tenantId, status: "Junk", createdAt: { lt: cutoff } },
  });
  return result.count;
}

// Deep retention: DPDP-aligned data minimisation.
//   1. Anonymize Patient PII for patients with NO visits in last 24 months.
//      Replace name/phone/email with stable hashes so the row remains
//      referentially intact (visits/consents still link) but PII is gone.
//   2. Hard-delete ConsentForm rows older than 7 years.
//   3. Hard-delete OUTBOUND CallLog rows older than 12 months with null notes.
//
// Idempotent: anonymized patients have an "ANON-" prefix on name; we skip
// them on subsequent runs.
function hashFor(prefix, idOrValue) {
  const h = crypto.createHash("sha256").update(`${prefix}:${idOrValue}`).digest("hex").slice(0, 12);
  return `${prefix}${h}`;
}

// PRD Gap §12 #4d — fire one Notification per membership when endDate
// is in [now, now+7d] and we haven't already notified for that membership.
// Targets every ADMIN/MANAGER in the tenant (mirrors lowStockEngine pattern;
// patients are not Users so direct patient-bell targeting isn't possible
// without a portal-user join — managers/owners is the right operational
// audience anyway, since they own renewal upsell). Idempotency via
// Membership.expiryNotifiedAt: stamped on first fire, query filters it
// out on subsequent ticks.
async function runMembershipExpiryForTenant(tenantId) {
  const now = new Date();
  const membershipExpiryWindowDays = await getSetting(tenantId, KEYS.WELLNESS_MEMBERSHIP_EXPIRY_WINDOW_DAYS, { fallback: MEMBERSHIP_EXPIRY_WINDOW_DAYS, coerce: Number });
  const windowEnd = new Date(now.getTime() + membershipExpiryWindowDays * 86400000);

  const expiring = await prisma.membership.findMany({
    where: {
      tenantId,
      status: "active",
      expiryNotifiedAt: null,
      endDate: { gte: now, lte: windowEnd },
    },
    include: {
      patient: { select: { id: true, name: true } },
      plan: { select: { id: true, name: true } },
    },
    take: 500,
  });

  if (expiring.length === 0) return { notified: 0, notifications: 0 };

  const recipients = await prisma.user.findMany({
    where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });

  let notified = 0;
  let notifications = 0;

  for (const m of expiring) {
    try {
      const daysLeft = Math.max(
        0,
        Math.ceil((new Date(m.endDate).getTime() - now.getTime()) / 86400000),
      );
      const planName = m.plan?.name || "Membership";
      const patientName = m.patient?.name || `Patient #${m.patientId}`;
      const title = `Membership expiring: ${patientName}`;
      const message = `${planName} for ${patientName} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${new Date(m.endDate).toLocaleDateString("en-IN")}). Reach out for renewal.`;
      const link = `/wellness/patients/${m.patientId}`;

      if (recipients.length > 0) {
        await prisma.notification.createMany({
          data: recipients.map((u) => ({
            tenantId,
            userId: u.id,
            title,
            message,
            type: "warning",
            link,
          })),
        });
        notifications += recipients.length;
      }

      // Stamp marker AFTER the notifications insert so a transient failure
      // above leaves expiryNotifiedAt=null and the next tick retries.
      await prisma.membership.update({
        where: { id: m.id },
        data: { expiryNotifiedAt: now },
      });

      // v3.7.3 — emit `membership.renewal_due` so user-configured workflow
      // rules can hook in (e.g. send_email to the patient, queue an SMS).
      // Fires AFTER the expiryNotifiedAt stamp so the event is at-most-once
      // per membership row (the next tick filters out marker-stamped rows).
      //
      // v3.7.5 — awaited + try/catch so a workflow-rule failure (or, in
      // unit tests, the absence of DATABASE_URL when emitEvent calls
      // `prisma.automationRule.findMany`) doesn't surface as an Unhandled
      // Rejection and trip the vitest run. Without the await, the catch
      // block only saw synchronous throws — the async rejection bubbled
      // up uncaught and v3.7.5's unit_tests gate caught it.
      try {
        await require("../lib/eventBus").emitEvent(
          "membership.renewal_due",
          {
            membershipId: m.id,
            patientId: m.patientId,
            patientName,
            planId: m.planId,
            planName,
            daysLeft,
            endDate: m.endDate,
          },
          tenantId,
        );
      } catch (eventErr) {
        console.warn(
          `[WellnessOps][membership-expiry] tenant=${tenantId} membership=${m.id} event emit failed:`,
          eventErr.message,
        );
      }

      notified++;
    } catch (e) {
      console.error(
        `[WellnessOps][membership-expiry] tenant=${tenantId} membership=${m.id} failed:`,
        e.message,
      );
    }
  }

  return { notified, notifications };
}

async function runDeepRetentionForTenant(tenantId) {
  const now = Date.now();
  const dormantCutoff = new Date(now - PATIENT_DORMANT_MONTHS * 30 * 86400000);
  const consentCutoff = new Date(now - CONSENT_RETENTION_YEARS * 365 * 86400000);
  const callLogCutoff = new Date(now - CALLLOG_RETENTION_MONTHS * 30 * 86400000);

  // ── 1. Anonymize dormant patients ──────────────────────────────────
  // Find candidates: tenant patients whose latest visit (if any) is older
  // than the cutoff. Patients with no visits at all are also candidates if
  // they were created before the cutoff. Skip already-anonymized.
  const candidates = await prisma.patient.findMany({
    where: {
      tenantId,
      NOT: { name: { startsWith: "ANON-" } },
      // Created before the dormant cutoff, AND no recent visits
      createdAt: { lt: dormantCutoff },
      visits: { none: { visitDate: { gte: dormantCutoff } } },
    },
    select: { id: true },
    take: 500, // batch cap to avoid runaway runs
  });

  let anonymized = 0;
  for (const p of candidates) {
    await prisma.patient.update({
      where: { id: p.id },
      data: {
        name: hashFor("ANON-", p.id),
        phone: hashFor("anon-", p.id),
        email: `${hashFor("anon-", p.id)}@anon.local`,
      },
    });
    anonymized++;
  }

  // ── 2. Hard-delete ConsentForm rows >7 years old ───────────────────
  const consentDel = await prisma.consentForm.deleteMany({
    where: { tenantId, signedAt: { lt: consentCutoff } },
  });

  // ── 3. Hard-delete stale OUTBOUND CallLogs ─────────────────────────
  const callLogDel = await prisma.callLog.deleteMany({
    where: {
      tenantId,
      direction: "OUTBOUND",
      notes: null,
      createdAt: { lt: callLogCutoff },
    },
  });

  return {
    anonymized,
    consentsDeleted: consentDel.count,
    callLogsDeleted: callLogDel.count,
  };
}

async function runOpsForAllWellnessTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "wellness", isActive: true },
    select: { id: true, slug: true },
  });
  for (const t of tenants) {
    try {
      const npsSent  = await runNpsForTenant(t.id);
      const purged   = await runRetentionForTenant(t.id);
      const deep     = await runDeepRetentionForTenant(t.id);
      const expiry   = await runMembershipExpiryForTenant(t.id);
      if (npsSent || purged || deep.anonymized || deep.consentsDeleted || deep.callLogsDeleted || expiry.notified) {
        console.log(
          `[WellnessOps] tenant ${t.slug}: ${npsSent} NPS sent, ${purged} junk leads purged, ` +
          `${deep.anonymized} patients anonymized, ${deep.consentsDeleted} consents deleted, ` +
          `${deep.callLogsDeleted} call logs deleted, ${expiry.notified} memberships flagged expiring`
        );
      }
    } catch (e) {
      console.error("[WellnessOps] tenant fail:", t.slug, e.message);
    }
  }
}

function initWellnessOpsCron() {
  // Hourly — NPS sends are time-sensitive (catch the 72h window cleanly)
  cronRegistry.register({
    name: "wellnessOpsEngine",
    description: "Hourly wellness NPS survey (72h post-visit) + 90-day junk-lead retention purge",
    defaultSchedule: "17 * * * *",
    tickFn: runOpsForAllWellnessTenants,
  }).catch((e) => console.error("[WellnessOps] cronRegistry registration failed:", e.message));
}

module.exports = {
  initWellnessOpsCron,
  runNpsForTenant,
  runRetentionForTenant,
  runDeepRetentionForTenant,
  runMembershipExpiryForTenant,
};
