const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const router = express.Router();

// Mailgun config (shared with cron engine)
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

async function sendMailgun(to, subject, body) {
  if (!MAILGUN_API_KEY) {
    console.log(`[ScheduledEmail] Mailgun not configured — email to ${to} logged but not sent`);
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
      return { sent: true, id: data.id };
    }
    const err = await response.text();
    return { sent: false, reason: err };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// ── Signature endpoints (specific routes BEFORE /:id) ──────────────

// GET current user's signature
router.get("/signature", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, emailSignature: true },
    });
    res.json({ signature: user?.emailSignature || "" });
  } catch (err) {
    console.error("[ScheduledEmail] Signature fetch error:", err);
    res.status(500).json({ error: "Failed to fetch signature" });
  }
});

// PUT update current user's signature
router.put("/signature", async (req, res) => {
  try {
    const { signature } = req.body;
    if (typeof signature !== "string") {
      return res.status(400).json({ error: "signature must be a string" });
    }
    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: { emailSignature: signature },
      select: { id: true, emailSignature: true },
    });
    res.json({ signature: user.emailSignature || "" });
  } catch (err) {
    console.error("[ScheduledEmail] Signature update error:", err);
    res.status(500).json({ error: "Failed to update signature" });
  }
});

// ── Scheduled Emails ────────────────────────────────────────────────

// GET list — defaults to next 7 days, filterable by status
router.get("/", async (req, res) => {
  try {
    const { status, all } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = String(status).toUpperCase();
    if (!all) {
      const now = new Date();
      const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      where.scheduledFor = { gte: now, lte: in7Days };
    }
    const records = await prisma.scheduledEmail.findMany({
      where,
      orderBy: { scheduledFor: "asc" },
      take: 200,
    });
    res.json(records);
  } catch (err) {
    console.error("[ScheduledEmail] List error:", err);
    res.status(500).json({ error: "Failed to list scheduled emails" });
  }
});

// POST schedule a new email
router.post("/", async (req, res) => {
  try {
    const { to, subject, body, scheduledFor, contactId } = req.body;
    if (!to || !subject || !body || !scheduledFor) {
      return res.status(400).json({ error: "to, subject, body, and scheduledFor are required" });
    }
    const when = new Date(scheduledFor);
    if (isNaN(when.getTime())) {
      return res.status(400).json({ error: "scheduledFor must be a valid ISO date" });
    }
    if (when.getTime() <= Date.now()) {
      return res.status(400).json({ error: "scheduledFor must be in the future" });
    }

    // Append signature if user has one
    let finalBody = body;
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { emailSignature: true },
    });
    if (user && user.emailSignature && user.emailSignature.trim()) {
      finalBody = `${body}\n\n${user.emailSignature}`;
    }

    const record = await prisma.scheduledEmail.create({
      data: {
        to,
        subject,
        body: finalBody,
        scheduledFor: when,
        status: "PENDING",
        contactId: contactId ? parseInt(contactId) : null,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(record);
  } catch (err) {
    console.error("[ScheduledEmail] Create error:", err);
    res.status(500).json({ error: "Failed to schedule email" });
  }
});

// GET single
router.get("/:id", async (req, res) => {
  try {
    const record = await prisma.scheduledEmail.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!record) return res.status(404).json({ error: "Not found" });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scheduled email" });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const record = await prisma.scheduledEmail.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!record) return res.status(404).json({ error: "Not found" });
    await prisma.scheduledEmail.delete({ where: { id: record.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete scheduled email" });
  }
});

// POST cancel — only if PENDING
router.post("/:id/cancel", async (req, res) => {
  try {
    const record = await prisma.scheduledEmail.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!record) return res.status(404).json({ error: "Not found" });
    if (record.status !== "PENDING") {
      return res.status(400).json({ error: `Cannot cancel email with status ${record.status}` });
    }
    const updated = await prisma.scheduledEmail.update({
      where: { id: record.id },
      data: { status: "CANCELED" },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel scheduled email" });
  }
});

// POST send-now — fire immediately
router.post("/:id/send-now", async (req, res) => {
  try {
    const record = await prisma.scheduledEmail.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!record) return res.status(404).json({ error: "Not found" });
    if (record.status === "SENT") {
      return res.status(400).json({ error: "Already sent" });
    }

    // Build EmailMessage row first so we can attach a tracking pixel
    const emailRecord = await prisma.emailMessage.create({
      data: {
        subject: record.subject,
        body: record.body,
        from: FROM_EMAIL,
        to: record.to,
        direction: "OUTBOUND",
        read: true,
        contactId: record.contactId,
        userId: record.userId,
        tenantId: record.tenantId,
      },
    });

    const trackingId = crypto.randomUUID();
    await prisma.emailTracking.create({
      data: {
        emailId: emailRecord.id,
        trackingId,
        type: "open",
        tenantId: record.tenantId,
      },
    });

    const baseUrl = process.env.BASE_URL || "https://crm.globusdemos.com";
    const trackedBody = `${record.body}\n\n<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" />`;

    const result = await sendMailgun(record.to, record.subject, trackedBody);

    if (result.sent) {
      const updated = await prisma.scheduledEmail.update({
        where: { id: record.id },
        data: { status: "SENT", sentAt: new Date(), errorMessage: null },
      });
      return res.json({ success: true, delivered: true, record: updated });
    } else {
      const updated = await prisma.scheduledEmail.update({
        where: { id: record.id },
        data: { status: "FAILED", errorMessage: result.reason || "send failed" },
      });
      return res.status(502).json({ success: false, delivered: false, record: updated });
    }
  } catch (err) {
    console.error("[ScheduledEmail] Send-now error:", err);
    res.status(500).json({ error: "Failed to send scheduled email" });
  }
});

module.exports = router;
