"use strict";

const prisma = require("./prisma");
const { getSetting, setSetting, KEYS } = require("./tenantSettings");
const { encrypt, decrypt } = require("./fieldEncryption");
const { writeAudit } = require("./audit");
const { inferProvider } = require("./apiPricing");
const aiCreditLedger = require("./aiCreditLedger");

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-latest";

const BYOK_CATEGORY = "ai";

const PROVIDER_CATALOG = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    family: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: DEFAULT_GEMINI_MODEL,
    allowCustomBaseUrl: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    family: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: DEFAULT_OPENAI_MODEL,
    allowCustomBaseUrl: true,
  },
  claude: {
    id: "claude",
    label: "Claude",
    family: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    allowCustomBaseUrl: true,
  },
  groq: {
    id: "groq",
    label: "Groq",
    family: "openai-compatible",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    allowCustomBaseUrl: true,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    family: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    allowCustomBaseUrl: true,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    family: "openai-compatible",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    allowCustomBaseUrl: true,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    family: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: DEFAULT_OPENAI_MODEL,
    allowCustomBaseUrl: true,
  },
  cohere: {
    id: "cohere",
    label: "Cohere",
    family: "openai-compatible",
    defaultBaseUrl: "https://api.cohere.com/compatibility/v1",
    defaultModel: "command-r-plus",
    allowCustomBaseUrl: true,
  },
  "azure-openai": {
    id: "azure-openai",
    label: "Azure OpenAI",
    family: "openai-compatible",
    defaultBaseUrl: "",
    defaultModel: DEFAULT_OPENAI_MODEL,
    allowCustomBaseUrl: true,
  },
  other: {
    id: "other",
    label: "Other",
    family: "openai-compatible",
    defaultBaseUrl: "",
    defaultModel: DEFAULT_OPENAI_MODEL,
    allowCustomBaseUrl: true,
  },
};

// Legacy manual-approval workflow statuses. Superseded by the
// AiSubscriptionPlan / AiTenantSubscription / AiCreditWallet system below;
// kept only as a value some already-persisted TenantSetting rows may still
// contain so old data doesn't throw when read.
const CRM_STATUS = {
  NONE: "none",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CANCELLED: "cancelled",
};

function configuredProviderHosts() {
  return new Set(
    String(process.env.AI_PROVIDER_ALLOWED_HOSTS || process.env.WELLNESS_AI_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean),
  );
}

function resolveFetch(fetchImpl) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") {
    throw new Error("No fetch implementation available (Node 18+ required).");
  }
  return impl;
}

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

function getProviderMeta(providerId) {
  return PROVIDER_CATALOG[String(providerId || "").trim().toLowerCase()] || null;
}

function normalizeProviderId(providerId) {
  const meta = getProviderMeta(providerId);
  return meta ? meta.id : null;
}

function validateProviderBaseUrl(providerId, baseUrl, { source = "byok" } = {}) {
  const meta = getProviderMeta(providerId);
  if (!meta) {
    const err = new Error("Unsupported AI provider.");
    err.code = "AI_PROVIDER_UNSUPPORTED";
    throw err;
  }

  const raw = String(baseUrl || meta.defaultBaseUrl || "").trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_e) {
    const err = new Error("Provider base URL is invalid.");
    err.code = "INVALID_PROVIDER_BASE_URL";
    throw err;
  }

  if (source !== "internal") {
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const builtinHosts = new Set(
      Object.values(PROVIDER_CATALOG)
        .map((entry) => {
          try {
            return entry.defaultBaseUrl ? new URL(entry.defaultBaseUrl).hostname.toLowerCase() : null;
          } catch (_e) {
            return null;
          }
        })
        .filter(Boolean),
    );
    const allowed = builtinHosts.has(hostname) || configuredProviderHosts().has(hostname);
    const isAzure = /^[a-z0-9-]+\.openai\.azure\.com$/i.test(hostname);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      (!allowed && !isAzure)
    ) {
      const err = new Error(
        "Provider base URL must use HTTPS and an approved provider hostname.",
      );
      err.code = "INVALID_PROVIDER_BASE_URL";
      throw err;
    }
  }

  return parsed.toString().replace(/\/$/, "");
}

function normalizeOpenAIResponse(data) {
  const msg = data?.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || [])
    .filter((tc) => tc && tc.function && tc.function.name)
    .map((tc, i) => {
      let args = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (_e) {
        args = {};
      }
      return { id: tc.id || `openai-${i + 1}-${Date.now()}`, name: tc.function.name, args };
    });
  const u = data?.usage || {};
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    usage: {
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      totalTokens: u.total_tokens || 0,
    },
  };
}

function normalizeGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let text = "";
  const toolCalls = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.text && !p.thought) text += p.text;
    if (p.functionCall && p.functionCall.name) {
      toolCalls.push({
        id: `gemini-${toolCalls.length + 1}-${Date.now()}`,
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      });
    }
  }
  const u = data?.usageMetadata || {};
  return {
    text,
    toolCalls,
    usage: {
      promptTokens: u.promptTokenCount || 0,
      completionTokens: u.candidatesTokenCount || 0,
      totalTokens: u.totalTokenCount || 0,
    },
  };
}

