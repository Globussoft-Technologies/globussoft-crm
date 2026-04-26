/**
 * Email Conversation Threading + Auto-Threading
 * ----------------------------------------------
 * Provides thread grouping for the EmailMessage model. Threads are derived from
 * a deterministic hash of (cleaned subject + sorted participants), so legacy
 * messages that lack a threadId can be back-filled in bulk.
 *
 * All endpoints are tenant-scoped via req.user.tenantId and require verifyToken.
 */
const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Strip "Re:", "Fwd:", "Fw:", "Aw:", "Sv:", "Antw:" prefixes recursively
 * (case-insensitive) and normalize for hashing.
 */
function cleanSubject(s) {
  if (!s) return "";
  let cleaned = s;
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/^(re|fwd|fw|aw|sv|antw)\s*:\s*/i, "");
  } while (prev !== cleaned);
  return cleaned.trim().toLowerCase();
}

/**
 * Deterministic 16-char threadId from cleaned subject + sorted participants.
 */
function computeThreadId(subject, from, to) {
  const cleaned = cleanSubject(subject);
  const participants = [from, to]
    .filter(Boolean)
    .map((p) => p.toLowerCase().trim())
    .sort()
    .join("|");
  const key = `${cleaned}::${participants}`;
  return crypto.createHash("md5").update(key).digest("hex").slice(0, 16);
}

// All endpoints require auth
router.use(verifyToken);

