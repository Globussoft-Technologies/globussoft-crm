// @ts-check
//
// WhatsApp routes — /api/whatsapp/*
//
// Existing surface:
//   POST   /send                      — send session-text or template message
//   GET    /messages                  — list messages (paginated)
//   GET    /templates                 — list templates
//   POST   /templates                 — create template (PENDING until Meta-approved)
//   PUT    /templates/:id             — update template body
//   DELETE /templates/:id             — delete template
//   POST   /templates/:id/sync        — pull approval-status from Meta
//   GET    /config (ADMIN)            — list provider configs (masked accessToken)
//   PUT    /config/:provider (ADMIN)  — upsert provider config
//   GET    /webhook                   — Meta verify (no auth)
//   POST   /webhook                   — Meta event ingress (no auth)
//
// Wave 2 Agent KK additions — 2-way completion:
//   GET    /threads                   — list threads for tenant (paginated, filterable)
//   GET    /threads/:id               — thread detail with last 50 messages
//   POST   /threads/:id/assign        — set assignedToId + audit
//   POST   /threads/:id/close         — set status=CLOSED
//   POST   /threads/:id/snooze        — set status=SNOOZED + snoozedUntil
//   POST   /threads/:id/mark-read     — zero unreadCount
//   POST   /opt-outs                  — manual opt-out (admin/manager)
//   GET    /opt-outs                  — list opt-outs (filter by phone)
//   DELETE /opt-outs/:id              — re-opt-in (admin)
//
// The webhook handler now upserts a WhatsAppThread on every inbound message
// and detects "STOP" / "UNSUBSCRIBE" keywords to auto-record opt-out.
// The /send handler rejects 422 CONTACT_OPTED_OUT for opted-out recipients
// (DPDP / TRAI compliance).

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { sendTemplate, sendText, verifyWebhook } = require("../services/whatsappProvider");
const { toE164 } = require("../utils/deduplication");
const { writeAudit } = require("../lib/audit");
const {
  encryptCredential,
  decryptCredential,
  looksLikeMaskedSentinel,
  maskConfigRow,
} = require("../lib/credentialMasking");
// #681: Unified Inbox / WhatsApp threads expose lead `contactPhone` +
// `contact.phone` + `contact.email` in list views. Mask for low-trust
// viewers (USER role on generic / telecaller / helper on wellness).
const {
  shouldMaskForViewer,
  maskPhone,
  maskName,
  maskEmail,
  auditDisclosureDetails,
} = require("../lib/piiMask");

// #651 — third-party credentials on WhatsAppConfig. GET masks; PUT requires
// full fresh value; rotation stamps lastRotatedAt + emits audit row.
const WA_SECRET_FIELDS = ["accessToken", "webhookVerifyToken"];

// ─── Phone helpers (Wave 2 Agent KK) ───────────────────────────────────────
// Inbound webhook messages from Meta arrive as digits-only ("919876543210"),
// while the operator UI / external partner API canonicalises to E.164
// ("+919876543210"). We normalise to E.164 at thread-key creation so both
// directions agree on a single key.
function normalizeToE164(phone) {
  if (!phone) return null;
  const e164 = toE164(phone);
  if (e164) return e164;
  // toE164 returns null for non-Indian / unrecognised shapes; fall back to
  // adding "+" if the input looks E.164-ish (digits-only, ≥10 chars). This
  // keeps cross-border WABA usage working even though IN-only utils.toE164
  // doesn't recognise e.g. US +1xxxxxxxxxx.
  const stripped = String(phone).replace(/[^0-9+]/g, "");
  if (stripped.startsWith("+") && stripped.length >= 11) return stripped;
  if (/^[0-9]{10,15}$/.test(stripped)) return "+" + stripped;
  return null;
}

// ─── Opt-out detection (Wave 2 Agent KK) ───────────────────────────────────
// DPDP/TRAI compliance: inbound message bodies that match these keywords
// auto-create a WhatsAppOptOut row + reply with a confirmation. Match is
// case-insensitive + whole-word (so "STOPPED" inside a sentence does NOT
// trigger; only literal "STOP" / "UNSUBSCRIBE" / "UNSUB" do).
const STOP_KEYWORDS = /^\s*(STOP|UNSUBSCRIBE|UNSUB|OPT[\s-]?OUT|STOP ALL)\s*$/i;
function isStopKeyword(body) {
  if (!body || typeof body !== "string") return false;
  return STOP_KEYWORDS.test(body.trim());
}

