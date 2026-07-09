const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const crypto = require("crypto");
const multer = require("multer");

const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");
const { hasModuleAction } = require("../middleware/fieldFilter");

// Compose-mail attachments: memory storage so the buffer can be base64'd
// straight into the SendGrid payload without a disk round-trip. multer is a
// no-op for non-multipart requests, so the legacy JSON path (no attachments)
// keeps working unchanged.
const ATTACHMENT_ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "application/zip",
]);
const composeAttachmentMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 10 MB per file, 5 files max
  fileFilter: (req, file, cb) => {
    if (ATTACHMENT_ALLOWED_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Attachment type not allowed: ${file.mimetype}`));
  },
}).array("attachments", 5);

// Convert multer errors (size/type/count) to JSON 400 so the SPA can surface
// a useful message instead of the default Express HTML stack trace.
function composeAttachmentUpload(req, res, next) {
  composeAttachmentMulter(req, res, (err) => {
    if (!err) return next();
    const code = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(code).json({ error: err.message || "Attachment upload failed" });
  });
}

// SendGrid email sending via their REST API
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Make bare URLs clickable in the HTML part of an email. Runs on the
// ALREADY-escaped body, so it's XSS-safe: escapeHtml has neutralised quotes +
// angle brackets (no attribute break-out), and we only ever match http(s):// —
// never javascript:/data: schemes. Trailing sentence punctuation is kept
// OUTSIDE the link so "see https://x.com." doesn't include the period.
function linkifyHtml(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
    const trail = m.match(/[.,!?;:)\]]+$/);
    const url = trail ? m.slice(0, -trail[0].length) : m;
    const tail = trail ? trail[0] : "";
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
  });
}

async function sendSendGrid(to, subject, body, opts = {}) {
  if (!SENDGRID_API_KEY) {
    console.log(`[Email] SendGrid not configured — email to ${to} logged but not sent`);
    return { sent: false, reason: "no_api_key" };
  }

  if (!isValidEmail(to)) {
    console.error(`[Email] Invalid email address: ${to}`);
    return { sent: false, reason: "invalid_recipient_email" };
  }

  if (!subject || !body) {
    return { sent: false, reason: "missing_subject_or_body" };
  }

  // Escape the user-supplied body so any HTML they typed renders as text (not
  // markup). The tracking pixel is RAW trusted HTML we control, so it must be
  // appended AFTER escaping — otherwise the <img> tag itself gets escaped to
  // &lt;img&gt; and shows up as visible literal text in the email body.
  let htmlBody = linkifyHtml(escapeHtml(body).replace(/\n/g, "<br>"));
  if (typeof opts.trackingPixelHtml === "string" && opts.trackingPixelHtml) {
    htmlBody += opts.trackingPixelHtml;
  }
  const personalization = { to: [{ email: to }] };
  // #623 — propagate cc/bcc through SendGrid personalization. Each recipient
  // here is a string; SendGrid wants {email}-shaped objects.
  if (Array.isArray(opts.cc) && opts.cc.length > 0) {
    personalization.cc = opts.cc.filter(isValidEmail).map((email) => ({ email }));
    if (personalization.cc.length === 0) delete personalization.cc;
  }
  if (Array.isArray(opts.bcc) && opts.bcc.length > 0) {
    personalization.bcc = opts.bcc.filter(isValidEmail).map((email) => ({ email }));
    if (personalization.bcc.length === 0) delete personalization.bcc;
  }
  const payload = {
    personalizations: [personalization],
    from: { email: FROM_EMAIL },
    subject: subject,
    content: [
      { type: "text/plain", value: body },
      { type: "text/html", value: htmlBody }
    ]
  };

  // Inline attachments → SendGrid's v3 `attachments` field. Caller passes
  // already-shaped `{ content, filename, type, disposition }` objects so this
  // helper stays a thin SendGrid wrapper.
  if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
    payload.attachments = opts.attachments;
  }

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
      console.log(`[Email] Sent to ${to}: ${messageId}`);
      return { sent: true, id: messageId };
    } else {
      const err = await response.text();
      console.error(`[Email] SendGrid error (${response.status}):`, err);
      return { sent: false, reason: `sendgrid_error_${response.status}`, details: err };
    }
  } catch (err) {
    console.error("[Email] Send error:", err.message);
    return { sent: false, reason: "send_error", details: err.message };
  }
}

if (SENDGRID_API_KEY) {
  console.log(`[Email] SendGrid configured with sender: ${FROM_EMAIL}`);
} else {
  console.warn("[Email] SENDGRID_API_KEY not set — emails will be logged but not delivered");
}

// GET all communications (Unified Inbox) — scoped to current tenant.
//
// #624 — supports an optional `folder` query param so the Inbox UI can
// segregate inbound vs outbound mail without a second route:
//   ?folder=inbox  → direction='INBOUND' only
//   ?folder=sent   → direction='OUTBOUND' only
//   (omitted)      → both, original behaviour preserved for back-compat
// Pre-this-change the Sent folder UI had nothing to query against — the
// only filtering surface was GET /api/email?folder=sent which returns a
// `{total}` count for the sidebar, not the row list.
router.get("/inbox", async (req, res) => {
  const canAccess = await hasModuleAction(req.user, "Communications", "READ");
  if (!canAccess) {
    return res.status(403).json({ error: "You don't have permission to access Communications" });
  }

  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.folder === 'sent') where.direction = 'OUTBOUND';
    else if (req.query.folder === 'inbox') where.direction = 'INBOUND';
    const emails = await prisma.emailMessage.findMany({
      where,
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
router.post("/send-email", composeAttachmentUpload, async (req, res) => {
  const canAccess = await hasModuleAction(req.user, "Communications", "WRITE");
  if (!canAccess) {
    return res.status(403).json({ error: "You don't have permission to access Communications" });
  }

  try {
    const { to, cc, bcc, subject, body, contactId } = req.body;
    if (!to || !subject) return res.status(400).json({ error: "Recipient and subject required" });
    if (!req.user) return res.status(401).json({ error: "Authentication required" });

    // Build SendGrid-shaped attachments from multer-parsed buffers. Empty
    // when the client posts plain JSON (no multipart files), so the legacy
    // JSON path is unaffected.
    const sendgridAttachments = Array.isArray(req.files)
      ? req.files.map((f) => ({
          content: f.buffer.toString("base64"),
          filename: f.originalname,
          type: f.mimetype,
          disposition: "attachment",
        }))
      : [];

    // Anti-DoS caps: prevent a malformed `to` string with thousands of
    // addresses from creating N EmailMessage + EmailTracking rows.
    const MAX_RECIPIENTS = 50;
    const MAX_SUBJECT_LENGTH = 500;
    const MAX_BODY_LENGTH = 100_000; // 100 KB

    if (subject && subject.length > MAX_SUBJECT_LENGTH) {
      return res.status(400).json({ error: `Subject exceeds ${MAX_SUBJECT_LENGTH} characters` });
    }
    if (body && body.length > MAX_BODY_LENGTH) {
      return res.status(400).json({ error: `Body exceeds ${MAX_BODY_LENGTH} characters` });
    }

    const recipients = parseRecipients(to);
    if (recipients.length === 0) {
      return res.status(400).json({ error: "No valid recipient parsed from 'to'" });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Too many recipients in 'to' (max ${MAX_RECIPIENTS})` });
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

    // #623 — cc/bcc accepted as either comma-separated string OR array.
    // Invalid cc/bcc addresses are surfaced in `failures` but do NOT block
    // the send (To-line is the only required recipient).
    const ccList = parseRecipients(typeof cc === 'string' ? cc : Array.isArray(cc) ? cc.join(',') : '');
    const bccList = parseRecipients(typeof bcc === 'string' ? bcc : Array.isArray(bcc) ? bcc.join(',') : '');
    const ccDeliverable = [];
    for (const r of ccList) {
      if (isValidEmail(r)) ccDeliverable.push(r);
      else failures.push({ to: r, reason: "invalid_cc_email" });
    }
    const bccDeliverable = [];
    for (const r of bccList) {
      if (isValidEmail(r)) bccDeliverable.push(r);
      else failures.push({ to: r, reason: "invalid_bcc_email" });
    }
    const ccPersist = ccDeliverable.length > 0 ? ccDeliverable.join(', ') : null;
    const bccPersist = bccDeliverable.length > 0 ? bccDeliverable.join(', ') : null;

    const totalRecipients = deliverable.length + ccDeliverable.length + bccDeliverable.length;
    if (totalRecipients > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Too many total recipients (max ${MAX_RECIPIENTS}, got ${totalRecipients})` });
    }

    const results = [];

    // #611: tenant emailRetention toggle. Default true (industry-norm Sent
    // folder + threading + audit). When admin opts out, skip the EmailMessage +
    // EmailTracking persists — the response still reports delivery, but no row
    // lands in the DB. Read defensively: pre-migration tenants without the
    // column read undefined → coalesce to true (back-compat for the rolling
    // deploy gap between schema push and column hydrate). Also default-on
    // when the prisma.tenant surface is not available (some vitest mock
    // setups stub only the surfaces under test and the find() would hang).
    let retainMessages = true;
    if (prisma.tenant && typeof prisma.tenant.findUnique === 'function') {
      try {
        const tenantCfg = await prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { emailRetention: true },
        });
        if (tenantCfg && tenantCfg.emailRetention === false) retainMessages = false;
      } catch (_e) { /* default-on if config read fails */ }
    }

    for (const recipient of deliverable) {
      let emailRecord = null;
      // Tracking pixel is always rendered into the body so opens can be
      // counted, but the EmailTracking row only persists when retention
      // is on (otherwise the trackingId resolves to nothing on open). The
      // tracking column is not retention-bearing — its purpose is open-rate
      // analytics, which loses fidelity-but-not-correctness when off.
      const trackingId = crypto.randomUUID();
      if (retainMessages) {
        emailRecord = await prisma.emailMessage.create({
          data: {
            subject,
            body,
            from: FROM_EMAIL,
            to: recipient,
            cc: ccPersist,
            bcc: bccPersist,
            direction: "OUTBOUND",
            read: true,
            contactId: contactId ? parseInt(contactId) : null,
            userId: req.user.userId,
            tenantId: req.user.tenantId,
          }
        });

        await prisma.emailTracking.create({
          data: { emailId: emailRecord.id, trackingId, type: "open", tenantId: req.user.tenantId }
        });
      }

      // Build the open-tracking pixel as raw HTML and hand it to sendSendGrid
      // via opts so it's appended to the HTML body AFTER the user body is
      // escaped. It's an invisible 1×1 image (display:none) — present for
      // open-tracking but never shown as text. (Previously it was concatenated
      // into `body` and then escaped along with it, which rendered the <img>
      // tag as visible literal text in the recipient's inbox.)
      const baseUrl = process.env.BASE_URL || "https://crm.globusdemos.com";
      const trackingPixelHtml = `<img src="${baseUrl}/api/communications/track/${trackingId}/open.gif" width="1" height="1" style="display:none" alt="" />`;


      // Send via SendGrid with tracking pixel.
      // PR #511 review blocker #1: pass `recipient` (loop iteratee) NOT `to`
      // (outer comma-separated string). v3.4.12 #435 fix introduced the
      // per-recipient loop; passing `to` here would send every iteration to
      // ALL recipients, undoing #435.
      // #623 — cc/bcc are propagated identically across the per-recipient
      // loop. The SendGrid carbon-copy semantics fan to every cc/bcc per
      // primary-recipient send (mirrors stock email-client behaviour).
      const mailResult = await sendSendGrid(recipient, subject, body, {
        cc: ccDeliverable,
        bcc: bccDeliverable,
        attachments: sendgridAttachments,
        trackingPixelHtml,
      });

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
        }).catch(() => { });
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
  const canAccess = await hasModuleAction(req.user, "Communications", "READ");
  if (!canAccess) {
    return res.status(403).json({ error: "You don't have permission to access Communications" });
  }

  try {
    const calls = await prisma.callLog.findMany({
      where: { tenantId: req.user.tenantId },
      include: { contact: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(calls);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch call history" });
  }
});

// POST to log a call
router.post("/log-call", async (req, res) => {
  const canAccess = await hasModuleAction(req.user, "Communications", "WRITE");
  if (!canAccess) {
    return res.status(403).json({ error: "You don't have permission to access Communications" });
  }

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
  const canAccess = await hasModuleAction(req.user, "Communications", "READ");
  if (!canAccess) {
    return res.status(403).json({ error: "You don't have permission to access Communications" });
  }

  try {
    const tracks = await prisma.emailTracking.findMany({
      where: { emailId: parseInt(req.params.emailId), tenantId: req.user.tenantId },
      take: 200,
    });
    const opens = tracks.filter(t => t.openedAt).length;
    const clicks = tracks.filter(t => t.clickedAt).length;
    res.json({ emailId: parseInt(req.params.emailId), opens, clicks, events: tracks });
  } catch (_err) { res.status(500).json({ error: "Failed to fetch tracking data" }); }
});

// Helpers exported for vitest unit coverage (see test/routes/communications.test.js)
module.exports = router;
module.exports.parseRecipients = parseRecipients;
module.exports.isValidEmail = isValidEmail;
module.exports.escapeHtml = escapeHtml;
module.exports.linkifyHtml = linkifyHtml;
