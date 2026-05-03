const router = require('express').Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

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

module.exports = router;
