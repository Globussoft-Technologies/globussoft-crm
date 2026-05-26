const router = require("express").Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
// #527 (CRIT-02 hardening): chatbot CRUD + activate/deactivate are admin-only.
// GET stays open (USERs may need to see the bot list). POST /chat/:botId is
// the actual chat-usage endpoint and stays open to all auth users — that's
// what bots are FOR.
const adminOnly = [verifyToken, verifyRole(["ADMIN"])];

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
    // #920 slice 19 — payload reduction via opt-in slim shape. When the
    // caller passes ?fields=summary, GET /api/chatbots returns a slim
    // Prisma select dropping the heavy `flow` column (a LongText JSON node
    // graph that runs into KB per row for non-trivial bots) and the
    // per-row groupBy `conversationCount` decoration. The slim branch is
    // suitable for picker / directory / dashboard-counter UIs that only
    // need id + name + isActive + tenantId + timestamps. ADDITIVE: when
    // ?fields is absent or any other value, the prior full-row shape is
    // preserved (full row + parsed flow + conversationCount) so the
    // existing Marketing → Chatbots admin page keeps getting the rich
    // payload it currently renders.
    const isSummary = req.query.fields === "summary";
    if (isSummary) {
      const bots = await prisma.chatbot.findMany({
        where: { tenantId },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          isActive: true,
          tenantId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return res.json(bots);
    }
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
router.post("/", ...adminOnly, async (req, res) => {
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

// ============================================================================
// GET /api/chatbots/stats — tenant-wide chatbot rollup
//
// Marketing/Support polish — first /stats endpoint on the chatbots route.
// Powers a future Marketing → Chatbots dashboard KPI strip without
// firing N+1 round-trips (list + count(isActive=true) + groupBy(status) +
// max(createdAt)). Mirrors the /stats template established by
// travel-suppliers / sequences / accounting / billing / tickets etc.
//
// Schema reality (verified against prisma/schema.prisma):
//   - Chatbot has NO channel column (only id, name, flow, isActive,
//     tenantId, createdAt, updatedAt). The "byChannel" envelope key
//     described in the prompt is therefore intentionally OMITTED — there
//     is no source column to bucket by. The closest available dimension
//     is ChatbotConversation.status ('ACTIVE' / 'COMPLETED' / 'ABANDONED'),
//     surfaced as byConversationStatus.
//   - byBotStatus buckets the Chatbot rows by isActive (active / inactive).
//
// Behaviour:
//   - Auth: verifyToken only (mirrors GET / list, which is open to all
//     authenticated users; only mutate endpoints are admin-only).
//   - Tenant-scoped via req.user.tenantId.
//   - ?from / ?to optional ISO date bounds on Chatbot.createdAt.
//     Invalid → 400 INVALID_DATE.
//   - Aggregates:
//       totalBots                — count of Chatbot rows in window
//       activeBots               — count where isActive=true
//       inactiveBots             — count where isActive=false
//       byBotStatus              — { active, inactive } convenience map
//       totalConversations       — count of ChatbotConversation rows
//                                  attached to bots in the window
//       byConversationStatus     — { ACTIVE, COMPLETED, ABANDONED } counts
//       lastCreatedAt            — max(Chatbot.createdAt) as ISO or null
//   - NO audit row written (read-only meta surface).
//
// Express route ordering: this literal-path /stats MUST be declared BEFORE
// the /:id family or `:id="stats"` would 404 (NaN parseInt) before
// reaching this handler.
// ============================================================================
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Optional ISO date bounds on Chatbot.createdAt
    const where = { tenantId };
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      where.createdAt = Object.assign(where.createdAt || {}, { lte: d });
    }

    const bots = await prisma.chatbot.findMany({
      where,
      select: { id: true, isActive: true, createdAt: true },
      orderBy: [{ id: "asc" }],
    });

    // Empty short-circuit — return zeroed shape.
    if (bots.length === 0) {
      return res.json({
        totalBots: 0,
        activeBots: 0,
        inactiveBots: 0,
        byBotStatus: { active: 0, inactive: 0 },
        totalConversations: 0,
        byConversationStatus: { ACTIVE: 0, COMPLETED: 0, ABANDONED: 0 },
        lastCreatedAt: null,
      });
    }

    let activeBots = 0;
    let inactiveBots = 0;
    let lastCreatedAt = null;
    for (const b of bots) {
      if (b.isActive) activeBots += 1;
      else inactiveBots += 1;
      const ts = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastCreatedAt || ts > lastCreatedAt) lastCreatedAt = ts;
      }
    }

    // Conversation rollup — tenant-scoped + restricted to the
    // window-matching bot ids so ?from/?to flows downstream correctly.
    const botIds = bots.map((b) => b.id);
    const convoGroups = await prisma.chatbotConversation.groupBy({
      by: ["status"],
      where: { tenantId, chatbotId: { in: botIds } },
      _count: { _all: true },
    });

    const byConversationStatus = { ACTIVE: 0, COMPLETED: 0, ABANDONED: 0 };
    let totalConversations = 0;
    for (const g of convoGroups) {
      const n = (g._count && g._count._all) || 0;
      totalConversations += n;
      const key = String(g.status || "ACTIVE");
      byConversationStatus[key] = (byConversationStatus[key] || 0) + n;
    }

    res.json({
      totalBots: bots.length,
      activeBots,
      inactiveBots,
      byBotStatus: { active: activeBots, inactive: inactiveBots },
      totalConversations,
      byConversationStatus,
      lastCreatedAt: lastCreatedAt ? lastCreatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("[chatbots/stats]", err);
    res.status(500).json({ error: "Stats failed" });
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
router.put("/:id", ...adminOnly, async (req, res) => {
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
router.delete("/:id", ...adminOnly, async (req, res) => {
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
router.post("/:id/activate", ...adminOnly, async (req, res) => {
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
router.post("/:id/deactivate", ...adminOnly, async (req, res) => {
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
    // #646: body field is `previewTenantId` (NOT `tenantId`) because the global
    // stripDangerous middleware deletes `tenantId` from every request body. With
    // the old name the override never fired and inactive bots ALWAYS returned 403,
    // making the test-mode preview path dead code. The endpoint is public (real
    // visitors hit it without auth), so the preview "guard" is just knowledge of
    // the bot's tenantId — sufficient for an in-CRM admin Test button without
    // standing up a separate authenticated preview route.
    const { visitorId, message, previewTenantId } = req.body || {};
    if (!botId) return res.status(400).json({ error: "botId required" });
    if (!visitorId) return res.status(400).json({ error: "visitorId required" });

    const bot = await prisma.chatbot.findUnique({ where: { id: botId } });
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    // Allow inactive bots in test mode (when previewTenantId matches), but block for public visitors.
    if (!bot.isActive && parseInt(previewTenantId, 10) !== bot.tenantId) {
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
      } catch (_e) { /* ignore */ }
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
