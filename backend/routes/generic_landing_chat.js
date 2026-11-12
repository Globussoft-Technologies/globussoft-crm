const express = require("express");
const prisma = require("../lib/prisma");
const aiGateway = require("../lib/aiGateway");
const aiProviderManagement = require("../lib/aiProviderManagement");
const landingFormConfig = require("../lib/landingFormConfig");
const { getQuestionGroupKey } = require("../lib/genericChatTicketGrouping");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const KNOWLEDGE_SETTING_KEY = "generic.landing.ai.knowledge";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_KNOWLEDGE_LENGTH = 120000;
const CHAT_SETTINGS_KEY = "generic.landing.ai.settings";
const DEFAULT_CHAT_SETTINGS = {
  generalResponsesEnabled: true,
  businessFallback: "I'm sorry, but I couldn't find relevant information in our available knowledge base. Would you like me to connect you with our support team?",
  unrelatedFallback: "I can help with questions about our CRM products, services, pricing, policies, and support. What would you like to know?",
  aiUnavailableFallback: "I couldn't verify that answer right now. Would you like me to connect you with our support team?",
};
function acceptedSupportConnection(message) {
  return /^(yes|yeah|yep|sure|okay|ok|please|connect|connect me|go ahead)$/i.test(String(message || "").trim());
}

