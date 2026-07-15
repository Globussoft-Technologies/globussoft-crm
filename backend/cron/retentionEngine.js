const cronRegistry = require('../lib/cronRegistry');
const prisma = require("../lib/prisma");

// Map RetentionPolicy.entity → prisma model property name. Resolved
// lazily (prisma[propName]) at sweep time rather than eagerly captured
// at module load — important so unit tests can monkey-patch the prisma
// singleton's model accessors AFTER importing this module without
// fighting a stale captured reference.
const ENTITY_MAP = {
  EmailMessage: 'emailMessage',
  CallLog: 'callLog',
  Activity: 'activity',
  SmsMessage: 'smsMessage',
  WhatsAppMessage: 'whatsAppMessage',
  // #576 — clinical / medical records (wellness vertical). DPDP /
  // clinical-records norm in India is 7 years (consents must outlive
  // the engagement); Patient is 10 years for conservativeness.
  Patient: 'patient',
  Visit: 'visit',
  Prescription: 'prescription',
  ConsentForm: 'consentForm',
  TreatmentPlan: 'treatmentPlan',
  MedicalAttachment: 'attachment',
  // Gap A4 (Q14, travel vertical) — per-type document/communication/
  // financial retention. TRAVEL_CRM_PRD.md §4.7 / Q14 accepted GS
  // defaults: passport/Aadhaar/PAN docs 24m post-trip, call recordings
  // 12m, financial 84m, diagnostic responses = lifetime of profile.
  //
  //   ContactAttachment — uploaded identity documents (passport scans,
  //     Aadhaar, PAN). TripParticipant.passportDocId points at a
  //     ContactAttachment row (bare Int, no enforced FK), so purging the
  //     attachment removes the document file reference while keeping the
  //     trip roster intact. Engine cuts on createdAt — "post-trip"
  //     anchoring is approximated by upload date (documented residual).
  //   VoiceSession — telephony sessions carrying recordingUrl +
  //     transcript (call-recording retention, alongside CallLog which is
  //     already mapped above).
  //   TravelInvoice — financial records. Guarded by ENTITY_GUARDS below
  //     so open receivables (Issued / Partial) are NEVER auto-purged.
  //
  // TravelDiagnostic is INTENTIONALLY absent — Q14 mandates lifetime-of-
  // profile retention for diagnostic responses, and the engine's
  // "unknown entity → skip + warn" behaviour makes absence a hard
  // never-purge guarantee even if a policy row were created manually.
  ContactAttachment: 'contactAttachment',
  VoiceSession: 'voiceSession',
  TravelInvoice: 'travelInvoice',
};

// Gap A4 (Q14) — per-entity extra where-conditions merged into the
// hard-delete filter. Spread FIRST in the where clause so the mandatory
// tenantId + createdAt scoping can never be overridden by a guard.
//
// TravelInvoice: allowlist of terminal/abandoned states. 'Issued' and
// 'Partial' (open receivables — money still owed or under dispute) are
// excluded so the 84-month financial sweep never destroys an unpaid or
// disputed invoice, mirroring the route layer's DELETE handler which
// only permits Draft deletion (routes/travel_invoices.js,
// INVOICE_DELETE_FORBIDDEN). Hard-deleting a TravelInvoice cascades to
// TravelInvoiceLine + TravelPaymentSchedule (schema onDelete: Cascade);
// child credit-notes survive via parentInvoiceId onDelete: SetNull.
const ENTITY_GUARDS = {
  TravelInvoice: { status: { in: ['Draft', 'Paid', 'Voided'] } },
};

// #628 + #576 — entities that support soft-delete (have a `deletedAt`
// column). The retention engine's first pass on these entities sets
// deletedAt; the second pass (after `retainDays * 1.5` — the tombstone
// window) does the actual hard-delete. Entities NOT in this set are
// hard-deleted directly on the configured retainDays cutoff.
const SOFT_DELETE_ENTITIES = new Set(['Patient']);
const TOMBSTONE_MULTIPLIER = 1.5;

/**
 * Core retention sweep — purges records older than each tenant's policy.
 * Returns a summary array: [{ tenantId, entity, deleted, softDeleted, cutoff }]
 *
 * Why we always write the AuditLog row (even on deleted=0): GDPR Art. 30
 * + SOC-2 require a complete trail of when retention was *attempted*, not
 * just when it actually deleted. Previously the engine only wrote an
 * AuditLog when `deleted > 0`, which left a 30-day stretch of no-op runs
 * indistinguishable from "the cron never ran" in an audit. The manual
 * trigger in routes/gdpr.js (POST /api/gdpr/retention/run, G-11 commit
 * cb96793) already writes regardless; the cron path now matches the same
 * contract. The `via:'cron'` marker in details lets audit consumers
 * distinguish automated sweeps from human-triggered ones. Closes #411.
 */
