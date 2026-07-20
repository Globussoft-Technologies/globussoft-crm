/**
 * supportChatbot — orchestrator for the Wellness Admin Support Chatbot.
 *
 * Public surface (consumed by routes/support_chat.js +
 * routes/wellness_ai_config.js):
 *
 *   handleChatMessage({ tenantId, userId, message, history, pageContext })
 *     → runs the LLM tool loop (search_help_docs / get_page_info), logs
 *       every LLM call to LlmCallLog (task='support-chat'), returns
 *       { reply, links, toolsUsed, provider }.
 *
 *   getAnalytics(tenantId)
 *     → aggregates LlmCallLog rows where task='support-chat' for the
 *       tenant (calls, tokens, cost, failures, per-provider split).
 *
 * Provider resolution lives in providerAdapters.resolveProviderConfig():
 * tenant BYOK first, internal Gemini proxy as a NON-PRODUCTION fallback,
 * null in production-without-BYOK (routes translate that into the
 * friendly AI_PROVIDER_NOT_CONFIGURED envelope).
 */

const prisma = require("../../lib/prisma");
const { estimateLlmCost } = require("../../lib/apiPricing");
const {
  generateChatCompletion,
  resolveProviderConfig,
  providerFamilyFor,
} = require("./providerAdapters");
const { searchHelpDocs } = require("./rag");
const { TOOL_DEFINITIONS, buildSystemPrompt, findPageInfo } = require("./prompts");

const TASK_NAME = "support-chat";
const SURFACE = "wellness-admin-support-chat";
const MAX_TOOL_ROUNDS = 3;
// History is capped so a long-lived widget session can't blow the prompt
// budget; the oldest turns drop off first.
const MAX_HISTORY_TURNS = 20;

// ─── LlmCallLog persistence (non-fatal, mirrors llmRouter posture) ────
function persistLog(data) {
  try {
    prisma.llmCallLog.create({ data }).catch((e) =>
      console.error(`[support-chatbot] LlmCallLog persist failed (non-fatal): ${e.message}`),
    );
  } catch (e) {
    console.error(`[support-chatbot] LlmCallLog persist failed (non-fatal): ${e.message}`);
  }
}

// ─── Tool execution ───────────────────────────────────────────────────
/**
 * executeTool — runs one model-requested tool and returns
 * { result, sideEffects } where `result` is the JSON payload handed back
 * to the model and `sideEffects` accumulates UI-facing artefacts (deep
 * links, created ticket) for the route response.
 */
async function executeTool(name, args, ctx) {
  const { tenantId } = ctx;

  if (name === "search_help_docs") {
    const { results } = await searchHelpDocs(tenantId, args?.query, { limit: 5 });
    // KB article deep links are intentionally NOT surfaced because the
    // /portal/kb/:slug reader page is not wired up in this SPA yet.
    // The article content is still used to answer the question.
    return {
      result: results.length
        ? { articles: results.map((d) => ({ title: d.title, snippet: d.snippet, source: d.source })) }
        : { articles: [], note: "No matching help articles or docs found." },
      sideEffects: {},
    };
  }

  if (name === "get_page_info") {
    const matches = findPageInfo(args?.page);
    return {
      result: matches.length
        ? {
            matches: matches.map((p) => ({
              title: p.title,
              path: p.path,
              description: p.description,
              score: p.score,
            })),
          }
        : { found: false, note: "No matching page. Describe the task in other words." },
      sideEffects: matches.length
        ? {
            links: matches.map((p) => ({ label: p.title, path: p.path })),
          }
        : {},
    };
  }

  // Unknown tool — tell the model rather than throwing; it can recover
  // and answer in prose on the next round.
  return { result: { error: `Unknown tool: ${name}` }, sideEffects: {} };
}

// ─── Main chat orchestration ──────────────────────────────────────────
/**
 * handleChatMessage — one user turn through the support chatbot.
 *
 * `history` is the widget's prior turns as [{ role: "user"|"assistant",
 * content }] (already tenant/user-scoped client-side). `pageContext` is
 * { path, pageName? } from the widget's useLocation().
 *
 * Throws err.code === 'AI_PROVIDER_NOT_CONFIGURED' when no BYOK config
 * exists and the env fallback is unavailable (production) — the route
 * turns that into a friendly 503.
 */
