const cron = require("node-cron");
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

async function sendViaSendGrid(to, subject, body) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { sent: false, reason: "no_api_key" };
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
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      const messageId = r.headers.get("x-message-id") || "sent";
      return { sent: true, id: messageId };
    }
    const txt = await r.text().catch(() => "");
    return { sent: false, reason: `sendgrid ${r.status}: ${txt}` };
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

        const result = await sendViaSendGrid(item.to, item.subject, trackedBody);

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
