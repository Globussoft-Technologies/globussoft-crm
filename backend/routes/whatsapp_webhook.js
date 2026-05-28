//
// WhatsApp webhook ingress router (P1).
//
// Mounted in server.js BEFORE the global express.json() so the raw request
// body is preserved for HMAC verification. The actual middleware pipeline
// (raw-body capture → signature verify → JSON parse → tenant routing →
// idempotency → 200 response) lives in middleware/metaWebhook.js.
//
// This router only defines the route surface:
//   GET  /api/whatsapp/webhook  — Meta verify handshake
//   POST /api/whatsapp/webhook  — Meta event ingress
//
// Note: the OLD /api/whatsapp/webhook handlers in routes/whatsapp.js are
// removed by P1. Express resolves routes in registration order; this
// router is registered FIRST in server.js, so the catch-all whatsapp
// router never sees webhook requests.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { decryptCredential } = require("../lib/credentialMasking");
const { sendText, verifyWebhook } = require("../services/whatsappProvider");
const {
  captureRawBody,
  verifySignature,
  parseBody,
  routeToTenant,
  ensureIdempotency,
  respondImmediately,
} = require("../middleware/metaWebhook");
const { getQueue } = require("../lib/whatsappQueue");
const { toE164 } = require("../utils/deduplication");

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";

