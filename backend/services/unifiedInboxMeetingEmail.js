const prisma = require("../lib/prisma");
const { sendEmail } = require("../lib/emailSender");
const { formatInTenantTZ } = require("../lib/datetime");

const MEETING_BUTTON_MARKER = "[[TMC_MEETING_BUTTON]]";

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
    meeting_button: MEETING_BUTTON_MARKER,
    institution: booking.institution || "",
  };
}

function renderMeetingTemplate({ form, booking }) {
  const values = templateValues(form, booking);
  const subject = interpolate(form.emailSubject, { ...values, meeting_button: "Join Meeting" });
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
  const plainText = text.replaceAll(
    MEETING_BUTTON_MARKER,
    values.meeting_url ? `Join Meeting: ${values.meeting_url}` : "",
  );
  return { values, subject, text, plainText };
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
  const escapedButtonMarker = escapeHtml(MEETING_BUTTON_MARKER);
  const meetingLink = escapedMeetingUrl
    ? `<a href="${escapedMeetingUrl}" style="color:#2563eb;text-decoration:underline">${escapedMeetingUrl}</a>`
    : "";
  const meetingButton = escapedMeetingUrl
    ? `<a href="${escapedMeetingUrl}" style="display:inline-block;padding:12px 18px;background:#0798d4;color:#fff;text-decoration:none;border-radius:6px;font-weight:700">Join Meeting</a>`
    : "";
  const linkedBody = escapeHtml(text)
    .split(escapedButtonMarker)
    .map((segment) => (escapedMeetingUrl ? segment.split(escapedMeetingUrl).join(meetingLink) : segment))
    .join(meetingButton);
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

async function sendMeetingConfirmation({ form, booking }) {
  const { values, subject, text, plainText } = renderMeetingTemplate({ form, booking });
  const html = buildMeetingHtml({ form, text, meetingUrl: values.meeting_url });

  // Travel CRM email always follows its SendGrid selection: the tenant's
  // customer-managed credentials when configured, otherwise the CRM-managed
  // backend credentials. A connected Gmail inbox does not change this route.
  const result = await sendEmail({
    tenantId: booking.tenantId,
    to: booking.contactEmail,
    subject,
    text: plainText,
    html,
  });
  const failureReason = result?.sent ? null : result?.reason || "email_send_failed";
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
