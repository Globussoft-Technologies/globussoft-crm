const router = require("express").Router();
const prisma = require("../lib/prisma");
const { notify, notifyTenant, resolve } = require("../lib/notificationService");
const { writeAudit } = require("../lib/audit");

// GET / — list notifications (paginated) with optional filters
router.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const skip = (page - 1) * limit;

    const where = {
      userId: req.user.userId,
      tenantId: req.user.tenantId
    };

    // Support filters
    if (req.query.unread === "true") where.isRead = false;
    if (req.query.status === "read") where.isRead = true;
    if (req.query.status === "unread") where.isRead = false;
    if (req.query.priority) where.priority = req.query.priority;
    if (req.query.entityType) where.entityType = req.query.entityType;

    console.log('[notifications.get] Fetching notifications for user:', { userId: req.user.userId, tenantId: req.user.tenantId, where });

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where }),
    ]);

    console.log('[notifications.get] Found:', { total, returned: notifications.length });
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
    res.json({ status: "ok", code: "NOTIFICATIONS_MARKED_READ", updated: count }); // #550
  } catch (err) {
    console.error("[Notifications] Mark all read error:", err);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

// PUT /:id/read
// #185: external clients (and the bug report repros) tested POST /:id/read,
// POST /mark-all-read, and POST /read-all — all returning 404 because only
// PUT was wired. Add POST aliases that delegate to the same handlers so the
// API matches typical mark-as-read conventions.
async function markReadHandler(req, res) {
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
}
router.put("/:id/read", markReadHandler);
router.post("/:id/read", markReadHandler);

// PATCH /:id/resolve — mark notification as resolved (read + sets readAt)
router.patch("/:id/resolve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid notification ID" });

    const existing = await prisma.notification.findFirst({
      where: { id, tenantId: req.user.tenantId }
    });
    if (!existing) return res.status(404).json({ error: "Notification not found" });

    const notification = await resolve(id, req.user.tenantId);
    if (!notification) return res.status(500).json({ error: "Failed to resolve notification" });

    res.json(notification);
  } catch (err) {
    console.error("[Notifications] Resolve error:", err);
    res.status(500).json({ error: "Failed to resolve notification" });
  }
});

// #185: PATCH /:id with `{isRead:true}` is the third API shape clients tested
// (alongside PUT /:id/read and POST /:id/read). The bug-report repro flagged
// all three returning 404; aliasing PATCH to the same handler closes the gap
// without forcing the client to switch verbs. Body content is ignored — the
// handler always sets isRead=true, matching POST /:id/read semantics.
// NOTE: PATCH /:id/resolve takes precedence over generic PATCH /:id for the /resolve path
router.patch("/:id", markReadHandler);

async function markAllReadHandler(req, res) {
  try {
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId, isRead: false },
      data: { isRead: true },
    });
    if (req.io) req.io.emit("notifications_cleared", { userId: req.user.userId });
    res.json({ status: "ok", code: "NOTIFICATIONS_MARKED_READ", updated: count }); // #550
  } catch (err) {
    console.error("[Notifications] Mark all read error:", err);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
}
router.post("/mark-all-read", markAllReadHandler);
router.post("/read-all", markAllReadHandler);

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const existing = await prisma.notification.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Notification not found" });

    await prisma.notification.delete({ where: { id: existing.id } });
    // #179: audit destructive delete. entityId points at the now-deleted row's
    // id so admins can correlate with logs from the moments before deletion.
    await writeAudit('Notification', 'DELETE', existing.id, req.user.userId, req.user.tenantId, {
      title: existing.title,
      type: existing.type,
      targetUserId: existing.userId,
    });
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error("[Notifications] Delete error:", err);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// #169: enforce a type enum so callers can't store arbitrary strings.
const ALLOWED_NOTIFICATION_TYPES = new Set(["info", "success", "warning", "error", "system", "deal", "task", "ticket"]);

