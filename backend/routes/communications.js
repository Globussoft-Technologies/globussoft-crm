const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// Mailgun email sending via their REST API
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function sendMailgun(to, subject, body) {
  if (!MAILGUN_API_KEY) {
    console.log(`[Email] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  const formData = new URLSearchParams();
  formData.append("from", FROM_EMAIL);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", body);
  formData.append("html", body.replace(/\n/g, "<br>"));

  try {
    const response = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from("api:" + MAILGUN_API_KEY).toString("base64") },
      body: formData,
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[Email] Sent to ${to}: ${data.id}`);
      return { sent: true, id: data.id };
    } else {
      const err = await response.text();
      console.error(`[Email] Mailgun error (${response.status}):`, err);
      return { sent: false, reason: err };
    }
  } catch (err) {
    console.error("[Email] Send error:", err.message);
    return { sent: false, reason: err.message };
  }
}

if (MAILGUN_API_KEY) {
  console.log(`[Email] Mailgun configured for domain: ${MAILGUN_DOMAIN}`);
} else {
  console.warn("[Email] MAILGUN_API_KEY not set — emails will be logged but not delivered");
}

// GET all communications (Unified Inbox)
router.get("/inbox", async (req, res) => {
  try {
    const emails = await prisma.emailMessage.findMany({
      include: { contact: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch inbox load" });
  }
});

// POST to send email via CRM (now with real Mailgun delivery)
router.post("/send-email", async (req, res) => {
  try {
    const { to, subject, body, contactId } = req.body;
    if (!to || !subject) return res.status(400).json({ error: "Recipient and subject required" });

    // Send via Mailgun
    const mailResult = await sendMailgun(to, subject, body);

    // Always persist to DB regardless of delivery status
    const emailRecord = await prisma.emailMessage.create({
      data: {
        subject,
        body,
        from: FROM_EMAIL,
        to,
        direction: "OUTBOUND",
        read: true,
        contactId: contactId ? parseInt(contactId) : null,
        userId: req.user ? req.user.id : null
      }
    });

    // Create activity on the contact
    if (contactId) {
      await prisma.activity.create({
        data: {
          type: "Email",
          description: `Sent email: "${subject}"`,
          contactId: parseInt(contactId),
          userId: req.user ? req.user.id : null,
        }
      }).catch(() => {}); // non-critical
    }

    if (req.io) req.io.emit('email_sent', emailRecord);
    res.status(200).json({ success: true, delivered: mailResult.sent, email: emailRecord });
  } catch (err) {
    console.error("[Email] Dispatch error:", err);
    res.status(500).json({ error: "Email dispatch failed" });
  }
});

// GET all call logs
router.get("/calls", async (req, res) => {
  try {
    const calls = await prisma.callLog.findMany({
      include: { contact: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch call history" });
  }
});

// POST to log a call
router.post("/log-call", async (req, res) => {
  try {
    const { duration, notes, contactId, direction, recordingUrl } = req.body;
    const callLog = await prisma.callLog.create({
      data: {
        duration: parseInt(duration),
        notes,
        direction: direction || "OUTBOUND",
        recordingUrl,
        contactId: contactId ? parseInt(contactId) : null,
        userId: req.user ? req.user.id : null
      }
    });

    if (req.io) req.io.emit('call_logged', callLog);
    res.status(201).json(callLog);
  } catch (err) {
    res.status(500).json({ error: "Logging phone interaction failed" });
  }
});

module.exports = router;