function isSupportFollowUpQuestion(message) {
  return /\b(support team|support|reach me|contact me|follow up|representative|agent|hear from)\b/i.test(String(message || ""));
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function readUnresolvedQuestions(conversation) {
  const parsed = parseJson(conversation.unresolvedQuestions, null);
  if (Array.isArray(parsed)) return parsed.filter(Boolean).map((item) => String(item));
  return conversation.unresolvedQuestion ? [String(conversation.unresolvedQuestion)] : [];
}

function parseModelReply(text) {
  const raw = String(text || "").trim();
  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  for (const candidate of candidates) {
    const parsed = parseJson(candidate, null);
    if (parsed && typeof parsed === "object" && typeof parsed.answer === "string") {
      return {
        answer: parsed.answer.trim(),
        canAnswer: parsed.canAnswer !== false,
        intent: parsed.intent || null,
        leadCaptureStep: parsed.leadCaptureStep || null,
      };
    }
  }
  return { answer: raw, canAnswer: Boolean(raw), intent: null, leadCaptureStep: null };
}

async function resolvePublicGenericTenant() {
  const config = await landingFormConfig.readPublicConfig(prisma);
  if (!config?.tenantId) return null;
  return prisma.tenant.findFirst({
    where: { id: config.tenantId, vertical: "generic", isActive: true },
    select: { id: true, name: true },
  });
}

async function loadChatSettings() {
  const row = await prisma.systemSetting.findUnique({ where: { key: CHAT_SETTINGS_KEY }, select: { value: true } });
  const parsed = parseJson(row?.value, {});
  return { ...DEFAULT_CHAT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
}

function knowledgeTokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

async function retrieveKnowledge(tenantId, question) {
  const [setting, articles] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: KNOWLEDGE_SETTING_KEY }, select: { value: true } }),
    prisma.kbArticle.findMany({
      where: { tenantId, isPublished: true },
      select: { title: true, content: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
  ]);
  const queryTokens = knowledgeTokens(question);
  const matchedArticles = articles.map((article) => {
    const articleTokens = knowledgeTokens(`${article.title} ${article.content}`);
    const score = [...queryTokens].filter((token) => articleTokens.has(token)).length;
    return { ...article, score };
  }).filter((article) => article.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  const uploaded = String(setting?.value || "").trim();
  const uploadedTokens = knowledgeTokens(uploaded);
  const uploadedRelevant = uploaded && [...queryTokens].some((token) => uploadedTokens.has(token));
  const sources = [
    ...(uploadedRelevant ? [{ title: "Approved Generic CRM knowledge", content: uploaded }] : []),
    ...matchedArticles.map((article) => ({ title: article.title, content: article.content })),
  ];
  return {
    text: sources.map((source) => `## ${source.title}\n${source.content}`).join("\n\n").slice(0, MAX_KNOWLEDGE_LENGTH),
    sources: sources.map((source) => source.title),
  };
}

async function classifyIntentWithAi(tenant, message, messages) {
  const response = await aiGateway.runAiRequest({
    tenantId: tenant.id,
    task: "generic-landing-chat-intent",
    surface: "routes/generic_landing_chat.js:classify-intent",
    messages: [
      { role: "system", content: `Classify and respond to the visitor's latest message for the ${tenant.name} public chatbot. Return only JSON: {"intent":"greeting|general|business|unrelated","answer":"...","canAnswer":true|false,"leadCaptureStep":"name|email|null"}. greeting means greetings, thanks, farewells, or casual conversation. general means calculations, basic facts, or ordinary questions that do not require company knowledge. business means products, services, pricing, policies, procedures, support, or company-specific information. unrelated means outside the chatbot's supported scope. For greeting/general/unrelated messages, provide the natural answer in answer. For business messages, leave answer empty unless the conversation context already contains the answer.` },
      { role: "user", content: `${transcript(messages)}\n\nLatest message: ${message}` },
    ],
    requestedModelLabel: "gemini-flash",
  });
  const raw = String(response.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = parseJson(raw, null);
  return {
    intent: ["greeting", "general", "business", "unrelated"].includes(parsed?.intent) ? parsed.intent : "business",
    answer: typeof parsed?.answer === "string" ? parsed.answer.trim() : "",
    canAnswer: parsed?.canAnswer !== false,
    leadCaptureStep: parsed?.leadCaptureStep || null,
  };
}

async function getOrCreateConversation(tenantId, visitorId) {
  const existing = await prisma.genericChatConversation.findFirst({ where: { tenantId, visitorId } });
  if (existing) return existing;
  return prisma.genericChatConversation.create({ data: { tenantId, visitorId, messages: "[]" } });
}

function transcript(messages) {
  return messages
    .filter((item) => item && ["user", "assistant", "agent"].includes(item.role))
    .map((item) => `${item.role === "user" ? "Visitor" : item.role === "agent" ? "Support agent" : "Assistant"}: ${String(item.content || "")}`)
    .join("\n");
}

function parseConversationMessages(conversation) {
  return parseJson(conversation?.messages, [])
    .filter((item) => item && item.content)
    .map((item, index) => ({
      id: `generic-${conversation.id}-${index}`,
      sender: item.role === "user"
        ? "visitor"
        : item.role === "assistant" ? "assistant" : "agent",
      body: String(item.content),
      createdAt: item.at || conversation.updatedAt || conversation.createdAt,
    }));
}

function conversationSummary(conversation) {
  const messages = parseConversationMessages(conversation);
  const lastMessage = messages[messages.length - 1] || null;
  return {
    id: `generic-${conversation.id}`,
    source: "generic-chatbot",
    sourceId: conversation.id,
    visitorId: conversation.visitorId,
    visitorName: conversation.requesterName,
    visitorEmail: conversation.requesterEmail,
    status: conversation.status === "CLOSED" ? "CLOSED" : "OPEN",
    startedAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessage,
  };
}

async function requireGenericTenant(req) {
  return prisma.tenant.findFirst({
    where: { id: req.user.tenantId, vertical: "generic", isActive: true },
    select: { id: true },
  });
}

router.post("/", async (req, res) => {
  try {
    const visitorId = String(req.body?.visitorId || "").trim();
    const message = String(req.body?.message || "").trim().slice(0, MAX_MESSAGE_LENGTH);
    const requesterName = String(req.body?.requesterName || "").trim().slice(0, 200) || null;
    const requesterEmail = String(req.body?.requesterEmail || "").trim().toLowerCase().slice(0, 320) || null;
    const saveOnly = req.body?.saveOnly === true;
    if (!visitorId || !message) return res.status(400).json({ error: "visitorId and message are required" });

    const tenant = await resolvePublicGenericTenant();
    if (!tenant) return res.status(503).json({ error: "Generic landing tenant is not configured", code: "GENERIC_LANDING_NOT_CONFIGURED" });
    const conversation = await getOrCreateConversation(tenant.id, visitorId);
    const messages = parseJson(conversation.messages, []);
    const unresolvedQuestions = readUnresolvedQuestions(conversation);
    const previousAssistantMessage = [...messages].reverse().find((item) => item?.role === "assistant");
    messages.push({ role: "user", content: message, at: new Date().toISOString() });

    const chatSettings = await loadChatSettings();
    let intent = "business";
    let intentClassificationConfirmed = false;
    let classificationAnswer = "";
    let classificationCanAnswer = true;
    let reply = null;
    let canAnswer = true;
    let shouldCreateTicket = false;
    let sourceTitles = [];
    let leadCaptureStep = null;
    if (!saveOnly) {
      try {
        const classification = await classifyIntentWithAi(tenant, message, messages);
        intent = classification.intent;
        intentClassificationConfirmed = true;
        classificationAnswer = classification.answer;
        classificationCanAnswer = classification.canAnswer;
        leadCaptureStep = classification.leadCaptureStep;
      } catch (classificationError) {
        console.warn("[generic-landing-chat] intent classification unavailable:", classificationError.message);
      }
      const supportOfferWasActive = /connect you with (?:our )?support|connect.*support/i.test(String(previousAssistantMessage?.content || ""));
      const supportConsent = acceptedSupportConnection(message) && supportOfferWasActive;
      const useGeneralAi = intent !== "business" || isSupportFollowUpQuestion(message) || supportConsent;
      if (intent === "unrelated" && !chatSettings.generalResponsesEnabled) {
        reply = chatSettings.unrelatedFallback;
      } else if (intent === "business" && !useGeneralAi) {
        const knowledge = await retrieveKnowledge(tenant.id, message);
        sourceTitles = knowledge.sources;
        if (!knowledge.text) {
          reply = chatSettings.businessFallback;
          canAnswer = false;
          shouldCreateTicket = intentClassificationConfirmed && intent === "business";
        } else {
          try {
            const response = await aiGateway.runAiRequest({
              tenantId: tenant.id,
              task: "generic-landing-chat",
              surface: "routes/generic_landing_chat.js:chat",
              messages: [
                { role: "system", content: `You are the public Globus CRM assistant for ${tenant.name}. This is a business question. Answer only from the relevant knowledge below and the conversation context. Do not invent or assume company information. Return only valid JSON: {"answer":"...","canAnswer":true|false}.\n\nRelevant knowledge:\n${knowledge.text}` },
                { role: "user", content: `${transcript(messages)}\n\nAnswer the visitor's latest question.` },
              ],
              requestedModelLabel: "gemini-flash",
            });
            const parsed = parseModelReply(response.text);
            reply = parsed.answer || chatSettings.businessFallback;
            canAnswer = parsed.canAnswer;
            shouldCreateTicket = !canAnswer;
          } catch (aiError) {
            console.warn("[generic-landing-chat] AI unavailable:", aiError.message);
            reply = chatSettings.aiUnavailableFallback;
            canAnswer = false;
            shouldCreateTicket = intentClassificationConfirmed && intent === "business";
          }
        }
      } else if (classificationAnswer && (intent !== "business" || useGeneralAi)) {
        reply = classificationAnswer;
        canAnswer = classificationCanAnswer;
      } else {
        try {
          const response = await aiGateway.runAiRequest({
            tenantId: tenant.id,
            task: "generic-landing-chat",
            surface: "routes/generic_landing_chat.js:chat",
            messages: [
              { role: "system", content: `You are the general AI assistant for the public Globus CRM chatbot. Answer greetings, casual conversation, general questions, and support follow-up questions naturally. Use the conversation context. If the visitor has accepted a support connection, ask for their name and set leadCaptureStep to "name". If their name is already known but their email is missing, ask for their email and set leadCaptureStep to "email". If both are already known, explain the next support step without asking again. Known requester name: ${requesterName || conversation.requesterName || "none"}. Known requester email: ${requesterEmail || conversation.requesterEmail || "none"}. Do not invent company facts. Return only valid JSON: {"answer":"...","canAnswer":true|false,"intent":"greeting|general|business|unrelated","leadCaptureStep":"name|email|null"}.` },
              { role: "user", content: `${transcript(messages)}\n\nAnswer the visitor's latest question.` },
            ],
            requestedModelLabel: "gemini-flash",
          });
          const parsed = parseModelReply(response.text);
          reply = parsed.answer || "I need to check that with our support team.";
          canAnswer = parsed.canAnswer;
          if (parsed.intent) intent = parsed.intent;
          leadCaptureStep = parsed.leadCaptureStep;
        } catch (aiError) {
          // A missing/unavailable provider is also an unanswered question. Keep
          // the conversation and ticket path working instead of silently using
          // a canned answer that looks authoritative.
          console.warn("[generic-landing-chat] AI unavailable:", aiError.message);
          reply = chatSettings.aiUnavailableFallback;
          canAnswer = false;
        }
      }
      if (sourceTitles.length && canAnswer) reply = `${reply}\n\nSources: ${sourceTitles.join(", ")}`;
      messages.push({ role: "assistant", content: reply, canAnswer, at: new Date().toISOString() });
      if (shouldCreateTicket && !unresolvedQuestions.includes(message)) {
        unresolvedQuestions.push(message);
      }
    }

    const updateData = {
      messages: JSON.stringify(messages),
      requesterName: requesterName || conversation.requesterName,
      requesterEmail: requesterEmail || conversation.requesterEmail,
      unresolvedQuestion: unresolvedQuestions[0] || null,
      unresolvedQuestions: JSON.stringify(unresolvedQuestions),
    };
    const createdTickets = [];
    const effectiveEmail = requesterEmail || conversation.requesterEmail;
    let linkedTicketId = null;
    if (effectiveEmail && unresolvedQuestions.length > 0) {
      const existingTickets = await prisma.ticket.findMany({
        where: { tenantId: tenant.id, sourceConversationId: String(conversation.id) },
        select: { id: true, status: true, sourceQuestionKey: true, description: true },
      });
      const groupedQuestions = new Map();
      unresolvedQuestions.forEach((question) => {
        const key = getQuestionGroupKey(question);
        if (!groupedQuestions.has(key)) groupedQuestions.set(key, []);
        groupedQuestions.get(key).push(question);
      });

      for (const [questionKey, questions] of groupedQuestions) {
        const activeTicket = existingTickets.find((item) => (
          item.sourceQuestionKey === questionKey && !["resolved", "closed"].includes(String(item.status || "").toLowerCase())
        ));
        if (activeTicket) {
          linkedTicketId ||= activeTicket.id;
          if (!saveOnly) {
            await prisma.ticket.update({
              where: { id: activeTicket.id },
              data: {
                description: `${String(activeTicket.description || "")}\n\nUpdated unanswered questions:\n${questions.map((question) => `- ${question}`).join("\n")}\n\nLatest transcript:\n${transcript(messages)}`,
              },
            });
          }
          continue;
        }

        const description = [
          "Created by the Generic CRM landing AI assistant.",
          `Conversation ID: ${conversation.id}`,
          `Question group: ${questionKey}`,
          `Requester name: ${requesterName || conversation.requesterName || "Not provided"}`,
          `Requester email: ${effectiveEmail}`,
          "",
          `Unanswered questions:\n${questions.map((question) => `- ${question}`).join("\n")}`,
          "",
          "Conversation transcript:",
          transcript(messages),
        ].join("\n");
        const createdTicket = await prisma.ticket.create({
          data: {
            tenantId: tenant.id,
            subject: `Landing assistant question: ${questions[0].slice(0, 140)}`,
            description,
            priority: "Medium",
            status: "Open",
            requesterName: requesterName || conversation.requesterName,
            requesterEmail: effectiveEmail,
            sourceConversationId: String(conversation.id),
            sourceQuestionKey: questionKey,
          },
        });
        createdTickets.push(createdTicket);
        linkedTicketId ||= createdTicket.id;
      }
    }
    if (linkedTicketId) updateData.ticketId = linkedTicketId;
    const saved = await prisma.genericChatConversation.update({ where: { id: conversation.id }, data: updateData });
    res.json({ reply, canAnswer, intent, leadCaptureStep, sources: sourceTitles, ticketCreated: createdTickets.length > 0, ticketId: linkedTicketId || saved.ticketId || null, ticketIds: createdTickets.map((ticket) => ticket.id), conversationId: saved.id });
  } catch (err) {
    console.error("[generic-landing-chat] failed:", err.message);
    const status = err.code === "AI_NOT_CONFIGURED" || err.code === "AI_CREDITS_EXHAUSTED" ? 503 : 500;
    res.status(status).json({ error: err.message || "Chat unavailable", code: err.code || "GENERIC_LANDING_CHAT_FAILED" });
  }
});

// Public, key-safe readiness check used only to decide whether the Generic
// CRM landing chatbot should be shown. It never returns provider credentials.
router.get("/availability", async (_req, res) => {
  try {
    const tenant = await resolvePublicGenericTenant();
    if (!tenant) return res.json({ available: false });
    const config = await aiProviderManagement.resolveProviderConfig(tenant.id, { requestedModelLabel: "gemini-flash" });
    const model = String(config?.model || "").toLowerCase();
    const unusableForChat = /(?:tts|embedding|image|vision-only)/i.test(model);
    res.set("Cache-Control", "no-store");
    res.json({ available: Boolean(config?.apiKey) && !unusableForChat });
  } catch (err) {
    console.warn("[generic-landing-chat] availability check failed:", err.message);
    res.json({ available: false });
  }
});

// Staff inbox endpoints for Generic CRM chatbot conversations. These are kept
// separate from the public POST endpoint above so the existing landing widget
// contract and all other verticals remain unchanged.
router.get("/agent/conversations", verifyToken, async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req);
    if (!tenant) return res.json([]);
    const conversations = await prisma.genericChatConversation.findMany({
      // The agent inbox includes every landing-page chatbot conversation;
      // the UI labels records without requester details as Anonymous.
      where: { tenantId: tenant.id },
      orderBy: { updatedAt: "desc" },
    });
    res.json(conversations.map(conversationSummary));
  } catch (err) {
    console.error("[generic-landing-chat] agent list failed:", err.message);
    res.status(500).json({ error: "Failed to list chatbot conversations" });
  }
});