function normalizeAnthropicResponse(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const toolCalls = blocks
    .filter((block) => block && block.type === "tool_use" && block.name)
    .map((block, i) => ({
      id: block.id || `anthropic-${i + 1}-${Date.now()}`,
      name: block.name,
      args: block.input || {},
    }));
  const u = data?.usage || {};
  return {
    text,
    toolCalls,
    usage: {
      promptTokens: u.input_tokens || 0,
      completionTokens: u.output_tokens || 0,
      totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

// A message's `content` is either a plain string (the original, unchanged
// shape every existing call site uses) or an array of multimodal parts:
//   [{ type: "text", text }, { type: "image", mimeType, data (base64) }]
// isMultimodalContent/isValidContent let every converter accept both shapes
// without disturbing the string path — string-content messages produce the
// exact same output they always did.
function isMultimodalContent(content) {
  return Array.isArray(content) && content.length > 0 &&
    content.every((p) => p && (p.type === "text" || p.type === "image"));
}

function isValidContent(content) {
  return typeof content === "string" || isMultimodalContent(content);
}

function toOpenAIMessages(messages) {
  return (messages || [])
    .filter((m) => m && isValidContent(m.content))
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || m.name || "tool",
          content: typeof m.content === "string" ? m.content : "",
        };
      }
      if (typeof m.content === "string") {
        return { role: m.role, content: m.content };
      }
      // Multimodal: OpenAI-compatible content-parts array.
      // https://platform.openai.com/docs/guides/vision
      const parts = m.content.map((p) => {
        if (p.type === "image") {
          return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
        }
        return { type: "text", text: p.text || "" };
      });
      return { role: m.role, content: parts };
    });
}

function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  for (const m of messages || []) {
    if (!m || !isValidContent(m.content)) continue;
    if (m.role === "system") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId || m.name || "tool",
            content: typeof m.content === "string" ? m.content : "",
          },
        ],
      });
      continue;
    }
    if (typeof m.content === "string") {
      out.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      });
      continue;
    }
    // Multimodal: Anthropic content-blocks array.
    // https://docs.anthropic.com/en/docs/build-with-claude/vision
    const blocks = m.content.map((p) => {
      if (p.type === "image") {
        return {
          type: "image",
          source: { type: "base64", media_type: p.mimeType, data: p.data },
        };
      }
      return { type: "text", text: p.text || "" };
    });
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: blocks });
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

function toGeminiContents(messages) {
  let systemInstruction;
  const contents = [];
  for (const m of messages || []) {
    if (!m || !isValidContent(m.content)) continue;
    if (m.role === "system") {
      if (typeof m.content === "string") systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: m.name || "tool",
              response: { result: typeof m.content === "string" ? m.content : "" },
            },
          },
        ],
      });
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      contents.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    // Multimodal: Gemini inline_data parts.
    const parts = m.content.map((p) => {
      if (p.type === "image") {
        return { inlineData: { mimeType: p.mimeType, data: p.data } };
      }
      return { text: p.text || "" };
    });
    contents.push({ role, parts });
  }
  return { systemInstruction, contents };
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

async function callGemini(config, { messages, tools, generationConfig }, fetchImpl) {
  const fetchFn = resolveFetch(fetchImpl);
  const base = validateProviderBaseUrl(config.providerId || "gemini", config.baseUrl, {
    source: config.source,
  });
  const model = config.model || DEFAULT_GEMINI_MODEL;
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const { systemInstruction, contents } = toGeminiContents(messages);
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const geminiTools = toGeminiTools(tools);
  if (geminiTools) body.tools = geminiTools;
  body.generationConfig = generationConfig || { thinkingConfig: { thinkingBudget: 512 } };

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "x-goog-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`gemini generateContent failed with status ${res.status}`);
    err.status = res.status;
    err.provider = "gemini";
    throw err;
  }
  const data = await res.json();
  return { ...normalizeGeminiResponse(data), model, provider: "gemini" };
}

async function callOpenAICompatible(config, { messages, tools }, fetchImpl) {
  const fetchFn = resolveFetch(fetchImpl);
  const base = validateProviderBaseUrl(config.providerId || "openai", config.baseUrl, {
    source: config.source,
  });
  const url = `${base}/chat/completions`;
  const body = {
    model: config.model || DEFAULT_OPENAI_MODEL,
    messages: toOpenAIMessages(messages),
  };
  const openaiTools = toOpenAITools(tools);
  if (openaiTools) body.tools = openaiTools;

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`openai-compatible chat completions failed with status ${res.status}`);
    err.status = res.status;
    err.provider = "openai-compatible";
    throw err;
  }
  const data = await res.json();
  return { ...normalizeOpenAIResponse(data), model: body.model, provider: "openai-compatible" };
}

async function callAnthropic(config, { messages, tools }, fetchImpl) {
  const fetchFn = resolveFetch(fetchImpl);
  const base = validateProviderBaseUrl(config.providerId || "claude", config.baseUrl, {
    source: config.source,
  });
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const body = {
    model: config.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools) body.tools = anthropicTools;

  const res = await fetchFn(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`anthropic messages failed with status ${res.status}`);
    err.status = res.status;
    err.provider = "anthropic";
    throw err;
  }
  const data = await res.json();
  return { ...normalizeAnthropicResponse(data), model: body.model, provider: "anthropic" };
}

