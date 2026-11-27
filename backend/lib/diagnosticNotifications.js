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
const { getNotificationEmailConfig } = require("./notificationEmailCc");
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

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function absoluteCrmUrl(path) {
  const base = String(process.env.FRONTEND_URL || "https://crm.globusdemos.com").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildDiagnosticEmail({ subBrand, diagnosticId, contactLabel, score, classificationLabel, recommendedTier, link, reportPdfUrl }) {
  // Keep both email affordances pointed at the downloadable diagnostic PDF.
  const reportUrl = absoluteCrmUrl(reportPdfUrl || link || `/travel/diagnostics/${diagnosticId}`);
  const reportLabel = "Open diagnostic report";
  const label = SUB_BRAND_LABELS[subBrand] || subBrand;
  const rows = [
    ["Diagnostic", `#${diagnosticId}`],
    ["Sub-brand", label],
    ["Customer", contactLabel || "Not provided"],
    ["Score", Number.isFinite(Number(score)) ? String(score) : "Not scored"],
    ["Classification", classificationLabel || "Not classified"],
    ["Recommended tier", recommendedTier || "Not assigned"],
  ];
  const text = [
    `New ${label} diagnostic submission`,
    "",
    ...rows.map(([name, value]) => `${name}: ${value}`),
    "",
    `Open the diagnostic report: ${reportUrl}`,
  ].join("\n");
  const htmlRows = rows.map(([name, value]) => `<tr><td style="padding:8px 12px;color:#667085;font-weight:600">${escapeHtml(name)}</td><td style="padding:8px 12px">${escapeHtml(value)}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#1d2939;max-width:640px"><h2>New ${escapeHtml(label)} diagnostic submission</h2><table style="border-collapse:collapse;width:100%;border:1px solid #eaecf0">${htmlRows}</table><p style="margin-top:24px"><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">${reportLabel}</a></p><p style="color:#667085;font-size:12px">If the button does not work, open: ${escapeHtml(reportUrl)}</p></div>`;
  return { text, html };
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
  reportPdfUrl: submittedReportPdfUrl,
}) {
  try {
    const recipients = await diagnosticNotificationSettings.getNotificationRecipients({ tenantId, subBrand });
    const { title, message } = buildCopy({ subBrand, diagnosticId, contactLabel, score, classificationLabel, recommendedTier });
    const resolvedLink = link || `/travel/diagnostics/${diagnosticId}`;
    const diagnostic = prisma.travelDiagnostic?.findFirst
      ? await prisma.travelDiagnostic.findFirst({
        where: { id: Number(diagnosticId), tenantId },
        select: { reportPdfUrl: true, reportSlugToken: true },
      }).catch(() => null)
      : null;
    const reportPdfUrl = submittedReportPdfUrl || diagnostic?.reportPdfUrl || null;
    const tenant = diagnostic?.reportSlugToken && prisma.tenant?.findUnique
      ? await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true },
      }).catch(() => null)
      : null;
    const publicReportLink = String(subBrand || "").toLowerCase() === "tmc" && diagnostic?.reportSlugToken
      && tenant?.slug
      ? `/diagnostic-form/${encodeURIComponent(tenant.slug)}/tmc/report/${encodeURIComponent(`${diagnosticId}-${diagnostic.reportSlugToken}`)}`
      : resolvedLink;
    const reportLink = reportPdfUrl || publicReportLink;
    const email = buildDiagnosticEmail({
      subBrand,
      diagnosticId,
      contactLabel,
      score,
      classificationLabel,
      recommendedTier,
      link: reportLink,
      reportPdfUrl,
    });
    let tenantEmailConfig = null;
    try {
      tenantEmailConfig = await getNotificationEmailConfig(prisma, tenantId);
    } catch (error) {
      console.error("[diagnosticNotifications] tenant email settings lookup failed:", error.message);
    }

    if (!recipients.length) {
      // Keep the in-app alert broad, but prefer an explicitly configured
      // tenant email destination over emailing every ADMIN/MANAGER directly.
      const fallbackUsers = await prisma.user.findMany({
        where: { tenantId, role: { in: ["ADMIN", "MANAGER"] } },
        select: { id: true, email: true },
      });
      if (!fallbackUsers.length) return;
      await notifyMany({
        userIds: fallbackUsers.map((u) => u.id),
        tenantId,
        title,
        message,
        type: "info",
        category: "tmc_catalogue",
        link: resolvedLink,
        entityType: "TravelDiagnostic",
        entityId: diagnosticId,
        channels: ["db", "socket"],
        fanoutOptionalChannels: false,
        fanoutBrowserPush: true,
      });
      if (tenantEmailConfig === null) return;

      const ccRecipients = tenantEmailConfig.ccRecipients || [];
      const configuredTo = tenantEmailConfig.receiverEmail || ccRecipients[0];
      if (configuredTo) {
        const normalizedTo = String(configuredTo).trim().toLowerCase();
        const cc = [...new Set(ccRecipients
          .map((address) => String(address || "").trim().toLowerCase())
          .filter((address) => address && address !== normalizedTo))];
        await sendEmail({
          tenantId,
          to: configuredTo,
          cc,
          subject: title,
          text: email.text,
          html: email.html,
        });
      } else {
        await Promise.all(fallbackUsers
          .filter((user) => user.email)
          .map((user) => sendEmail({
            tenantId,
            to: user.email,
            subject: title,
            text: email.text,
            html: email.html,
          })));
      }
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
            category: "tmc_catalogue",
            link: resolvedLink,
            entityType: "TravelDiagnostic",
            entityId: diagnosticId,
            channels: ["db", "socket"],
            fanoutOptionalChannels: false,
            fanoutBrowserPush: true,
          });
        } catch (e) {
          console.warn(`[diagnosticNotifications] db notify failed for user ${r.userId} (non-fatal):`, e.message);
        }
      }
      if (r.channels.includes("email") && user.email) {
        try {
          const primaryEmail = String(user.email).trim().toLowerCase();
          const cc = [...new Set([
            ...(tenantEmailConfig?.ccRecipients || []),
            tenantEmailConfig?.receiverEmail,
          ]
            .map((address) => String(address || "").trim().toLowerCase())
            .filter((address) => address && address !== primaryEmail))];
          await sendEmail({ tenantId, to: user.email, cc, subject: title, text: email.text, html: email.html });
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

  if (!user.email) {
    result.email = "no_email_on_file";
  } else {
    try {
      const r = await sendEmail({ tenantId, to: user.email, subject: title, text: message });
      result.email = r?.sent ? "sent" : r?.reason === "no_api_key" ? "unavailable" : "failed";
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
