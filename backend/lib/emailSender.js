// Generic transactional email sender (SendGrid). Shared by any feature that
// needs to email a customer (trip-countdown nudges, etc.). Mirrors the
// SendGrid fetch pattern in routes/communications.js + lib/emailOtp.js.
//
// Returns { sent: boolean, reason?: string } and NEVER throws — callers treat
// email as best-effort. When SENDGRID_API_KEY is unset it logs + returns
// { sent: false, reason: "no_api_key" } so dev/CI exercise the surrounding
// logic without real delivery.

const SENDGRID_API_KEY = () => process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = () => process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

async function sendEmail({ to, subject, text, html }) {
  if (!to || !subject) {
    return { sent: false, reason: "missing_to_or_subject" };
  }
  const key = SENDGRID_API_KEY();
  if (!key) {
    console.log(`[Email] SendGrid not configured — email to ${to} ("${subject}") logged, not sent`);
    return { sent: false, reason: "no_api_key" };
  }
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL() },
    subject,
    content: [
      { type: "text/plain", value: text || subject },
      { type: "text/html", value: html || (text || subject).replace(/\n/g, "<br>") },
    ],
  };
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      console.log(`[Email] Sent to ${to}: "${subject}"`);
      return { sent: true };
    }
    const t = await resp.text();
    console.error(`[Email] SendGrid error ${resp.status}: ${t}`);
    return { sent: false, reason: `sendgrid_${resp.status}` };
  } catch (err) {
    console.error("[Email] send failed:", err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendEmail };
