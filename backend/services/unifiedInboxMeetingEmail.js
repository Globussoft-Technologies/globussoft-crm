const prisma = require("../lib/prisma");
const { sendEmail } = require("../lib/emailSender");
const { google } = require("googleapis");
const { buildRawMessage } = require("../lib/gmailMessage");
const { formatInTenantTZ } = require("../lib/datetime");

const GOOGLE_CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GMAIL_REDIRECT_URI = () => process.env.GMAIL_REDIRECT_URI || process.env.GOOGLE_GMAIL_REDIRECT_URI || "http://localhost:5000/api/gmail/callback";

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function interpolate(template, values) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => String(values[key] ?? ""));
}

function templateValues(form, booking) {
  return {
    name: booking.contactName,
    date: formatInTenantTZ(booking.scheduledAt, booking.timezone, "EEEE, d MMMM yyyy"),
    time: formatInTenantTZ(booking.scheduledAt, booking.timezone, "h:mm a zzz"),
    timezone: booking.timezone,
    duration: String(form.durationMins),
    meeting_url: booking.meetingUrl || "",
    institution: booking.institution || "",
  };
}

function renderMeetingTemplate({ form, booking }) {
  const values = templateValues(form, booking);
  const subject = interpolate(form.emailSubject, values);
  const configuredBody = interpolate(form.emailBody, values);
  const text = configuredBody || [
    `Hi ${values.name},`,
    "",
    "Your conversation with The Modern Classroom is confirmed.",
    `Date: ${values.date}`,
    `Time: ${values.time}`,
    `Format: ${values.duration}-minute Zoom conversation`,
    "",
    `Join Zoom Meeting: ${values.meeting_url}`,
  ].join("\n");
  return { values, subject, text };
}

function publicAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const candidates = [
    process.env.PUBLIC_BASE_URL,
    process.env.FRONTEND_URL,
    process.env.BASE_URL,
    "https://crm.globusdemos.com",
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(String(candidate || "").trim());
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      const base = parsed.origin;
      return new URL(raw.startsWith("/") ? raw : `/${raw}`, `${base}/`).toString();
    } catch {
      // Vite/Vitest commonly sets BASE_URL="/". Ignore non-origin values and
      // continue to the production-safe fallback instead of dropping assets.
    }
  }
  return "";
}

function buildMeetingHtml({ form, text, meetingUrl }) {
  const escapedMeetingUrl = escapeHtml(meetingUrl);
  let linkedBody = escapeHtml(text);
  if (escapedMeetingUrl) {
    linkedBody = linkedBody.replace(escapedMeetingUrl, `<a href="${escapedMeetingUrl}" style="display:inline-block;padding:12px 18px;background:#0798d4;color:#fff;text-decoration:none;border-radius:6px">Join Zoom Meeting</a>`);
  }
  const body = linkedBody
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph) => `<div style="margin:0 0 14px">${paragraph.replace(/\n/g, "<br>")}</div>`)
    .join("");
  const logoUrl = publicAssetUrl(form.emailLogoUrl);
  const logo = logoUrl
    ? `<div style="margin-top:24px;padding-top:18px;border-top:1px solid #e5e7eb"><img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(form.name || "Company")} logo" style="display:block;max-width:180px;max-height:72px;width:auto;height:auto;object-fit:contain" /></div>`
    : "";
  return `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#122647">${body}${logo}</div>`;
}

async function sendThroughConnectedInbox({ form, booking, subject, text, html }) {
  const integration = await prisma.gmailIntegration.findUnique({
    where: {
      tenantId_userId_provider: {
        tenantId: booking.tenantId,
        userId: form.hostUserId,
        provider: "google",
      },
    },
  });
  if (!integration) return null;

  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID(), GOOGLE_CLIENT_SECRET(), GMAIL_REDIRECT_URI());
  client.setCredentials({
    access_token: integration.accessToken,
    refresh_token: integration.refreshToken || undefined,
    expiry_date: integration.expiresAt ? integration.expiresAt.getTime() : undefined,
  });
  client.on("tokens", async (tokens) => {
    const data = {};
    if (tokens.access_token) data.accessToken = tokens.access_token;
    if (tokens.refresh_token) data.refreshToken = tokens.refresh_token;
    if (tokens.expiry_date) data.expiresAt = new Date(tokens.expiry_date);
    if (Object.keys(data).length) {
      await prisma.gmailIntegration.update({ where: { id: integration.id }, data }).catch(() => {});
    }
  });

  try {
    const gmail = google.gmail({ version: "v1", auth: client });
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: buildRawMessage({
          from: integration.emailAddress || undefined,
          to: booking.contactEmail,
          subject,
          text,
          html,
        }),
      },
    });
    return {
      sent: true,
      from: integration.emailAddress || "me",
      threadId: sent.data?.threadId || `travel-meeting-${booking.id}`,
    };
  } catch (error) {
    console.error("[travel-meeting-email] connected Gmail send failed:", error.message);
    return { sent: false, reason: error.code ? `gmail_${error.code}` : "gmail_send_failed" };
  }
}

async function sendMeetingConfirmation({ form, booking }) {
  const { values, subject, text } = renderMeetingTemplate({ form, booking });
  const html = buildMeetingHtml({ form, text, meetingUrl: values.meeting_url });

  // Prefer the host's mailbox already connected to Unified Inbox. If that
  // connection is missing, expired, or rejected, still try the transactional
  // sender before reporting the confirmation as failed.
  const inboxResult = await sendThroughConnectedInbox({ form, booking, subject, text, html });
  const sendGridResult = inboxResult?.sent
    ? null
    : await sendEmail({ to: booking.contactEmail, subject, text, html });
  const result = inboxResult?.sent ? inboxResult : sendGridResult;
  const failureReason = result?.sent
    ? null
    : [inboxResult?.reason, sendGridResult?.reason].filter(Boolean).join("; ") || "email_send_failed";
  let emailMessageId = null;
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: booking.tenantId }, select: { emailRetention: true } });
    if (result.sent === true && tenant?.emailRetention !== false) {
      const row = await prisma.emailMessage.create({
        data: {
          tenantId: booking.tenantId,
          userId: form.hostUserId,
          contactId: booking.contactId || null,
          subject,
          body: html,
          from: result.from || process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com",
          to: booking.contactEmail,
          direction: "OUTBOUND",
          read: true,
          threadId: result.threadId || `travel-meeting-${booking.id}`,
        },
      });
      emailMessageId = row.id;
    }
  } catch (error) {
    console.error("[travel-meeting-email] Unified Inbox persistence failed:", error.message);
  }
  return { sent: result?.sent === true, reason: failureReason, emailMessageId };
}

module.exports = { sendMeetingConfirmation, interpolate, templateValues, renderMeetingTemplate, publicAssetUrl, buildMeetingHtml };