// ─── Send WhatsApp Message ─────────────────────────────────────────────────
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { to, body, templateName, parameters, contactId } = req.body;

    if (!to) {
      return res.status(400).json({ error: "to is required" });
    }
    if (!body && !templateName) {
      return res.status(400).json({ error: "body or templateName is required" });
    }

    // Wave 2 Agent KK: opt-out gate. Reject before hitting Meta to keep
    // delivery costs + spam-flag risk down. 422 with structured `code` so
    // the frontend can show "This contact has opted out" instead of a
    // generic 500. Phone normalisation aligns with how the opt-out row
    // was stored.
    const normalizedTo = normalizeToE164(to);
    if (normalizedTo) {
      const optOut = await prisma.whatsAppOptOut.findUnique({
        where: { tenantId_contactPhone: { tenantId: req.user.tenantId, contactPhone: normalizedTo } },
      });
      if (optOut) {
        return res.status(422).json({
          error: "Recipient has opted out of WhatsApp messages",
          code: "CONTACT_OPTED_OUT",
          optedOutAt: optOut.capturedAt,
          reason: optOut.reason,
        });
      }
    }

    // Wave 7D — PRD Gap §7 item 5 — Meta 24h re-engagement-window enforcement.
    // Per Meta WhatsApp Business policy, free-form (non-template) messages
    // are only allowed within 24h of the customer's last INBOUND message.
    // Outside that window the message MUST be a pre-approved template — sending
    // free-form will get the message rejected by Meta and risks WABA quality
    // rating drops. We enforce server-side so the operator UI gets a clear
    // 422 OUTSIDE_24H_WINDOW with a hint to use a template, instead of the
    // generic Meta 4xx that lands on stderr.
    //
    // Templates bypass the gate (per Meta — templates can re-open the window).
    // The window is anchored on the most recent inbound message for this
    // (tenant, normalisedPhone). When there is NO prior inbound (cold outreach)
    // the gate also requires a template — first-touch must be opt-in-shaped.
    const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000;
    if (!templateName && normalizedTo) {
      const lastInbound = await prisma.whatsAppMessage.findFirst({
        where: { tenantId: req.user.tenantId, direction: "INBOUND", from: { contains: normalizedTo.replace(/^\+/, "") } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }).catch(() => null);
      const sinceMs = lastInbound ? Date.now() - new Date(lastInbound.createdAt).getTime() : Infinity;
      if (sinceMs > TWENTY_FOUR_HOURS_MS) {
        return res.status(422).json({
          error:
            "Free-form messages are only allowed within 24 hours of the customer's last inbound message. Use an approved template (templateName) to message outside this window.",
          code: "OUTSIDE_24H_WINDOW",
          lastInboundAt: lastInbound ? lastInbound.createdAt : null,
          hint: "Pass templateName + parameters in the request body to send an approved template instead.",
        });
      }
    }

    // Get active config for this tenant
    const config = await prisma.whatsAppConfig.findFirst({ where: { isActive: true, tenantId: req.user.tenantId } });
    if (!config) {
      return res.status(400).json({ error: "No active WhatsApp provider configured" });
    }

    // Wave 2 Agent KK: upsert thread for the recipient phone so outbound
    // messages slot into the same conversation as inbound. lastMessageAt
    // bumped; unreadCount NOT bumped (outbound doesn't increment unread).
    let thread = null;
    if (normalizedTo) {
      thread = await prisma.whatsAppThread.upsert({
        where: { tenantId_contactPhone: { tenantId: req.user.tenantId, contactPhone: normalizedTo } },
        create: {
          tenantId: req.user.tenantId,
          contactPhone: normalizedTo,
          status: "OPEN",
          contactId: contactId || null,
          lastMessageAt: new Date(),
        },
        update: {
          lastMessageAt: new Date(),
          // Reopen a CLOSED thread when the operator sends a new message.
          ...(undefined /* keep status as-is unless CLOSED */),
        },
      });
      // Re-open closed threads when an operator sends a new outbound.
      if (thread.status === "CLOSED") {
        thread = await prisma.whatsAppThread.update({
          where: { id: thread.id },
          data: { status: "OPEN" },
        });
      }
    }

    // P3: persist the message in QUEUED state and enqueue a WaOutboundJob.
    // The whatsappOutboundEngine cron picks it up within 30s, sends via
    // Meta, retries on transient failures, marks status=SENT/FAILED, and
    // broadcasts via Socket.io. The route returns 202 immediately so the
    // caller is not blocked on Meta's HTTPS round-trip — better UX, better
    // protection against Meta latency, and the queue provides retry on
    // transient failures (5xx, 429) which the old synchronous path could
    // not. Internal callers needing direct-send still call the provider
    // helpers (`sendText`, `sendTemplate`) directly — only this route
    // (the operator-facing surface) goes async.
    const message = await prisma.whatsAppMessage.create({
      data: {
        to,
        from: config.phoneNumberId || "",
        body: body || null,
        direction: "OUTBOUND",
        status: "QUEUED",
        templateName: templateName || null,
        contactId: contactId || null,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
        threadId: thread?.id || null,
      },
    });

    // Enqueue. Failure here is fatal — we already wrote the message row,
    // so without a job the cron will never pick it up. Mark the message
    // FAILED and return 500 in that case so the caller knows their send
    // didn't actually queue.
    try {
      const { getQueue } = require("../lib/whatsappQueue");
      await getQueue().enqueueSend({
        messageId: message.id,
        tenantId: req.user.tenantId,
      });
    } catch (enqueueErr) {
      console.error("[whatsapp /send] enqueue failed:", enqueueErr);
      await prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: { status: "FAILED", errorMessage: `enqueue failed: ${enqueueErr.message}` },
      }).catch(() => {});
      return res.status(500).json({
        success: false,
        messageId: message.id,
        error: "Failed to enqueue send",
        code: "ENQUEUE_FAILED",
      });
    }

    if (req.io) {
      req.io.emit("whatsapp:queued", { messageId: message.id, to, threadId: thread?.id || null });
    }

    // 202 Accepted — the message is QUEUED. Caller polls /api/whatsapp/messages
    // or listens on Socket.io 'whatsapp:sent' / 'whatsapp:status' for the
    // eventual SENT / DELIVERED / READ / FAILED transitions.
    res.status(202).json({
      success: true,
      messageId: message.id,
      status: "QUEUED",
      threadId: thread?.id || null,
    });
    // unused legacy reference — kept to satisfy a require() warning silencer
    void sendText; void sendTemplate; void decryptCredential;
  } catch (err) {
    console.error("WhatsApp send error:", err);
    res.status(500).json({ error: "Failed to send WhatsApp message" });
  }
});

