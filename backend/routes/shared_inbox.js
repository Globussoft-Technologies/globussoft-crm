const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// Helper: parse JSON members array safely
function parseMembers(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Helper: enrich an inbox row with parsed members
function shape(inbox) {
  if (!inbox) return inbox;
  return { ...inbox, members: parseMembers(inbox.members) };
}

// ── GET / — list shared inboxes for tenant ──────────────────────────
router.get("/", async (req, res) => {
  try {
    const inboxes = await prisma.sharedInbox.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(inboxes.map(shape));
  } catch (err) {
    console.error("[shared-inbox] list error:", err);
    res.status(500).json({ error: "Failed to list shared inboxes." });
  }
});

// ── POST / — create a new shared inbox ─────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { name, emailAddress, members } = req.body;
    if (!name || !emailAddress) {
      return res.status(400).json({ error: "name and emailAddress are required" });
    }
    const memberIds = Array.isArray(members) ? members.map(Number).filter(Boolean) : [];

    const inbox = await prisma.sharedInbox.create({
      data: {
        name,
        emailAddress,
        members: JSON.stringify(memberIds),
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(shape(inbox));
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Email address already in use by another inbox." });
    }
    console.error("[shared-inbox] create error:", err);
    res.status(500).json({ error: "Failed to create shared inbox." });
  }
});

// ── PUT /:id — update inbox ────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.sharedInbox.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Shared inbox not found." });

    const { name, emailAddress, members } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (emailAddress !== undefined) data.emailAddress = emailAddress;
    if (members !== undefined) {
      const memberIds = Array.isArray(members) ? members.map(Number).filter(Boolean) : [];
      data.members = JSON.stringify(memberIds);
    }

    const updated = await prisma.sharedInbox.update({ where: { id }, data });
    res.json(shape(updated));
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Email address already in use by another inbox." });
    }
    console.error("[shared-inbox] update error:", err);
    res.status(500).json({ error: "Failed to update shared inbox." });
  }
});

// ── DELETE /:id ────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.sharedInbox.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Shared inbox not found." });

    await prisma.sharedInbox.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[shared-inbox] delete error:", err);
    res.status(500).json({ error: "Failed to delete shared inbox." });
  }
});

// ── POST /:id/members — add or remove a member ─────────────────────
router.post("/:id/members", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { userId, action } = req.body;
    if (!userId || !["add", "remove"].includes(action)) {
      return res.status(400).json({ error: "userId and action ('add'|'remove') required." });
    }

    const inbox = await prisma.sharedInbox.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!inbox) return res.status(404).json({ error: "Shared inbox not found." });

    const current = parseMembers(inbox.members);
    const uid = Number(userId);
    let next;
    if (action === "add") {
      next = current.includes(uid) ? current : [...current, uid];
    } else {
      next = current.filter((m) => m !== uid);
    }

    const updated = await prisma.sharedInbox.update({
      where: { id },
      data: { members: JSON.stringify(next) },
    });
    res.json(shape(updated));
  } catch (err) {
    console.error("[shared-inbox] members error:", err);
    res.status(500).json({ error: "Failed to update members." });
  }
});

// ── GET /:id/messages — group EmailMessages into conversation threads ─
router.get("/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const inbox = await prisma.sharedInbox.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!inbox) return res.status(404).json({ error: "Shared inbox not found." });

    const messages = await prisma.emailMessage.findMany({
      where: {
        tenantId: req.user.tenantId,
        to: inbox.emailAddress,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    // Group into threads by threadId, fall back to from+subject
    const threadMap = new Map();
    for (const msg of messages) {
      const key = msg.threadId || `${msg.from}::${(msg.subject || "").toLowerCase().replace(/^(re:|fwd:)\s*/i, "").trim()}`;
      if (!threadMap.has(key)) {
        threadMap.set(key, {
          threadKey: key,
          subject: msg.subject,
          from: msg.from,
          to: msg.to,
          lastMessageAt: msg.createdAt,
          unread: 0,
          messageCount: 0,
          assignedUserId: msg.userId || null,
          messages: [],
        });
      }
      const t = threadMap.get(key);
      t.messages.push(msg);
      t.messageCount += 1;
      if (!msg.read) t.unread += 1;
      if (new Date(msg.createdAt) > new Date(t.lastMessageAt)) {
        t.lastMessageAt = msg.createdAt;
      }
      // Use the most recent assignment
      if (msg.userId && !t.assignedUserId) t.assignedUserId = msg.userId;
    }

    const threads = Array.from(threadMap.values()).sort(
      (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
    );
    res.json({ inbox: shape(inbox), threads });
  } catch (err) {
    console.error("[shared-inbox] messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages." });
  }
});

// ── POST /:id/assign-message — assign a thread to a user ───────────
router.post("/:id/assign-message", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { messageId, userId } = req.body;
    if (!messageId) return res.status(400).json({ error: "messageId required." });

    const inbox = await prisma.sharedInbox.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!inbox) return res.status(404).json({ error: "Shared inbox not found." });

    const message = await prisma.emailMessage.findFirst({
      where: { id: parseInt(messageId, 10), tenantId: req.user.tenantId },
    });
    if (!message) return res.status(404).json({ error: "Message not found." });

    const assigneeId = userId ? parseInt(userId, 10) : null;

    // Persist assignment via the existing userId FK on EmailMessage. If a
    // threadId exists, re-assign every message in the thread for consistency.
    if (message.threadId) {
      await prisma.emailMessage.updateMany({
        where: {
          tenantId: req.user.tenantId,
          to: inbox.emailAddress,
          threadId: message.threadId,
        },
        data: { userId: assigneeId },
      });
    } else {
      await prisma.emailMessage.update({
        where: { id: message.id },
        data: { userId: assigneeId },
      });
    }

    console.log(
      `[shared-inbox] assignment: inbox=${inbox.id} thread=${message.threadId || message.id} assignee=${assigneeId} actor=${req.user.userId}`
    );

    res.json({ success: true, messageId: message.id, threadId: message.threadId, assignedUserId: assigneeId });
  } catch (err) {
    console.error("[shared-inbox] assign error:", err);
    res.status(500).json({ error: "Failed to assign message." });
  }
});

module.exports = router;
