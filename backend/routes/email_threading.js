/**
 * Email Conversation Threading + Auto-Threading
 * ----------------------------------------------
 * Provides thread grouping for the EmailMessage model. Threads are derived from
 * a deterministic hash of (cleaned subject + sorted participants), so legacy
 * messages that lack a threadId can be back-filled in bulk.
 *
 * All endpoints are tenant-scoped via req.user.tenantId and require verifyToken.
 *
 * Issue #422 contract-drift fixes:
 *   1. POST /threads/:threadId/archive — was a stub. The EmailMessage schema
 *      has no `archived` field, and adding one is out of scope for this route
 *      fix (schema agent owns it). Workaround: piggyback on `threadId` itself
 *      with a sentinel prefix `__ARCHIVED__:`. All messages in the thread are
 *      atomically re-keyed to the archived form, the list endpoint hides them
 *      by default, and the detail endpoint can still resolve either form. This
 *      persists archive state across restarts using only existing columns.
 *      Documented in commit message; agent E will replace with a proper
 *      `archived` field in a follow-up.
 *   2. GET /threads/:threadId — now honours `?limit` (1-200, default 50) and
 *      `?offset` (≥0, default 0) so 1000-message threads don't blow request
 *      size. Returns `{ threadId, messageCount, total, limit, offset, messages }`.
 *   3. POST /reply — fail-loud on attempted cross-tenant write. The global
 *      stripDangerous middleware deletes req.body.tenantId before any route
 *      handler runs, but it now records the stripped value on
 *      req.strippedFields so we can 400 instead of silently 200'ing a no-op.
 */
const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// Sentinel for archive piggyback (drift #1). All messages whose threadId
// begins with this prefix are considered archived. Long enough that no
// legitimate md5-hash threadId could ever collide.
const ARCHIVED_PREFIX = "__ARCHIVED__:";
const isArchivedThreadId = (id) => typeof id === "string" && id.startsWith(ARCHIVED_PREFIX);
const toArchivedId = (id) => (isArchivedThreadId(id) ? id : `${ARCHIVED_PREFIX}${id}`);

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

/**
 * Reject body that attempts to set tenantId (or other dangerous fields) —
 * drift #3 fix. stripDangerous runs first and stashes the value on
 * req.strippedFields, so by the time we get here we know intent vs accident.
 */
function rejectImmutableTenant(req, res, next) {
  if (req.strippedFields && "tenantId" in req.strippedFields) {
    return res.status(400).json({
      error: "tenantId is read-only",
      code: "IMMUTABLE_FIELD",
      field: "tenantId",
    });
  }
  next();
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
// Archived threads (threadId starts with __ARCHIVED__:) are hidden unless
// `?includeArchived=1` is passed.
router.get("/threads", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const contactId = req.query.contactId
      ? parseInt(req.query.contactId, 10)
      : null;
    const includeArchived =
      req.query.includeArchived === "1" || req.query.includeArchived === "true";

    const where = { tenantId, threadId: { not: null } };
    if (contactId) where.contactId = contactId;

    const messages = await prisma.emailMessage.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });

    // Group by threadId
    const threadMap = new Map();
    for (const m of messages) {
      // drift #1: hide archived threads by default
      if (!includeArchived && isArchivedThreadId(m.threadId)) continue;
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
          archived: isArchivedThreadId(m.threadId),
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
// Full thread with pagination (drift #2 fix).
// Query params:
//   ?limit  — 1-200, default 50
//   ?offset — ≥0, default 0
// Returns { threadId, messageCount, total, limit, offset, messages }.
// `messageCount` is preserved as the count in the page (legacy clients) and
// `total` is the count across the whole thread (new clients).
// Resolves both bare threadId and the archived-prefix form.
router.get("/threads/:threadId", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { threadId } = req.params;

    // Validate pagination params explicitly so a bad client sees 400 instead
    // of silently getting page 0.
    const rawLimit = req.query.limit;
    const rawOffset = req.query.offset;
    let limit = 50;
    if (rawLimit !== undefined) {
      const n = parseInt(rawLimit, 10);
      if (Number.isNaN(n) || n < 1 || n > 200) {
        return res
          .status(400)
          .json({ error: "limit must be an integer between 1 and 200" });
      }
      limit = n;
    }
    let offset = 0;
    if (rawOffset !== undefined) {
      const n = parseInt(rawOffset, 10);
      if (Number.isNaN(n) || n < 0) {
        return res
          .status(400)
          .json({ error: "offset must be a non-negative integer" });
      }
      offset = n;
    }

    // Accept both forms: clients may have bookmarked the bare id pre-archive.
    const candidates = isArchivedThreadId(threadId)
      ? [threadId]
      : [threadId, toArchivedId(threadId)];

    const total = await prisma.emailMessage.count({
      where: { tenantId, threadId: { in: candidates } },
    });

    if (total === 0) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const messages = await prisma.emailMessage.findMany({
      where: { tenantId, threadId: { in: candidates } },
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: limit,
    });

    res.json({
      threadId,
      messageCount: messages.length, // legacy field — count in this page
      total, // total across whole thread (drift #2)
      limit,
      offset,
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

    // Match either bare or archived form so mark-read still works on archived
    // threads (e.g. when a client opens an archived conversation).
    const candidates = isArchivedThreadId(threadId)
      ? [threadId]
      : [threadId, toArchivedId(threadId)];

    const result = await prisma.emailMessage.updateMany({
      where: { tenantId, threadId: { in: candidates }, read: false },
      data: { read: true },
    });

    res.json({ updated: result.count });
  } catch (err) {
    console.error("[email_threading] mark-read error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /threads/:threadId/archive ──────────────────────────────────────
// Drift #1 fix: actually persist archive state. Re-keys every message in the
// thread with the __ARCHIVED__: prefix (atomic via updateMany). Returns 404
// if no messages exist for the thread in this tenant.
router.post("/threads/:threadId/archive", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { threadId } = req.params;

    // Already archived → idempotent success, count zero.
    if (isArchivedThreadId(threadId)) {
      const existing = await prisma.emailMessage.count({
        where: { tenantId, threadId },
      });
      if (existing === 0) {
        return res.status(404).json({ error: "Thread not found" });
      }
      return res.json({
        archived: true,
        threadId,
        archivedThreadId: threadId,
        updated: 0,
        alreadyArchived: true,
      });
    }

    const archivedThreadId = toArchivedId(threadId);
    const result = await prisma.emailMessage.updateMany({
      where: { tenantId, threadId },
      data: { threadId: archivedThreadId },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: "Thread not found" });
    }

    res.json({
      archived: true,
      threadId,
      archivedThreadId,
      updated: result.count,
    });
  } catch (err) {
    console.error("[email_threading] archive error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /reply ──────────────────────────────────────────────────────────
// Create new OUTBOUND EmailMessage attached to an existing thread.
// Drift #3 fix: rejectImmutableTenant fires 400 if the client included
// `tenantId` in the body (stripDangerous deleted it but recorded the intent).
router.post("/reply", rejectImmutableTenant, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const userId = req.user.userId || null;
    const { threadId, body, subject } = req.body || {};

    if (!threadId || !body) {
      return res.status(400).json({ error: "threadId and body required" });
    }

    // Pull the most recent message in the thread to derive participants/subject.
    // Resolve archived form too — replying to an archived thread should work.
    const candidates = isArchivedThreadId(threadId)
      ? [threadId]
      : [threadId, toArchivedId(threadId)];
    const last = await prisma.emailMessage.findFirst({
      where: { tenantId, threadId: { in: candidates } },
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
    // changes — but we always honor the supplied threadId for continuity.
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
