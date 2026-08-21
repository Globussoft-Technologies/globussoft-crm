// POST /api/leads/extension-capture — browser-extension lead ingestion
// (2026-07-09).
//
// A browser extension (built by the senior team) scrapes Gmail + WhatsApp
// Web and POSTs whatever it captures here. The extension authenticates as a
// normal logged-in staff user (POST /api/auth/login → JWT), so this route
// sits behind the same verifyToken every other authenticated route uses —
// NOT the X-API-Key middleware/externalAuth.js (that's for server-to-server
// sister products with no human session, e.g. Callified.ai/AdsGPT).
//
// Two payload shapes, keyed by `source`:
//   Gmail:    { source: "gmail", capturedAt, subject, sender, date, to, cc,
//               body, attachments, links }
//   WhatsApp: { source: "whatsapp", capturedAt, chatName,
//               messages: [{ direction: "in"|"out", sender, text, timestamp }] }
// Both may also carry an optional `assignedToId` (tenant user id) — see
// resolveAssignee() below.
//
// Both shapes get normalized into the SAME internal message list and handed
// to lib/leadConversationSummary.js's summarizeMessages() — the exact
// Gemini-backed (OpenAI-fallback) summarizer already shipped for the
// WhatsApp "Sync Lead" feature (PR #1203). No new LLM plumbing here.
//
// Dedup: Contact.email / Contact.phone (via findDuplicateContact, same
// helper contacts.js's POST / uses) is tried first — if the sender/chat
// already has a Contact, this APPENDS a summary block to their existing
// description instead of creating a duplicate. If genuinely new, a Contact
// is created with source="gmail"/"whatsapp-extension" and the idempotencyKey
// set from a hash of the capture (Contact.idempotencyKey +
// @@unique([tenantId, source, idempotencyKey]) already exists in schema for
// exactly this "external producer retries the same POST" case — see
// PRD_TRAVEL_MULTICHANNEL_LEADS G002). A retried POST with the same
// idempotencyKey returns the existing contact instead of creating a second
// one, even when there's no email/phone to key off (e.g. a WhatsApp chat
// with an unresolved contact name).

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { notify } = require("../lib/notificationService");
const { findDuplicateContact } = require("../utils/deduplication");
const {
  summarizeMessages,
  renderBlock,
} = require("../lib/leadConversationSummary");

