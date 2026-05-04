const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const crypto = require("crypto");

const router = express.Router();
const prisma = require("../lib/prisma");

// Mailgun email sending via their REST API
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || "crm.globusdemos.com";
const FROM_EMAIL = `Globussoft CRM <noreply@${MAILGUN_DOMAIN}>`;

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

async function sendMailgun(to, subject, body) {
  if (!MAILGUN_API_KEY) {
    console.log(`[Email] Mailgun not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  if (!isValidEmail(to)) {
    console.error(`[Email] Invalid email address: ${to}`);
    return { sent: false, reason: "invalid_recipient_email" };
  }

  if (!subject || !body) {
    return { sent: false, reason: "missing_subject_or_body" };
  }

  const formData = new URLSearchParams();
  formData.append("from", FROM_EMAIL);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", body);
  const htmlBody = escapeHtml(body).replace(/\n/g, "<br>");
  formData.append("html", htmlBody);

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
      return { sent: false, reason: `mailgun_error_${response.status}`, details: err };
    }
  } catch (err) {
    console.error("[Email] Send error:", err.message);
    return { sent: false, reason: "send_error", details: err.message };
  }
}

if (MAILGUN_API_KEY) {
  console.log(`[Email] Mailgun configured for domain: ${MAILGUN_DOMAIN}`);
} else {
  console.warn("[Email] MAILGUN_API_KEY not set — emails will be logged but not delivered");
}

// GET all communications (Unified Inbox) — scoped to current tenant
router.get("/inbox", async (req, res) => {
  try {
    const emails = await prisma.emailMessage.findMany({
      where: { tenantId: req.user.tenantId },
      include: { contact: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(emails);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch inbox load" });
  }
});

// #435: parse a comma-separated "to" string into a deduped list of
// candidate recipients. Trims, drops empties, lowercase-dedupes (preserves
// first-seen casing). Pure / no I/O so it's easy to unit-test if needed.
function parseRecipients(toField) {
  if (typeof toField !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const raw of toField.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// POST to send email via CRM (now with real Mailgun delivery + #435 multi-recipient).
//
// Response shape — envelope (#435 design (b)):
//   {
//     success: true,
//     delivered: <bool — true iff every attempted send was accepted by Mailgun>,
//     email: <first EmailMessage row, or null if zero sent>,    // back-compat
//     messageId: <first Mailgun id, or undefined>,              // back-compat
//     totalSent: N,                                             // delivered count
//     totalFailed: M,                                           // attempted-but-failed
//     results: [{ to, delivered, email, messageId, reason? }, ...],
//     failures: [{ to, reason }, ...]    // pre-flight invalid recipients
//   }
//
// Single-recipient calls keep the top-level `email` + `messageId` for back-compat.
// Multi-recipient calls expose the full per-recipient breakdown via `results` /
// `failures`. Mailgun is called once per valid recipient (no BCC fan-out — keeps
// per-recipient tracking pixels distinct).
router.post("/send-email", async (req, res) => {
  try {
    const { to, subject, body, contactId } = req.body;
    if (!to || !subject) return res.status(400).json({ error: "Recipient and subject required" });
    if (!req.user) return res.status(401).json({ error: "Authentication required" });

    const recipients = parseRecipients(to);
    if (recipients.length === 0) {
      return res.status(400).json({ error: "No valid recipient parsed from 'to'" });
    }

    // Pre-flight validation: split into deliverable + invalid before touching DB.
    // Mailgun-side invalids would still get an EmailMessage row + tracking pixel
    // for an address we know we can't deliver to — wasteful and confusing in the
    // inbox.
    const deliverable = [];
    const failures = [];
    for (const r of recipients) {
      if (isValidEmail(r)) deliverable.push(r);
      else failures.push({ to: r, reason: "invalid_recipient_email" });
    }
    if (deliverable.length === 0) {
      return res.status(400).json({
        error: "No valid recipient parsed from 'to'",
        failures,
      });
    }

    const baseUrl = process.env.BASE_URL || "https://crm.globusdemos.com";
    const results = [];

    for (const recipient of deliverable) {
      const emailRecord = await prisma.emailMessage.create({
        data: {
          subject,
          body,
          from: FROM_EMAIL,
          to: recipient,
          direction: "OUTBOUND",
          read: true,
          contactId: contactId ? parseInt(contactId) : null,
          userId: req.user.userId,
          tenantId: req.user.tenantId,
        }
      });

      // Per-recipient tracking pixel so opens / clicks attribute correctly.
      const trackingId = crypto.randomUUID();
      await prisma.emailTracking.create({
        data: { emailId: emailRecord.id, trackingId, type: "open", tenantId: req.user.tenantId }
      });
      const trackedBody = `${body}\n\n<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" />`;

      const mailResult = await sendMailgun(recipient, subject, trackedBody);

      // Per-recipient Activity on the linked contact (if any). Same pattern as
      // single-recipient: best-effort, non-critical.
      if (contactId) {
        await prisma.activity.create({
          data: {
            type: "Email",
            description: `Sent email: "${subject}"`,
            contactId: parseInt(contactId),
            userId: req.user.userId,
            tenantId: req.user.tenantId,
          }
        }).catch(() => {});
      }

      if (req.io) req.io.emit('email_sent', emailRecord);

      results.push({
        to: recipient,
        delivered: mailResult.sent,
        email: emailRecord,
        messageId: mailResult.id,
        ...(mailResult.sent ? {} : { reason: mailResult.reason }),
      });
    }

    const totalSent = results.filter(r => r.delivered).length;
    const totalFailed = results.length - totalSent + failures.length;

    // Always 200 with the envelope. The single-recipient case keeps the top-level
    // `email` + `messageId` keys (back-compat with the pre-#435 response shape
    // that the Inbox / DocumentTemplates / 50+ specs rely on); multi-recipient
    // adds the per-recipient `results` + `failures` arrays. The `delivered` flag
    // is true iff every attempted Mailgun call was accepted (single-recipient
    // semantics preserved); `success` is true when at least one row landed in
    // the DB.
    res.status(200).json({
      success: true,
      delivered: results.length > 0 && results.every(r => r.delivered),
      email: results[0]?.email ?? null,
      messageId: results[0]?.messageId,
      ...(results[0] && !results[0].delivered ? { reason: results[0].reason } : {}),
      totalSent,
      totalFailed,
      results,
      failures,
    });
  } catch (err) {
    console.error("[Email] Dispatch error:", err);
    res.status(500).json({ error: "Email dispatch failed", details: err.message });
  }
});

// GET all call logs — scoped to tenant
router.get("/calls", async (req, res) => {
  try {
    const calls = await prisma.callLog.findMany({
      where: { tenantId: req.user.tenantId },
      include: { contact: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(calls);
  } catch (_err) {
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
        userId: req.user ? req.user.userId : null,
        tenantId: req.user.tenantId,
      }
    });

    if (req.io) req.io.emit('call_logged', callLog);
    res.status(201).json(callLog);
  } catch (_err) {
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
  } catch (_err) { /* silent — don't break tracking pixel */ }

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
  } catch (_err) { /* silent */ }
  res.redirect(req.query.url || "/");
});

// Get tracking stats for an email
router.get("/tracking/:emailId", async (req, res) => {
  try {
    const tracks = await prisma.emailTracking.findMany({ where: { emailId: parseInt(req.params.emailId), tenantId: req.user.tenantId } });
    const opens = tracks.filter(t => t.openedAt).length;
    const clicks = tracks.filter(t => t.clickedAt).length;
    res.json({ emailId: parseInt(req.params.emailId), opens, clicks, events: tracks });
  } catch (_err) { res.status(500).json({ error: "Failed to fetch tracking data" }); }
});

module.exports = router;