async function generateChatCompletion(config, payload, fetchImpl) {
  if (!config || !config.apiKey) {
    const err = new Error("AI provider not configured for this tenant.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const attempts = Array.isArray(config.fallbacks) && config.fallbacks.length
    ? [config, ...config.fallbacks]
    : [config];
  let lastErr = null;

  for (const attempt of attempts) {
    try {
      if (attempt.family === "gemini") return await callGemini(attempt, payload, fetchImpl);
      if (attempt.family === "openai-compatible") {
        return await callOpenAICompatible(attempt, payload, fetchImpl);
      }
      if (attempt.family === "anthropic") return await callAnthropic(attempt, payload, fetchImpl);
      const err = new Error(`Unsupported AI provider family: ${attempt.family}`);
      err.code = "AI_PROVIDER_UNSUPPORTED";
      throw err;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr;
}

// NOTE: the single mandatory entry point for tenant-facing AI features is
// lib/aiGateway.js's runAiRequest()/runNonTokenAiRequest() — it wraps
// resolveProviderConfig + generateChatCompletion below with unconditional
// LlmCallLog persistence and credit deduction. Route/service/cron code
// should call aiGateway, not resolveProviderConfig/generateChatCompletion
// directly (those stay exported here for aiGateway's own use, and for the
// narrow "test connection" / "discover models" probes that intentionally
// don't spend credits or log task history).

function defaultModelForProvider(providerId) {
  const meta = getProviderMeta(providerId);
  return meta ? meta.defaultModel : DEFAULT_OPENAI_MODEL;
}

async function readByokConfig(tenantId) {
  const raw = await getSetting(tenantId, KEYS.AI_PROVIDER_BYOK_CONFIG, {
    coerce: (value) => value,
    fallback: null,
  });
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || !parsed.providerId || !parsed.apiKey) return null;
    return {
      ...parsed,
      providerId: normalizeProviderId(parsed.providerId),
      apiKey: decrypt(parsed.apiKey),
    };
  } catch (_e) {
    return null;
  }
}

function internalCandidatesForFamily(family) {
  const candidates = [];
  if (family === "gemini" && process.env.GEMINI_API_KEY) {
    candidates.push({
      providerId: "gemini",
      providerLabel: "Google Gemini",
      family: "gemini",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.AI_CRM_GEMINI_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
      baseUrl: process.env.AI_CRM_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
      source: "internal",
    });
  }
  if (family === "openai-compatible" && process.env.OPENAI_API_KEY) {
    candidates.push({
      providerId: "openai",
      providerLabel: "OpenAI",
      family: "openai-compatible",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.AI_CRM_OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      baseUrl: process.env.AI_CRM_OPENAI_BASE_URL || "https://api.openai.com/v1",
      source: "internal",
    });
  }
  if (family === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    candidates.push({
      providerId: "claude",
      providerLabel: "Claude",
      family: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.AI_CRM_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      baseUrl: process.env.AI_CRM_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      source: "internal",
    });
  }
  if (family === "openai-compatible" && process.env.GROQ_API_KEY) {
    candidates.push({
      providerId: "groq",
      providerLabel: "Groq",
      family: "openai-compatible",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.AI_CRM_GROQ_MODEL || "llama-3.3-70b-versatile",
      baseUrl: process.env.AI_CRM_GROQ_BASE_URL || "https://api.groq.com/openai/v1",
      source: "internal",
    });
  }
  return candidates;
}

function requestedFamilyForLabel(modelLabel) {
  const inferred = inferProvider(modelLabel);
  if (inferred === "gemini") return "gemini";
  if (inferred === "anthropic") return "anthropic";
  if (["openai", "groq", "perplexity"].includes(inferred)) return "openai-compatible";
  return "openai-compatible";
}

function publicStatusMessage({ byok, walletState }) {
  if (byok) {
    return "Your organization is using its own AI provider credentials.";
  }
  if (walletState.hasActiveSubscription && walletState.wallet.balanceTokens > 0) {
    return "CRM-managed AI access is active for your organization.";
  }
  if (walletState.hasActiveSubscription && walletState.wallet.balanceTokens <= 0) {
    return "Your AI credits have been exhausted. Purchase a new AI subscription or add your own AI provider API key to continue using AI-powered features.";
  }
  return "Your organization has not configured an AI provider yet.";
}

function publicUnavailableReason(walletState) {
  if (walletState.hasActiveSubscription && walletState.wallet.balanceTokens <= 0) return "CREDITS_EXHAUSTED";
  return "NO_CONFIGURATION";
}

// Resolver priority:
//   1. Tenant's own BYOK credentials (unchanged, highest priority).
//   2. CRM-managed AI — only if the tenant has an ACTIVE AiTenantSubscription
//      AND a positive AiCreditWallet balance. Credit deduction happens
//      AFTER the caller's provider call succeeds (see aiCreditLedger.deductUsage);
//      this function only decides whether to attempt the call at all.
//   3. Neither — return null; callers show the friendly upgrade message.
async function resolveProviderConfig(tenantId, { requestedModelLabel = null } = {}) {
  const byok = await readByokConfig(tenantId);
  if (byok && byok.apiKey) {
    const providerMeta = getProviderMeta(byok.providerId);
    return {
      providerId: providerMeta.id,
      providerLabel: providerMeta.label,
      family: providerMeta.family,
      apiKey: byok.apiKey,
      model: byok.model || defaultModelForProvider(providerMeta.id),
      baseUrl: validateProviderBaseUrl(providerMeta.id, byok.baseUrl, { source: "byok" }),
      source: "byok",
      accessType: "byok",
    };
  }

  const gate = await aiCreditLedger.canUseManagedAi(tenantId);
  if (!gate.allowed) return null;

  const preferredFamily = requestedModelLabel
    ? requestedFamilyForLabel(requestedModelLabel)
    : "openai-compatible";
  const primary = internalCandidatesForFamily(preferredFamily)[0];
  const fallbacks = [
    ...internalCandidatesForFamily("openai-compatible"),
    ...internalCandidatesForFamily("gemini"),
    ...internalCandidatesForFamily("anthropic"),
  ].filter(Boolean);
  if (!primary && fallbacks.length === 0) return null;

  const config = primary || fallbacks[0];
  return {
    ...config,
    source: "internal",
    accessType: "crm-managed",
    fallbacks: fallbacks
      .filter((candidate) => candidate.providerId !== config.providerId || candidate.model !== config.model)
      .map((candidate) => ({ ...candidate, accessType: "crm-managed" })),
  };
}

async function getTenantAiState(tenantId) {
  const [byok, walletState] = await Promise.all([
    readByokConfig(tenantId),
    aiCreditLedger.getWalletState(tenantId),
  ]);

  const resolverAccess = byok
    ? "byok"
    : (walletState.hasActiveSubscription && walletState.wallet.balanceTokens > 0)
      ? "crm-managed"
      : "none";

  return {
    byokConfigured: Boolean(byok && byok.apiKey),
    byok: byok
      ? {
          providerId: byok.providerId,
          providerLabel: getProviderMeta(byok.providerId)?.label || byok.providerId,
          model: byok.model || defaultModelForProvider(byok.providerId),
          baseUrl: byok.baseUrl || null,
          maskedApiKey: maskApiKey(byok.apiKey),
          updatedAt: byok.updatedAt || null,
        }
      : null,
    creditWallet: {
      balanceTokens: walletState.wallet.balanceTokens,
      totalPurchasedTokens: walletState.wallet.totalPurchasedTokens,
      totalUsedTokens: walletState.wallet.totalUsedTokens,
      percentRemaining: walletState.percentRemaining,
      percentUsed: walletState.percentUsed,
    },
    activeSubscription: walletState.activeSubscription
      ? {
          id: walletState.activeSubscription.id,
          planId: walletState.activeSubscription.planId,
          planName: walletState.activeSubscription.planNameSnapshot,
          startDate: walletState.activeSubscription.startDate,
          endDate: walletState.activeSubscription.endDate,
        }
      : null,
    resolverAccess,
    canPurchaseSubscription: !byok,
    friendlyMessage: publicStatusMessage({ byok, walletState }),
    unavailableReason: resolverAccess === "none" ? publicUnavailableReason(walletState) : null,
  };
}

async function testProviderConnection(input, fetchImpl) {
  const providerId = normalizeProviderId(input.providerId || input.provider);
  const meta = getProviderMeta(providerId);
  if (!meta) {
    const err = new Error("Unsupported AI provider.");
    err.code = "AI_PROVIDER_UNSUPPORTED";
    throw err;
  }

  const config = {
    providerId,
    providerLabel: meta.label,
    family: meta.family,
    apiKey: String(input.apiKey || "").trim(),
    model: String(input.model || "").trim() || meta.defaultModel,
    baseUrl: validateProviderBaseUrl(providerId, input.baseUrl, { source: "ad-hoc" }),
    source: "ad-hoc",
  };
  const started = Date.now();
  const response = await generateChatCompletion(
    config,
    { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
    fetchImpl,
  );
  return {
    ok: true,
    providerId,
    providerLabel: meta.label,
    family: meta.family,
    model: response.model || config.model,
    latencyMs: Date.now() - started,
    sample: (response.text || "").slice(0, 80),
  };
}

async function discoverModels(input, fetchImpl) {
  const fetchFn = resolveFetch(fetchImpl);
  const providerId = normalizeProviderId(input.providerId || input.provider);
  const meta = getProviderMeta(providerId);
  if (!meta) {
    const err = new Error("Unsupported AI provider.");
    err.code = "AI_PROVIDER_UNSUPPORTED";
    throw err;
  }
  const apiKey = String(input.apiKey || "").trim();
  if (!apiKey) {
    const err = new Error("apiKey is required");
    err.code = "MISSING_API_KEY";
    throw err;
  }
  const baseUrl = validateProviderBaseUrl(providerId, input.baseUrl, { source: "ad-hoc" });

  if (meta.family === "gemini") {
    const res = await fetchFn(`${baseUrl}/v1beta/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-goog-api-key": apiKey,
      },
    });
    if (!res.ok) {
      const err = new Error(`Model discovery failed (${res.status})`);
      err.code = "MODEL_DISCOVERY_FAILED";
      throw err;
    }
    const data = await res.json();
    return (data.models || [])
      .map((row) => row.name || "")
      .map((name) => name.replace(/^models\//, ""))
      .filter(Boolean);
  }

  if (meta.family === "anthropic") {
    const res = await fetchFn(`${baseUrl}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) {
      const err = new Error(`Model discovery failed (${res.status})`);
      err.code = "MODEL_DISCOVERY_FAILED";
      throw err;
    }
    const data = await res.json();
    return (data.data || []).map((row) => row.id).filter(Boolean);
  }

  const res = await fetchFn(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const err = new Error(`Model discovery failed (${res.status})`);
    err.code = "MODEL_DISCOVERY_FAILED";
    throw err;
  }
  const data = await res.json();
  return (data.data || []).map((row) => row.id).filter(Boolean);
}

async function saveByokConfig({
  tenantId,
  actorUserId,
  providerId,
  apiKey,
  model,
  baseUrl,
  providerName = "",
}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const meta = getProviderMeta(normalizedProviderId);
  if (!meta) {
    const err = new Error("Unsupported AI provider.");
    err.code = "AI_PROVIDER_UNSUPPORTED";
    throw err;
  }
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error("apiKey is required");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const stored = await readByokConfig(tenantId);
  const finalKey = String(apiKey).trim().includes("...") && stored ? stored.apiKey : String(apiKey).trim();
  const finalBaseUrl = validateProviderBaseUrl(normalizedProviderId, baseUrl, { source: "byok" });
  const payload = {
    providerId: normalizedProviderId,
    providerName: providerName || meta.label,
    family: meta.family,
    apiKey: encrypt(finalKey),
    model: String(model || "").trim() || defaultModelForProvider(normalizedProviderId),
    baseUrl: finalBaseUrl,
    updatedAt: new Date().toISOString(),
  };

  await setSetting(
    tenantId,
    KEYS.AI_PROVIDER_BYOK_CONFIG,
    JSON.stringify(payload),
    { category: BYOK_CATEGORY },
  );
  await writeAudit(
    "TenantSetting",
    stored ? "UPDATE" : "CREATE",
    null,
    actorUserId,
    tenantId,
    {
      key: KEYS.AI_PROVIDER_BYOK_CONFIG,
      providerId: normalizedProviderId,
      providerName: payload.providerName,
      model: payload.model,
      maskedApiKey: maskApiKey(finalKey),
    },
  );

  return {
    configured: true,
    providerId: normalizedProviderId,
    providerLabel: meta.label,
    model: payload.model,
    baseUrl: payload.baseUrl,
    maskedApiKey: maskApiKey(finalKey),
    updatedAt: payload.updatedAt,
  };
}

async function removeByokConfig({ tenantId, actorUserId }) {
  await prisma.tenantSetting.deleteMany({
    where: { tenantId, key: KEYS.AI_PROVIDER_BYOK_CONFIG },
  });
  await writeAudit("TenantSetting", "DELETE", null, actorUserId, tenantId, {
    key: KEYS.AI_PROVIDER_BYOK_CONFIG,
  });
}

async function notifyTenantAdmins(tenantId, title, message, link = "/settings") {
  const admins = await prisma.user.findMany({
    where: { tenantId, role: "ADMIN" },
    select: { id: true },
    take: 25,
  });
  if (!admins.length) return;
  await prisma.notification.createMany({
    data: admins.map((admin) => ({
      tenantId,
      userId: admin.id,
      title,
      message,
      type: "system",
      priority: "high",
      link,
      entityType: "ai-management",
    })),
  });
}

// Tenant ADMIN cancels their own active CRM-managed AI subscription.
// Cancelling does NOT claw back the remaining credit balance — the tenant
// keeps whatever balance is left (consistent with subscriptions.js's
// platform-billing cancel semantics), it just stops the plan from
// auto-implying "active access" for future purchases/renewal UI.
async function cancelTenantSubscription({ tenantId, actorUserId }) {
  const subscription = await prisma.aiTenantSubscription.findFirst({
    where: { tenantId, status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!subscription) {
    const err = new Error("No active AI subscription to cancel.");
    err.code = "NO_ACTIVE_SUBSCRIPTION";
    throw err;
  }
  const updated = await prisma.aiTenantSubscription.update({
    where: { id: subscription.id },
    data: { status: "CANCELLED" },
  });
  await writeAudit("AiTenantSubscription", "CANCEL", subscription.id, actorUserId, tenantId, {
    planId: subscription.planId,
  });
  await notifyTenantAdmins(
    tenantId,
    "CRM AI subscription cancelled",
    "Your CRM-managed AI subscription has been cancelled. Any remaining credit balance stays available until used.",
  );
  return updated;
}

// Super Admin manual credit grant/correction — audited, never touches
// provider usage metadata (that's only recorded by aiCreditLedger.deductUsage
// off real AI request usage).
async function superAdminAdjustCredits({ tenantId, superAdminUsername, tokens, direction, reason = "" }) {
  const amount = Number(tokens);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("tokens must be a positive number.");
    err.code = "INVALID_ADJUSTMENT";
    throw err;
  }
  const result = direction === "debit"
    ? await aiCreditLedger.debitAdjustment({ tenantId, tokens: amount, performedBySuperAdmin: superAdminUsername, reason })
    : await aiCreditLedger.creditTokens({ tenantId, tokens: amount, type: "ADJUSTMENT", performedBySuperAdmin: superAdminUsername, reason });
  await writeAudit("AiCreditWallet", "SUPER_ADMIN_ADJUSTMENT", result.wallet.id, null, tenantId, {
    direction: direction === "debit" ? "debit" : "credit",
    tokens: amount,
    reason,
    performedBySuperAdmin: superAdminUsername,
    newBalance: result.wallet.balanceTokens,
  });
  return result;
}

// Super Admin suspends/resumes a tenant's CRM-managed AI access without
// touching their credit balance — e.g. abuse/fraud hold. Suspension is
// modeled as flipping the active subscription to CANCELLED (resolver then
// naturally falls through to "no active subscription"); resume re-activates
// the most recent CANCELLED subscription that hasn't expired.
async function superAdminSetSubscriptionStatus({ tenantId, superAdminUsername, action }) {
  if (action === "suspend") {
    const active = await prisma.aiTenantSubscription.findFirst({
      where: { tenantId, status: "ACTIVE" },
      orderBy: { startDate: "desc" },
    });
    if (!active) {
      const err = new Error("Tenant has no active AI subscription to suspend.");
      err.code = "NO_ACTIVE_SUBSCRIPTION";
      throw err;
    }
    const updated = await prisma.aiTenantSubscription.update({
      where: { id: active.id },
      data: { status: "CANCELLED" },
    });
    await writeAudit("AiTenantSubscription", "SUPER_ADMIN_SUSPEND", active.id, null, tenantId, { superAdminUsername });
    await notifyTenantAdmins(tenantId, "CRM AI access suspended", "Your CRM-managed AI access has been suspended by the platform administrator.");
    return updated;
  }

  if (action === "resume") {
    const latestCancelled = await prisma.aiTenantSubscription.findFirst({
      where: { tenantId, status: "CANCELLED", OR: [{ endDate: null }, { endDate: { gt: new Date() } }] },
      orderBy: { startDate: "desc" },
    });
    if (!latestCancelled) {
      const err = new Error("Tenant has no eligible AI subscription to resume.");
      err.code = "NO_ELIGIBLE_SUBSCRIPTION";
      throw err;
    }
    const updated = await prisma.aiTenantSubscription.update({
      where: { id: latestCancelled.id },
      data: { status: "ACTIVE" },
    });
    await writeAudit("AiTenantSubscription", "SUPER_ADMIN_RESUME", latestCancelled.id, null, tenantId, { superAdminUsername });
    await notifyTenantAdmins(tenantId, "CRM AI access resumed", "Your CRM-managed AI access has been resumed by the platform administrator.");
    return updated;
  }

  const err = new Error("Unsupported action; expected 'suspend' or 'resume'.");
  err.code = "UNSUPPORTED_ACTION";
  throw err;
}

function normalizeAnalyticsDate(value, boundary = "start") {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const plainDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  let parsed;
  if (plainDate) {
    const [, year, month, day] = plainDate;
    parsed = new Date(
      boundary === "end"
        ? Date.UTC(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
        : Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0),
    );
  } else {
    parsed = new Date(raw);
  }

  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

function buildLlmUsageSummary(rows) {
  const summary = {
    totalRequests: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    averageTokens: 0,
    maxTokens: 0,
    lastActivityAt: null,
    activeDays: 0,
    activeMonths: 0,
    dailyAverageHits: 0,
    monthlyAverageHits: 0,
    providerBreakdown: [],
    taskBreakdown: [],
    modelBreakdown: [],
    daily: [],
  };

  const activeDaySet = new Set();
  const activeMonthSet = new Set();
  const providerMap = new Map();
  const taskMap = new Map();
  const modelMap = new Map();
  const dailyMap = new Map();

  for (const row of rows || []) {
    const promptTokens = Number(row.promptTokens || 0);
    const completionTokens = Number(row.completionTokens || 0);
    const rawTotalTokens = Number(row.totalTokens || 0);
    const effectiveTotalTokens = Math.max(rawTotalTokens, promptTokens + completionTokens);
    const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    const dayKey = Number.isFinite(createdAt.getTime()) ? createdAt.toISOString().slice(0, 10) : "unknown";
    const monthKey = dayKey !== "unknown" ? dayKey.slice(0, 7) : "unknown";

    summary.totalRequests += 1;
    summary.totalTokens += effectiveTotalTokens;
    summary.promptTokens += promptTokens;
    summary.completionTokens += completionTokens;
    summary.maxTokens = Math.max(summary.maxTokens, effectiveTotalTokens);
    if (!summary.lastActivityAt || createdAt > summary.lastActivityAt) {
      summary.lastActivityAt = createdAt;
    }
    if (dayKey !== "unknown") activeDaySet.add(dayKey);
    if (monthKey !== "unknown") activeMonthSet.add(monthKey);

    const providerKey = row.provider || "unknown";
    const providerBucket = providerMap.get(providerKey) || { provider: providerKey, requests: 0, totalTokens: 0 };
    providerBucket.requests += 1;
    providerBucket.totalTokens += effectiveTotalTokens;
    providerMap.set(providerKey, providerBucket);

    const taskKey = row.task || "unknown";
    const taskBucket = taskMap.get(taskKey) || { task: taskKey, requests: 0, totalTokens: 0 };
    taskBucket.requests += 1;
    taskBucket.totalTokens += effectiveTotalTokens;
    taskMap.set(taskKey, taskBucket);

    const modelKey = row.model || "unknown";
    const modelBucket = modelMap.get(modelKey) || { model: modelKey, requests: 0, totalTokens: 0 };
    modelBucket.requests += 1;
    modelBucket.totalTokens += effectiveTotalTokens;
    modelMap.set(modelKey, modelBucket);

    const dailyBucket = dailyMap.get(dayKey) || {
      date: dayKey,
      requests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
    dailyBucket.requests += 1;
    dailyBucket.totalTokens += effectiveTotalTokens;
    dailyBucket.promptTokens += promptTokens;
    dailyBucket.completionTokens += completionTokens;
    dailyMap.set(dayKey, dailyBucket);
  }

  summary.averageTokens = summary.totalRequests ? Math.round(summary.totalTokens / summary.totalRequests) : 0;
  summary.activeDays = activeDaySet.size;
  summary.activeMonths = activeMonthSet.size;
  summary.dailyAverageHits = summary.activeDays ? Number((summary.totalRequests / summary.activeDays).toFixed(2)) : 0;
  summary.monthlyAverageHits = summary.activeMonths ? Number((summary.totalRequests / summary.activeMonths).toFixed(2)) : 0;
  summary.providerBreakdown = Array.from(providerMap.values()).sort((a, b) => b.requests - a.requests);
  summary.taskBreakdown = Array.from(taskMap.values()).sort((a, b) => b.requests - a.requests);
  summary.modelBreakdown = Array.from(modelMap.values())
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 10);
  summary.daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  return summary;
}

async function getSuperAdminTenantOverview(options = {}) {
  const from = normalizeAnalyticsDate(options.from, "start");
  const to = normalizeAnalyticsDate(options.to, "end");
  const search = String(options.search || "").trim().toLowerCase();
  const requestStatusFilter = String(options.requestStatus || "all").trim().toLowerCase();

  const where = {};
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lte = to;
  }

  const [tenants, rows] = await Promise.all([
    prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        ownerEmail: true,
        createdAt: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.llmCallLog.findMany({
      where,
      select: {
        tenantId: true,
        totalTokens: true,
        promptTokens: true,
        completionTokens: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20000,
    }),
  ]);

  const usageByTenant = new Map();
  for (const row of rows) {
    const bucket = usageByTenant.get(row.tenantId) || {
      totalRequests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      maxTokens: 0,
      activeDays: new Set(),
      activeMonths: new Set(),
      lastActivityAt: null,
    };
    const promptTokens = Number(row.promptTokens || 0);
    const completionTokens = Number(row.completionTokens || 0);
    const rawTotalTokens = Number(row.totalTokens || 0);
    const effectiveTotalTokens = Math.max(rawTotalTokens, promptTokens + completionTokens);
    bucket.totalRequests += 1;
    bucket.totalTokens += effectiveTotalTokens;
    bucket.promptTokens += promptTokens;
    bucket.completionTokens += completionTokens;
    bucket.maxTokens = Math.max(bucket.maxTokens, effectiveTotalTokens);
    if (row.createdAt) {
      const isoDate = row.createdAt.toISOString().slice(0, 10);
      bucket.activeDays.add(isoDate);
      bucket.activeMonths.add(isoDate.slice(0, 7));
      if (!bucket.lastActivityAt || row.createdAt > bucket.lastActivityAt) {
        bucket.lastActivityAt = row.createdAt;
      }
    }
    usageByTenant.set(row.tenantId, bucket);
  }

  const results = [];
  for (const tenant of tenants) {
    const [byok, walletState] = await Promise.all([
      readByokConfig(tenant.id),
      aiCreditLedger.getWalletState(tenant.id),
    ]);
    const usage = usageByTenant.get(tenant.id) || {
      totalRequests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      maxTokens: 0,
      activeDays: new Set(),
      activeMonths: new Set(),
      lastActivityAt: null,
    };
    const requestStatus = walletState.hasActiveSubscription ? CRM_STATUS.ACTIVE : CRM_STATUS.NONE;
    const row = {
      tenantId: tenant.id,
      organization: tenant.name,
      slug: tenant.slug,
      status: tenant.isActive ? "active" : "disabled",
      ownApiKey: Boolean(byok && byok.apiKey),
      crmAiEnabled: walletState.hasActiveSubscription,
      requestStatus,
      subscription: walletState.activeSubscription
        ? {
            planId: walletState.activeSubscription.planId,
            planName: walletState.activeSubscription.planNameSnapshot,
            endDate: walletState.activeSubscription.endDate,
          }
        : null,
      credits: {
        balanceTokens: walletState.wallet.balanceTokens,
        totalPurchasedTokens: walletState.wallet.totalPurchasedTokens,
        totalUsedTokens: walletState.wallet.totalUsedTokens,
        percentRemaining: walletState.percentRemaining,
      },
      monthlyUsage: usage.totalRequests,
      averageTokens: usage.totalRequests ? Math.round(usage.totalTokens / usage.totalRequests) : 0,
      maxTokens: usage.maxTokens,
      activeDays: usage.activeDays.size,
      activeMonths: usage.activeMonths.size,
      dailyAverageHits: usage.activeDays.size ? Number((usage.totalRequests / usage.activeDays.size).toFixed(2)) : 0,
      monthlyAverageHits: usage.activeMonths.size ? Number((usage.totalRequests / usage.activeMonths.size).toFixed(2)) : 0,
      lastActivityAt: usage.lastActivityAt,
      totalTokens: usage.totalTokens,
      ownerEmail: tenant.ownerEmail || null,
      createdAt: tenant.createdAt,
    };

    if (requestStatusFilter !== "all" && row.requestStatus !== requestStatusFilter) continue;
    if (search) {
      const haystack = [row.organization, row.slug, row.ownerEmail, String(row.tenantId)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    results.push(row);
  }

  return {
    tenants: results,
    summary: {
      totalTenants: results.length,
      activeRequestCount: results.filter((tenant) => tenant.requestStatus && tenant.requestStatus !== CRM_STATUS.NONE).length,
      crmEnabledCount: results.filter((tenant) => tenant.crmAiEnabled).length,
      byokCount: results.filter((tenant) => tenant.ownApiKey).length,
    },
    appliedFilters: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      search: search || "",
      requestStatus: requestStatusFilter || "all",
    },
  };
}

async function getSuperAdminTenantDetail(tenantId, options = {}) {
  const from = normalizeAnalyticsDate(options.from, "start");
  const to = normalizeAnalyticsDate(options.to, "end");

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      isActive: true,
      ownerEmail: true,
      createdAt: true,
    },
  });
  if (!tenant) {
    const err = new Error("Tenant not found");
    err.code = "TENANT_NOT_FOUND";
    throw err;
  }

  const where = { tenantId };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lte = to;
  }

  const [walletState, byok, rows, recentTransactions] = await Promise.all([
    aiCreditLedger.getWalletState(tenantId),
    readByokConfig(tenantId),
    prisma.llmCallLog.findMany({
      where,
      select: {
        id: true,
        task: true,
        model: true,
        provider: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        status: true,
        stub: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 10000,
    }),
    prisma.aiCreditTransaction.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const usage = buildLlmUsageSummary(rows);
  return {
    tenantId: tenant.id,
    organization: tenant.name,
    slug: tenant.slug,
    status: tenant.isActive ? "active" : "disabled",
    ownerEmail: tenant.ownerEmail || null,
    createdAt: tenant.createdAt,
    ownApiKey: Boolean(byok && byok.apiKey),
    crmAiEnabled: walletState.hasActiveSubscription,
    requestStatus: walletState.hasActiveSubscription ? CRM_STATUS.ACTIVE : CRM_STATUS.NONE,
    subscription: walletState.activeSubscription
      ? {
          id: walletState.activeSubscription.id,
          planId: walletState.activeSubscription.planId,
          planName: walletState.activeSubscription.planNameSnapshot,
          startDate: walletState.activeSubscription.startDate,
          endDate: walletState.activeSubscription.endDate,
        }
      : null,
    credits: {
      balanceTokens: walletState.wallet.balanceTokens,
      totalPurchasedTokens: walletState.wallet.totalPurchasedTokens,
      totalUsedTokens: walletState.wallet.totalUsedTokens,
      percentRemaining: walletState.percentRemaining,
    },
    recentTransactions,
    byok: byok
      ? {
          providerId: byok.providerId,
          providerName: byok.providerName,
          model: byok.model,
          updatedAt: byok.updatedAt || null,
        }
      : null,
    usage,
    appliedFilters: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    },
  };
}

module.exports = {
  CRM_STATUS,
  PROVIDER_CATALOG,
  DEFAULT_GEMINI_MODEL,
  maskApiKey,
  validateProviderBaseUrl,
  normalizeOpenAIResponse,
  normalizeGeminiResponse,
  toGeminiContents,
  toOpenAIMessages,
  generateChatCompletion,
  resolveProviderConfig,
  getTenantAiState,
  readByokConfig,
  saveByokConfig,
  removeByokConfig,
  cancelTenantSubscription,
  superAdminAdjustCredits,
  superAdminSetSubscriptionStatus,
  getSuperAdminTenantOverview,
  getSuperAdminTenantDetail,
  testProviderConnection,
  discoverModels,
  requestedFamilyForLabel,
};