const VALID_SOURCES = new Set(["gmail", "whatsapp"]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Stable idempotency key so a retried POST (extension retry, double-click,
// network blip) never creates a second Contact for the same capture. Hashed
// (not stored raw) so arbitrary subject lines / chat names don't leak into
// an index value verbatim.
function computeIdempotencySeed(body) {
  const seed =
    body.source === "gmail"
      ? `${body.capturedAt || ""}|${body.subject || ""}|${body.sender || ""}`
      : `${body.capturedAt || ""}|${body.chatName || ""}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

// Extract a usable email/phone/name from either payload shape so dedup +
// Contact creation can stay source-agnostic below this point.
function extractContactHints(body) {
  if (body.source === "gmail") {
    const senderRaw = String(body.sender || "").trim();
    // "Name <email@x.com>" or a bare email address.
    const m = senderRaw.match(/^(.*?)\s*<([^<>]+)>\s*$/);
    const email = (m ? m[2] : senderRaw).trim() || null;
    const name = (m && m[1].trim()) || (email ? email.split("@")[0] : null);
    return { name, email, phone: null };
  }
  // whatsapp — chatName is the closest thing to a display name; no
  // structured phone field in the scraped payload, so phone stays null and
  // dedup falls back to the idempotency key.
  return { name: body.chatName || null, email: null, phone: null };
}

// Optional `assignedToId` (2026-08-17) — the extension's lead cards now carry
// the same tenant-user picker the "Send as Task" modal already had, so a rep
// can file a capture straight onto a colleague instead of it always landing in
// their own queue. Omitted / empty → unchanged behaviour: the capturing user
// owns the lead. `assignedToId` is NOT touched by the global stripDangerous
// middleware (only bare `userId` is), so it's safe to read off req.body
// directly — same as contacts.js's POST / and PUT /:id/assign.
//
// Any authenticated tenant user may pick an assignee here, matching POST
// /api/tasks's `targetUserId` (the flow this mirrors). That's deliberately
// looser than contacts.js's ADMIN-only PUT /:id/assign, which re-assigns a
// lead someone else may already be working; this only ever sets the owner on a
// lead being created (or adopts an unowned one), so there's nothing to steal.
async function resolveAssignee(rawAssignedToId, req) {
  if (
    rawAssignedToId === undefined ||
    rawAssignedToId === null ||
    rawAssignedToId === ""
  ) {
    return { assigneeId: req.user.userId, explicit: false };
  }
  const assigneeId = parseInt(rawAssignedToId, 10);
  if (Number.isNaN(assigneeId)) {
    return { error: "assignedToId must be a user id", code: "INVALID_ASSIGNEE" };
  }
  const user = await prisma.user.findFirst({
    where: { id: assigneeId, tenantId: req.user.tenantId },
    select: { id: true },
  });
  if (!user) {
    return {
      error: "That user isn't in your organisation",
      code: "INVALID_ASSIGNEE",
    };
  }
  return { assigneeId, explicit: true };
}

// Fire-and-forget "a lead landed in your queue" ping, reusing the copy the
// ADMIN assign route (contacts.js PUT /:id/assign) sends. Skipped when the
// capturing user assigned the lead to themselves — nobody needs to be told
// about their own click.
async function notifyLeadAssignee({ assigneeId, contact, req }) {
  if (!assigneeId || assigneeId === req.user.userId) return;
  try {
    const actorName = req.user?.name || req.user?.email || "A teammate";
    const leadName = contact.name || "#" + contact.id;
    await notify({
      userId: assigneeId,
      tenantId: req.user.tenantId,
      title: "New lead assigned",
      message:
        actorName +
        ' has assigned lead "' +
        leadName +
        '" to you. Please look into it.',
      type: "info",
      category: "lead",
      entityType: "lead",
      entityId: contact.id,
      link: "/contacts/" + contact.id,
      io: req.io,
    });
  } catch (notifyErr) {
    console.error(
      "[leads-extension-capture] assignee notify failed:",
      notifyErr && notifyErr.message,
    );
  }
}

// Normalize either payload shape into the { direction, body, createdAt }[]
// shape lib/leadConversationSummary.js's summarizeMessages() expects
// (direction "INBOUND"|"OUTBOUND", mirroring WhatsAppMessage rows).
function normalizeMessages(body) {
  const capturedAt = body.capturedAt ? new Date(body.capturedAt) : new Date();
  const validCapturedAt = Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt;

  if (body.source === "gmail") {
    return [
      {
        direction: "INBOUND",
        body: [body.subject ? `Subject: ${body.subject}` : null, body.body || ""]
          .filter(Boolean)
          .join("\n\n"),
        createdAt: validCapturedAt,
      },
    ];
  }
  // whatsapp
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && isNonEmptyString(m.text))
    .map((m) => ({
      direction: m.direction === "out" ? "OUTBOUND" : "INBOUND",
      body: m.text,
      // Per-message timestamps in the scraped payload are wall-clock strings
      // ("10:01 am") with no date part, so they aren't reliably parseable —
      // the capture's own capturedAt is the only trustworthy instant we
      // have. Message ORDER (as scraped, oldest-first per the extension's
      // contract) is preserved; only the absolute timestamp is collapsed.
      createdAt: validCapturedAt,
    }));
}

/**
 * POST /api/leads/extension-capture
 *
 * Body: see file header for the two accepted shapes.
 *
 * Responses:
 *   201 { created: true, contactId, assignedToId, summary: {purpose, highlights, leadStage} }
 *   200 { created: false, contactId, assignedToId, appended: true, summary: {...} }  — existing contact, summary appended
 *   200 { created: false, contactId, duplicate: true }                — idempotent retry, no new work done
 *   400 { error, code: "INVALID_SOURCE" | "MISSING_PAYLOAD" | "EMPTY_CAPTURE" | "INVALID_ASSIGNEE" }
 */
router.post("/extension-capture", verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    if (!isNonEmptyString(body.source) || !VALID_SOURCES.has(body.source)) {
      return res.status(400).json({
        error: `source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`,
        code: "INVALID_SOURCE",
      });
    }
    if (body.source === "gmail" && !isNonEmptyString(body.body) && !isNonEmptyString(body.subject)) {
      return res.status(400).json({
        error: "gmail capture requires at least a subject or a body",
        code: "MISSING_PAYLOAD",
      });
    }
    if (body.source === "whatsapp" && !Array.isArray(body.messages)) {
      return res.status(400).json({
        error: "whatsapp capture requires a messages array",
        code: "MISSING_PAYLOAD",
      });
    }

    const messages = normalizeMessages(body);
    if (!messages.length) {
      return res.status(400).json({
        error: "Capture had no usable text content",
        code: "EMPTY_CAPTURE",
      });
    }

    // Resolved before the (slow, billable) summarizer call so a bad assignee
    // fails fast instead of after an LLM round-trip.
    const assignee = await resolveAssignee(body.assignedToId, req);
    if (assignee.error) {
      return res.status(400).json({ error: assignee.error, code: assignee.code });
    }

    const tenantId = req.user.tenantId;
    const idempotencyKey = computeIdempotencySeed(body);
    const sourceTag = body.source === "gmail" ? "gmail" : "whatsapp-extension";
    const { name, email, phone } = extractContactHints(body);

    // 1. Idempotent-retry short-circuit — same capture POSTed twice (extension
    // retry / double-click) must not do the LLM call or create a second row.
    const idempotent = await prisma.contact.findFirst({
      where: { tenantId, source: sourceTag, idempotencyKey },
      select: { id: true },
    });
    if (idempotent) {
      return res.json({ created: false, contactId: idempotent.id, duplicate: true });
    }

    // 2. Real dedup — does this sender/phone already have a Contact? If so,
    // append the summary to their existing description rather than forking
    // a second row for the same person.
    const existing =
      email || phone ? await findDuplicateContact(email, phone, tenantId) : null;

    const summary = await summarizeMessages({
      tenantId,
      customerName: name,
      messages,
    });
    const block = renderBlock({
      customerName: name,
      date: messages[messages.length - 1].createdAt,
      purpose: summary.purpose,
      highlights: summary.highlights,
      leadStage: summary.leadStage,
    });

    if (existing) {
      const nextDescription = existing.description
        ? `${existing.description}\n\n${block}`
        : block;
      // An explicit pick only ADOPTS an unowned lead — it never yanks a lead
      // off whoever already owns it. Re-assignment stays the ADMIN-only
      // contacts.js PUT /:id/assign path; a capture appended to someone's
      // existing lead shouldn't silently move it out of their queue.
      const adopts = assignee.explicit && existing.assignedToId == null;
      const updated = await prisma.contact.update({
        where: { id: existing.id },
        data: {
          description: nextDescription,
          ...(adopts ? { assignedToId: assignee.assigneeId } : {}),
        },
      });
      await writeAudit("Contact", "EXTENSION_CAPTURE_APPEND", existing.id, req.user.userId, tenantId, {
        source: sourceTag,
        ...(adopts ? { assignedTo: assignee.assigneeId } : {}),
      });
      if (adopts) {
        await notifyLeadAssignee({ assigneeId: assignee.assigneeId, contact: updated, req });
      }
      return res.json({
        created: false,
        appended: true,
        contactId: existing.id,
        assignedToId: updated.assignedToId,
        summary,
      });
    }

    // 3. Genuinely new lead.
    const aiScore = Math.max(1, Math.min(100, Math.round((summary.leadStage ? 40 : 20))));
    const contact = await prisma.contact.create({
      data: {
        tenantId,
        name: name || (body.source === "gmail" ? "Unknown (Gmail)" : "Unknown (WhatsApp)"),
        email,
        phone,
        source: sourceTag,
        status: "Lead",
        description: block,
        idempotencyKey,
        aiScore,
        aiScoreLastComputedAt: new Date(),
        assignedToId: assignee.assigneeId,
      },
    });

    await notifyLeadAssignee({ assigneeId: assignee.assigneeId, contact, req });

    try {
      const { emitEvent } = require("../lib/eventBus");
      await emitEvent(
        "contact.created",
        { contactId: contact.id, name: contact.name, email: contact.email, userId: req.user.userId },
        tenantId,
        req.io,
      );
    } catch (_e) {
      /* event bus optional */
    }

    await prisma.touchpoint
      .create({
        data: { tenantId, contactId: contact.id, channel: sourceTag, source: `extension:${body.source}`, timestamp: new Date() },
      })
      .catch(() => {
        /* best-effort attribution — never block lead creation */
      });

    await writeAudit("Contact", "CREATE", contact.id, req.user.userId, tenantId, {
      name: contact.name,
      source: sourceTag,
      assignedTo: contact.assignedToId,
    });

    return res.status(201).json({
      created: true,
      contactId: contact.id,
      assignedToId: contact.assignedToId,
      summary,
    });
  } catch (err) {
    console.error("[leads-extension-capture] error:", err && err.message);
    return res.status(500).json({ error: "Failed to capture lead", code: "CAPTURE_FAILED" });
  }
});

module.exports = router;
