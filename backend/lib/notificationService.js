/**
 * Notification Delivery Engine
 * Multi-channel dispatcher: DB + Socket.io + Web Push + Email
 *
 * Usage:
 *   const { notify, notifyMany, notifyTenant } = require('../lib/notificationService');
 *   await notify({ userId, tenantId, title, message, type, link, channels, io });
 */

const prisma = require("./prisma");
const { sendEmail } = require("./emailSender");
const {
  DEFAULT_SENDER_EMAIL,
  getNotificationEmailConfig,
} = require("./notificationEmailCc");

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
    tmc_catalogue: true,
    travel_quote: true,
    travel_visa: true,
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

// Helper: check if current time is within quiet hours (timezone-aware)
function isInQuietHours(timezone, quietHoursStart, quietHoursEnd) {
  if (!quietHoursStart || !quietHoursEnd || !timezone) return false;

  try {
    // Get current time in user's timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const currentTime = `${hour}:${minute}`;

    // Parse times (HH:MM format)
    const [startHour, startMin] = quietHoursStart.split(':').map(Number);
    const [endHour, endMin] = quietHoursEnd.split(':').map(Number);
    const [curHour, curMin] = currentTime.split(':').map(Number);
    const startTotalMin = startHour * 60 + startMin;
    const endTotalMin = endHour * 60 + endMin;
    const curTotalMin = curHour * 60 + curMin;

    // Handle wrap-around (e.g., 22:00 to 07:00)
    if (startTotalMin < endTotalMin) {
      return curTotalMin >= startTotalMin && curTotalMin < endTotalMin;
    } else {
      return curTotalMin >= startTotalMin || curTotalMin < endTotalMin;
    }
  } catch (e) {
    console.warn("[notificationService] quiet hours check failed:", e.message);
    return false;
  }
}

// --------------- SendGrid helper (inline, same pattern as communications.js) ---------------
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = DEFAULT_SENDER_EMAIL;

function escapeEmailHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[character]));
}