// ─── List WhatsApp Messages ────────────────────────────────────────────────
router.get("/messages", verifyToken, async (req, res) => {
  try {
    const { direction, contactId, status, page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { tenantId: req.user.tenantId };
    if (direction) where.direction = direction;
    if (contactId) where.contactId = parseInt(contactId);
    if (status) where.status = status;

    const [messages, total] = await Promise.all([
      prisma.whatsAppMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { contact: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.whatsAppMessage.count({ where }),
    ]);

    res.json({
      messages,
      pagination: {
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error("WhatsApp list error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Threads (Wave 2 Agent KK)
// ────────────────────────────────────────────────────────────────────────────

// GET /threads — list threads for the current tenant
//
// Query params:
//   ?assignedToId=<int>  filter by assignee (use "0" for unassigned)
//   ?status=OPEN|PENDING_AGENT|SNOOZED|CLOSED
//   ?unread=true         filter unreadCount > 0
//   ?q=<phone-or-name>   substring match on phone or linked contact.name
//   ?page=N&limit=N      pagination (defaults: page 1, limit 25)
//
// Snooze auto-expiry: any thread whose status=SNOOZED and snoozedUntil < now
// is flipped back to OPEN as a side effect of this read. This avoids needing
// a dedicated cron tick for snooze-wakeup.
router.get("/threads", verifyToken, async (req, res) => {
  try {
    const { assignedToId, status, unread, q, page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(parseInt(limit), 100);

    // Auto-wake snoozed threads whose timer has elapsed.
    await prisma.whatsAppThread.updateMany({
      where: {
        tenantId: req.user.tenantId,
        status: "SNOOZED",
        snoozedUntil: { lt: new Date() },
      },
      data: { status: "OPEN", snoozedUntil: null },
    });

    const where = { tenantId: req.user.tenantId };
    if (status) where.status = String(status);
    if (assignedToId !== undefined) {
      const id = parseInt(assignedToId);
      where.assignedToId = Number.isFinite(id) && id > 0 ? id : null;
    }
    if (unread === "true" || unread === "1") {
      where.unreadCount = { gt: 0 };
    }
    if (q) {
      const term = String(q).trim();
      if (term) {
        where.OR = [
          { contactPhone: { contains: term } },
          { contact: { name: { contains: term } } },
        ];
      }
    }

    const [threads, total] = await Promise.all([
      prisma.whatsAppThread.findMany({
        where,
        orderBy: { lastMessageAt: "desc" },
        skip,
        take,
        include: {
          contact: { select: { id: true, name: true, phone: true, email: true } },
          patient: { select: { id: true, name: true, phone: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.whatsAppThread.count({ where }),
    ]);

    // #681: PII masking on the inbox list. Lead phone (`contactPhone` on the
    // thread itself + the nested `contact.phone`) is the leak surface; mask
    // for low-trust viewers and emit a PII_DISCLOSED audit for callers who
    // see unmasked rows.
    const mustMask = shouldMaskForViewer(req);
    const outThreads = mustMask
      ? threads.map((t) => ({
          ...t,
          contactPhone: maskPhone(t.contactPhone),
          contact: t.contact
            ? {
                ...t.contact,
                name: maskName(t.contact.name),
                phone: maskPhone(t.contact.phone),
                email: maskEmail(t.contact.email),
              }
            : t.contact,
          patient: t.patient
            ? {
                ...t.patient,
                name: maskName(t.patient.name),
                phone: maskPhone(t.patient.phone),
              }
            : t.patient,
        }))
      : threads;
    if (!mustMask && threads.length > 0) {
      writeAudit(
        "WhatsAppThread",
        "PII_DISCLOSED",
        null,
        req.user.userId,
        req.user.tenantId,
        auditDisclosureDetails(req, "whatsapp_threads", threads, {
          fields: ["contactPhone", "contact.name", "contact.phone", "contact.email"],
        }),
      ).catch((e) => console.warn("[whatsapp] audit PII_DISCLOSED failed:", e.message));
    }

    res.json({
      threads: outThreads,
      pagination: {
        total,
        page: parseInt(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error("WhatsApp threads list error:", err);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});

// GET /threads/:id — thread detail with last 50 messages
router.get("/threads/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const thread = await prisma.whatsAppThread.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: {
        contact: { select: { id: true, name: true, phone: true, email: true } },
        patient: { select: { id: true, name: true, phone: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const messages = await prisma.whatsAppMessage.findMany({
      where: { threadId: thread.id, tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Check for opt-out so the frontend can disable the reply box.
    const optOut = await prisma.whatsAppOptOut.findUnique({
      where: { tenantId_contactPhone: { tenantId: req.user.tenantId, contactPhone: thread.contactPhone } },
    });

    res.json({
      thread,
      messages: messages.reverse(), // ascending for UI render
      optedOut: optOut
        ? { capturedAt: optOut.capturedAt, reason: optOut.reason, notes: optOut.notes || null }
        : null,
    });
  } catch (err) {
    console.error("WhatsApp thread detail error:", err);
    res.status(500).json({ error: "Failed to fetch thread" });
  }
});

// POST /threads/:id/assign body { targetUserId }
//
// NOTE: per CLAUDE.md "Standing rules for new code", the global stripDangerous
// middleware deletes req.body.userId on every request. Use `targetUserId`
// (or `userId` is silently dropped to null and we'd unassign instead of
// rejecting bad input). Falling back to `userId` for client back-compat is
// pointless because it never reaches us.
//
// Self-assign: any logged-in user can assign to themselves
// (`targetUserId === req.user.userId`).
// Cross-assign to another user: ADMIN/MANAGER only.
// targetUserId = null clears the assignment.
router.post("/threads/:id/assign", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const { targetUserId } = req.body;
    let targetId;
    if (targetUserId === null || targetUserId === undefined) {
      targetId = null;
    } else if (typeof targetUserId === "number" && Number.isFinite(targetUserId) && Number.isInteger(targetUserId)) {
      targetId = targetUserId;
    } else if (typeof targetUserId === "string" && /^\d+$/.test(targetUserId.trim())) {
      targetId = parseInt(targetUserId, 10);
    } else {
      // Reject 'not-a-number', booleans, objects, fractional, etc.
      return res.status(400).json({ error: "targetUserId must be a number or null", code: "INVALID_USER_ID" });
    }

    // RBAC: cross-assign requires manager; self-assign / unassign open to all.
    const isSelf = targetId === req.user.userId;
    const isUnassign = targetId === null;
    const isManager = req.user.role === "ADMIN" || req.user.role === "MANAGER";
    if (!isSelf && !isUnassign && !isManager) {
      return res.status(403).json({ error: "Only managers can assign threads to other users" });
    }

    const thread = await prisma.whatsAppThread.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    if (targetId !== null) {
      // Verify target user belongs to the same tenant (cross-tenant assignment is a security hole).
      const target = await prisma.user.findFirst({
        where: { id: targetId, tenantId: req.user.tenantId },
      });
      if (!target) return res.status(404).json({ error: "Target user not found in tenant" });
    }

    const updated = await prisma.whatsAppThread.update({
      where: { id: thread.id },
      data: { assignedToId: targetId, status: targetId ? "OPEN" : thread.status },
    });

    await writeAudit("WhatsAppThread", "ASSIGN", thread.id, req.user.userId, req.user.tenantId, {
      previousAssignedToId: thread.assignedToId,
      newAssignedToId: targetId,
    });

    res.json(updated);
  } catch (err) {
    console.error("WhatsApp thread assign error:", err);
    res.status(500).json({ error: "Failed to assign thread" });
  }
});

// POST /threads/:id/close
router.post("/threads/:id/close", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const thread = await prisma.whatsAppThread.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const updated = await prisma.whatsAppThread.update({
      where: { id: thread.id },
      data: { status: "CLOSED", snoozedUntil: null },
    });

    await writeAudit("WhatsAppThread", "CLOSE", thread.id, req.user.userId, req.user.tenantId, {
      previousStatus: thread.status,
    });

    res.json(updated);
  } catch (err) {
    console.error("WhatsApp thread close error:", err);
    res.status(500).json({ error: "Failed to close thread" });
  }
});

// POST /threads/:id/snooze body { until: ISO datetime }
router.post("/threads/:id/snooze", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const { until } = req.body;
    if (!until) return res.status(400).json({ error: "until is required" });
    const snoozeDate = new Date(until);
    if (Number.isNaN(snoozeDate.getTime())) {
      return res.status(400).json({ error: "until must be a valid ISO datetime" });
    }
    if (snoozeDate <= new Date()) {
      return res.status(400).json({ error: "until must be in the future" });
    }

    const thread = await prisma.whatsAppThread.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const updated = await prisma.whatsAppThread.update({
      where: { id: thread.id },
      data: { status: "SNOOZED", snoozedUntil: snoozeDate },
    });

    await writeAudit("WhatsAppThread", "SNOOZE", thread.id, req.user.userId, req.user.tenantId, {
      until: snoozeDate.toISOString(),
    });

    res.json(updated);
  } catch (err) {
    console.error("WhatsApp thread snooze error:", err);
    res.status(500).json({ error: "Failed to snooze thread" });
  }
});

// POST /threads/:id/mark-read — zero unreadCount
router.post("/threads/:id/mark-read", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const thread = await prisma.whatsAppThread.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const updated = await prisma.whatsAppThread.update({
      where: { id: thread.id },
      data: { unreadCount: 0 },
    });

    res.json(updated);
  } catch (err) {
    console.error("WhatsApp thread mark-read error:", err);
    res.status(500).json({ error: "Failed to mark thread read" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Opt-outs (Wave 2 Agent KK)
// ────────────────────────────────────────────────────────────────────────────

// POST /opt-outs body { contactPhone, reason?, notes? } — manual opt-out
//
// Manager-only. Phone is normalised to E.164 before insert so the upsert
// matches the format the /send and webhook handlers use as the lookup key.
router.post("/opt-outs", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { contactPhone, reason, notes } = req.body;
    if (!contactPhone) return res.status(400).json({ error: "contactPhone is required" });

    const normalized = normalizeToE164(contactPhone);
    if (!normalized) {
      return res.status(400).json({ error: "contactPhone must be a valid E.164 number" });
    }

    const validReasons = ["USER_REQUESTED", "STOP_KEYWORD", "COMPLAINT", "UNSUBSCRIBE_LINK"];
    const finalReason = reason && validReasons.includes(reason) ? reason : "USER_REQUESTED";

    const optOut = await prisma.whatsAppOptOut.upsert({
      where: { tenantId_contactPhone: { tenantId: req.user.tenantId, contactPhone: normalized } },
      create: {
        tenantId: req.user.tenantId,
        contactPhone: normalized,
        reason: finalReason,
        notes: notes || null,
      },
      update: {
        reason: finalReason,
        notes: notes || null,
      },
    });

    await writeAudit("WhatsAppOptOut", "CREATE", optOut.id, req.user.userId, req.user.tenantId, {
      contactPhone: normalized,
      reason: finalReason,
    });

    res.status(201).json(optOut);
  } catch (err) {
    console.error("WhatsApp opt-out create error:", err);
    res.status(500).json({ error: "Failed to record opt-out" });
  }
});

// GET /opt-outs?phone=<E.164 prefix>
router.get("/opt-outs", verifyToken, async (req, res) => {
  try {
    const { phone, page = 1, limit = 25 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = Math.min(parseInt(limit), 100);

    const where = { tenantId: req.user.tenantId };
    if (phone) where.contactPhone = { contains: String(phone).trim() };

    const [optOuts, total] = await Promise.all([
      prisma.whatsAppOptOut.findMany({
        where,
        orderBy: { capturedAt: "desc" },
        skip,
        take,
      }),
      prisma.whatsAppOptOut.count({ where }),
    ]);

    res.json({
      optOuts,
      pagination: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) },
    });
  } catch (err) {
    console.error("WhatsApp opt-outs list error:", err);
    res.status(500).json({ error: "Failed to fetch opt-outs" });
  }
});

// DELETE /opt-outs/:id — re-opt-in (ADMIN only — DPDP requires careful handling)
//
// DPDP Act §11 (right to withdraw consent) implication: re-opting a contact in
// silently lets the system message a user who previously opted out, which the
// regulation reads as "fresh consent". Until the product surface gains an
// explicit user-side re-opt-in flow (separate user-attention item), every
// admin-initiated re-opt-in MUST justify itself via a written reason that
// lands in the audit trail, so a regulator can reconstruct WHY the contact
// was reactivated without their direct re-confirmation.
//
// Contract:
//   - body.reason  is REQUIRED; min 10 chars after trim. Missing / too short
//                  → 400 REASON_REQUIRED so the frontend can surface a clear
//                  modal prompt instead of a generic 500.
//   - audit row    written with action='WHATSAPP_OPT_IN_RESET' (NOT 'DELETE')
//                  so audit-log filters can find every re-opt-in event without
//                  scanning every WhatsAppOptOut DELETE row.
//   - details      includes actor='admin', the supplied reason, and the prior
//                  opt-out row's reason / capturedAt for a self-contained log.
router.delete("/opt-outs/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 10) {
      return res.status(400).json({
        error: "reason is required (min 10 chars) — DPDP §11 audit requirement",
        code: "REASON_REQUIRED",
      });
    }

    const existing = await prisma.whatsAppOptOut.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Opt-out not found" });

    await prisma.whatsAppOptOut.delete({ where: { id: existing.id } });
    await writeAudit("WhatsAppOptOut", "WHATSAPP_OPT_IN_RESET", existing.id, req.user.userId, req.user.tenantId, {
      actor: "admin",
      reasonRequired: true,
      reason,
      contactPhone: existing.contactPhone,
      priorReason: existing.reason,
      priorCapturedAt: existing.capturedAt,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("WhatsApp opt-out delete error:", err);
    res.status(500).json({ error: "Failed to delete opt-out" });
  }
});

// ─── List WhatsApp Templates ───────────────────────────────────────────────
router.get("/templates", verifyToken, async (req, res) => {
  try {
    const templates = await prisma.whatsAppTemplate.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(templates);
  } catch (err) {
    console.error("WhatsApp templates list error:", err);
    res.status(500).json({ error: "Failed to fetch templates" });
  }
});

// ─── Create WhatsApp Template ──────────────────────────────────────────────
router.post("/templates", verifyToken, async (req, res) => {
  try {
    const { name, language, category, body, headerType, headerContent, footer, buttons } = req.body;

    if (!name || !body) {
      return res.status(400).json({ error: "name and body are required" });
    }

    const template = await prisma.whatsAppTemplate.create({
      data: {
        name,
        language: language || "en_US",
        category: category || "MARKETING",
        body,
        headerType: headerType || null,
        headerContent: headerContent || null,
        footer: footer || null,
        buttons: buttons ? JSON.stringify(buttons) : null,
        status: "PENDING",
        tenantId: req.user.tenantId,
      },
    });

    res.status(201).json(template);
  } catch (err) {
    console.error("WhatsApp template create error:", err);
    if (err.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    res.status(500).json({ error: "Failed to create template" });
  }
});

// ─── Update WhatsApp Template ──────────────────────────────────────────────
router.put("/templates/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, language, category, body, headerType, headerContent, footer, buttons } = req.body;

    const existing = await prisma.whatsAppTemplate.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const template = await prisma.whatsAppTemplate.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(language !== undefined && { language }),
        ...(category !== undefined && { category }),
        ...(body !== undefined && { body }),
        ...(headerType !== undefined && { headerType }),
        ...(headerContent !== undefined && { headerContent }),
        ...(footer !== undefined && { footer }),
        ...(buttons !== undefined && { buttons: buttons ? JSON.stringify(buttons) : null }),
      },
    });

    res.json(template);
  } catch (err) {
    console.error("WhatsApp template update error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    if (err.code === "P2002") return res.status(409).json({ error: "Template name already exists" });
    res.status(500).json({ error: "Failed to update template" });
  }
});

// ─── Delete WhatsApp Template ──────────────────────────────────────────────
router.delete("/templates/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.whatsAppTemplate.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Template not found" });
    await prisma.whatsAppTemplate.delete({ where: { id: existing.id } });
    res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    console.error("WhatsApp template delete error:", err);
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ─── Bulk Sync ALL Templates from Meta (P4) ────────────────────────────────
//
// Pulls every template for this tenant's WABA and upserts. Manual trigger
// for the same routine the daily whatsappTemplateSyncEngine cron runs.
router.post("/templates/sync", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { syncTemplatesForTenant } = require("../cron/whatsappTemplateSyncEngine");
    const r = await syncTemplatesForTenant(req.user.tenantId);
    if (!r.ok) {
      const status = r.code === "NOT_CONNECTED" ? 404 : r.code === "GRAPH_ERROR" ? 502 : 400;
      return res.status(status).json({ error: r.code, detail: r.error });
    }
    res.json({ success: true, synced: r.synced, total: r.total });
  } catch (err) {
    console.error("WhatsApp templates bulk sync error:", err);
    res.status(500).json({ error: "Failed to sync templates" });
  }
});

// ─── Sync Single Template Status from Meta ─────────────────────────────────
router.post("/templates/:id/sync", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const template = await prisma.whatsAppTemplate.findFirst({ where: { id: parseInt(id), tenantId: req.user.tenantId } });
    if (!template) return res.status(404).json({ error: "Template not found" });

    const config = await prisma.whatsAppConfig.findFirst({ where: { isActive: true, tenantId: req.user.tenantId } });
    if (!config) return res.status(400).json({ error: "No active WhatsApp config" });

    const https = require("https");
    const result = await new Promise((resolve) => {
      const options = {
        hostname: "graph.facebook.com",
        path: `/v18.0/${config.businessAccountId}/message_templates?name=${encodeURIComponent(template.name)}`,
        method: "GET",
        // #651 — decrypt on-read for the Meta API call.
        headers: { Authorization: `Bearer ${decryptCredential(config.accessToken)}` },
      };

      const req2 = https.request(options, (res2) => {
        let data = "";
        res2.on("data", (chunk) => (data += chunk));
        res2.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ error: { message: data } });
          }
        });
      });
      req2.on("error", (err) => resolve({ error: { message: err.message } }));
      req2.end();
    });

    if (result.data && result.data.length > 0) {
      const metaTemplate = result.data[0];
      const statusMap = { APPROVED: "APPROVED", REJECTED: "REJECTED", PENDING: "PENDING" };

      const updated = await prisma.whatsAppTemplate.update({
        where: { id: template.id },
        data: {
          status: statusMap[metaTemplate.status] || "PENDING",
          metaTemplateId: metaTemplate.id || null,
        },
      });

      res.json({ success: true, template: updated });
    } else {
      res.json({ success: false, message: "Template not found on Meta", error: result.error?.message });
    }
  } catch (err) {
    console.error("WhatsApp template sync error:", err);
    res.status(500).json({ error: "Failed to sync template" });
  }
});

// ─── Get WhatsApp Config (ADMIN only) ──────────────────────────────────────
//
// #651 — see routes/sms.js GET /config doc-comment. accessToken +
// webhookVerifyToken are projected to `{ configured, last4 }`; the
// browser never sees plaintext.
router.get("/config", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const configs = await prisma.whatsAppConfig.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });

    const masked = configs.map((c) => maskConfigRow(c, WA_SECRET_FIELDS));
    res.json(masked);
  } catch (err) {
    console.error("WhatsApp config get error:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ─── Upsert WhatsApp Config (ADMIN only) ───────────────────────────────────
//
// #651 — see routes/sms.js PUT /config doc-comment. Masked sentinels are
// dropped before reaching prisma; any genuine rotation stamps
// lastRotatedAt + emits a ProviderConfig.ROTATE audit row.
router.put("/config/:provider", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider } = req.params;
    const { phoneNumberId, businessAccountId, isActive, settings } = req.body;

    const rotatedFields = [];
    const cleanSecrets = {};
    for (const f of WA_SECRET_FIELDS) {
      const v = req.body[f];
      if (v === undefined) continue;
      if (v === null || v === "") {
        cleanSecrets[f] = null;
        rotatedFields.push(f);
        continue;
      }
      if (typeof v === "object") continue; // GET shape echoed back
      if (typeof v !== "string") continue;
      if (looksLikeMaskedSentinel(v)) continue;
      cleanSecrets[f] = encryptCredential(v);
      rotatedFields.push(f);
    }

    const stampRotation = rotatedFields.length > 0;

    const config = await prisma.whatsAppConfig.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      create: {
        provider,
        phoneNumberId: phoneNumberId || "",
        businessAccountId: businessAccountId || null,
        accessToken: cleanSecrets.accessToken !== undefined ? cleanSecrets.accessToken : "",
        webhookVerifyToken: cleanSecrets.webhookVerifyToken !== undefined ? cleanSecrets.webhookVerifyToken : null,
        isActive: isActive !== undefined ? isActive : true,
        settings: settings || null,
        tenantId: req.user.tenantId,
        ...(stampRotation && { lastRotatedAt: new Date() }),
      },
      update: {
        ...(phoneNumberId !== undefined && { phoneNumberId }),
        ...(businessAccountId !== undefined && { businessAccountId }),
        ...cleanSecrets,
        ...(isActive !== undefined && { isActive }),
        ...(settings !== undefined && { settings }),
        ...(stampRotation && { lastRotatedAt: new Date() }),
      },
    });

    if (isActive) {
      await prisma.whatsAppConfig.updateMany({
        where: { provider: { not: provider }, tenantId: req.user.tenantId },
        data: { isActive: false },
      });
    }

    if (stampRotation) {
      await writeAudit("ProviderConfig", "ROTATE", config.id, req.user.userId, req.user.tenantId, {
        provider: `whatsapp:${provider}`,
        rotatedFields,
      });
    }

    res.json({
      success: true,
      config: maskConfigRow(config, WA_SECRET_FIELDS),
    });
  } catch (err) {
    console.error("WhatsApp config upsert error:", err);
    res.status(500).json({ error: "Failed to update config" });
  }
});

