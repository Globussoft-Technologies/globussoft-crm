const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });
const { PrismaClient } = require("@prisma/client");

const crypto = require("crypto");

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

    // Always persist to DB first
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

    // Create tracking pixel for open tracking
    const trackingId = crypto.randomUUID();
    await prisma.emailTracking.create({
      data: { emailId: emailRecord.id, trackingId, type: "open" }
    });

    // Inject tracking pixel into email body for Mailgun
    const baseUrl = process.env.BASE_URL || "https://crm.globusdemos.com";
    const trackedBody = `${body}\n\n<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" />`;

    // Send via Mailgun with tracking pixel
    const mailResult = await sendMailgun(to, subject, trackedBody);

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

// ── Email Tracking ────────────────────────────────────────────────

// Open tracking pixel (no auth — embedded in emails)
router.get("/track/:trackingId/open.gif", async (req, res) => {
  try {
    await prisma.emailTracking.update({
      where: { trackingId: req.params.trackingId },
      data: { openedAt: new Date(), ipAddress: req.ip, userAgent: req.headers["user-agent"] },
    });

    // Update the email's read count or mark as opened
    const track = await prisma.emailTracking.findUnique({ where: { trackingId: req.params.trackingId } });
    if (track) {
      // Emit real-time notification
      if (req.io) req.io.emit("email_opened", { emailId: track.emailId, trackingId: track.trackingId });
    }
  } catch (err) { /* silent — don't break tracking pixel */ }

  // Return 1x1 transparent GIF
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache" }).send(gif);
});

// Click tracking redirect (no auth — embedded in email links)
router.get("/track/:trackingId/click", async (req, res) => {
  try {
    const { url } = req.query;
    await prisma.emailTracking.updateMany({
      where: { trackingId: req.params.trackingId },
      data: { clickedAt: new Date(), type: "click", url: url || null },
    });
    if (req.io) req.io.emit("email_clicked", { trackingId: req.params.trackingId, url });
  } catch (err) { /* silent */ }
  res.redirect(req.query.url || "/");
});

// Get tracking stats for an email
router.get("/tracking/:emailId", async (req, res) => {
  try {
    const tracks = await prisma.emailTracking.findMany({ where: { emailId: parseInt(req.params.emailId) } });
    const opens = tracks.filter(t => t.openedAt).length;
    const clicks = tracks.filter(t => t.clickedAt).length;
    res.json({ emailId: parseInt(req.params.emailId), opens, clicks, events: tracks });
  } catch (err) { res.status(500).json({ error: "Failed to fetch tracking data" }); }
});

module.exports = router;
