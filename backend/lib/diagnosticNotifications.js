/**
 * Orchestrates "who gets told, and how" when a travel diagnostic is
 * submitted (2026-08-28) — the send-side counterpart to
 * diagnosticNotificationSettings.js's storage.
 *
 * Fans a single event out to up to 3 independent channels per recipient:
 *   - db       -> notificationService.notify() with channels:['db','socket']
 *                 (in-app bell + live socket push; NOT notify()'s bundled
 *                 'email' channel — see note below).
 *   - email    -> emailSender.sendEmail() directly, NOT notify()'s inline
 *                 SendGrid path. notify()'s email channel is gated behind
 *                 each user's personal NotificationPreference row, which
 *                 defaults email to OFF for anyone who has never touched
 *                 their notification settings — that would silently defeat
 *                 an admin's explicit "email Priya about new diagnostics"
 *                 configuration for most real users. This is a targeted
 *                 operational alert the admin deliberately set up per
 *                 person, not a personal-preference-driven notification, so
 *                 it bypasses that gate.
 *   - whatsapp -> whatsappWebClient.sendBestEffort() (free-form text, no
 *                 template needed, never throws, degrades to a stub if the
 *                 tenant hasn't connected a WhatsApp Web session).
 *
 * Every send is best-effort and independently caught — one recipient or
 * one channel failing never blocks the rest, and this function itself
 * never throws (matches every existing diagnostic-submit call site's
 * try/catch-and-warn style).
 */

const prisma = require("./prisma");
const diagnosticNotificationSettings = require("./diagnosticNotificationSettings");
const { notify, notifyMany } = require("./notificationService");
const { sendEmail } = require("./emailSender");
const whatsappWebClient = require("../services/whatsappWebClient");

const SUB_BRAND_LABELS = {
  tmc: "TMC",
  rfu: "RFU",
  travelstall: "Travel Stall",
  visasure: "Visa Sure",
};

function buildCopy({ subBrand, diagnosticId, contactLabel, score, classificationLabel, recommendedTier }) {
  const label = SUB_BRAND_LABELS[subBrand] || subBrand;
  const who = contactLabel || `Diagnostic #${diagnosticId}`;
  const scoreBit = Number.isFinite(Number(score)) ? ` and scored ${score}` : "";
  const classBit = classificationLabel || recommendedTier ? ` (${classificationLabel || recommendedTier})` : "";
  return {
    title: `New ${label} diagnostic submission`,
    message: `${who} submitted a diagnostic${scoreBit}${classBit}.`,
  };
}

/**
 * Fire the "a diagnostic was just submitted" notification. Never throws.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {number} opts.diagnosticId
 * @param {string} [opts.contactLabel] - display name/email for the submitter
 * @param {number|string} [opts.score]
 * @param {string} [opts.classificationLabel]
 * @param {string} [opts.recommendedTier]
 * @param {string} [opts.link] - deep link, defaults to /travel/diagnostics
 */
async function notifyDiagnosticSubmitted({
  tenantId, subBrand, diagnosticId, contactLabel, score, classificationLabel, recommendedTier, link,
}) {
  try {
    const recipients = await diagnosticNotificationSettings.getNotificationRecipients({ tenantId, subBrand });
    const { title, message } = buildCopy({ subBrand, diagnosticId, contactLabel, score, classificationLabel, recommendedTier });
    const resolvedLink = link || "/travel/diagnostics";

    if (!recipients.length) {
      // Zero-config fallback — every ADMIN/MANAGER, in-app only. Preserves
      // exactly what this feature replaces so an un-configured tenant never
      // silently loses the notification it gets today just because nobody
      // has opened the new Notifications tab yet.
      const fallbackUsers = await prisma.user.findMany({
        where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
        select: { id: true },
      });
      if (!fallbackUsers.length) return;
      await notifyMany({
        userIds: fallbackUsers.map((u) => u.id),
        tenantId,
        title,
        message,
        type: "info",
        link: resolvedLink,
        entityType: "TravelDiagnostic",
        entityId: diagnosticId,
        channels: ["db", "socket"],
        ignorePreferences: true,
      });
      return;
    }

    const users = await prisma.user.findMany({
      where: { id: { in: recipients.map((r) => r.userId) }, tenantId },
      select: { id: true, email: true, phone: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    await Promise.all(recipients.map(async (r) => {
      const user = userById.get(r.userId);
      if (!user) return; // stale config referencing a removed/foreign user

      if (r.channels.includes("db")) {
        try {
          await notify({
            userId: r.userId,
            tenantId,
            title,
            message,
            type: "info",
            link: resolvedLink,
            entityType: "TravelDiagnostic",
            entityId: diagnosticId,
            channels: ["db", "socket"],
            ignorePreferences: true,
          });
        } catch (e) {
          console.warn(`[diagnosticNotifications] db notify failed for user ${r.userId} (non-fatal):`, e.message);
        }
      }
      if (r.channels.includes("email") && user.email) {
        try {
          await sendEmail({ to: user.email, subject: title, text: message });
        } catch (e) {
          console.warn(`[diagnosticNotifications] email failed for user ${r.userId} (non-fatal):`, e.message);
        }
      }
      if (r.channels.includes("whatsapp") && user.phone) {
        try {
          await whatsappWebClient.sendBestEffort({ tenantId, subBrand, toPhone: user.phone, fallbackText: message });
        } catch (e) {
          console.warn(`[diagnosticNotifications] whatsapp failed for user ${r.userId} (non-fatal):`, e.message);
        }
      }
    }));
  } catch (e) {
    console.error("[diagnosticNotifications] notifyDiagnosticSubmitted failed (non-fatal):", e.message);
  }
}

/**
 * Send a one-off test ping to a single user across all 3 channels,
 * regardless of their saved configuration, so an admin can verify the
 * Notifications tab is actually working without waiting for a real
 * submission. Reports per-channel outcome instead of throwing.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {number} opts.userId
 * @returns {Promise<{db:string, email:string, whatsapp:string}>}
 */
async function sendTestNotification({ tenantId, subBrand, userId }) {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, email: true, phone: true },
  });
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const label = SUB_BRAND_LABELS[subBrand] || subBrand;
  const title = `Test notification — ${label} diagnostics`;
  const message = "This is a test of the diagnostic notification center. If you received this, the channel is working.";

  const result = { db: "failed", email: "unavailable", whatsapp: "unavailable" };

  try {
    const saved = await notify({ userId, tenantId, title, message, type: "info", channels: ["db", "socket"] });
    result.db = saved ? "sent" : "blocked";
  } catch {
    result.db = "failed";
  }

  if (!process.env.SENDGRID_API_KEY) {
    result.email = "unavailable";
  } else if (!user.email) {
    result.email = "no_email_on_file";
  } else {
    try {
      const r = await sendEmail({ to: user.email, subject: title, text: message });
      result.email = r?.sent ? "sent" : "failed";
    } catch {
      result.email = "failed";
    }
  }

  if (!whatsappWebClient.isConnected(tenantId)) {
    result.whatsapp = "unavailable";
  } else if (!user.phone) {
    result.whatsapp = "no_phone_on_file";
  } else {
    try {
      const r = await whatsappWebClient.sendBestEffort({ tenantId, subBrand, toPhone: user.phone, fallbackText: message });
      result.whatsapp = r?.sent ? "sent" : "failed";
    } catch {
      result.whatsapp = "failed";
    }
  }

  return result;
}

module.exports = {
  notifyDiagnosticSubmitted,
  sendTestNotification,
  SUB_BRAND_LABELS,
};
