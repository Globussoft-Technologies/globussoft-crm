// Generic transactional email sender (SendGrid). Shared by any feature that
// needs to email a customer (trip-countdown nudges, etc.). Mirrors the
// SendGrid fetch pattern in routes/communications.js + lib/emailOtp.js.
//
// Returns { sent: boolean, reason?: string } and NEVER throws — callers treat
// email as best-effort. When SENDGRID_API_KEY is unset it logs + returns
// { sent: false, reason: "no_api_key" } so dev/CI exercise the surrounding
// logic without real delivery.

const { resolveSendGridConfig } = require("../services/travelSendGrid");

function recipientList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const recipients = values
    .map((email) => String(email || "").trim())
    .filter(Boolean)
    .map((email) => ({ email }));
  return recipients.length ? recipients : undefined;
}

async function sendEmail({ tenantId = null, to, cc = [], bcc = [], subject, text, html, attachments = [], fromName = null }) {
  if (!to || !subject) {
    return { sent: false, reason: "missing_to_or_subject" };
  }
  let provider;
  try {
    provider = await resolveSendGridConfig(tenantId);
  } catch (error) {
    console.error(`[Email] Tenant SendGrid configuration failed for tenant ${tenantId}:`, error.message);
    return { sent: false, reason: "tenant_sendgrid_config_invalid", source: "tenant" };
  }
  const key = provider.apiKey;
  if (!key) {
    console.log(`[Email] SendGrid not configured — email to ${to} ("${subject}") logged, not sent`);
    return { sent: false, reason: "no_api_key", source: provider.source };
  }
  const personalization = { to: [{ email: to }] };
  const ccRecipients = recipientList(cc);
  const bccRecipients = recipientList(bcc);
  if (ccRecipients) personalization.cc = ccRecipients;
  if (bccRecipients) personalization.bcc = bccRecipients;
  const senderName = String(fromName || provider.fromName || "").trim();
  const payload = {
    personalizations: [personalization],
    from: {
      email: provider.fromEmail,
      ...(senderName ? { name: senderName } : {}),
    },
    subject,
    content: [
      { type: "text/plain", value: text || subject },
      { type: "text/html", value: html || (text || subject).replace(/\n/g, "<br>") },
    ],
  };
  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments
      .filter((attachment) => attachment && attachment.filename && attachment.content)
      .map((attachment) => ({
        content: attachment.content,
        filename: attachment.filename,
        type: attachment.type || "application/octet-stream",
        disposition: "attachment",
      }));
  }
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      console.log(`[Email] Sent to ${to}: "${subject}"`);
      return { sent: true, from: provider.fromEmail, fromName: senderName || null, source: provider.source };
    }
    const t = await resp.text();
    console.error(`[Email] SendGrid error ${resp.status}: ${t}`);
    return { sent: false, reason: `sendgrid_${resp.status}`, source: provider.source };
  } catch (err) {
    console.error("[Email] send failed:", err.message);
    return { sent: false, reason: err.message, source: provider.source };
  }
}

module.exports = { sendEmail };