// POST / — create + deliver notification (admin-only for broadcast / cross-user)
//
// Targeting parameter naming: the body field is `targetUserId`, NOT `userId`.
// Reason: the global `stripDangerous` middleware deletes `req.body.userId` for
// every request before any route handler runs (anti-impersonation guardrail
// — see middleware/validateInput.js). If the route read `userId` from the
// body, every targeted call would silently fall into the broadcast branch
// because `userId` would already be undefined. `targetUserId` is not in the
// strip list, so it survives the middleware and reaches this handler.
// The audit-log payload has used the same `targetUserId` field name since
// #179 — this just lines up the request shape with what the audit row
// already records.
router.post("/", async (req, res) => {
  try {
    const { targetUserId, title, message, type, link, channels } = req.body;
    if (!title || !message) {
      return res.status(400).json({ error: "title and message are required" });
    }
    // #169: validate type so "INVALID_TYPE_ZZZ" can't be persisted.
    if (type !== undefined && type !== null && type !== "" && !ALLOWED_NOTIFICATION_TYPES.has(type)) {
      return res.status(400).json({
        error: `type must be one of: ${[...ALLOWED_NOTIFICATION_TYPES].join(", ")}`,
        code: "INVALID_NOTIFICATION_TYPE",
      });
    }

    const tenantId = req.user.tenantId;
    const isAdmin = req.user.role === "ADMIN";
    const callerId = req.user.userId;
    const io = req.io || null;

    // #169: tighten authorization so a non-admin can't spam every user in the tenant.
    //   - With a targetUserId targeting another user → admin only.
    //   - Without a targetUserId (broadcast) → admin only.
    //   - With targetUserId === own userId → self-notify allowed for any role.
    if (!targetUserId) {
      if (!isAdmin) return res.status(403).json({ error: "Only admins can broadcast notifications", code: "BROADCAST_FORBIDDEN" });
      const result = await notifyTenant({ tenantId, title, message, type, link, channels, io });
      // #179: tenant-wide broadcasts are an admin "blast" surface — must be audited.
      // entityId is null because the broadcast spawned N notifications, not one.
      await writeAudit('Notification', 'BROADCAST', null, callerId, tenantId, {
        title,
        type: type || null,
        delivered: result.length,
        channels: channels || null,
      });
      return res.status(201).json({ delivered: result.length, notifications: result });
    }
    const targetId = parseInt(targetUserId);
    if (targetId !== callerId && !isAdmin) {
      return res.status(403).json({ error: "Only admins can notify other users", code: "CROSS_USER_FORBIDDEN" });
    }
    const result = await notify({ userId: targetId, tenantId, title, message, type, link, channels, io });
    // #179: only audit cross-user notifications. Self-notify is too noisy and
    // not security-relevant; admin → other-user is.
    if (targetId !== callerId) {
      await writeAudit('Notification', 'CREATE', result?.id || null, callerId, tenantId, {
        targetUserId: targetId,
        title,
        type: type || null,
      });
    }
    res.status(201).json({ delivered: 1, notification: result });
  } catch (err) {
    console.error("[Notifications] Create/deliver error:", err);
    res.status(500).json({ error: "Failed to create notification" });
  }
});

// Default preferences when no custom row exists
const DEFAULT_PREFERENCES = {
  categoryToggles: {
    deal: true,
    task: true,
    ticket: true,
    lead: true,
    approval: true,
    leave: true,
    expense: true,
  },
  channels: {
    db: true,
    socket: true,
    push: false,
    email: false,
  },
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
};

// GET /preferences — fetch user's notification preferences with defaults
router.get("/preferences", async (req, res) => {
  try {
    const prefs = await prisma.notificationPreference.findUnique({
      where: { userId: req.user.userId },
    });

    if (!prefs) {
      return res.json(DEFAULT_PREFERENCES);
    }

    res.json({
      categoryToggles: prefs.categoryToggles || DEFAULT_PREFERENCES.categoryToggles,
      channels: prefs.channels || DEFAULT_PREFERENCES.channels,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      timezone: prefs.timezone,
    });
  } catch (err) {
    console.error("[Notifications] Get preferences error:", err);
    res.status(500).json({ error: "Failed to fetch notification preferences" });
  }
});

// PUT /preferences — save user's notification preferences
router.put("/preferences", async (req, res) => {
  try {
    const { categoryToggles, channels, quietHoursStart, quietHoursEnd, timezone } = req.body;
    const userId = req.user.userId;
    const tenantId = req.user.tenantId;

    // Validate times if provided (HH:MM format)
    if (quietHoursStart && !/^\d{2}:\d{2}$/.test(quietHoursStart)) {
      return res.status(400).json({ error: "quietHoursStart must be in HH:MM format" });
    }
    if (quietHoursEnd && !/^\d{2}:\d{2}$/.test(quietHoursEnd)) {
      return res.status(400).json({ error: "quietHoursEnd must be in HH:MM format" });
    }

    const prefs = await prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        tenantId,
        categoryToggles: categoryToggles || DEFAULT_PREFERENCES.categoryToggles,
        channels: channels || DEFAULT_PREFERENCES.channels,
        quietHoursStart: quietHoursStart || null,
        quietHoursEnd: quietHoursEnd || null,
        timezone: timezone || null,
      },
      update: {
        categoryToggles: categoryToggles || DEFAULT_PREFERENCES.categoryToggles,
        channels: channels || DEFAULT_PREFERENCES.channels,
        quietHoursStart: quietHoursStart || null,
        quietHoursEnd: quietHoursEnd || null,
        timezone: timezone || null,
      },
    });

    res.json({
      status: "ok",
      code: "PREFERENCES_SAVED",
      preferences: {
        categoryToggles: prefs.categoryToggles,
        channels: prefs.channels,
        quietHoursStart: prefs.quietHoursStart,
        quietHoursEnd: prefs.quietHoursEnd,
        timezone: prefs.timezone,
      },
    });
  } catch (err) {
    console.error("[Notifications] Save preferences error:", err);
    res.status(500).json({ error: "Failed to save notification preferences" });
  }
});

// POST /preferences/reset — reset to default preferences
router.post("/preferences/reset", async (req, res) => {
  try {
    const userId = req.user.userId;

    await prisma.notificationPreference.delete({
      where: { userId },
    }).catch(() => null); // Ignore if doesn't exist

    res.json({
      status: "ok",
      code: "PREFERENCES_RESET",
      preferences: DEFAULT_PREFERENCES,
    });
  } catch (err) {
    console.error("[Notifications] Reset preferences error:", err);
    res.status(500).json({ error: "Failed to reset notification preferences" });
  }
});

module.exports = router;
