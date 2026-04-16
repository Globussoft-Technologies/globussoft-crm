const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────
// PUBLIC VISITOR ENDPOINTS — mounted under /api/live-chat/visitor/*
// (matched by the openPaths "/live-chat/visitor" prefix in server.js)
// ─────────────────────────────────────────────────────────────────────

// POST /visitor/start — visitor opens a chat session
router.post("/visitor/start", async (req, res) => {
  try {
    const { tenantId, visitorName, visitorEmail, visitorId } = req.body || {};
    if (!visitorId) return res.status(400).json({ error: "visitorId is required" });

    const tid = parseInt(tenantId, 10) || 1;

    const session = await prisma.liveChatSession.create({
      data: {
        visitorId: String(visitorId),
        visitorName: visitorName || null,
        visitorEmail: visitorEmail || null,
        status: "OPEN",
        tenantId: tid,
      },
    });

    // System message announcing the new visitor
    await prisma.liveChatMessage.create({
      data: {
        sessionId: session.id,
        sender: "system",
        body: `Visitor ${visitorName || visitorId} started a chat`,
        tenantId: tid,
      },
    });

    // Notify all agents in this tenant of the new session
    if (req.io) {
      req.io.to(`tenant-${tid}`).emit("chat_new_session", { session });
    }

    res.json({ sessionId: session.id, session });
  } catch (err) {
    console.error("[live-chat] visitor/start error:", err);
    res.status(500).json({ error: "Failed to start chat session" });
  }
});

