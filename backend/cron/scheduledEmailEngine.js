const cron = require("node-cron");
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function sendViaMailgun(to, subject, body) {
  const key = process.env.MAILGUN_API_KEY || MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || MAILGUN_DOMAIN;
  if (!key) return { sent: false, reason: "no_api_key" };
  const fd = new URLSearchParams();
  fd.append("from", `Globussoft CRM <noreply@${domain}>`);
  fd.append("to", to);
  fd.append("subject", subject);
  fd.append("text", body);
  fd.append("html", body.replace(/\n/g, "<br>"));
  try {
    const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("api:" + key).toString("base64") },
      body: fd,
    });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return { sent: true, id: data.id };
    }
    const txt = await r.text().catch(() => "");
    return { sent: false, reason: `mailgun ${r.status}: ${txt}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

async function processScheduledEmails() {
  let processed = 0;
  try {
    const now = new Date();
    const due = await prisma.scheduledEmail.findMany({
      where: { status: "PENDING", scheduledFor: { lte: now } },
      take: 50,
    });

    for (const item of due) {
      try {
        // Persist as EmailMessage for inbox visibility
        const emailRecord = await prisma.emailMessage.create({
          data: {
            subject: item.subject,
            body: item.body,
            from: FROM_EMAIL,
            to: item.to,
            direction: "OUTBOUND",
            read: true,
            contactId: item.contactId,
            userId: item.userId,
            tenantId: item.tenantId,
          },
        });

        // Tracking pixel
        const trackingId = crypto.randomUUID();
        await prisma.emailTracking.create({
          data: {
            emailId: emailRecord.id,
            trackingId,
            type: "open",
            tenantId: item.tenantId,
          },
        });

        const baseUrl = process.env.BASE_URL || "https://crm.globusdemos.com";
        const trackedBody = `${item.body}\n\n<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" />`;

        const result = await sendViaMailgun(item.to, item.subject, trackedBody);

        if (result.sent) {
          await prisma.scheduledEmail.update({
            where: { id: item.id },
            data: { status: "SENT", sentAt: new Date(), errorMessage: null },
          });
        } else {
          await prisma.scheduledEmail.update({
            where: { id: item.id },
            data: { status: "FAILED", errorMessage: result.reason || "send failed" },
          });
        }
        processed++;
      } catch (err) {
        console.error(`[ScheduledEmail] Error processing id=${item.id}:`, err.message);
        try {
          await prisma.scheduledEmail.update({
            where: { id: item.id },
            data: { status: "FAILED", errorMessage: err.message },
          });
        } catch (_) { /* ignore */ }
      }
    }

    if (processed > 0) {
      console.log(`[ScheduledEmail] processed ${processed} emails`);
    }
  } catch (err) {
    console.error("[ScheduledEmail] Engine error:", err);
  }
  return processed;
}

function initScheduledEmailCron() {
  cron.schedule("* * * * *", () => {
    processScheduledEmails();
  });
  console.log("Scheduled Email Engine initialized (cron: * * * * *)");
}

module.exports = {
  initScheduledEmailCron,
  processScheduledEmails, // exported for manual debug
};
