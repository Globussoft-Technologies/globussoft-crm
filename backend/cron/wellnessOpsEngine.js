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
const cron = require("node-cron");
const prisma = require("../lib/prisma");

const crypto = require("crypto");

const NPS_DELAY_HOURS = 72;       // 3 days post-visit
const JUNK_RETENTION_DAYS = 90;   // delete junk leads older than this
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

// Deep retention thresholds
const PATIENT_DORMANT_MONTHS = 24;  // anonymize patients with no visits in 24 months
const CONSENT_RETENTION_YEARS = 7;  // DPDP: hard-delete consent forms older than 7 years
const CALLLOG_RETENTION_MONTHS = 12; // hard-delete OUTBOUND CallLogs >12 months old with no notes

async function runNpsForTenant(tenantId) {
  const cutoff = new Date(Date.now() - NPS_DELAY_HOURS * 3600000);
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
    const existing = await prisma.survey.findFirst({ where: { tenantId, name: tag } });
    if (existing) continue;

    const survey = await prisma.survey.create({
      data: {
        name: tag,
        type: "NPS",
        question: `How was your ${v.service?.name || "visit"} with us? Reply 0-10 (10 = loved it).`,
        tenantId,
      },
    });

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
  const cutoff = new Date(Date.now() - JUNK_RETENTION_DAYS * 86400000);
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
      if (npsSent || purged || deep.anonymized || deep.consentsDeleted || deep.callLogsDeleted) {
        console.log(
          `[WellnessOps] tenant ${t.slug}: ${npsSent} NPS sent, ${purged} junk leads purged, ` +
          `${deep.anonymized} patients anonymized, ${deep.consentsDeleted} consents deleted, ` +
          `${deep.callLogsDeleted} call logs deleted`
        );
      }
    } catch (e) {
      console.error("[WellnessOps] tenant fail:", t.slug, e.message);
    }
  }
}

function initWellnessOpsCron() {
  // Hourly — NPS sends are time-sensitive (catch the 72h window cleanly)
  cron.schedule("17 * * * *", () => {
    runOpsForAllWellnessTenants().catch((e) => console.error("[WellnessOps] cron fail:", e.message));
  });
  console.log("[WellnessOps] cron initialized (hourly NPS + retention)");
}

module.exports = {
  initWellnessOpsCron,
  runNpsForTenant,
  runRetentionForTenant,
  runDeepRetentionForTenant,
};