function buildTravelNotificationUrl(link) {
  const value = String(link || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return "";

  const origin = String(process.env.FRONTEND_URL || "https://crm.globusdemos.com").replace(/\/+$/, "");
  return `${origin}${value.startsWith("/") ? "" : "/"}${value}`;
}

async function sendSendGrid(to, subject, body, emailHtml, cc = []) {
  if (!SENDGRID_API_KEY) {
    console.log(`[Notification-Email] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  const htmlBody = emailHtml || body.replace(/\n/g, "<br>");
  const ccRecipients = [...new Set(cc
    .map((email) => String(email || "").trim().toLowerCase())
    .filter((email) => email && email !== String(to).trim().toLowerCase()))]
    .map((email) => ({ email }));
  const personalization = { to: [{ email: to }] };
  if (ccRecipients.length) personalization.cc = ccRecipients;
  const payload = {
    personalizations: [personalization],
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

async function sendNotificationEmail(tenantId, to, subject, body, emailHtml, link, cc = []) {
  let tenant = null;
  try {
    tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true, name: true } });
  } catch (_error) {
    // Preserve the existing backend-managed path if tenant lookup is unavailable.
  }
  if (String(tenant?.vertical || "").toLowerCase() === "travel") {
    const notificationUrl = buildTravelNotificationUrl(link);
    const emailText = notificationUrl && !String(body).includes(notificationUrl)
      ? `${body}\n\nView details: ${notificationUrl}`
      : body;
    const notificationBody = [
      `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#172b3a;">${escapeEmailHtml(subject)}</h1>`,
      `<div style="font-size:15px;line-height:1.7;">${escapeEmailHtml(body).replace(/\r\n|\n|\r/g, "<br>")}</div>`,
      `<p style="margin:24px 0 0;color:#6b7780;font-size:12px;">Received (UTC): ${escapeEmailHtml(new Date().toISOString())}</p>`,
      notificationUrl
        ? `<p style="margin:22px 0 0;text-align:center;"><a href="${escapeEmailHtml(notificationUrl)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;">Open notification</a></p>`
        : "",
    ].join("");
    const brandedHtml = emailHtml || await require("./travelEmailAutomation").renderTravelEmailHtml({
      tenantId,
      body: notificationBody,
      tenantName: tenant?.name || "Travel team",
    });
    return sendEmail({
      tenantId,
      to,
      cc,
      subject,
      text: emailText,
      html: brandedHtml,
    });
  }
  return sendSendGrid(to, subject, body, emailHtml, cc);
}

// --------------- Core dispatcher ---------------

/**
 * Send a notification to a single user across multiple channels with deduplication.
 * Respects user's notification preferences (category toggles, channel selection, quiet hours).
 * @param {Object} opts
 * @param {number} opts.userId       - Target user ID
 * @param {number} opts.tenantId     - Tenant ID for multi-tenancy
 * @param {string} opts.title        - Notification title
 * @param {string} opts.message      - Notification body
 * @param {string} [opts.type=info]  - info | success | warning | error
 * @param {string} [opts.priority=normal] - low | normal | high | critical
 * @param {string} [opts.link]       - Deep-link path (e.g. "/pipeline")
 * @param {string} [opts.entityType] - lead | ticket | approval | expense | leave
 * @param {string} [opts.category]   - Notification category for preference filtering (deal, task, ticket, lead, approval, leave, expense)
 * @param {string} [opts.emailHtml]  - Optional email-only HTML body; in-app content remains `message`
 * @param {number} [opts.entityId]   - ID of the entity
 * @param {number} [opts.dedupWindowHours=24] - Hours to look back for dedup
 * @param {string[]} [opts.channels] - Delivery channels: db, socket, push, email (push is added when the user has enabled Browser Push and the caller requests db/socket)
 * @param {Object} [opts.io]         - Socket.io server instance
 * @returns {Promise<Object|null>}   - The created Notification record or null if deduped/blocked by prefs
 */
async function notify({ userId, tenantId, title, message, type, priority, link, entityType, entityId, category, emailHtml, dedupWindowHours = 24, channels, io, ignorePreferences = false, fanoutOptionalChannels = true, fanoutEmail = fanoutOptionalChannels, fanoutBrowserPush = fanoutOptionalChannels }) {
  const requestedChannels = channels || ["db", "socket"];

  // Fetch user preferences
  const userPrefs = await prisma.notificationPreference.findUnique({
    where: { userId },
  }).catch(() => null);

  const prefs = userPrefs ? {
    categoryToggles: userPrefs.categoryToggles || DEFAULT_PREFERENCES.categoryToggles,
    channels: userPrefs.channels || DEFAULT_PREFERENCES.channels,
    quietHoursStart: userPrefs.quietHoursStart,
    quietHoursEnd: userPrefs.quietHoursEnd,
    timezone: userPrefs.timezone,
  } : DEFAULT_PREFERENCES;

  const notifCategory = category || type || "info";
  const categoryChannels = prefs.channels?.byCategory?.[notifCategory] || prefs.channels;
  const channelEnabled = (channel) => categoryChannels[channel] !== false;

  // Browser Push and Email are user delivery preferences, not separate
  // requirements every caller must remember to add. Most notification
  // producers request the canonical in-app channels (db/socket); when the
  // user has enabled either optional channel, fan that same notification out
  // through it as well. Keep explicit non-in-app channel lists unchanged.
  const wantsBrowserPush = fanoutBrowserPush && channelEnabled("push")
    && requestedChannels.includes("socket");
  const wantsEmail = fanoutEmail && channelEnabled("email")
    && requestedChannels.includes("socket");
  const effectiveRequestedChannels = [
    ...requestedChannels,
    ...(wantsBrowserPush && !requestedChannels.includes("push") ? ["push"] : []),
    ...(wantsEmail && !requestedChannels.includes("email") ? ["email"] : []),
  ];

  // Check if category is enabled (map type to category if category not provided)
  if (!ignorePreferences && prefs.categoryToggles[notifCategory] === false) {
    console.log(`[notificationService] Category "${notifCategory}" is disabled for user ${userId}`);
    return null;
  }

  // Check if in quiet hours
  if (!ignorePreferences && isInQuietHours(prefs.timezone, prefs.quietHoursStart, prefs.quietHoursEnd)) {
    console.log(`[notificationService] User ${userId} is in quiet hours; suppressing notification`);
    return null;
  }

  // Determine active channels based on preferences
  const activeChannels = ignorePreferences ? effectiveRequestedChannels : effectiveRequestedChannels.filter(ch => {
    const allowed = categoryChannels[ch];
    if (allowed === false) {
      console.log(`[notificationService] Channel "${ch}" is disabled for user ${userId}`);
      return false;
    }
    return true;
  });

  // A notification with no enabled delivery channel must not be persisted or
  // delivered. This makes the preference checkboxes authoritative instead of
  // leaving an unwanted row in the in-app bell.
  if (activeChannels.length === 0) return null;

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

  // 1. Save to DB only when the user selected the in-app bell. Other channels
  // still receive a transient payload without creating an in-app row.
  const notificationData = {
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
  };
  const notification = activeChannels.includes("db")
    ? await prisma.notification.create({ data: notificationData })
    : { id: null, createdAt: new Date(), ...notificationData };

  console.log(`[notificationService] Created notification for user ${userId}:`, { title, message, entityType, hasIo: !!io });

  // 2. Real-time socket
  if (activeChannels.includes("socket") && io) {
    console.log(`[notificationService] Sending socket.io notification to user:${userId}`);
    io.to(`user:${userId}`).emit("notification_new", {
      id: notification.id,
      userId,
      notification,
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
      // A user can have more than one active subscription after Chrome rotates
      // a PushSubscription. Give deliveries for the same persisted entity a
      // stable browser-notification tag so the service worker replaces a stale
      // card instead of showing the same event twice.
      const pushTag = entityType && entityId
        ? `crm-${String(entityType).toLowerCase()}-${entityId}`
        : undefined;
      await pushService.sendToUser(userId, {
        title,
        body: message,
        url: link,
        ...(pushTag ? { tag: pushTag } : {}),
      }, prisma);
    } catch (e) {
      console.warn("[Notification-Push] Push delivery failed:", e.message);
    }
  }

  // 4. Email (best-effort)
  if (activeChannels.includes("email")) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user?.email) {
        let cc = [];
        try {
          const emailConfig = await getNotificationEmailConfig(prisma, tenantId);
          cc = [...new Set([...emailConfig.ccRecipients, emailConfig.receiverEmail]
            .filter(Boolean)
            .filter((email) => email !== String(user.email).trim().toLowerCase()))];
        } catch (error) {
          console.error("[Notification-Email] Failed to load tenant email settings:", error.message);
        }
        await sendNotificationEmail(tenantId, user.email, title, message, emailHtml, link, cc);
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
async function notifyMany({ userIds, tenantId, title, message, type, priority, link, entityType, entityId, category, emailHtml, dedupWindowHours, channels, io, ignorePreferences = false, fanoutOptionalChannels = true, fanoutEmail = fanoutOptionalChannels, fanoutBrowserPush = fanoutOptionalChannels }) {
  const results = [];
  for (const uid of userIds) {
    const n = await notify({ userId: uid, tenantId, title, message, type, priority, link, entityType, entityId, category, emailHtml, dedupWindowHours, channels, io, ignorePreferences, fanoutOptionalChannels, fanoutEmail, fanoutBrowserPush });
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
