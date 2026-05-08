const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { computeHash } = require('../lib/audit');

// Daily integrity sweep — for every tenant, walk the audit hash chain and
// emit an AUDIT_INTEGRITY row recording {chainLength, brokenAt, head}. The
// row itself is hash-chained on top of the chain it just verified, so the
// next day's sweep proves the previous day's integrity row also wasn't
// retroactively edited. If a break is detected the row is still emitted
// (with brokenAt populated) so a human reviewer of /audit-log sees the
// alarm even if /api/audit/verify hasn't been clicked. #558.

async function runAuditIntegritySweep() {
  const summary = [];
  try {
    // Distinct tenants that own at least one audit row.
    const tenants = await prisma.auditLog.findMany({
      distinct: ['tenantId'],
      select: { tenantId: true },
    });

    for (const { tenantId } of tenants) {
      const rows = await prisma.auditLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, action: true, entity: true, entityId: true, userId: true,
          details: true, createdAt: true, prevHash: true, hash: true,
        },
      });

      let chainLength = 0;
      let brokenAt = null;
      let lastHash = null;

      for (const row of rows) {
        if (row.hash == null) continue;
        chainLength += 1;
        const expectedPrev = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
        if (row.prevHash !== expectedPrev) { brokenAt = row.id; break; }
        const recomputed = computeHash(row.prevHash, {
          tenantId, entity: row.entity, action: row.action,
          entityId: row.entityId, userId: row.userId,
          details: row.details, createdAt: row.createdAt.toISOString(),
        });
        if (recomputed !== row.hash) { brokenAt = row.id; break; }
        lastHash = row.hash;
      }

      // Emit AUDIT_INTEGRITY row via prisma directly (NOT writeAudit) — we
      // want to record the head we just verified BEFORE anyone else writes,
      // so the next sweep can detect retroactive edits to today's chain.
      // Using writeAudit would re-look-up the head (creating a race window).
      const detailsStr = JSON.stringify({
        source: 'AuditIntegrityEngine',
        chainLength,
        brokenAt,
        head: lastHash,
        verifiedAt: new Date().toISOString(),
      });
      const createdAt = new Date();
      const prevHash = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
      const hash = computeHash(prevHash, {
        tenantId, entity: 'AuditLog', action: 'AUDIT_INTEGRITY',
        entityId: null, userId: null, details: detailsStr,
        createdAt: createdAt.toISOString(),
      });
      await prisma.auditLog.create({
        data: {
          action: 'AUDIT_INTEGRITY',
          entity: 'AuditLog',
          entityId: null,
          userId: null,
          tenantId,
          details: detailsStr,
          createdAt,
          prevHash,
          hash,
        },
      }).catch((err) => {
        console.error(`[AuditIntegrity] Failed to emit row for tenant ${tenantId}:`, err.message);
      });

      summary.push({ tenantId, chainLength, brokenAt });
      if (brokenAt !== null) {
        console.error(`[AuditIntegrity] !!! Tenant ${tenantId} chain BROKEN at row id=${brokenAt} (chainLength=${chainLength})`);
      }
    }
  } catch (err) {
    console.error('[AuditIntegrity] Sweep error:', err);
  }
  return summary;
}

function initAuditIntegrityCron() {
  // Daily at 04:00 server time (after the 03:00 retention sweep has finished
  // so we record the post-retention chain head).
  cron.schedule('0 4 * * *', () => {
    console.log('[AuditIntegrity] Cron tick — running daily integrity sweep...');
    runAuditIntegritySweep().catch((err) =>
      console.error('[AuditIntegrity] Cron failure:', err)
    );
  });
  console.log('[AuditIntegrity] Cron scheduled: daily at 04:00.');
}

module.exports = { initAuditIntegrityCron, runAuditIntegritySweep };