async function runRetentionSweep() {
  const summary = [];
  try {
    const policies = await prisma.retentionPolicy.findMany({ where: { isActive: true } });
    if (policies.length === 0) {
      console.log('[Retention] No active retention policies — skipping.');
      return summary;
    }

    for (const policy of policies) {
      const propName = ENTITY_MAP[policy.entity];
      const model = propName ? prisma[propName] : null;
      if (!model) {
        console.warn(`[Retention] Unknown entity in policy: ${policy.entity}`);
        continue;
      }
      const cutoff = new Date(Date.now() - policy.retainDays * 24 * 60 * 60 * 1000);
      try {
        let deleted = 0;
        let softDeleted = 0;
        const isSoftDelete = SOFT_DELETE_ENTITIES.has(policy.entity);
        if (isSoftDelete) {
          // Two-phase purge for soft-delete-aware entities (#628 + #576).
          // Phase 1: rows older than `cutoff` AND not already soft-deleted
          //          → set deletedAt = now (tombstone).
          // Phase 2: rows whose deletedAt < (now - retainDays * 1.5)
          //          → hard-delete.
          const tombstoneCutoff = new Date(
            Date.now() - policy.retainDays * TOMBSTONE_MULTIPLIER * 24 * 60 * 60 * 1000
          );
          const softResult = await model.updateMany({
            where: {
              tenantId: policy.tenantId,
              createdAt: { lt: cutoff },
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
          softDeleted = softResult?.count || 0;
          const hardResult = await model.deleteMany({
            where: {
              tenantId: policy.tenantId,
              deletedAt: { lt: tombstoneCutoff, not: null },
            },
          });
          deleted = hardResult?.count || 0;
        } else {
          // Per-entity guard (ENTITY_GUARDS) merged in FIRST — the
          // tenantId scope + createdAt cutoff are spread last so a guard
          // can never widen the sweep beyond the policy's tenant/window.
          const guard = ENTITY_GUARDS[policy.entity] || {};
          const result = await model.deleteMany({
            where: { ...guard, tenantId: policy.tenantId, createdAt: { lt: cutoff } },
          });
          deleted = result?.count || 0;
        }
        summary.push({ tenantId: policy.tenantId, entity: policy.entity, deleted, softDeleted, cutoff });
        if (deleted > 0 || softDeleted > 0) {
          console.log(`[Retention] Tenant ${policy.tenantId} — ${policy.entity}: deleted ${deleted}, soft-deleted ${softDeleted} (cutoff ${cutoff.toISOString()}, retainDays=${policy.retainDays}).`);
        }
        // Always write an AuditLog row — even when deleted=0 — so the
        // sweep attempt is captured for GDPR/SOC-2 trail compliance. The
        // `deleted` count is included in details so downstream consumers
        // can filter no-op runs from real deletions.
        await prisma.auditLog.create({
          data: {
            action: 'DELETE',
            entity: policy.entity,
            details: JSON.stringify({
              source: 'RetentionEngine',
              deleted,
              softDeleted,
              retainDays: policy.retainDays,
              cutoff: cutoff.toISOString(),
              via: 'cron',
            }),
            tenantId: policy.tenantId,
          },
        }).catch(() => { /* best-effort */ });
      } catch (err) {
        console.error(`[Retention] Tenant ${policy.tenantId} — ${policy.entity}: sweep failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Retention] Sweep error:', err);
  }
  return summary;
}

/**
 * Initialize the retention cron job (daily at 03:00 server time).
 * Wire this in server.js: `require('./cron/retentionEngine').initRetentionCron()`.
 */
async function tick() {
  console.log('[Retention] Cron tick — running daily retention sweep...');
  return runRetentionSweep();
}

function initRetentionCron() {
  cronRegistry.register({
    name: 'retentionEngine',
    description: 'Daily GDPR/DPDP retention sweep — purges rows past their RetentionPolicy window',
    defaultSchedule: '0 3 * * *',
    tickFn: tick,
  }).catch((e) => console.error('[Retention] cronRegistry registration failed:', e.message));
}

// #576 — default retention windows for new wellness tenants. Matches
// the issue's product call: 7y for clinical records, 10y for Patient
// (slightly more conservative — patient-identity outlives the chart).
// 2555 days = ~7y; 3650 days = ~10y. isActive=false by default — admins
// must explicitly enable purge from /privacy.
const WELLNESS_DEFAULT_POLICIES = [
  { entity: 'Patient', retainDays: 3650, isActive: false },
  { entity: 'Visit', retainDays: 2555, isActive: false },
  { entity: 'Prescription', retainDays: 2555, isActive: false },
  { entity: 'ConsentForm', retainDays: 2555, isActive: false },
  { entity: 'TreatmentPlan', retainDays: 2555, isActive: false },
  { entity: 'MedicalAttachment', retainDays: 2555, isActive: false },
];

/**
 * Idempotent seed — for a given wellness tenantId, ensure the 6 medical
 * RetentionPolicy rows exist. Re-runnable; existing rows are left alone
 * so admins keep their tweaks. Used by:
 *   - prisma/seed-wellness.js on tenant create
 *   - one-time migration callable for existing wellness tenants
 */
async function seedWellnessRetentionPolicies(tenantId) {
  if (!tenantId) return [];
  const created = [];
  for (const p of WELLNESS_DEFAULT_POLICIES) {
    const existing = await prisma.retentionPolicy.findUnique({
      where: { tenantId_entity: { tenantId, entity: p.entity } },
    }).catch(() => null);
    if (existing) continue;
    const row = await prisma.retentionPolicy.create({
      data: { tenantId, entity: p.entity, retainDays: p.retainDays, isActive: p.isActive },
    }).catch(() => null);
    if (row) created.push(row);
  }
  return created;
}

// Gap A4 — default retention windows for travel tenants per
// TRAVEL_CRM_PRD.md §4.7 + Q14 (accepted GS defaults):
//   passport / Aadhaar / PAN documents  →  24 months post-trip
//   call recordings                     →  12 months
//   financial records                   →  84 months (~7y)
//   diagnostic responses                →  lifetime of profile (NO row)
// 730 days = 24m; 365 days = 12m; 2555 days = ~84m/7y (same constant the
// wellness clinical defaults use for 7y). isActive=false by default —
// admins must explicitly enable purge from /privacy, matching the
// wellness convention above.
//
// TravelDiagnostic deliberately has NO policy row here (and no
// ENTITY_MAP entry) — Q14 sets diagnostic responses to lifetime-of-
// profile retention, and "no policy row" is the engine's never-purge
// representation.
const TRAVEL_DEFAULT_POLICIES = [
  // Identity documents (passport/Aadhaar/PAN uploads live in
  // ContactAttachment; TripParticipant.passportDocId references them).
  { entity: 'ContactAttachment', retainDays: 730, isActive: false },
  // Call recordings — both telephony surfaces.
  { entity: 'CallLog', retainDays: 365, isActive: false },
  { entity: 'VoiceSession', retainDays: 365, isActive: false },
  // Financial records — sweep guarded by ENTITY_GUARDS.TravelInvoice so
  // open receivables (Issued/Partial) are never auto-purged.
  { entity: 'TravelInvoice', retainDays: 2555, isActive: false },
];

/**
 * Idempotent seed — for a given travel tenantId, ensure the 4 Q14
 * RetentionPolicy rows exist. Re-runnable; existing rows are left alone
 * so admins keep their tweaks. Used by prisma/seed-travel.js on tenant
 * create (mirrors seedWellnessRetentionPolicies above).
 */
async function seedTravelRetentionPolicies(tenantId) {
  if (!tenantId) return [];
  const created = [];
  for (const p of TRAVEL_DEFAULT_POLICIES) {
    const existing = await prisma.retentionPolicy.findUnique({
      where: { tenantId_entity: { tenantId, entity: p.entity } },
    }).catch(() => null);
    if (existing) continue;
    const row = await prisma.retentionPolicy.create({
      data: { tenantId, entity: p.entity, retainDays: p.retainDays, isActive: p.isActive },
    }).catch(() => null);
    if (row) created.push(row);
  }
  return created;
}

module.exports = {
  initRetentionCron,
  runRetentionSweep,
  ENTITY_MAP,
  ENTITY_GUARDS,
  SOFT_DELETE_ENTITIES,
  WELLNESS_DEFAULT_POLICIES,
  seedWellnessRetentionPolicies,
  TRAVEL_DEFAULT_POLICIES,
  seedTravelRetentionPolicies,
};
