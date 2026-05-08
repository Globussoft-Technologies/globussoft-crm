const router = require('express').Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { computeHash } = require("../lib/audit");

// GET / — list audit logs with optional filtering. ADMIN-only — audit
// rows include the `details` JSON column which carries PII for several
// entity classes (Contact name+email on SOFT_DELETE, wellness Patient
// writes carry richer attributes, etc.). Closes #408.
router.get('/', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const { entity, action } = req.query;
    const where = { tenantId: req.user.tenantId };

    if (entity) where.entity = entity;
    if (action) where.action = action;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(logs);
  } catch (err) {
    console.error('[AuditLog] List error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// GET /verify — walk the audit hash chain for the requesting tenant and
// confirm every row's stored hash equals the recomputed sha256 of
// prevHash + canonicalised row data. Returns the chain length, the id of
// the first row whose hash doesn't validate (or null if clean), and a
// boolean. Used by the AuditLog UI's "Verify chain" button + the daily
// auditIntegrityEngine cron. ADMIN-only. #558.
//
// Rows whose `hash` is null (legacy pre-#558 inserts that pre-date the
// migration) are skipped — they don't break the chain but don't extend
// it either. The first post-migration row's prevHash points at the
// GENESIS sentinel for tenants whose first hashed insert was post-#558.
router.get('/verify', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rows = await prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        userId: true,
        details: true,
        createdAt: true,
        prevHash: true,
        hash: true,
      },
    });

    let chainLength = 0;
    let brokenAt = null;
    let lastHash = null;

    for (const row of rows) {
      // Skip legacy rows (pre-#558) that have no hash — they pre-date
      // the chain so can't be verified, but their absence isn't a break.
      if (row.hash == null) continue;
      chainLength += 1;

      const expectedPrev = lastHash == null ? `GENESIS_${tenantId}` : lastHash;
      // The first hashed row's prevHash must equal the GENESIS sentinel.
      // Subsequent rows' prevHash must equal the prior hashed row's hash.
      if (row.prevHash !== expectedPrev) {
        brokenAt = row.id;
        break;
      }

      const recomputed = computeHash(row.prevHash, {
        tenantId,
        entity: row.entity,
        action: row.action,
        entityId: row.entityId,
        userId: row.userId,
        details: row.details,
        createdAt: row.createdAt.toISOString(),
      });

      if (recomputed !== row.hash) {
        brokenAt = row.id;
        break;
      }

      lastHash = row.hash;
    }

    res.json({
      chainLength,
      brokenAt,
      integrityVerified: brokenAt === null,
      lastVerifiedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[AuditLog] Verify error:', err);
    res.status(500).json({ error: 'Failed to verify audit chain' });
  }
});

module.exports = router;
