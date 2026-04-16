const router = require("express").Router();
const prisma = require("../lib/prisma");

// ── Helpers ────────────────────────────────────────────────────────
function parseJSON(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function isEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function isPhone(v) {
  return typeof v === "string" && /^\+?[\d\s\-().]{7,}$/.test(v.trim());
}

// flow shape: { nodes: [{id, type, content, options?}], edges: [{from, to, condition?}] }
// node types: message, question, capture-email, capture-phone, branch, end

function getStartNode(flow) {
  if (!flow || !Array.isArray(flow.nodes) || flow.nodes.length === 0) return null;
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  const targets = new Set(edges.map(e => e.to));
  // Start = first node not targeted by any edge, fallback to first
  return flow.nodes.find(n => !targets.has(n.id)) || flow.nodes[0];
}

function findNode(flow, id) {
  if (!flow || !Array.isArray(flow.nodes)) return null;
  return flow.nodes.find(n => n.id === id) || null;
}

function nextNodeId(flow, currentId, userInput) {
  if (!flow || !Array.isArray(flow.edges)) return null;
  const edges = flow.edges.filter(e => e.from === currentId);
  if (edges.length === 0) return null;
  // For branch/conditional: try matching condition (case-insensitive substring)
  if (userInput) {
    const lower = String(userInput).toLowerCase().trim();
    const matched = edges.find(e => e.condition && lower.includes(String(e.condition).toLowerCase()));
    if (matched) return matched.to;
  }
  // Default: first edge with no condition or first edge
  const def = edges.find(e => !e.condition) || edges[0];
  return def ? def.to : null;
}

// nodeRequiresInput — does this node block until the visitor responds?
function nodeRequiresInput(node) {
  if (!node) return false;
  return ["question", "capture-email", "capture-phone"].includes(node.type);
}

// runEngine — given a starting node id and a user message, advance the bot
// state and produce reply messages. Returns { replyMessages, currentNodeId,
// completed, requiresInput, captured }
function runEngine(flow, currentNodeId, userMessage) {
  const replyMessages = [];
  const captured = {};
  let nodeId = currentNodeId;
  let node = findNode(flow, nodeId);

  // If we're at an input-requiring node, validate / consume the user message
  if (node && nodeRequiresInput(node)) {
    if (node.type === "capture-email") {
      if (!isEmail(userMessage || "")) {
        replyMessages.push({ from: "bot", text: "That doesn't look like a valid email. Please try again.", at: new Date().toISOString() });
        return { replyMessages, currentNodeId: nodeId, completed: false, requiresInput: true, captured };
      }
      captured.email = String(userMessage).trim().toLowerCase();
    } else if (node.type === "capture-phone") {
      if (!isPhone(userMessage || "")) {
        replyMessages.push({ from: "bot", text: "Please enter a valid phone number.", at: new Date().toISOString() });
        return { replyMessages, currentNodeId: nodeId, completed: false, requiresInput: true, captured };
      }
      captured.phone = String(userMessage).trim();
    }
    // advance from this node using user input (for branch matching)
    nodeId = nextNodeId(flow, nodeId, userMessage);
    node = findNode(flow, nodeId);
  } else if (!node) {
    // no current node — start at beginning
    const start = getStartNode(flow);
    nodeId = start ? start.id : null;
    node = start;
  }

  // Walk forward emitting messages until we hit an input-requiring node or end
  let safety = 0;
  while (node && safety < 50) {
    safety++;
    if (node.type === "message" || node.type === "question" || node.type === "capture-email" || node.type === "capture-phone" || node.type === "branch") {
      if (node.content) {
        replyMessages.push({ from: "bot", text: String(node.content), at: new Date().toISOString(), nodeId: node.id });
      }
    }
    if (node.type === "end") {
      return { replyMessages, currentNodeId: node.id, completed: true, requiresInput: false, captured };
    }
    if (nodeRequiresInput(node)) {
      return { replyMessages, currentNodeId: node.id, completed: false, requiresInput: true, captured };
    }
    // message / branch with no input — auto-advance
    const nextId = nextNodeId(flow, node.id, null);
    if (!nextId) {
      return { replyMessages, currentNodeId: node.id, completed: true, requiresInput: false, captured };
    }
    nodeId = nextId;
    node = findNode(flow, nodeId);
  }
  return { replyMessages, currentNodeId: nodeId, completed: true, requiresInput: false, captured };
}

// ── Authenticated routes ───────────────────────────────────────────

// GET /api/chatbots
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const bots = await prisma.chatbot.findMany({
      where: { tenantId },
      orderBy: { updatedAt: "desc" },
    });
    // Add conversation counts
    const ids = bots.map(b => b.id);
    const counts = ids.length
      ? await prisma.chatbotConversation.groupBy({
          by: ["chatbotId"],
          where: { tenantId, chatbotId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const countMap = Object.fromEntries(counts.map(c => [c.chatbotId, c._count._all]));
    res.json(bots.map(b => ({
      ...b,
      flow: parseJSON(b.flow, { nodes: [], edges: [] }),
      conversationCount: countMap[b.id] || 0,
    })));
  } catch (err) {
    console.error("[chatbots/list]", err);
    res.status(500).json({ error: "List failed" });
  }
});

// POST /api/chatbots
router.post("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { name, flow } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const flowJson = typeof flow === "string" ? flow : JSON.stringify(flow || { nodes: [], edges: [] });
    const bot = await prisma.chatbot.create({
      data: { name, flow: flowJson, isActive: false, tenantId },
    });
    res.json({ ...bot, flow: parseJSON(bot.flow, { nodes: [], edges: [] }) });
  } catch (err) {
    console.error("[chatbots/create]", err);
    res.status(500).json({ error: "Create failed" });
  }
});

