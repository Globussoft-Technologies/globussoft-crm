const router = require('express').Router();
const { verifyToken, verifyRole } = require('../middleware/auth');

const prisma = require("../lib/prisma");

// Admin/Manager only — audit log viewer
router.use(verifyToken, verifyRole(["ADMIN", "MANAGER"]));

// Build a Prisma `where` clause from query params, scoped to the caller's tenant.
function buildWhere(req) {
  const { entity, action, userId, from, to } = req.query;
  const where = { tenantId: req.user.tenantId };

  if (entity) where.entity = entity;
  if (action) where.action = action;
  if (userId) {
    const uid = parseInt(userId, 10);
    if (!Number.isNaN(uid)) where.userId = uid;
  }
  if (from || to) {
    where.createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) where.createdAt.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) where.createdAt.lte = d;
    }
  }
  return where;
}

// GET / — paginated list of audit logs
router.get('/', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const where = buildWhere(req);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      logs,
      total,
      pages: Math.max(Math.ceil(total / limit), 1),
      page,
      limit,
    });
  } catch (err) {
    console.error('[AuditViewer] List error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// GET /stats — last 30 days aggregate stats for the current tenant
router.get('/stats', async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const baseWhere = { tenantId: req.user.tenantId, createdAt: { gte: since } };

    const [byAction, byEntity, byUser, total] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ['action'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.auditLog.groupBy({
        by: ['entity'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { entity: 'desc' } },
        take: 10,
      }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where: { ...baseWhere, userId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 5,
      }),
      prisma.auditLog.count({ where: baseWhere }),
    ]);

    // Hydrate user details for top users
    const userIds = byUser.map(u => u.userId).filter(Boolean);
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const counts = { CREATE: 0, UPDATE: 0, DELETE: 0 };
    for (const row of byAction) {
      counts[row.action] = row._count._all;
    }

    res.json({
      total,
      since,
      byAction: counts,
      byEntity: byEntity.map(e => ({ entity: e.entity, count: e._count._all })),
      topUsers: byUser.map(u => ({
        userId: u.userId,
        count: u._count._all,
        user: userMap[u.userId] || null,
      })),
    });
  } catch (err) {
    console.error('[AuditViewer] Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch audit stats' });
  }
});

// GET /entity/:entity/:id — full audit trail for a single record
router.get('/entity/:entity/:id', async (req, res) => {
  try {
    const entityId = parseInt(req.params.id, 10);
    if (Number.isNaN(entityId)) {
      return res.status(400).json({ error: 'Invalid entity id' });
    }

    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        entity: req.params.entity,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ logs, entity: req.params.entity, entityId });
  } catch (err) {
    console.error('[AuditViewer] Entity trail error:', err);
    res.status(500).json({ error: 'Failed to fetch entity audit trail' });
  }
});

// CSV escaping — wraps in quotes and doubles internal quotes
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// GET /export.csv — CSV export of filtered audit logs (capped at 10k rows)
router.get('/export.csv', async (req, res) => {
  try {
    const where = buildWhere(req);
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const header = ['ID', 'Timestamp', 'Action', 'Entity', 'EntityId', 'UserName', 'UserEmail', 'Details'];
    const rows = logs.map(l => [
      l.id,
      l.createdAt ? new Date(l.createdAt).toISOString() : '',
      l.action,
      l.entity,
      l.entityId ?? '',
      l.user ? l.user.name : '',
      l.user ? l.user.email : '',
      l.details || '',
    ].map(csvCell).join(','));

    const csv = [header.join(','), ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=audit-log.csv');
    res.send(csv);
  } catch (err) {
    console.error('[AuditViewer] CSV export error:', err);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

module.exports = router;
