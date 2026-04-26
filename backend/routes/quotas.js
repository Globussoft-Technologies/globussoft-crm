const express = require('express');
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

/**
 * Convert a period string ("2026-Q1", "2026-Q2", "2026") into a date range.
 * Quarters: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec.
 * Year-only ("2026") spans the whole calendar year.
 */
function periodToRange(period) {
  if (!period) return null;
  const m = String(period).match(/^(\d{4})(?:-Q([1-4]))?$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const q = m[2] ? parseInt(m[2], 10) : null;
  if (q) {
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, startMonth + 3, 1, 0, 0, 0));
    return { start, end };
  }
  return {
    start: new Date(Date.UTC(year, 0, 1, 0, 0, 0)),
    end: new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0)),
  };
}

// GET / — list quotas, optionally filter by userId/period
router.get('/', async (req, res) => {
  try {
    const { userId, period } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (userId) where.userId = parseInt(userId, 10);
    if (period) where.period = period;
    const quotas = await prisma.quota.findMany({
      where,
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
    });
    // Attach user names
    const userIds = [...new Set(quotas.map(q => q.userId))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds }, tenantId: req.user.tenantId },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));
    res.json(
      quotas.map(q => ({
        ...q,
        userName: userMap.get(q.userId)?.name || userMap.get(q.userId)?.email || `User #${q.userId}`,
      }))
    );
  } catch (err) {
    console.error('quotas list error:', err);
    res.status(500).json({ error: 'Failed to list quotas' });
  }
});

// POST / — set quota (upsert on userId+period+tenantId).
// userId is read from query string because the global `stripDangerous`
// middleware deletes it from req.body to block tenantId/userId injection
// on every other route. Without this, the route was unreachable.
router.post('/', async (req, res) => {
  try {
    const userId = req.query.userId || req.body.userId;
    const { period, target } = req.body;
    if (!userId || !period || target === undefined || target === null) {
      return res.status(400).json({ error: 'userId (query or body), period, target required' });
    }
    const tenantId = req.user.tenantId;
    const numTarget = parseFloat(target);
    if (Number.isNaN(numTarget) || numTarget < 0) {
      return res.status(400).json({ error: 'Invalid target' });
    }
    const quota = await prisma.quota.upsert({
      where: {
        userId_period_tenantId: {
          userId: parseInt(userId, 10),
          period,
          tenantId,
        },
      },
      update: { target: numTarget },
      create: {
        userId: parseInt(userId, 10),
        period,
        target: numTarget,
        tenantId,
      },
    });
    res.status(201).json(quota);
  } catch (err) {
    console.error('quota upsert error:', err);
    res.status(500).json({ error: 'Failed to save quota' });
  }
});

// PUT /:id — update target
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.quota.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Quota not found' });
    const { target } = req.body;
    const numTarget = parseFloat(target);
    if (Number.isNaN(numTarget) || numTarget < 0) {
      return res.status(400).json({ error: 'Invalid target' });
    }
    const updated = await prisma.quota.update({
      where: { id },
      data: { target: numTarget },
    });
    res.json(updated);
  } catch (err) {
    console.error('quota update error:', err);
    res.status(500).json({ error: 'Failed to update quota' });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.quota.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Quota not found' });
    await prisma.quota.delete({ where: { id } });
    res.json({ message: 'Quota deleted' });
  } catch (err) {
    console.error('quota delete error:', err);
    res.status(500).json({ error: 'Failed to delete quota' });
  }
});

// Internal — build attainment list for a period
async function buildAttainment(tenantId, period) {
  const range = periodToRange(period);
  if (!range) return [];

  const quotas = await prisma.quota.findMany({
    where: { tenantId, period },
  });
  if (!quotas.length) return [];

  const userIds = quotas.map(q => q.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, tenantId },
    select: { id: true, name: true, email: true },
  });
  const userMap = new Map(users.map(u => [u.id, u]));

  // Aggregate won deal amounts per owner within period
  // We treat "won within period" as Deal.stage='won' AND createdAt between start/end.
  // (Schema lacks an explicit closedAt; createdAt is the most reliable signal.)
  const wonDeals = await prisma.deal.findMany({
    where: {
      tenantId,
      stage: 'won',
      ownerId: { in: userIds },
      createdAt: { gte: range.start, lt: range.end },
    },
    select: { ownerId: true, amount: true },
  });

  const achievedMap = new Map();
  for (const d of wonDeals) {
    if (!d.ownerId) continue;
    achievedMap.set(d.ownerId, (achievedMap.get(d.ownerId) || 0) + (d.amount || 0));
  }

  return quotas.map(q => {
    const achieved = achievedMap.get(q.userId) || 0;
    const target = q.target || 0;
    const attainmentPct = target > 0 ? Math.round((achieved / target) * 1000) / 10 : 0;
    const u = userMap.get(q.userId);
    return {
      quotaId: q.id,
      userId: q.userId,
      name: u?.name || u?.email || `User #${q.userId}`,
      target,
      achieved,
      attainmentPct,
    };
  });
}

// GET /attainment?period=
router.get('/attainment', async (req, res) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ error: 'period required' });
    const data = await buildAttainment(req.user.tenantId, period);
    res.json(data);
  } catch (err) {
    console.error('attainment error:', err);
    res.status(500).json({ error: 'Failed to compute attainment' });
  }
});

// GET /leaderboard?period=
router.get('/leaderboard', async (req, res) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ error: 'period required' });
    const data = await buildAttainment(req.user.tenantId, period);
    data.sort((a, b) => b.attainmentPct - a.attainmentPct);
    res.json(data);
  } catch (err) {
    console.error('leaderboard error:', err);
    res.status(500).json({ error: 'Failed to compute leaderboard' });
  }
});

module.exports = router;