// GET /api/chatbots/:id
router.get("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const bot = await prisma.chatbot.findFirst({ where: { id, tenantId } });
    if (!bot) return res.status(404).json({ error: "Not found" });
    res.json({ ...bot, flow: parseJSON(bot.flow, { nodes: [], edges: [] }) });
  } catch (err) {
    console.error("[chatbots/get]", err);
    res.status(500).json({ error: "Get failed" });
  }
});

// PUT /api/chatbots/:id
router.put("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.chatbot.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    const { name, flow, isActive } = req.body || {};
    const data = {};
    if (typeof name === "string") data.name = name;
    if (flow !== undefined) data.flow = typeof flow === "string" ? flow : JSON.stringify(flow);
    if (typeof isActive === "boolean") data.isActive = isActive;
    const bot = await prisma.chatbot.update({ where: { id }, data });
    res.json({ ...bot, flow: parseJSON(bot.flow, { nodes: [], edges: [] }) });
  } catch (err) {
    console.error("[chatbots/update]", err);
    res.status(500).json({ error: "Update failed" });
  }
});

// DELETE /api/chatbots/:id
router.delete("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.chatbot.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    await prisma.chatbotConversation.deleteMany({ where: { chatbotId: id, tenantId } });
    await prisma.chatbot.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[chatbots/delete]", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// POST /api/chatbots/:id/activate
router.post("/:id/activate", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.chatbot.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    const bot = await prisma.chatbot.update({ where: { id }, data: { isActive: true } });
    res.json({ ...bot, flow: parseJSON(bot.flow, { nodes: [], edges: [] }) });
  } catch (err) {
    console.error("[chatbots/activate]", err);
    res.status(500).json({ error: "Activate failed" });
  }
});

// POST /api/chatbots/:id/deactivate
router.post("/:id/deactivate", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.chatbot.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Not found" });
    const bot = await prisma.chatbot.update({ where: { id }, data: { isActive: false } });
    res.json({ ...bot, flow: parseJSON(bot.flow, { nodes: [], edges: [] }) });
  } catch (err) {
    console.error("[chatbots/deactivate]", err);
    res.status(500).json({ error: "Deactivate failed" });
  }
});

// GET /api/chatbots/:id/conversations
router.get("/:id/conversations", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = parseInt(req.params.id, 10);
    const bot = await prisma.chatbot.findFirst({ where: { id, tenantId } });
    if (!bot) return res.status(404).json({ error: "Not found" });
    const convos = await prisma.chatbotConversation.findMany({
      where: { chatbotId: id, tenantId },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    res.json(convos.map(c => ({
      ...c,
      messages: parseJSON(c.messages, []),
    })));
  } catch (err) {
    console.error("[chatbots/conversations]", err);
    res.status(500).json({ error: "List conversations failed" });
  }
});