router.get("/agent/conversations/:id", verifyToken, async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req);
    const id = parseInt(req.params.id, 10);
    if (!tenant || !Number.isInteger(id)) return res.status(404).json({ error: "Conversation not found" });
    const conversation = await prisma.genericChatConversation.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    res.json({ session: conversationSummary(conversation), messages: parseConversationMessages(conversation) });
  } catch (err) {
    console.error("[generic-landing-chat] agent conversation failed:", err.message);
    res.status(500).json({ error: "Failed to load chatbot conversation" });
  }
});

router.post("/agent/conversations/:id/messages", verifyToken, async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req);
    const id = parseInt(req.params.id, 10);
    const body = String(req.body?.body || "").trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!tenant || !Number.isInteger(id)) return res.status(404).json({ error: "Conversation not found" });
    if (!body) return res.status(400).json({ error: "body is required" });
    const conversation = await prisma.genericChatConversation.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    if (conversation.status === "CLOSED") return res.status(400).json({ error: "Conversation is closed" });

    const messages = parseJson(conversation.messages, []);
    messages.push({
      role: "agent",
      content: body,
      agentId: req.user.userId,
      at: new Date().toISOString(),
    });
    const updated = await prisma.genericChatConversation.update({
      where: { id: conversation.id },
      data: { messages: JSON.stringify(messages) },
    });
    res.json({ success: true, message: parseConversationMessages(updated).slice(-1)[0] });
  } catch (err) {
    console.error("[generic-landing-chat] agent send failed:", err.message);
    res.status(500).json({ error: "Failed to send chatbot reply" });
  }
});

