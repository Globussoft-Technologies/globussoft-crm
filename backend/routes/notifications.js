const router = require("express").Router();
const prisma = require("../lib/prisma");
const { notify, notifyMany, notifyTenant } = require("../lib/notificationService");

// GET / — list notifications (paginated)
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const skip = (page - 1) * limit;

    const where = { userId: req.user.userId, tenantId: req.user.tenantId };
    if (req.query.unread === "true") where.isRead = false;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({ notifications, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("[Notifications] List error:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// GET /unread-count
router.get("/unread-count", async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, isRead: false },
    });
    res.json({ count });
  } catch (err) {
    console.error("[Notifications] Unread count error:", err);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// PUT /read-all
router.put("/read-all", async (req, res) => {
  try {
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, isRead: false },
      data: { isRead: true },
    });
    if (req.io) req.io.emit("notifications_cleared", { userId: req.user.userId });
    res.json({ message: "All notifications marked as read", updated: count });
  } catch (err) {
    console.error("[Notifications] Mark all read error:", err);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

// PUT /:id/read
router.put("/:id/read", async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Notification not found" });

    const notification = await prisma.notification.update({
      where: { id: existing.id },
      data: { isRead: true },
    });
    res.json(notification);
  } catch (err) {
    console.error("[Notifications] Mark read error:", err);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Notification not found" });

    await prisma.notification.delete({ where: { id: existing.id } });
    res.json({ message: "Notification deleted" });
  } catch (err) {
    console.error("[Notifications] Delete error:", err);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// POST / — create + deliver notification (admin)
router.post("/", async (req, res) => {
  try {
    const { userId, title, message, type, link, channels } = req.body;
    if (!title || !message) {
      return res.status(400).json({ error: "title and message are required" });
    }

    const tenantId = req.user.tenantId;
    const io = req.io || null;

    let result;
    if (userId) {
      // Single user
      result = await notify({ userId: parseInt(userId), tenantId, title, message, type, link, channels, io });
      res.status(201).json({ delivered: 1, notification: result });
    } else {
      // Broadcast to entire tenant
      result = await notifyTenant({ tenantId, title, message, type, link, channels, io });
      res.status(201).json({ delivered: result.length, notifications: result });
    }
  } catch (err) {
    console.error("[Notifications] Create/deliver error:", err);
    res.status(500).json({ error: "Failed to create notification" });
  }
});

// GET /preferences — stub: return user notification preferences
router.get("/preferences", async (req, res) => {
  // TODO: back with a UserNotificationPreference model
  res.json({
    channels: {
      db: { enabled: true, configurable: false },
      socket: { enabled: true, configurable: false },
      push: { enabled: true, configurable: true },
      email: { enabled: false, configurable: true },
    },
  });
});

// PUT /preferences — stub: save preferences
router.put("/preferences", async (req, res) => {
  // TODO: persist to DB when model exists
  res.json({ message: "Preferences saved (stub)", preferences: req.body });
});

module.exports = router;