// ── PUBLIC: Chat endpoint ──────────────────────────────────────────
// POST /api/chatbots/chat/:botId
router.post("/chat/:botId", async (req, res) => {
  try {
    const botId = parseInt(req.params.botId, 10);
    const { visitorId, message, tenantId: tenantIdBody } = req.body || {};
    if (!botId) return res.status(400).json({ error: "botId required" });
    if (!visitorId) return res.status(400).json({ error: "visitorId required" });

    const bot = await prisma.chatbot.findUnique({ where: { id: botId } });
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    // Allow inactive bots in test mode (when tenantIdBody provided), but block for public visitors
    // Simpler rule: if not active, only allow if tenantIdBody matches bot.tenantId (test from CRM UI)
    if (!bot.isActive && parseInt(tenantIdBody, 10) !== bot.tenantId) {
      return res.status(403).json({ error: "Bot is not active" });
    }

    const flow = parseJSON(bot.flow, { nodes: [], edges: [] });

    // Find or create conversation
    let convo = await prisma.chatbotConversation.findFirst({
      where: { chatbotId: bot.id, visitorId, tenantId: bot.tenantId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
    });

    let messages = convo ? parseJSON(convo.messages, []) : [];
    let currentNodeId = null;
    let captured = {};

    // State is stored as a special last entry with role=state, OR as field on last message.
    // Use the most recent message with state to recover currentNodeId.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].state && messages[i].state.currentNodeId) {
        currentNodeId = messages[i].state.currentNodeId;
        break;
      }
    }
    // Recover captured fields from convo
    if (convo) {
      try { captured = parseJSON(convo._captured || null, {}) || {}; } catch { captured = {}; }
    }

    // First-touch: no convo yet, no message — start the flow.
    if (!convo) {
      const start = getStartNode(flow);
      if (!start) {
        return res.json({ reply: "This bot has no flow configured.", completed: true, requiresInput: false, messages: [] });
      }
      currentNodeId = start.id;
    }

    // Append user message if provided
    if (message) {
      messages.push({ from: "user", text: String(message), at: new Date().toISOString() });
    }

    // Run engine
    const result = runEngine(flow, currentNodeId, message || null);

    // Merge captured fields
    Object.assign(captured, result.captured || {});

    // Append bot reply messages, embed state on the last one
    if (result.replyMessages.length === 0) {
      // ensure at least one bot reply for first-touch starts
      result.replyMessages.push({ from: "bot", text: "Hello!", at: new Date().toISOString() });
    }
    const lastIdx = result.replyMessages.length - 1;
    result.replyMessages[lastIdx] = {
      ...result.replyMessages[lastIdx],
      state: { currentNodeId: result.currentNodeId },
    };
    messages = messages.concat(result.replyMessages);

    // Resolve contact if email captured
    let contactId = convo ? convo.contactId : null;
    if (captured.email) {
      const c = await prisma.contact.findFirst({
        where: { email: captured.email, tenantId: bot.tenantId },
      });
      if (c) contactId = c.id;
      // Also identify the WebVisitor
      try {
        const visitor = await prisma.webVisitor.findUnique({ where: { sessionId: visitorId } });
        if (visitor && c) {
          await prisma.webVisitor.update({
            where: { sessionId: visitorId },
            data: { contactId: c.id, identified: true },
          });
        }
      } catch (e) { /* ignore */ }
    }

    const status = result.completed ? "COMPLETED" : "ACTIVE";

    if (convo) {
      convo = await prisma.chatbotConversation.update({
        where: { id: convo.id },
        data: { messages: JSON.stringify(messages), status, contactId },
      });
    } else {
      convo = await prisma.chatbotConversation.create({
        data: {
          chatbotId: bot.id,
          visitorId,
          messages: JSON.stringify(messages),
          status,
          contactId,
          tenantId: bot.tenantId,
        },
      });
    }

    const lastBot = result.replyMessages[result.replyMessages.length - 1];
    res.json({
      reply: lastBot ? lastBot.text : "",
      replies: result.replyMessages.map(m => m.text),
      completed: result.completed,
      requiresInput: result.requiresInput,
      conversationId: convo.id,
      captured,
    });
  } catch (err) {
    console.error("[chatbots/chat]", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

module.exports = router;
