const cron = require('node-cron');
const prisma = require("../lib/prisma");

// Map RetentionPolicy.entity → prisma model accessor with deleteMany
const ENTITY_MAP = {
  EmailMessage: prisma.emailMessage,
  CallLog: prisma.callLog,
  Activity: prisma.activity,
  SmsMessage: prisma.smsMessage,
  WhatsAppMessage: prisma.whatsAppMessage,
};

/**
 * Core retention sweep — purges records older than each tenant's policy.
 * Returns a summary array: [{ tenantId, entity, deleted, cutoff }]
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
      const model = ENTITY_MAP[policy.entity];
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
          // Audit
          await prisma.auditLog.create({
            data: {
              action: 'DELETE',
              entity: policy.entity,
              details: JSON.stringify({
                source: 'RetentionEngine',
                deleted,
                retainDays: policy.retainDays,
                cutoff: cutoff.toISOString(),
              }),
              tenantId: policy.tenantId,
            },
          }).catch(() => {});
        }
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
