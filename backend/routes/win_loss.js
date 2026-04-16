const express = require('express');
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// GET /reasons — list reasons for current tenant
router.get('/reasons', async (req, res) => {
  try {
    const reasons = await prisma.winLossReason.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ type: 'asc' }, { count: 'desc' }],
    });
    res.json(reasons);
  } catch (err) {
    console.error('reasons list error:', err);
    res.status(500).json({ error: 'Failed to list reasons' });
  }
});

// POST /reasons — create reason
router.post('/reasons', async (req, res) => {
  try {
    const { type, reason } = req.body;
    if (!type || !reason) {
      return res.status(400).json({ error: 'type and reason required' });
    }
    if (!['won', 'lost'].includes(type)) {
      return res.status(400).json({ error: 'type must be "won" or "lost"' });
    }
    const created = await prisma.winLossReason.create({
      data: { type, reason, count: 0, tenantId: req.user.tenantId },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('reason create error:', err);
    res.status(500).json({ error: 'Failed to create reason' });
  }
});

// DELETE /reasons/:id
router.delete('/reasons/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.winLossReason.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Reason not found' });
    await prisma.winLossReason.delete({ where: { id } });
    res.json({ message: 'Reason deleted' });
  } catch (err) {
    console.error('reason delete error:', err);
    res.status(500).json({ error: 'Failed to delete reason' });
  }
});

// GET /analysis?from=&to=
router.get('/analysis', async (req, res) => {
  try {
    const { from, to } = req.query;
    const tenantId = req.user.tenantId;
    const range = {};
    if (from) range.gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setUTCHours(23, 59, 59, 999);
      range.lte = end;
    }

    const where = { tenantId, stage: { in: ['won', 'lost'] } };
    if (from || to) where.createdAt = range;

    const deals = await prisma.deal.findMany({
      where,
      select: {
        id: true,
        title: true,
        amount: true,
        stage: true,
        lostReason: true,
        winLossReasonId: true,
        createdAt: true,
        ownerId: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const reasonIds = [
      ...new Set(deals.map(d => d.winLossReasonId).filter(Boolean)),
    ];
    const reasons = reasonIds.length
      ? await prisma.winLossReason.findMany({
          where: { id: { in: reasonIds }, tenantId },
        })
      : [];
    const reasonMap = new Map(reasons.map(r => [r.id, r]));

    const wonDeals = deals.filter(d => d.stage === 'won');
    const lostDeals = deals.filter(d => d.stage === 'lost');
    const wonCount = wonDeals.length;
    const lostCount = lostDeals.length;
    const total = wonCount + lostCount;
    const winRate = total > 0 ? Math.round((wonCount / total) * 1000) / 10 : 0;

    const sumWon = wonDeals.reduce((s, d) => s + (d.amount || 0), 0);
    const sumLost = lostDeals.reduce((s, d) => s + (d.amount || 0), 0);
    const avgWon = wonCount > 0 ? Math.round((sumWon / wonCount) * 100) / 100 : 0;
    const avgLost = lostCount > 0 ? Math.round((sumLost / lostCount) * 100) / 100 : 0;

    // Group by reason — combine winLossReasonId (won + lost) and free-text lostReason fallback
    const byReasonMap = new Map();
    const keyOf = (type, reason) => `${type}::${reason}`;

    for (const d of deals) {
      let reasonText = null;
      let type = d.stage;
      if (d.winLossReasonId && reasonMap.has(d.winLossReasonId)) {
        const r = reasonMap.get(d.winLossReasonId);
        reasonText = r.reason;
        type = r.type;
      } else if (d.stage === 'lost' && d.lostReason) {
        reasonText = d.lostReason;
        type = 'lost';
      }
      if (!reasonText) continue;
      const key = keyOf(type, reasonText);
      const cur = byReasonMap.get(key) || { reason: reasonText, type, count: 0 };
      cur.count += 1;
      byReasonMap.set(key, cur);
    }
    const byReason = Array.from(byReasonMap.values()).sort((a, b) => b.count - a.count);

    // Closed deals list (lightweight) for the UI table
    const closedDeals = deals.slice(0, 50).map(d => {
      const r = d.winLossReasonId ? reasonMap.get(d.winLossReasonId) : null;
      return {
        id: d.id,
        title: d.title,
        amount: d.amount,
        stage: d.stage,
        reason: r?.reason || d.lostReason || null,
        createdAt: d.createdAt,
      };
    });

    res.json({
      wonCount,
      lostCount,
      winRate,
      byReason,
      avgDealSize: { won: avgWon, lost: avgLost },
      closedDeals,
    });
  } catch (err) {
    console.error('win/loss analysis error:', err);
    res.status(500).json({ error: 'Failed to compute analysis' });
  }
});

// PUT /deals/:dealId/reason — set lostReason or winLossReasonId
router.put('/deals/:dealId/reason', async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId, 10);
    const tenantId = req.user.tenantId;
    const existing = await prisma.deal.findFirst({
      where: { id: dealId, tenantId },
    });
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    const { lostReason, winLossReasonId } = req.body;
    const data = {};
    if (lostReason !== undefined) data.lostReason = lostReason || null;
    if (winLossReasonId !== undefined) {
      if (winLossReasonId === null) {
        data.winLossReasonId = null;
      } else {
        const reason = await prisma.winLossReason.findFirst({
          where: { id: parseInt(winLossReasonId, 10), tenantId },
        });
        if (!reason) return res.status(400).json({ error: 'Invalid winLossReasonId' });
        data.winLossReasonId = reason.id;
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const updated = await prisma.deal.update({ where: { id: dealId }, data });

    // Maintain the count tally on WinLossReason for quick analytics
    if (data.winLossReasonId) {
      await prisma.winLossReason.update({
        where: { id: data.winLossReasonId },
        data: { count: { increment: 1 } },
      });
    }

    res.json(updated);
  } catch (err) {
    console.error('set deal reason error:', err);
    res.status(500).json({ error: 'Failed to set deal reason' });
  }
});

module.exports = router;
