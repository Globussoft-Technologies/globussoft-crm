const cron = require('node-cron');
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
};

/**
 * Core retention sweep — purges records older than each tenant's policy.
 * Returns a summary array: [{ tenantId, entity, deleted, cutoff }]
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
        const result = await model.deleteMany({
          where: { tenantId: policy.tenantId, createdAt: { lt: cutoff } },
        });
        const deleted = result?.count || 0;
        summary.push({ tenantId: policy.tenantId, entity: policy.entity, deleted, cutoff });
        if (deleted > 0) {
          console.log(`[Retention] Tenant ${policy.tenantId} — ${policy.entity}: deleted ${deleted} records older than ${policy.retainDays}d (cutoff ${cutoff.toISOString()}).`);
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
              retainDays: policy.retainDays,
              cutoff: cutoff.toISOString(),
              via: 'cron',
            }),
            tenantId: policy.tenantId,
          },
        }).catch(() => { /* best-effort */ });
      } catch (err) {
        console.error(`[Retention] Tenant ${policy.tenantId} — ${policy.entity}: deleteMany failed:`, err.message);
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
function initRetentionCron() {
  cron.schedule('0 3 * * *', () => {
    console.log('[Retention] Cron tick — running daily retention sweep...');
    runRetentionSweep().catch(err => console.error('[Retention] Cron failure:', err));
  });
  console.log('[Retention] Cron scheduled: daily at 03:00.');
}

module.exports = { initRetentionCron, runRetentionSweep };
