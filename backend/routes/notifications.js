const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Note: routes use req.user.userId (set by middleware) — older code referenced req.user.id which is unset
// Multi-tenancy: scope by tenantId

// GET / — list notifications for authenticated user
router.get('/', async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(notifications);
  } catch (err) {
    console.error('[Notifications] List error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// GET /unread-count — count of unread notifications
router.get('/unread-count', async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, isRead: false },
    });
    res.json({ count });
  } catch (err) {
    console.error('[Notifications] Unread count error:', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// PUT /read-all — mark all as read
router.put('/read-all', async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[Notifications] Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// PUT /:id/read — mark single notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Notification not found' });
    const notification = await prisma.notification.update({
      where: { id: existing.id },
      data: { isRead: true },
    });
    res.json(notification);
  } catch (err) {
    console.error('[Notifications] Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// DELETE /:id — delete a notification
router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: 'Notification not found' });
    await prisma.notification.delete({
      where: { id: existing.id },
    });
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error('[Notifications] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

module.exports = router;
