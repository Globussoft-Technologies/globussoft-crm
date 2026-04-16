const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// GET / — list audit logs with optional filtering
router.get('/', async (req, res) => {
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
