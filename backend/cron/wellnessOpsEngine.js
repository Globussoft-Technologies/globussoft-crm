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

const NPS_DELAY_HOURS = 72;       // 3 days post-visit
const JUNK_RETENTION_DAYS = 90;   // delete junk leads older than this
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

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
    const existing = await prisma.survey.findFirst({ where: { tenantId, title: tag } });
    if (existing) continue;

    const survey = await prisma.survey.create({
      data: {
        title: tag,
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

async function runOpsForAllWellnessTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "wellness", isActive: true },
    select: { id: true, slug: true },
  });
  for (const t of tenants) {
    try {
      const npsSent  = await runNpsForTenant(t.id);
      const purged   = await runRetentionForTenant(t.id);
      if (npsSent || purged) {
        console.log(`[WellnessOps] tenant ${t.slug}: ${npsSent} NPS sent, ${purged} junk leads purged`);
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

module.exports = { initWellnessOpsCron, runNpsForTenant, runRetentionForTenant };