// ─── Meta Webhook (TOMBSTONE) ──────────────────────────────────────────────
//
// P1: The GET /webhook and POST /webhook handlers were extracted to
// routes/whatsapp_webhook.js and are mounted in server.js BEFORE the
// global express.json() so the raw body survives for X-Hub-Signature-256
// verification.
//
// The pre-P1 implementation here was removed for two correctness reasons:
//   1. It used `whatsAppConfig.findFirst({ isActive: true })` for the GET
//      verify, which broke multi-tenant: tenant B's webhook verify would
//      succeed against tenant A's token if A was created first.
//   2. The POST handler used `contact.findFirst({ phone: contains last10 })`
//      across ALL tenants then defaulted to `tenantId=1` if no match —
//      a cross-tenant data leak surface.
//
// Both issues are fixed in routes/whatsapp_webhook.js + middleware/metaWebhook.js.
// These stubs only fire if the mount order in server.js is wrong (in which
// case they LOG a clear error so the operator can fix it).
router.get("/webhook", async (req, res) => {
  console.error(
    "[whatsapp routes/whatsapp.js] LEGACY GET /webhook reached — " +
    "mount order is wrong; routes/whatsapp_webhook.js must be mounted " +
    "BEFORE express.json() in server.js.",
  );
  res.status(503).json({
    error: "Webhook routing misconfigured — operator action required",
    code: "WEBHOOK_MOUNT_ORDER",
  });
});

