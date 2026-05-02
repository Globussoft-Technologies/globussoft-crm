const express = require('express');
const { verifyToken } = require('../middleware/auth');
const prisma = require('../lib/prisma');

const router = express.Router();

// #402: the sidebar at frontend/src/components/Sidebar.jsx:56 polls
// `GET /api/email?unread=1` every 60s to render the Inbox counter.
// Pre-this-handler the route was undefined, Express fell through to
// the SPA static handler, returned the index.html shell, the JSON
// parser threw, fetchApi raised, and the global toast surfaced as
// "Not found." on every page.
//
// Shape contract with the sidebar (Sidebar.jsx:51):
//   safeLen = (p) => p.then(r => Array.isArray(r) ? r.length : (r?.total ?? 0))
//
// So either an array or `{ total }` works. Returning `{ total }` is
// cheap (count query) and avoids paginating an unbounded list.
router.get('/', verifyToken, async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.unread === '1') where.read = false;
    if (req.query.folder === 'inbox') where.direction = 'INBOUND';
    if (req.query.folder === 'sent') where.direction = 'OUTBOUND';
    const total = await prisma.emailMessage.count({ where });
    res.json({ total });
  } catch (_err) {
    // Soft-fail: the sidebar should never blow up the page.
    res.json({ total: 0 });
  }
});

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
  } catch (_err) {
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
  } catch (_err) {
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
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch scheduled emails' });
  }
});

module.exports = router;
