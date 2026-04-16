const express = require('express');
const { verifyToken } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

router.get('/events', verifyToken, async (req, res) => {
  try {
    const events = await prisma.calendarEvent.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { startTime: 'asc' },
      take: parseInt(req.query.limit) || 50,
    });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

router.get('/integrations', verifyToken, async (req, res) => {
  try {
    const integrations = await prisma.calendarIntegration.findMany({
      where: { userId: req.user.userId },
      select: { id: true, provider: true, syncEnabled: true, lastSyncAt: true, calendarId: true },
    });
    res.json(integrations);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch calendar integrations' });
  }
});

router.get('/upcoming', verifyToken, async (req, res) => {
  try {
    const now = new Date();
    const events = await prisma.calendarEvent.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, startTime: { gte: now } },
      orderBy: { startTime: 'asc' },
      take: 10,
    });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch upcoming events' });
  }
});

module.exports = router;
