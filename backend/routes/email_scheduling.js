const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");

const router = express.Router();

// SendGrid config (shared with cron engine)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

async function sendSendGrid(to, subject, body) {
  if (!SENDGRID_API_KEY) {
    console.log(`[ScheduledEmail] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }
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
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      const messageId = response.headers.get("x-message-id") || "sent";
      return { sent: true, id: messageId };
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
  } catch (_err) {
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
  } catch (_err) {
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
  } catch (_err) {
    res.status(500).json({ error: "Failed to cancel scheduled email" });
  }
});

// POST send-now — fire immediately
//
// #524: prior version's catch swallowed every failure into an opaque 500 with
// no `code`, no detail, and no audit. The demo regression that opened #524
// showed up as "POST /send-now returns 500" with literally no signal in the
// response — required ssh + pm2 logs to diagnose. Refactor below:
//
//   1. Stage the work in distinct phases (record → tracking → send → mark).
//      Each phase has a stable code (`code` in the 5xx body) so the SPA /
//      QA can tell which phase blew up without log access.
//   2. EmailTracking creation is best-effort. The send still proceeds (and
//      the audit row in EmailMessage still lands) even if the tracking row
//      fails — tracking is a nice-to-have analytics signal, not a blocker.
//   3. ALL 5xx responses carry a stable `code` + a sanitised `detail`
//      (truncated to 200 chars, no stack). Provider 502s on SendGrid 5xx
//      stay separate from 500s on persistence layer (so an SLO dashboard
//      can split "our bug" from "SendGrid is down").
//   4. ScheduledEmail row gets marked FAILED with the underlying message
//      regardless of whether the failure is in our prisma writes or
//      SendGrid — UI shows the real reason instead of the previous "send
//      failed" placeholder.
router.post("/:id/send-now", async (req, res) => {
  let record = null;
  try {
    record = await prisma.scheduledEmail.findFirst({
      where: { id: parseInt(req.params.id), tenantId: req.user.tenantId },
    });
    if (!record) return res.status(404).json({ error: "Not found", code: "SCHEDULED_EMAIL_NOT_FOUND" });
    if (record.status === "SENT") {
      return res.status(400).json({ error: "Already sent", code: "ALREADY_SENT" });
    }

    let emailRecord;
    try {
      emailRecord = await prisma.emailMessage.create({
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
    } catch (persistErr) {
      console.error("[ScheduledEmail] EmailMessage persist failed:", persistErr);
      try {
        await prisma.scheduledEmail.update({
          where: { id: record.id },
          data: {
            status: "FAILED",
            errorMessage: `EmailMessage persist failed: ${persistErr.message || persistErr.code || "unknown"}`,
          },
        });
      } catch (_) { /* swallow — already in error path */ }
      return res.status(500).json({
        success: false,
        error: "Failed to record outbound email",
        code: "EMAIL_PERSIST_FAILED",
        detail: String(persistErr.message || persistErr.code || "unknown").slice(0, 200),
      });
    }

    // Tracking row: best-effort. If it blows up (rare — only the @unique
    // trackingId constraint could collide and crypto.randomUUID makes that
    // ~impossible), the send still proceeds without a tracking pixel.
    const trackingId = crypto.randomUUID();
    let trackingOk = false;
    try {
      await prisma.emailTracking.create({
        data: {
          emailId: emailRecord.id,
          trackingId,
          type: "open",
          tenantId: record.tenantId,
        },
      });
      trackingOk = true;
    } catch (trackErr) {
      console.warn("[ScheduledEmail] EmailTracking create failed (non-fatal):", trackErr.message || trackErr.code);
    }

    const baseUrl = process.env.BASE_URL || "https://crm.globusdemos.com";
    const trackedBody = trackingOk
      ? `${record.body}\n\n<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" />`
      : record.body;

    const result = await sendSendGrid(record.to, record.subject, trackedBody);

    if (result.sent) {
      const updated = await prisma.scheduledEmail.update({
        where: { id: record.id },
        data: { status: "SENT", sentAt: new Date(), errorMessage: null },
      });
      return res.json({ success: true, delivered: true, record: updated });
    } else {
      const updated = await prisma.scheduledEmail.update({
        where: { id: record.id },
        data: { status: "FAILED", errorMessage: String(result.reason || "send failed").slice(0, 500) },
      });
      // 502 = upstream provider rejected. Keep separate from 500 so SLO
      // dashboards can distinguish "our bug" from "SendGrid down".
      return res.status(502).json({
        success: false,
        delivered: false,
        record: updated,
        code: result.reason === "no_api_key" ? "SENDGRID_NOT_CONFIGURED" : "SENDGRID_REJECTED",
        detail: String(result.reason || "send failed").slice(0, 200),
      });
    }
  } catch (err) {
    console.error("[ScheduledEmail] Send-now error:", err);
    if (record) {
      try {
        await prisma.scheduledEmail.update({
          where: { id: record.id },
          data: {
            status: "FAILED",
            errorMessage: `send-now: ${err.message || err.code || "unknown"}`.slice(0, 500),
          },
        });
      } catch (_) { /* already in error path */ }
    }
    res.status(500).json({
      error: "Failed to send scheduled email",
      code: "SEND_NOW_INTERNAL",
      detail: String(err.message || err.code || "unknown").slice(0, 200),
    });
  }
});

module.exports = router;
