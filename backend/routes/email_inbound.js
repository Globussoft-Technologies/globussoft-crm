/* Mailgun Inbound Email Webhook
 *
 * Receives emails forwarded by Mailgun (route action: forward to this URL).
 * Auto-matches sender to an existing Contact (across tenants), persists the
 * EmailMessage, logs an Activity, and broadcasts via Socket.io.
 *
 * Mounted at /api/email/inbound. POST / and POST /verify are public
 * (whitelisted in server.js openPaths) — Mailgun is the only caller.
 */
const express = require("express");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = require("../lib/prisma");

// Mailgun POSTs as application/x-www-form-urlencoded (and multipart for
// attachments, but the forward action gives us form-encoded fields).
router.use(express.urlencoded({ extended: true, limit: "25mb" }));

/**
 * Core processor — shared by the public Mailgun webhook and the
 * authenticated /test endpoint so QA payloads exercise the same path.
 */
async function processInboundEmail(payload, io) {
  const sender = (payload.sender || payload.from || "").toString().trim().toLowerCase();
  const recipient = (payload.recipient || payload.to || "").toString().trim();
  const subject = (payload.subject || "(no subject)").toString();
  const bodyPlain = payload["body-plain"] || payload.bodyPlain || "";
  const bodyHtml = payload["body-html"] || payload.bodyHtml || "";
  const body = (bodyPlain || bodyHtml || "").toString();

  if (!sender) {
    const err = new Error("Missing sender");
    err.statusCode = 400;
    throw err;
  }

  // 1. Look up contact across all tenants by email (Contact.email is unique).
  let contact = null;
  try {
    contact = await prisma.contact.findUnique({ where: { email: sender } });
  } catch (e) {
    contact = null;
  }

  // 2. Determine tenant: contact's tenant if matched, else default tenant 1.
  const tenantId = contact?.tenantId || 1;
  const contactId = contact?.id || null;

  // 3. Persist EmailMessage (always — even unmatched, so it can be linked later).
  const emailMessage = await prisma.emailMessage.create({
    data: {
      subject,
      body,
      from: sender,
      to: recipient,
      direction: "INBOUND",
      read: false,
      tenantId,
      contactId,
    },
  });

  // 4. Log Activity on the contact when matched.
  if (contactId) {
    try {
      await prisma.activity.create({
        data: {
          type: "Email",
          description: `Received: "${subject}"`,
          contactId,
          tenantId,
        },
      });
    } catch (e) {
      // Activity logging is best-effort — never fail the webhook for it.
      console.error("[email_inbound] activity log failed:", e.message);
    }
  }

  // 5. Real-time fanout.
  if (io) {
    io.emit("email_received", {
      emailId: emailMessage.id,
      contactId,
      tenantId,
    });
  }

  // 6. #7 — sequence reply detection. If the inbound thread tag is one of
  //    the synthesised drip threads (`seq-<enrollmentId>`), invoke the
  //    sequence engine's reply scanner directly so the pause kicks in
  //    immediately rather than waiting for the next cron tick. Failure
  //    here must NOT break the webhook response — Mailgun will retry.
  try {
    if (emailMessage.threadId && /^seq-\d+$/.test(emailMessage.threadId)) {
      const { processInboundReplies } = require("../cron/sequenceEngine");
      // Fire-and-forget; the dedup gate (sequenceReplyHandled) means it's
      // safe even if the cron tick is also running concurrently.
      processInboundReplies().catch((e) =>
        console.error("[email_inbound] reply pause failed:", e.message)
      );
    }
  } catch (e) {
    console.error("[email_inbound] reply pause require failed:", e.message);
  }

  return { emailId: emailMessage.id, contactId, tenantId };
}

/**
 * POST /api/email/inbound
 * PUBLIC — Mailgun store-and-forward / forward webhook.
 * Always responds 200 on processed payloads to prevent Mailgun retries.
 */
router.post("/", async (req, res) => {
  try {
    const result = await processInboundEmail(req.body || {}, req.io);
    return res.json({ success: true, emailId: result.emailId });
  } catch (err) {
    console.error("[email_inbound] webhook error:", err);
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/email/inbound/test
 * AUTHED — accepts a JSON Mailgun-shaped payload for QA / manual testing.
 */
router.post("/test", express.json({ limit: "25mb" }), verifyToken, async (req, res) => {
  try {
    const result = await processInboundEmail(req.body || {}, req.io);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[email_inbound] test error:", err);
    const code = err.statusCode || 500;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/email/inbound/verify
 * PUBLIC — Mailgun route verification endpoint. Echoes 200 OK.
 */
router.post("/verify", (req, res) => {
  return res.json({ ok: true });
});

module.exports = router;