async function handleChatMessage({
  tenantId,
  userId,
  message,
  history = [],
  pageContext = null,
  fetchImpl = null,
}) {
  const config = await resolveProviderConfig(tenantId);
  if (!config) {
    const err = new Error(
      "AI provider not configured. An administrator can add one under Settings → AI Provider (Support Chatbot).",
    );
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) {
    const err = new Error("message is required");
    err.code = "MISSING_MESSAGE";
    throw err;
  }

  const messages = [
    { role: "system", content: buildSystemPrompt({ pageContext }) },
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY_TURNS),
    { role: "user", content: cleanMessage },
  ];

  const providerFamily = providerFamilyFor(config);
  const links = [];
  const toolsUsed = [];
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    let resp;
    try {
      resp = await generateChatCompletion(
        config,
        { messages, tools: TOOL_DEFINITIONS },
        fetchImpl,
      );
    } catch (callErr) {
      persistLog({
        tenantId: Number(tenantId),
        task: TASK_NAME,
        model: config.model || "unknown",
        provider: providerFamily,
        reason: "primary",
        stub: false,
        userId: Number(userId),
        surface: SURFACE,
        status: "failed",
        errorMessage: String(callErr.message || "LLM call failed").slice(0, 500),
      });
      throw callErr;
    }

    persistLog({
      tenantId: Number(tenantId),
      task: TASK_NAME,
      model: resp.model || config.model || "unknown",
      provider: providerFamily,
      reason: "primary",
      promptTokens: resp.usage.promptTokens,
      completionTokens: resp.usage.completionTokens,
      totalTokens: resp.usage.totalTokens,
      costEstimate: estimateLlmCost(
        resp.model || config.model,
        resp.usage.promptTokens,
        resp.usage.completionTokens,
      ),
      stub: false,
      userId: Number(userId),
      surface: SURFACE,
      status: "success",
    });

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      reply = resp.text || "";
      break;
    }

    // Model wants tools. Replay its prose (may be empty) as an assistant
    // turn, then append one tool-result turn per call.
    messages.push({ role: "assistant", content: resp.text || "" });
    for (const call of resp.toolCalls) {
      toolsUsed.push(call.name);
      const { result, sideEffects } = await executeTool(call.name, call.args, {
        tenantId,
        userId,
      });
      if (sideEffects.links) links.push(...sideEffects.links);
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Tool budget exhausted without a prose answer — one final tools-off
  // call so the model is forced to summarise what it learned.
  if (!reply) {
    const resp = await generateChatCompletion(config, { messages }, fetchImpl);
    persistLog({
      tenantId: Number(tenantId),
      task: TASK_NAME,
      model: resp.model || config.model || "unknown",
      provider: providerFamily,
      reason: "tool-summary",
      promptTokens: resp.usage.promptTokens,
      completionTokens: resp.usage.completionTokens,
      totalTokens: resp.usage.totalTokens,
      costEstimate: estimateLlmCost(
        resp.model || config.model,
        resp.usage.promptTokens,
        resp.usage.completionTokens,
      ),
      stub: false,
      userId: Number(userId),
      surface: SURFACE,
      status: "success",
    });
    reply = resp.text || "I wasn't able to put together an answer — please try rephrasing your question.";
  }

  // De-dupe deep links by path (search + page_info can surface the same route).
  const seen = new Set();
  const dedupedLinks = links.filter((l) => {
    if (!l || !l.path || seen.has(l.path)) return false;
    seen.add(l.path);
    return true;
  });

  return {
    reply,
    links: dedupedLinks,
    toolsUsed,
    provider: { source: config.source, family: providerFamily, model: config.model },
  };
}

// ─── Analytics ────────────────────────────────────────────────────────
/**
 * getAnalytics — aggregates the tenant's LlmCallLog rows where
 * task='support-chat'. Returns totals + per-provider split + recent
 * failures so an admin can eyeball adoption, cost, and reliability.
 */
async function getAnalytics(tenantId) {
  const rows = await prisma.llmCallLog.findMany({
    where: { tenantId: Number(tenantId), task: TASK_NAME },
    select: {
      provider: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      costEstimate: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5000, // bounded rollup window — same in-process-bucketing posture as tickets /stats
  });

  const byProvider = new Map();
  let totalCalls = 0;
  let failedCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let lastCallAt = null;

  for (const r of rows) {
    totalCalls += 1;
    if (r.status === "failed") failedCalls += 1;
    promptTokens += r.promptTokens || 0;
    completionTokens += r.completionTokens || 0;
    totalTokens += r.totalTokens || 0;
    const cost = Number(r.costEstimate) || 0;
    totalCostUsd += cost;
    if (!lastCallAt && r.createdAt) lastCallAt = r.createdAt;

    const key = r.provider || "unknown";
    const bucket = byProvider.get(key) || { provider: key, calls: 0, totalTokens: 0, costUsd: 0 };
    bucket.calls += 1;
    bucket.totalTokens += r.totalTokens || 0;
    bucket.costUsd += cost;
    byProvider.set(key, bucket);
  }

  return {
    totalCalls,
    failedCalls,
    promptTokens,
    completionTokens,
    totalTokens,
    totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
    byProvider: Array.from(byProvider.values()).map((b) => ({
      ...b,
      costUsd: Math.round(b.costUsd * 1e6) / 1e6,
    })),
    lastCallAt,
  };
}

module.exports = {
  TASK_NAME,
  handleChatMessage,
  getAnalytics,
  // Re-exported so routes/tests can reach adapter helpers through one
  // service entry point.
  resolveProviderConfig,
};