// Verbose webhook logging — default OFF. Set WHATSAPP_DEBUG_LOG=true in
// backend/.env to surface every Meta verify-handshake / event POST.
const WA_DEBUG = String(process.env.WHATSAPP_DEBUG_LOG || "false").toLowerCase() === "true";
function whLog(tag, payload) {
  if (!WA_DEBUG) return;
  try {
    const pretty = payload == null ? "" : (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
    console.log(`[whatsapp-webhook] ${tag} ${pretty}`);
  } catch (e) {
    console.log(`[whatsapp-webhook] ${tag} <log-serialize-failed: ${e.message}>`);
  }
}
// Middleware that logs every incoming POST before signature verification
// runs — so we can see Meta hitting even if HMAC fails downstream.
function logIncoming(req, _res, next) {
  whLog(`→ POST /api/whatsapp/webhook (ip=${req.ip})`, {
    headers: {
      "x-hub-signature-256": req.headers["x-hub-signature-256"] ? "present" : "missing",
      "user-agent": req.headers["user-agent"],
      "content-type": req.headers["content-type"],
      "content-length": req.headers["content-length"],
    },
  });
  next();
}

// ─── E.164 normalisation (copied from routes/whatsapp.js) ──────────────────
// Kept inline to avoid coupling the webhook router to the rest of the
// whatsapp surface. If this ever drifts, consolidate via lib/.
function normalizeToE164(phone) {
  if (!phone) return null;
  const e164 = toE164(phone);
  if (e164) return e164;
  const stripped = String(phone).replace(/[^0-9+]/g, "");
  if (stripped.startsWith("+") && stripped.length >= 11) return stripped;
  if (/^[0-9]{10,15}$/.test(stripped)) return "+" + stripped;
  return null;
}

const STOP_KEYWORDS = /^\s*(STOP|UNSUBSCRIBE|UNSUB|OPT[\s-]?OUT|STOP ALL)\s*$/i;
function isStopKeyword(body) {
  if (!body || typeof body !== "string") return false;
  return STOP_KEYWORDS.test(body.trim());
}

// ────────────────────────────────────────────────────────────────────────
// GET — Meta verification handshake
// ────────────────────────────────────────────────────────────────────────
//
// Resolution order for the verify token:
//   1. META_VERIFY_TOKEN env var (platform-wide; what new tenants use)
//   2. Per-tenant WhatsAppConfig.webhookVerifyToken (legacy override)
//
// If a token query-string was supplied but no env match, we check whether
// it matches ANY active config's per-tenant token. This preserves the
// legacy behaviour where each tenant could set their own verify token.
// Critically: it no longer defaults to "first active config" (the pre-P1
// bug where tenant B verifying webhook would succeed against tenant A's
// token if A was created first).
router.get("/", async (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const providedToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    whLog(`→ GET /api/whatsapp/webhook (verify handshake from ip=${req.ip})`, {
      mode,
      providedToken: providedToken ? `(${providedToken.length} chars)` : null,
      challenge: challenge ? `(${challenge.length} chars)` : null,
      envTokenSet: !!META_VERIFY_TOKEN,
      envTokenLength: META_VERIFY_TOKEN.length,
    });

    if (mode !== "subscribe" || typeof providedToken !== "string") {
      whLog("← 403 verify (mode != 'subscribe' or no token)", { mode, hasToken: typeof providedToken === "string" });
      return res.status(403).json({ error: "Verification failed" });
    }

    // Resolution 1: platform-wide env token.
    if (META_VERIFY_TOKEN && providedToken === META_VERIFY_TOKEN) {
      whLog("← 200 verify (matched META_VERIFY_TOKEN)", { echoChallenge: !!challenge });
      return res.status(200).send(challenge);
    }

    // Resolution 2: per-tenant override. Look for an EXACT match across
    // active configs. Decrypt before compare (the column is AES-256-GCM
    // when WELLNESS_FIELD_KEY is set).
    const candidates = await prisma.whatsAppConfig.findMany({
      where: { isActive: true, webhookVerifyToken: { not: null } },
      select: { id: true, tenantId: true, webhookVerifyToken: true },
    });
    for (const c of candidates) {
      const decrypted = decryptCredential(c.webhookVerifyToken);
      if (decrypted && decrypted === providedToken) {
        whLog("← 200 verify (matched per-tenant webhookVerifyToken)", { tenantId: c.tenantId, configId: c.id });
        return res.status(200).send(challenge);
      }
    }

    // Resolution 3: legacy fallback — process.env.WHATSAPP_VERIFY_TOKEN
    // was the pre-P1 default name. Honour it during the rollout window so
    // existing webhook configurations don't break.
    if (process.env.WHATSAPP_VERIFY_TOKEN && providedToken === process.env.WHATSAPP_VERIFY_TOKEN) {
      whLog("← 200 verify (matched legacy WHATSAPP_VERIFY_TOKEN)", null);
      return res.status(200).send(challenge);
    }

    whLog("← 403 verify (token did NOT match any source)", {
      providedTokenLength: providedToken.length,
      envTokenLength: META_VERIFY_TOKEN.length,
      perTenantCandidates: candidates.length,
      hint: "Make sure the 'Verify token' you typed in Meta dashboard exactly matches META_VERIFY_TOKEN in backend/.env (or one of the per-tenant webhookVerifyToken values).",
    });
    return res.status(403).json({ error: "Verification failed" });
  } catch (err) {
    console.error("[whatsapp-webhook GET] error:", err);
    return res.status(500).json({ error: "Webhook verification failed" });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST — Meta event ingress
// ────────────────────────────────────────────────────────────────────────
//
// The middleware pipeline (captureRawBody → verifySignature → parseBody →
// routeToTenant → ensureIdempotency → respondImmediately) does everything
// up to and including the 200 response. By the time the handler below
// runs, the response has been flushed and we're working async.
//
// Per-event context arrives on:
//   req.waParsedBody          parsed JSON
//   req.waContext.entries[]   { tenantId, configId, phoneNumberId, disconnected, restricted }
//                              or { unknown: true, reason }
//   req.waEvents[]            { webhookEventId, entryIndex, change, tenantId, configId }
//                              — only events that resolved to a tenant
//   req.waSignatureVerified   boolean
//
// Event-type switch handles:
//   - field === 'messages'  → existing inbound/outbound-status processing
//   - field === 'message_template_status_update'  → update WhatsAppTemplate.status
//   - field === 'message_template_quality_update' → update qualityScore
//   - field === 'phone_number_quality_update'     → update WhatsAppConfig.qualityRating
//   - field === 'phone_number_name_update'        → no-op (audit only)
//   - field === 'account_update'                  → set businessRestricted true/false
//   - field === 'business_capability_update'      → update messagingLimitTier
router.post(
  "/",
  logIncoming,
  captureRawBody,
  verifySignature,
  parseBody,
  routeToTenant,
  ensureIdempotency,
  respondImmediately,
  async (req, res) => {
    // Response was already sent by respondImmediately. We process async.
    try {
      whLog("✓ webhook accepted (signature + tenant routing passed)", {
        signatureVerified: req.waSignatureVerified,
        entryCount: req.waContext?.entries?.length || 0,
        eventCount: (req.waEvents || []).length,
        body: req.waParsedBody,
      });
      const events = req.waEvents || [];
      if (events.length === 0) {
        whLog("⚠ no events to process (unknown tenant or no matching phoneNumberId)", {
          entries: req.waContext?.entries || [],
        });
        return;
      }

      for (const ev of events) {
        try {
          whLog(`→ processing event field=${ev.change.field} tenantId=${ev.tenantId}`, { value: ev.change.value });
          await processEvent(ev, req);
          whLog(`✓ event ${ev.webhookEventId} processed`, null);
          await prisma.webhookEvent.update({
            where: { id: ev.webhookEventId },
            data: { status: "PROCESSED", processedAt: new Date() },
          });
        } catch (err) {
          console.error(`[whatsapp-webhook POST] event ${ev.webhookEventId} processing error:`, err);
          await prisma.webhookEvent.update({
            where: { id: ev.webhookEventId },
            data: { status: "FAILED", errorMessage: err.message || String(err), processedAt: new Date() },
          }).catch(() => { /* don't propagate */ });
        }
      }
    } catch (err) {
      console.error("[whatsapp-webhook POST] async processing error:", err);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────
// Event handlers
// ────────────────────────────────────────────────────────────────────────

async function processEvent(ev, req) {
  const { change, tenantId, configId } = ev;
  const field = change.field;
  const value = change.value || {};

  switch (field) {
    case "messages":
      return handleMessagesEvent(value, tenantId, req);
    case "message_template_status_update":
      return handleTemplateStatusUpdate(value, tenantId);
    case "message_template_quality_update":
      return handleTemplateQualityUpdate(value, tenantId);
    case "phone_number_quality_update":
      return handlePhoneNumberQualityUpdate(value, configId);
    case "account_update":
      return handleAccountUpdate(value, configId);
    case "business_capability_update":
      return handleBusinessCapabilityUpdate(value, configId);
    case "phone_number_name_update":
      // No-op for now; audit row is sufficient. Could update a display-name
      // column on WhatsAppConfig if/when we add one.
      return;
    default:
      // Unknown field — log + move on. WebhookEvent.status remains RECEIVED
      // (the route handler caller will mark PROCESSED). This keeps the
      // forensic record intact for future schema additions.
      console.log(`[whatsapp-webhook] unknown field "${field}" — recorded for audit only`);
      return;
  }
}

async function handleMessagesEvent(value, tenantId, req) {
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const statuses = Array.isArray(value.statuses) ? value.statuses : [];
  const metadata = value.metadata || {};
  const queue = getQueue();

  // Inbound messages
  for (const msg of messages) {
    const from = msg.from;
    const body = msg.text?.body || msg.caption || "";
    const metaMediaId = msg.image?.id || msg.video?.id || msg.document?.id || msg.audio?.id || null;
    const metaType = msg.type || null;
    const mimeType = msg.image?.mime_type || msg.video?.mime_type || msg.document?.mime_type || msg.audio?.mime_type || null;

    // ── Reaction events — attach to the target message, don't create a
    //    standalone row. Meta sends `{ type: "reaction", reaction:
    //    { message_id, emoji } }` where message_id is the providerMsgId
    //    of the original message. Empty emoji = reaction removed.
    if (metaType === "reaction" && msg.reaction) {
      const targetWamid = msg.reaction.message_id;
      const emoji = msg.reaction.emoji || "";
      const target = targetWamid
        ? await prisma.whatsAppMessage.findFirst({
            where: { tenantId, providerMsgId: targetWamid },
            select: { id: true, reactionsJson: true, threadId: true },
          })
        : null;
      if (target) {
        let arr = [];
        try { arr = JSON.parse(target.reactionsJson || "[]"); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
        // Drop any prior reaction from the same sender — WhatsApp's
        // reaction model is "one emoji per sender per message".
        arr = arr.filter((r) => r.fromPhone !== from);
        if (emoji) {
          arr.push({ emoji, fromPhone: from, addedAt: new Date().toISOString() });
        }
        await prisma.whatsAppMessage.update({
          where: { id: target.id },
          data: { reactionsJson: JSON.stringify(arr) },
        });
        // Push to UI so the reaction pill appears live
        if (req.io) {
          req.io.to(`tenant:${tenantId}`).emit("whatsapp:reaction", {
            tenantId,
            threadId: target.threadId,
            messageId: target.id,
            emoji,
            from,
          });
        }
      }
      // Reactions don't create their own message row — move to next event.
      continue;
    }

    // Tenant-scoped contact lookup. This is the second important multi-tenant
    // fix: pre-P1 the contact lookup was tenant-agnostic. Now we ONLY match
    // contacts in the tenant we already resolved via phone_number_id.
    const contact = await prisma.contact.findFirst({
      where: { tenantId, phone: { contains: from.slice(-10) } },
      select: { id: true },
    });

    // Thread upsert (existing logic, tenant-scoped).
    const normalizedFrom = normalizeToE164(from);
    let thread = null;
    if (normalizedFrom) {
      const existing = await prisma.whatsAppThread.findUnique({
        where: { tenantId_contactPhone: { tenantId, contactPhone: normalizedFrom } },
      });
      if (existing) {
        const updates = { lastMessageAt: new Date(), lastInboundAt: new Date() };
        if (existing.status === "CLOSED") updates.status = "OPEN";
        if (!existing.assignedToId) updates.unreadCount = (existing.unreadCount || 0) + 1;
        thread = await prisma.whatsAppThread.update({ where: { id: existing.id }, data: updates });
      } else {
        thread = await prisma.whatsAppThread.create({
          data: {
            tenantId,
            contactPhone: normalizedFrom,
            status: "OPEN",
            contactId: contact?.id || null,
            lastMessageAt: new Date(),
            lastInboundAt: new Date(),
            unreadCount: 1,
          },
        });
      }
    }

    const created = await prisma.whatsAppMessage.create({
      data: {
        to: metadata.display_phone_number || metadata.phone_number_id || "",
        from,
        body,
        mediaUrl: metaMediaId ? `meta:${metaMediaId}` : null,
        mediaType: mimeType,
        metaType,
        direction: "INBOUND",
        status: "RECEIVED",
        providerMsgId: msg.id || null,
        contactId: contact?.id || null,
        tenantId,
        threadId: thread?.id || null,
      },
    });


    // If media, enqueue a download job — the cron engine pulls it down to S3.
    if (metaMediaId) {
      try {
        await queue.enqueueMedia({
          messageId: created.id,
          tenantId,
          metaMediaId,
          mimeType: mimeType || undefined,
        });
      } catch (err) {
        console.warn(`[whatsapp-webhook] enqueueMedia failed for msg ${created.id}:`, err.message);
      }
    }

    // STOP-keyword detection — preserved from the pre-P1 handler.
    if (isStopKeyword(body) && normalizedFrom) {
      await prisma.whatsAppOptOut.upsert({
        where: { tenantId_contactPhone: { tenantId, contactPhone: normalizedFrom } },
        create: {
          tenantId,
          contactPhone: normalizedFrom,
          reason: "STOP_KEYWORD",
          notes: `Inbound: ${body.trim().slice(0, 100)}`,
        },
        update: { reason: "STOP_KEYWORD", notes: `Inbound: ${body.trim().slice(0, 100)}` },
      }).catch((e) => console.warn("[whatsapp-webhook] STOP opt-out upsert failed:", e.message));

      // Best-effort confirmation send. Same pattern as the old route — failure
      // here doesn't fail the webhook.
      try {
        const cfg = await prisma.whatsAppConfig.findFirst({
          where: { isActive: true, tenantId },
        });
        if (cfg && cfg.accessToken && cfg.phoneNumberId) {
          const confirmBody = "You have been unsubscribed from WhatsApp messages. Reply START to opt back in.";
          const result = await sendText({
            to: from,
            body: confirmBody,
            phoneNumberId: cfg.phoneNumberId,
            accessToken: decryptCredential(cfg.accessToken),
          });
          await prisma.whatsAppMessage.create({
            data: {
              to: from,
              from: cfg.phoneNumberId || "",
              body: confirmBody,
              direction: "OUTBOUND",
              status: result.success ? "SENT" : "FAILED",
              providerMsgId: result.providerMsgId || null,
              errorMessage: result.error || null,
              tenantId,
              threadId: thread?.id || null,
            },
          });
        }
      } catch (sendErr) {
        console.warn("[whatsapp-webhook] STOP confirmation send failed:", sendErr?.message);
      }
    }

    // Real-time push to the tenant's connected operators via Socket.IO.
    // Scoped to room `tenant:<tenantId>` so events don't leak across
    // tenants (frontend joins this room on connect). Payload includes
    // enough for the inbox UI to refresh + optimistically render — full
    // detail still arrives via the JWT-protected GET /threads/:id route.
    if (req.io) {
      req.io.to(`tenant:${tenantId}`).emit("whatsapp:received", {
        from,
        body,
        mediaType: metaType,
        contactId: contact?.id,
        threadId: thread?.id,
        messageId: created.id,
        contactPhone: normalizedFrom || from,
        timestamp: msg.timestamp,
        tenantId,
      });
    }
  }

  // Delivery status updates
  const statusMap = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
  for (const status of statuses) {
    const newStatus = statusMap[status.status];
    if (!newStatus || !status.id) continue;
    await prisma.whatsAppMessage.updateMany({
      where: { providerMsgId: status.id, tenantId },
      data: {
        status: newStatus,
        ...(newStatus === "READ" && { read: true }),
        ...(newStatus === "FAILED" && { errorMessage: status.errors?.[0]?.title || "Delivery failed" }),
      },
    });
    if (req.io) {
      req.io.to(`tenant:${tenantId}`).emit("whatsapp:status", {
        providerMsgId: status.id,
        status: newStatus,
        recipientId: status.recipient_id,
        tenantId,
      });
    }
  }
}

async function handleTemplateStatusUpdate(value, tenantId) {
  const name = value.message_template_name;
  const language = value.message_template_language;
  const status = value.event; // "APPROVED" | "REJECTED" | "FLAGGED" | "PENDING" | ...
  if (!name) return;
  const statusMap = { APPROVED: "APPROVED", REJECTED: "REJECTED", FLAGGED: "FLAGGED", PENDING: "PENDING" };
  await prisma.whatsAppTemplate.updateMany({
    where: {
      tenantId,
      name,
      ...(language && { language }),
    },
    data: { status: statusMap[status] || "PENDING", lastSyncedAt: new Date() },
  });
}

async function handleTemplateQualityUpdate(value, tenantId) {
  const name = value.message_template_name;
  const score = value.new_quality_score;
  if (!name || !score) return;
  await prisma.whatsAppTemplate.updateMany({
    where: { tenantId, name },
    data: { qualityScore: String(score).toUpperCase(), lastSyncedAt: new Date() },
  });
}

async function handlePhoneNumberQualityUpdate(value, configId) {
  const rating = value.event || value.current_limit; // payload shape varies
  if (!rating || !configId) return;
  await prisma.whatsAppConfig.update({
    where: { id: configId },
    data: { qualityRating: String(rating).toUpperCase(), lastHealthCheckAt: new Date() },
  }).catch((e) => console.warn("[whatsapp-webhook] qualityRating update failed:", e.message));
}

async function handleAccountUpdate(value, configId) {
  if (!configId) return;
  // Meta sends `event` describing the change. Restriction-shaped events flip
  // businessRestricted; recovery events flip it back.
  const event = String(value.event || "").toUpperCase();
  const restricted = event.includes("RESTRICT") || event.includes("BAN") || event.includes("DISABLE");
  const recovered = event.includes("RESTORE") || event.includes("UNRESTRICT") || event.includes("ENABLE");
  if (!restricted && !recovered) return; // unknown event shape — leave alone
  await prisma.whatsAppConfig.update({
    where: { id: configId },
    data: { businessRestricted: restricted && !recovered, lastHealthCheckAt: new Date() },
  }).catch((e) => console.warn("[whatsapp-webhook] account_update apply failed:", e.message));
}

async function handleBusinessCapabilityUpdate(value, configId) {
  if (!configId) return;
  const tier = value.max_phone_numbers || value.messaging_limit_tier || value.event;
  if (!tier) return;
  await prisma.whatsAppConfig.update({
    where: { id: configId },
    data: { messagingLimitTier: String(tier).toUpperCase(), lastHealthCheckAt: new Date() },
  }).catch((e) => console.warn("[whatsapp-webhook] capability update failed:", e.message));
}

module.exports = router;