router.post("/agent/conversations/:id/close", verifyToken, async (req, res) => {
  try {
    const tenant = await requireGenericTenant(req);
    const id = parseInt(req.params.id, 10);
    if (!tenant || !Number.isInteger(id)) return res.status(404).json({ error: "Conversation not found" });
    const conversation = await prisma.genericChatConversation.findFirst({ where: { id, tenantId: tenant.id } });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const updated = await prisma.genericChatConversation.update({
      where: { id: conversation.id },
      data: { status: "CLOSED" },
    });
    res.json({ success: true, session: conversationSummary(updated) });
  } catch (err) {
    console.error("[generic-landing-chat] agent close failed:", err.message);
    res.status(500).json({ error: "Failed to close chatbot conversation" });
  }
});

// The public widget uses this read-only endpoint to receive replies written by
// a Generic CRM agent in Live Chat.
router.get("/conversation/:visitorId", async (req, res) => {
  try {
    const visitorId = String(req.params.visitorId || "").trim();
    const tenant = await resolvePublicGenericTenant();
    if (!tenant || !visitorId) return res.status(404).json({ error: "Conversation not found" });
    const conversation = await prisma.genericChatConversation.findFirst({ where: { tenantId: tenant.id, visitorId } });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const tickets = await prisma.ticket.findMany({
      where: { tenantId: tenant.id, sourceConversationId: String(conversation.id) },
      select: { id: true, status: true, resolutionNotes: true, sourceQuestionKey: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
    });
    res.json({
      conversationId: conversation.id,
      requesterName: conversation.requesterName,
      requesterEmail: conversation.requesterEmail,
      messages: parseJson(conversation.messages, []),
      ticket: tickets[tickets.length - 1] || null,
      tickets,
      updatedAt: conversation.updatedAt,
    });
  } catch (err) {
    console.error("[generic-landing-chat] public conversation failed:", err.message);
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

module.exports = { router, KNOWLEDGE_SETTING_KEY };