// POST /visitor/:sessionId/message — visitor sends a message
router.post("/visitor/:sessionId/message", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    const { body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: "body is required" });

    const session = await prisma.liveChatSession.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.status === "CLOSED") return res.status(400).json({ error: "Session is closed" });

    const message = await prisma.liveChatMessage.create({
      data: {
        sessionId,
        sender: "visitor",
        body: body.trim(),
        tenantId: session.tenantId,
      },
    });

    if (req.io) {
      req.io.to(`tenant-${session.tenantId}`).emit("chat_message", { sessionId, message });
      req.io.to(`chat-${sessionId}`).emit("chat_message", { sessionId, message });
    }

    res.json({ success: true, message });
  } catch (err) {
    console.error("[live-chat] visitor/message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// GET /visitor/:sessionId/messages — visitor polls for messages
router.get("/visitor/:sessionId/messages", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    const session = await prisma.liveChatSession.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const messages = await prisma.liveChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });

    res.json({ session, messages });
  } catch (err) {
    console.error("[live-chat] visitor/messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// POST /visitor/:sessionId/rate — visitor rates and closes the session
router.post("/visitor/:sessionId/rate", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    const { rating } = req.body || {};
    const score = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));

    const session = await prisma.liveChatSession.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const updated = await prisma.liveChatSession.update({
      where: { id: sessionId },
      data: { rating: score, status: "CLOSED", closedAt: new Date() },
    });

    if (req.io) {
      req.io.to(`tenant-${session.tenantId}`).emit("chat_closed", { sessionId, session: updated });
      req.io.to(`chat-${sessionId}`).emit("chat_closed", { sessionId, session: updated });
    }

    res.json({ success: true, session: updated });
  } catch (err) {
    console.error("[live-chat] visitor/rate error:", err);
    res.status(500).json({ error: "Failed to rate session" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// AGENT-AUTHENTICATED ENDPOINTS — protected by global verifyToken guard
// ─────────────────────────────────────────────────────────────────────

// GET / — list active sessions for current tenant
router.get("/", async (req, res) => {
  try {
    const sessions = await prisma.liveChatSession.findMany({
      where: {
        tenantId: req.user.tenantId,
        status: { not: "CLOSED" },
      },
      orderBy: { startedAt: "desc" },
    });

    // Attach last message preview for each session
    const enriched = await Promise.all(
      sessions.map(async (s) => {
        const last = await prisma.liveChatMessage.findFirst({
          where: { sessionId: s.id },
          orderBy: { createdAt: "desc" },
        });
        return { ...s, lastMessage: last };
      })
    );

    res.json(enriched);
  } catch (err) {
    console.error("[live-chat] list error:", err);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// GET /stats — count open/assigned/closed-today sessions
router.get("/stats", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [open, assigned, closedToday] = await Promise.all([
      prisma.liveChatSession.count({ where: { tenantId, status: "OPEN" } }),
      prisma.liveChatSession.count({ where: { tenantId, status: "ASSIGNED" } }),
      prisma.liveChatSession.count({
        where: { tenantId, status: "CLOSED", closedAt: { gte: startOfDay } },
      }),
    ]);

    res.json({ open, assigned, closedToday });
  } catch (err) {
    console.error("[live-chat] stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// GET /:id — single session with all messages
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const session = await prisma.liveChatSession.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const messages = await prisma.liveChatMessage.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
    });

    res.json({ session, messages });
  } catch (err) {
    console.error("[live-chat] get session error:", err);
    res.status(500).json({ error: "Failed to fetch session" });
  }
});

// POST /:id/assign — assign session to an agent (default: current user)
router.post("/:id/assign", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { agentId } = req.body || {};
    const assignTo = agentId ? parseInt(agentId, 10) : req.user.userId;

    const session = await prisma.liveChatSession.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const updated = await prisma.liveChatSession.update({
      where: { id },
      data: { agentId: assignTo, status: "ASSIGNED" },
    });

    // System message recording the assignment
    await prisma.liveChatMessage.create({
      data: {
        sessionId: id,
        sender: "system",
        body: `Agent assigned to chat`,
        agentId: assignTo,
        tenantId: session.tenantId,
      },
    });

    if (req.io) {
      req.io.to(`tenant-${session.tenantId}`).emit("chat_assigned", { sessionId: id, session: updated });
      req.io.to(`chat-${id}`).emit("chat_assigned", { sessionId: id, session: updated });
    }

    res.json({ success: true, session: updated });
  } catch (err) {
    console.error("[live-chat] assign error:", err);
    res.status(500).json({ error: "Failed to assign session" });
  }
});

// POST /:id/messages — agent sends a message
router.post("/:id/messages", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: "body is required" });

    const session = await prisma.liveChatSession.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const message = await prisma.liveChatMessage.create({
      data: {
        sessionId: id,
        sender: "agent",
        agentId: req.user.userId,
        body: body.trim(),
        tenantId: req.user.tenantId,
      },
    });

    if (req.io) {
      req.io.to(`chat-${id}`).emit("chat_message", { sessionId: id, message });
      req.io.to(`tenant-${req.user.tenantId}`).emit("chat_message", { sessionId: id, message });
    }

    res.json({ success: true, message });
  } catch (err) {
    console.error("[live-chat] send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// POST /:id/close — close a session (with optional rating)
router.post("/:id/close", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rating } = req.body || {};

    const session = await prisma.liveChatSession.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const data = { status: "CLOSED", closedAt: new Date() };
    if (rating !== undefined && rating !== null) {
      data.rating = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
    }

    const updated = await prisma.liveChatSession.update({ where: { id }, data });

    await prisma.liveChatMessage.create({
      data: {
        sessionId: id,
        sender: "system",
        body: "Chat closed by agent",
        agentId: req.user.userId,
        tenantId: req.user.tenantId,
      },
    });

    if (req.io) {
      req.io.to(`tenant-${req.user.tenantId}`).emit("chat_closed", { sessionId: id, session: updated });
      req.io.to(`chat-${id}`).emit("chat_closed", { sessionId: id, session: updated });
    }

    res.json({ success: true, session: updated });
  } catch (err) {
    console.error("[live-chat] close error:", err);
    res.status(500).json({ error: "Failed to close session" });
  }
});

module.exports = router;