// ─── Meta Webhook POST (TOMBSTONE) ─────────────────────────────────────────
// See the GET /webhook stub above for the full P1 explanation.
router.post("/webhook", async (req, res) => {
  console.error(
    "[whatsapp routes/whatsapp.js] LEGACY POST /webhook reached — " +
    "mount order is wrong; routes/whatsapp_webhook.js must be mounted " +
    "BEFORE express.json() in server.js.",
  );
  res.status(503).json({
    error: "Webhook routing misconfigured — operator action required",
    code: "WEBHOOK_MOUNT_ORDER",
  });
});

// Legacy webhook POST processing — KEPT AS DEAD CODE inside an unreachable
// branch so a follow-up reviewer can verify P1's webhook handler captures
// every behavior the old code had. Once the new handler has run a full
// release cycle without regression, this block can be deleted.
async function _legacyPostWebhookDeadCode(req, res) {
  if (false) {
    const { object, entry } = req.body;

    res.status(200).json({ received: true });

    if (object !== "whatsapp_business_account" || !entry) return;

    for (const entryItem of entry) {
      const changes = entryItem.changes || [];

      for (const change of changes) {
        if (change.field !== "messages") continue;

        const value = change.value || {};
        const messages = value.messages || [];
        const statuses = value.statuses || [];
        const metadata = value.metadata || {};

        for (const msg of messages) {
          const from = msg.from;
          const body = msg.text?.body || msg.caption || "";
          const mediaUrl = msg.image?.id || msg.video?.id || msg.document?.id || null;
          const mediaType = msg.type !== "text" ? msg.type : null;

          const contact = await prisma.contact.findFirst({
            where: { phone: { contains: from.slice(-10) } },
          });
          const tenantId = contact?.tenantId || 1;

          // Wave 2 Agent KK: thread upsert per (tenantId, normalizedPhone).
          const normalizedFrom = normalizeToE164(from);
          let thread = null;
          if (normalizedFrom) {
            thread = await prisma.whatsAppThread.upsert({
              where: { tenantId_contactPhone: { tenantId, contactPhone: normalizedFrom } },
              create: {
                tenantId,
                contactPhone: normalizedFrom,
                status: "OPEN",
                contactId: contact?.id || null,
                lastMessageAt: new Date(),
                lastInboundAt: new Date(),
                unreadCount: 1,
              },
              update: {
                lastMessageAt: new Date(),
                lastInboundAt: new Date(),
                // Reopen CLOSED threads on new inbound so the agent inbox
                // surfaces the new message instead of silently dropping it.
                status: "CLOSED" /* placeholder; updated below */,
              },
            });
            // Two-step status reconciliation: re-fetch and apply OPEN if was CLOSED,
            // increment unreadCount if no assignee.
            const fresh = await prisma.whatsAppThread.findUnique({ where: { id: thread.id } });
            const updates = { lastMessageAt: new Date(), lastInboundAt: new Date() };
            if (fresh.status === "CLOSED") updates.status = "OPEN";
            if (!fresh.assignedToId) updates.unreadCount = (fresh.unreadCount || 0) + 1;
            thread = await prisma.whatsAppThread.update({
              where: { id: thread.id },
              data: updates,
            });
          }

          await prisma.whatsAppMessage.create({
            data: {
              to: metadata.display_phone_number || metadata.phone_number_id || "",
              from,
              body,
              mediaUrl: mediaUrl || null,
              mediaType: mediaType || null,
              direction: "INBOUND",
              status: "RECEIVED",
              providerMsgId: msg.id || null,
              contactId: contact?.id || null,
              tenantId,
              threadId: thread?.id || null,
            },
          });

          // Wave 2 Agent KK: STOP-keyword opt-out detection. Auto-record
          // opt-out + best-effort confirmation reply. We don't fail the
          // webhook on send-confirmation errors — Meta requires a 200 in
          // ≤5s and the opt-out itself is the load-bearing record.
          if (isStopKeyword(body) && normalizedFrom) {
            try {
              await prisma.whatsAppOptOut.upsert({
                where: { tenantId_contactPhone: { tenantId, contactPhone: normalizedFrom } },
                create: {
                  tenantId,
                  contactPhone: normalizedFrom,
                  reason: "STOP_KEYWORD",
                  notes: `Inbound: ${body.trim().slice(0, 100)}`,
                },
                update: {
                  reason: "STOP_KEYWORD",
                  notes: `Inbound: ${body.trim().slice(0, 100)}`,
                },
              });

              // Outbound confirmation reply — uses sendText with the active
              // config. Wrapped in its own try/catch so a Meta send error
              // doesn't blow up the webhook.
              const config = await prisma.whatsAppConfig.findFirst({
                where: { isActive: true, tenantId },
              });
              if (config && config.accessToken && config.phoneNumberId) {
                const confirmBody =
                  "You have been unsubscribed from WhatsApp messages. Reply START to opt back in.";
                try {
                  // #651 — decrypt on-read for the provider HTTP call.
                  const result = await sendText({
                    to: from,
                    body: confirmBody,
                    phoneNumberId: config.phoneNumberId,
                    accessToken: decryptCredential(config.accessToken),
                  });
                  await prisma.whatsAppMessage.create({
                    data: {
                      to: from,
                      from: config.phoneNumberId || "",
                      body: confirmBody,
                      direction: "OUTBOUND",
                      status: result.success ? "SENT" : "FAILED",
                      providerMsgId: result.providerMsgId || null,
                      errorMessage: result.error || null,
                      tenantId,
                      threadId: thread?.id || null,
                    },
                  });
                } catch (sendErr) {
                  // Log + continue — opt-out itself is the load-bearing record.
                  console.warn("STOP-keyword confirmation send failed:", sendErr?.message);
                }
              }
            } catch (optErr) {
              console.error("STOP-keyword opt-out record error:", optErr);
            }
          }

          if (req.io) {
            req.io.emit("whatsapp:received", {
              from,
              body,
              mediaType,
              contactId: contact?.id,
              threadId: thread?.id,
              timestamp: msg.timestamp,
            });
          }
        }

        for (const status of statuses) {
          const statusMap = {
            sent: "SENT",
            delivered: "DELIVERED",
            read: "READ",
            failed: "FAILED",
          };

          const newStatus = statusMap[status.status];
          if (newStatus && status.id) {
            await prisma.whatsAppMessage.updateMany({
              where: { providerMsgId: status.id },
              data: {
                status: newStatus,
                ...(newStatus === "READ" && { read: true }),
                ...(newStatus === "FAILED" && { errorMessage: status.errors?.[0]?.title || "Delivery failed" }),
              },
            });

            if (req.io) {
              req.io.emit("whatsapp:status", {
                providerMsgId: status.id,
                status: newStatus,
                recipientId: status.recipient_id,
              });
            }
          }
        }
      }
    }
  }
}
// Make eslint happy — _legacyPostWebhookDeadCode is intentionally unreferenced.
void _legacyPostWebhookDeadCode;

module.exports = router;
