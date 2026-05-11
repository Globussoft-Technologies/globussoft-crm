/**
 * Notification Delivery Engine
 * Multi-channel dispatcher: DB + Socket.io + Web Push + Email
 *
 * Usage:
 *   const { notify, notifyMany, notifyTenant } = require('../lib/notificationService');
 *   await notify({ userId, tenantId, title, message, type, link, channels, io });
 */

const prisma = require("./prisma");

// --------------- SendGrid helper (inline, same pattern as communications.js) ---------------
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

async function sendSendGrid(to, subject, body) {
  if (!SENDGRID_API_KEY) {
    console.log(`[Notification-Email] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  const htmlBody = body.replace(/\n/g, "<br>");
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL },
    subject: subject,
    content: [
      { type: "text/plain", value: body },
      { type: "text/html", value: htmlBody }
    ]
  };

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log(`[Notification-Email] Sent to ${to}: "${subject}"`);
      return { sent: true };
    } else {
      const text = await response.text();
      console.error(`[Notification-Email] SendGrid error ${response.status}: ${text}`);
      return { sent: false, reason: text };
    }
  } catch (err) {
    console.error("[Notification-Email] SendGrid request failed:", err.message);
    return { sent: false, reason: err.message };
  }
}

// --------------- Core dispatcher ---------------

/**
 * Send a notification to a single user across multiple channels with deduplication.
 * @param {Object} opts
 * @param {number} opts.userId       - Target user ID
 * @param {number} opts.tenantId     - Tenant ID for multi-tenancy
 * @param {string} opts.title        - Notification title
 * @param {string} opts.message      - Notification body
 * @param {string} [opts.type=info]  - info | success | warning | error
 * @param {string} [opts.priority=normal] - low | normal | high | critical
 * @param {string} [opts.link]       - Deep-link path (e.g. "/pipeline")
 * @param {string} [opts.entityType] - lead | ticket | approval | expense | leave
 * @param {number} [opts.entityId]   - ID of the entity
 * @param {number} [opts.dedupWindowHours=24] - Hours to look back for dedup
 * @param {string[]} [opts.channels] - Delivery channels: db, socket, push, email (default: ['db','socket'])
 * @param {Object} [opts.io]         - Socket.io server instance
 * @returns {Promise<Object|null>}   - The created Notification record or null if deduped
 */
async function notify({ userId, tenantId, title, message, type, priority, link, entityType, entityId, dedupWindowHours = 24, channels, io }) {
  const activeChannels = channels || ["db", "socket"];

  // Deduplication check: look for duplicate within window
  if (entityId && entityType) {
    const windowStart = new Date(Date.now() - dedupWindowHours * 60 * 60 * 1000);
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        tenantId,
        type,
        entityId,
        entityType,
        createdAt: { gte: windowStart }
      }
    });

    if (existing) {
      console.log(`[Notification] Deduped ${type} for entity ${entityId} within ${dedupWindowHours}h window`);
      return null; // Skip duplicate
    }
  }

  // 1. Always save to DB
  const notification = await prisma.notification.create({
    data: {
      title,
      message,
      type: type || "info",
      priority: priority || "normal",
      link: link || null,
      entityType: entityType || null,
      entityId: entityId || null,
      isRead: false,
      userId,
      tenantId,
    },
  });

  console.log(`[notificationService] Created notification for user ${userId}:`, { title, message, entityType, hasIo: !!io });

  // 2. Real-time socket
  if (activeChannels.includes("socket") && io) {
    console.log(`[notificationService] Sending socket.io notification to user:${userId}`);
    io.to(`user:${userId}`).emit("notification_new", {
      id: notification.id,
      userId,
      title: notification.title,
      message: notification.message,
      type: notification.type,
      priority: notification.priority,
      link: notification.link,
      entityType: notification.entityType,
      entityId: notification.entityId,
      createdAt: notification.createdAt
    });
  } else {
    console.log(`[notificationService] Socket.io not available or disabled for user ${userId}`);
  }

  // 3. Web push (best-effort)
  if (activeChannels.includes("push")) {
    try {
      const pushService = require("../services/pushService");
      await pushService.sendToUser(userId, { title, body: message, url: link }, prisma);
    } catch (e) {
      console.warn("[Notification-Push] Push delivery failed:", e.message);
    }
  }

  // 4. Email (best-effort)
  if (activeChannels.includes("email")) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user?.email) {
        await sendSendGrid(user.email, title, message);
      }
    } catch (e) {
      console.warn("[Notification-Email] Email delivery failed:", e.message);
    }
  }

  return notification;
}

/**
 * Notify multiple users.
 */
async function notifyMany({ userIds, tenantId, title, message, type, link, channels, io }) {
  const results = [];
  for (const uid of userIds) {
    const n = await notify({ userId: uid, tenantId, title, message, type, link, channels, io });
    results.push(n);
  }
  return results;
}

/**
 * Notify every user in a tenant.
 */
async function notifyTenant({ tenantId, title, message, type, link, channels, io }) {
  const users = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true },
  });
  return notifyMany({
    userIds: users.map((u) => u.id),
    tenantId,
    title,
    message,
    type,
    link,
    channels,
    io,
  });
}

/**
 * Mark a notification as resolved (read + resolved).
 */
async function resolve(notificationId, tenantId) {
  try {
    const updated = await prisma.notification.update({
      where: { id: notificationId, tenantId },
      data: {
        isRead: true,
        readAt: new Date()
      }
    });
    return updated;
  } catch (err) {
    console.error('[Notification] resolve error:', err.message);
    return null;
  }
}

module.exports = { notify, notifyMany, notifyTenant, resolve };
