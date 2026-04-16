const express = require('express');
const { verifyToken } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

router.get('/threads', verifyToken, async (req, res) => {
  try {
    const emails = await prisma.emailMessage.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const threadMap = {};
    for (const e of emails) {
      const tid = e.threadId || `single-${e.id}`;
      if (!threadMap[tid]) threadMap[tid] = { threadId: tid, subject: e.subject, messages: [], lastAt: e.createdAt, unread: 0 };
      threadMap[tid].messages.push(e);
      if (!e.read) threadMap[tid].unread++;
      if (e.createdAt > threadMap[tid].lastAt) threadMap[tid].lastAt = e.createdAt;
    }
    const threads = Object.values(threadMap).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    res.json(threads.slice(0, 50));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch email threads' });
  }
});

router.get('/stats', verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [total, unread, sent, received] = await Promise.all([
      prisma.emailMessage.count({ where: { tenantId } }),
      prisma.emailMessage.count({ where: { tenantId, read: false } }),
      prisma.emailMessage.count({ where: { tenantId, direction: 'OUTBOUND' } }),
      prisma.emailMessage.count({ where: { tenantId, direction: 'INBOUND' } }),
    ]);
    res.json({ total, unread, sent, received });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch email stats' });
  }
});

router.get('/scheduled', verifyToken, async (req, res) => {
  try {
    const scheduled = await prisma.scheduledEmail.findMany({
      where: { tenantId: req.user.tenantId, status: 'PENDING' },
      orderBy: { scheduledFor: 'asc' },
    });
    res.json(scheduled);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scheduled emails' });
  }
});

module.exports = router;
