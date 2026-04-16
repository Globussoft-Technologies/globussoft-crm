const express = require('express');
const prisma = require('../lib/prisma');
const { verifyToken, verifyRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// ─── Helpers ───────────────────────────────────────────────────────

const parseLayout = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) || []; } catch { return []; }
};

const serializeDashboard = (d) => ({
  ...d,
  layout: parseLayout(d.layout),
});

// Tenant-scoped fetch — make sure user can read/write within their tenant.
const findTenantDashboard = async (id, tenantId) => {
  return prisma.dashboard.findFirst({ where: { id, tenantId } });
};

// ─── CRUD ──────────────────────────────────────────────────────────

// GET / — list dashboards for current user (their own + tenant default)
router.get('/', async (req, res) => {
  try {
    const { tenantId, id: userId } = req.user;
    const dashboards = await prisma.dashboard.findMany({
      where: {
        tenantId,
        OR: [
          { userId },
          { userId: null },
          { isDefault: true },
        ],
      },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    res.json(dashboards.map(serializeDashboard));
  } catch (err) {
    console.error('[dashboards] list failed', err);
    res.status(500).json({ error: 'Failed to fetch dashboards' });
  }
});

// GET /:id — fetch a single dashboard (tenant-scoped)
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid dashboard ID' });
    const dashboard = await findTenantDashboard(id, req.user.tenantId);
    if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
    res.json(serializeDashboard(dashboard));
  } catch (err) {
    console.error('[dashboards] get failed', err);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// POST / — create new dashboard
router.post('/', async (req, res) => {
  try {
    const { name, layout = [] } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Dashboard name is required' });
    }
    const created = await prisma.dashboard.create({
      data: {
        name,
        layout: JSON.stringify(Array.isArray(layout) ? layout : []),
        userId: req.user.id || null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(serializeDashboard(created));
  } catch (err) {
    console.error('[dashboards] create failed', err);
    res.status(500).json({ error: 'Failed to create dashboard' });
  }
});

// PUT /:id — update layout/name (tenant check)
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid dashboard ID' });
    const existing = await findTenantDashboard(id, req.user.tenantId);
    if (!existing) return res.status(404).json({ error: 'Dashboard not found' });

    const { name, layout } = req.body || {};
    const data = {};
    if (typeof name === 'string') data.name = name;
    if (layout !== undefined) {
      data.layout = JSON.stringify(Array.isArray(layout) ? layout : parseLayout(layout));
    }

    const updated = await prisma.dashboard.update({ where: { id }, data });
    res.json(serializeDashboard(updated));
  } catch (err) {
    console.error('[dashboards] update failed', err);
    res.status(500).json({ error: 'Failed to update dashboard' });
  }
});

// DELETE /:id — tenant check
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid dashboard ID' });
    const existing = await findTenantDashboard(id, req.user.tenantId);
    if (!existing) return res.status(404).json({ error: 'Dashboard not found' });
    await prisma.dashboard.delete({ where: { id } });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('[dashboards] delete failed', err);
    res.status(500).json({ error: 'Failed to delete dashboard' });
  }
});

// POST /:id/set-default — admin-only, set tenant default
router.post('/:id/set-default', verifyRole(['ADMIN']), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid dashboard ID' });
    const existing = await findTenantDashboard(id, req.user.tenantId);
    if (!existing) return res.status(404).json({ error: 'Dashboard not found' });

    await prisma.$transaction([
      prisma.dashboard.updateMany({
        where: { tenantId: req.user.tenantId, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.dashboard.update({ where: { id }, data: { isDefault: true } }),
    ]);

    const fresh = await prisma.dashboard.findUnique({ where: { id } });
    res.json(serializeDashboard(fresh));
  } catch (err) {
    console.error('[dashboards] set-default failed', err);
    res.status(500).json({ error: 'Failed to set default dashboard' });
  }
});

// ─── Widget Data Resolver ──────────────────────────────────────────

async function resolveWidget(type, tenantId) {
  const tenantWhere = { tenantId };

  switch (type) {
    case 'kpi-revenue': {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const agg = await prisma.deal.aggregate({
        _sum: { amount: true },
        where: { ...tenantWhere, stage: 'won', createdAt: { gte: since } },
      });
      return { value: agg._sum.amount || 0, label: 'Revenue (30d)' };
    }

    case 'kpi-deals': {
      const count = await prisma.deal.count({
        where: { ...tenantWhere, stage: { notIn: ['won', 'lost'] } },
      });
      return { value: count, label: 'Open Deals' };
    }

    case 'kpi-contacts': {
      const count = await prisma.contact.count({ where: tenantWhere });
      return { value: count, label: 'Total Contacts' };
    }

    case 'kpi-tasks': {
      const count = await prisma.task.count({
        where: { ...tenantWhere, status: 'Pending' },
      });
      return { value: count, label: 'Pending Tasks' };
    }

    case 'chart-pipeline': {
      const grouped = await prisma.deal.groupBy({
        by: ['stage'],
        where: tenantWhere,
        _count: { _all: true },
        _sum: { amount: true },
      });
      return grouped.map((g) => ({
        stage: g.stage,
        count: g._count._all,
        amount: g._sum.amount || 0,
      }));
    }

    case 'chart-revenue-trend': {
      const since = new Date();
      since.setMonth(since.getMonth() - 11);
      since.setDate(1);
      since.setHours(0, 0, 0, 0);
      const deals = await prisma.deal.findMany({
        where: { ...tenantWhere, stage: 'won', createdAt: { gte: since } },
        select: { amount: true, createdAt: true },
      });
      const buckets = {};
      for (let i = 0; i < 12; i++) {
        const d = new Date(since);
        d.setMonth(d.getMonth() + i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        buckets[key] = { month: key, revenue: 0 };
      }
      for (const d of deals) {
        const dt = new Date(d.createdAt);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        if (buckets[key]) buckets[key].revenue += d.amount || 0;
      }
      return Object.values(buckets);
    }

    case 'chart-leads-source': {
      const grouped = await prisma.contact.groupBy({
        by: ['source'],
        where: tenantWhere,
        _count: { _all: true },
      });
      return grouped.map((g) => ({
        source: g.source || 'Unknown',
        count: g._count._all,
      }));
    }

    case 'table-recent-deals': {
      return prisma.deal.findMany({
        where: tenantWhere,
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, title: true, amount: true, stage: true,
          currency: true, createdAt: true,
        },
      });
    }

    case 'table-overdue-tasks': {
      return prisma.task.findMany({
        where: {
          ...tenantWhere,
          status: 'Pending',
          dueDate: { lt: new Date() },
        },
        orderBy: { dueDate: 'asc' },
        take: 25,
        select: {
          id: true, title: true, dueDate: true,
          priority: true, status: true,
        },
      });
    }

    default:
      return { error: `Unknown widget type: ${type}` };
  }
}

// GET /:id/data — resolve real data for every widget in dashboard layout
router.get('/:id/data', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid dashboard ID' });
    const dashboard = await findTenantDashboard(id, req.user.tenantId);
    if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });

    const layout = parseLayout(dashboard.layout);
    const out = {};
    await Promise.all(
      layout.map(async (widget) => {
        if (!widget || !widget.i || !widget.type) return;
        try {
          out[widget.i] = await resolveWidget(widget.type, req.user.tenantId);
        } catch (err) {
          console.error(`[dashboards] widget ${widget.i} (${widget.type}) failed`, err);
          out[widget.i] = { error: 'Failed to load widget data' };
        }
      })
    );
    res.json(out);
  } catch (err) {
    console.error('[dashboards] data failed', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