// ── POST /auto-thread ────────────────────────────────────────────────────
// Back-fill threadId for messages that don't have one (oldest first).
router.post("/auto-thread", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const orphans = await prisma.emailMessage.findMany({
      where: { tenantId, threadId: null },
      orderBy: { createdAt: "asc" },
    });

    let processed = 0;
    for (const msg of orphans) {
      const threadId = computeThreadId(msg.subject, msg.from, msg.to);
      await prisma.emailMessage.update({
        where: { id: msg.id },
        data: { threadId },
      });
      processed++;
    }

    res.json({ processed });
  } catch (err) {
    console.error("[email_threading] auto-thread error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /threads ─────────────────────────────────────────────────────────
// List email threads for tenant, optionally filtered by contactId.
router.get("/threads", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const contactId = req.query.contactId
      ? parseInt(req.query.contactId, 10)
      : null;

    const where = { tenantId, threadId: { not: null } };
    if (contactId) where.contactId = contactId;

    const messages = await prisma.emailMessage.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });

    // Group by threadId
    const threadMap = new Map();
    for (const m of messages) {
      let t = threadMap.get(m.threadId);
      if (!t) {
        t = {
          threadId: m.threadId,
          subject: cleanSubject(m.subject) || m.subject || "(no subject)",
          participants: new Set(),
          messageCount: 0,
          lastMessageAt: m.createdAt,
          unreadCount: 0,
          contactId: m.contactId || null,
        };
        threadMap.set(m.threadId, t);
      }
      if (m.from) t.participants.add(m.from);
      if (m.to) t.participants.add(m.to);
      t.messageCount++;
      if (!m.read) t.unreadCount++;
      if (m.createdAt > t.lastMessageAt) t.lastMessageAt = m.createdAt;
      if (!t.contactId && m.contactId) t.contactId = m.contactId;
    }

    const threads = Array.from(threadMap.values())
      .map((t) => ({ ...t, participants: Array.from(t.participants) }))
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

    const total = threads.length;
    const paginated = threads.slice(offset, offset + limit);

    res.json({ total, limit, offset, threads: paginated });
  } catch (err) {
    console.error("[email_threading] list threads error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /threads/:threadId ───────────────────────────────────────────────
// Full thread: all messages in order.
router.get("/threads/:threadId", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { threadId } = req.params;

    const messages = await prisma.emailMessage.findMany({
      where: { tenantId, threadId },
      orderBy: { createdAt: "asc" },
    });

    if (messages.length === 0) {
      return res.status(404).json({ error: "Thread not found" });
    }

    res.json({
      threadId,
      messageCount: messages.length,
      messages,
    });
  } catch (err) {
    console.error("[email_threading] get thread error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /threads/:threadId/mark-read ────────────────────────────────────
router.post("/threads/:threadId/mark-read", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { threadId } = req.params;

    const result = await prisma.emailMessage.updateMany({
      where: { tenantId, threadId, read: false },
      data: { read: true },
    });

    res.json({ updated: result.count });
  } catch (err) {
    console.error("[email_threading] mark-read error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /threads/:threadId/archive ──────────────────────────────────────
// NOTE: EmailMessage schema currently has no `archived` field. To fully
// support archiving, add `archived Boolean @default(false)` to the
// EmailMessage model and run `prisma db push`. For now this endpoint just
// logs the intent and returns success so the UI can wire up the action.
router.post("/threads/:threadId/archive", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { threadId } = req.params;
    console.log(
      `[email_threading] archive requested for thread ${threadId} (tenant ${tenantId}) — schema needs 'archived' field to persist`
    );
    res.json({
      archived: true,
      threadId,
      note: "Archive logged only. Add 'archived Boolean @default(false)' to EmailMessage model to persist.",
    });
  } catch (err) {
    console.error("[email_threading] archive error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /reply ──────────────────────────────────────────────────────────
// Create new OUTBOUND EmailMessage attached to an existing thread.
router.post("/reply", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.id || req.user.userId || null;
    const { threadId, body, subject } = req.body || {};

    if (!threadId || !body) {
      return res.status(400).json({ error: "threadId and body required" });
    }

    // Pull the most recent message in the thread to derive participants/subject
    const last = await prisma.emailMessage.findFirst({
      where: { tenantId, threadId },
      orderBy: { createdAt: "desc" },
    });

    if (!last) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // Reply: swap from/to relative to the last message
    const replyFrom = last.to;
    const replyTo = last.from;
    let replySubject = subject;
    if (!replySubject) {
      const baseSubject = last.subject || "";
      replySubject = /^re\s*:/i.test(baseSubject)
        ? baseSubject
        : `Re: ${baseSubject}`;
    }

    // Re-compute threadId via the same helper to ensure it matches if subject
    // changes — but we always honor the provided threadId for continuity.
    const computed = computeThreadId(replySubject, replyFrom, replyTo);

    const created = await prisma.emailMessage.create({
      data: {
        subject: replySubject,
        body,
        from: replyFrom || "",
        to: replyTo || "",
        direction: "OUTBOUND",
        read: true,
        threadId: threadId, // preserve original thread for continuity
        tenantId,
        contactId: last.contactId || null,
        userId: userId || null,
      },
    });

    res.json({ message: created, computedThreadId: computed });
  } catch (err) {
    console.error("[email_threading] reply error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /messages ────────────────────────────────────────────────────────
// Gap #25: raw EmailMessage rows for a given contact, tenant-scoped.
// Used by sequence engines / external tooling to verify outbound dispatch
// without paying the thread-grouping cost of /threads.
router.get("/messages", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = parseInt(req.query.contactId, 10);
    if (!contactId || Number.isNaN(contactId)) {
      return res.status(400).json({ error: "contactId is required" });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const where = { tenantId, contactId };
    if (req.query.direction) {
      const dir = String(req.query.direction).toUpperCase();
      if (dir !== "INBOUND" && dir !== "OUTBOUND") {
        return res.status(400).json({ error: "direction must be INBOUND or OUTBOUND" });
      }
      where.direction = dir;
    }
    const messages = await prisma.emailMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ contactId, count: messages.length, messages });
  } catch (err) {
    console.error("[email_threading] list messages error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /stats ───────────────────────────────────────────────────────────
// Thread count, unread thread count, avg response time (OUTBOUND -> next INBOUND).
router.get("/stats", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const messages = await prisma.emailMessage.findMany({
      where: { tenantId, threadId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: {
        threadId: true,
        direction: true,
        read: true,
        createdAt: true,
      },
    });

    const threads = new Map();
    for (const m of messages) {
      let t = threads.get(m.threadId);
      if (!t) {
        t = { messages: [], hasUnread: false };
        threads.set(m.threadId, t);
      }
      t.messages.push(m);
      if (!m.read) t.hasUnread = true;
    }

    let unreadThreads = 0;
    const responseTimes = [];
    for (const t of threads.values()) {
      if (t.hasUnread) unreadThreads++;
      // Walk chronologically; for each OUTBOUND find the next INBOUND
      for (let i = 0; i < t.messages.length; i++) {
        const cur = t.messages[i];
        if (cur.direction !== "OUTBOUND") continue;
        for (let j = i + 1; j < t.messages.length; j++) {
          if (t.messages[j].direction === "INBOUND") {
            const diffMs =
              new Date(t.messages[j].createdAt).getTime() -
              new Date(cur.createdAt).getTime();
            if (diffMs >= 0) responseTimes.push(diffMs);
            break;
          }
        }
      }
    }

    const avgResponseMs = responseTimes.length
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;

    res.json({
      threadCount: threads.size,
      unreadThreads,
      avgResponseTimeMs: Math.round(avgResponseMs),
      avgResponseTimeMinutes: Math.round(avgResponseMs / 60000),
      sampleSize: responseTimes.length,
    });
  } catch (err) {
    console.error("[email_threading] stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
