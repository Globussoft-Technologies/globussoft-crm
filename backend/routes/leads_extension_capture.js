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
 *   201 { created: true, contactId, summary: {purpose, highlights, leadStage} }
 *   200 { created: false, contactId, appended: true, summary: {...} }  — existing contact, summary appended
 *   200 { created: false, contactId, duplicate: true }                — idempotent retry, no new work done
 *   400 { error, code: "INVALID_SOURCE" | "MISSING_PAYLOAD" | "EMPTY_CAPTURE" }
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
      await prisma.contact.update({
        where: { id: existing.id },
        data: { description: nextDescription },
      });
      await writeAudit("Contact", "EXTENSION_CAPTURE_APPEND", existing.id, req.user.userId, tenantId, {
        source: sourceTag,
      });
      return res.json({
        created: false,
        appended: true,
        contactId: existing.id,
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
        assignedToId: req.user.userId,
      },
    });

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
    });

    return res.status(201).json({ created: true, contactId: contact.id, summary });
  } catch (err) {
    console.error("[leads-extension-capture] error:", err && err.message);
    return res.status(500).json({ error: "Failed to capture lead", code: "CAPTURE_FAILED" });
  }
});

module.exports = router;
