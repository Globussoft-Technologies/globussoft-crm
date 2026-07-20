/**
 * supportChatbot/providerAdapters — LLM provider abstraction for the
 * Wellness Admin Support Chatbot.
 *
 * Two provider families are supported, normalised to ONE internal shape:
 *
 *   - "gemini"            — Google generateContent REST shape. Used by the
 *                           internal Gemini proxy (see gemini-central-docs.md)
 *                           AND by a tenant's own Google AI Studio key (BYOK),
 *                           since the proxy is wire-compatible with the public
 *                           v1beta API. Endpoint:
 *                           POST {baseUrl}/v1beta/models/{model}:generateContent
 *                           Headers: Authorization: Bearer <key>,
 *                                    x-goog-api-key: <key>
 *   - "openai-compatible" — any OpenAI Chat Completions-shaped endpoint
 *                           (OpenAI, Azure OpenAI, Groq, OpenRouter, …).
 *                           Endpoint: POST {baseUrl}/chat/completions
 *                           Header: Authorization: Bearer <key>
 *
 * Normalised response envelope (both families):
 *   {
 *     text:      string,                          // assistant prose (may be "")
 *     toolCalls: [{ id, name, args }],            // [] when the model just answered
 *     usage:     { promptTokens, completionTokens, totalTokens },
 *   }
 *
 * Canonical message format (provider-neutral, OpenAI-flavoured):
 *   { role: "system" | "user" | "assistant" | "tool",
 *     content: string,
 *     // tool-result messages only:
 *     name?: string,        // tool name that produced this result
 *     toolCallId?: string } // correlates to the toolCall.id we issued
 *
 * Security contract:
 *   - API keys NEVER appear in logs, thrown error messages, or return values.
 *   - maskApiKey() is the only way a key is ever surfaced (GET config route).
 */

const { getSetting, KEYS } = require("../../lib/tenantSettings");
const { decrypt } = require("../../lib/fieldEncryption");
const { inferProvider } = require("../../lib/apiPricing");

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GEMINI_PUBLIC_BASE_URL = "https://generativelanguage.googleapis.com";

const BUILTIN_PROVIDER_HOSTS = {
  gemini: new Set([
    "generativelanguage.googleapis.com",
    "gemini-central-beta-v1-pn-ds-01.poweradspy.ai",
  ]),
  "openai-compatible": new Set([
    "api.openai.com",
    "openrouter.ai",
    "api.together.xyz",
    "api.groq.com",
  ]),
};

function configuredProviderHosts() {
  return new Set(
    String(process.env.WELLNESS_AI_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean),
  );
}

/**
 * Validate tenant-controlled provider endpoints before a credential is sent.
 * Exact custom hosts can be enabled by the deployment through
 * WELLNESS_AI_ALLOWED_HOSTS. Paths are supported, but credentials, ports,
 * fragments, non-HTTPS schemes, IP literals and unapproved hosts are not.
 */
function validateProviderBaseUrl(provider, baseUrl, { source = "byok" } = {}) {
  const defaultUrl =
    provider === "gemini"
      ? DEFAULT_GEMINI_PUBLIC_BASE_URL
      : provider === "openai-compatible"
        ? DEFAULT_OPENAI_BASE_URL
        : null;
  if (!defaultUrl) {
    const err = new Error("Unsupported AI provider.");
    err.code = "AI_PROVIDER_UNSUPPORTED";
    throw err;
  }

  const raw = String(baseUrl || defaultUrl).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_e) {
    const err = new Error("Provider base URL is invalid.");
    err.code = "INVALID_PROVIDER_BASE_URL";
    throw err;
  }

  // The internal proxy URL is deployment-controlled, not tenant-controlled.
  // Keep supporting local development proxies while validating every BYOK
  // and ad-hoc URL that can be supplied through the API.
  if (source !== "internal") {
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const builtins = BUILTIN_PROVIDER_HOSTS[provider] || new Set();
    const isAzureOpenAI =
      provider === "openai-compatible" && /^[a-z0-9-]+\.openai\.azure\.com$/.test(hostname);
    const allowed = builtins.has(hostname) || isAzureOpenAI || configuredProviderHosts().has(hostname);

    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      !allowed
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

// Fetch injection point: tests stub the HTTP layer without module mocks.
// Callers may pass an explicit fetchImpl; otherwise we use globalThis.fetch.
function resolveFetch(fetchImpl) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") {
    throw new Error("No fetch implementation available (Node 18+ required).");
  }
  return impl;
}

/**
 * maskApiKey — the ONLY representation of a key allowed to leave the
 * backend. "sk-abc123456789" → "sk-...6789". Short keys mask fully.
 */
function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

// ─── Response normalisers ─────────────────────────────────────────────

/**
 * Gemini generateContent → normalised envelope.
 * Text parts with `thought: true` are chain-of-thought and MUST be dropped
 * (mirrors the Go/Python/Node examples in gemini-central-docs.md). Function
 * calls arrive as parts[].functionCall {name, args}; we synthesise a stable
 * id since Gemini doesn't issue one (OpenAI does — the tool loop correlates
 * results by id).
 */
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

/**
 * OpenAI Chat Completions → normalised envelope.
 * Tool calls arrive as message.tool_calls[] with function.arguments as a
 * JSON STRING — parse failures degrade to {} rather than throwing (a
 * malformed args blob shouldn't kill the whole chat turn).
 */
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

// ─── Message translators (canonical → provider wire shape) ────────────

/**
 * Canonical messages → Gemini { systemInstruction, contents }.
 *   system    → systemInstruction.parts[0].text (Gemini has no system role
 *               inside contents)
 *   user      → { role: "user",  parts: [{ text }] }
 *   assistant → { role: "model", parts: [{ text }] }
 *   tool      → { role: "function", parts: [{ functionResponse:
 *               { name, response } }] } — per gemini-central-docs.md the
 *               function-response role is literally "function".
 */
function toGeminiContents(messages) {
  let systemInstruction;
  const contents = [];
  for (const m of messages || []) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
    } else if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: m.content }] });
    } else if (m.role === "tool") {
      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: m.name || "tool",
              response: { result: m.content },
            },
          },
        ],
      });
    }
  }
  return { systemInstruction, contents };
}

/**
 * Canonical messages → OpenAI messages. Tool results map to
 * { role: "tool", tool_call_id, content }. Assistant tool-call turns are
 * NOT replayed (the orchestrator only appends tool RESULTS, never the raw
 * assistant tool_calls turn) so the history stays text + tool rows.
 */
function toOpenAIMessages(messages) {
  return (messages || [])
    .filter((m) => m && typeof m.content === "string")
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || m.name || "tool",
          content: m.content,
        };
      }
      return { role: m.role, content: m.content };
    });
}

// ─── Tool schema translators ──────────────────────────────────────────
// Canonical tool definition: { name, description, parameters(JSON Schema) }.

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

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ─── Raw provider calls ───────────────────────────────────────────────

/**
 * Gemini generateContent call. Works against BOTH the internal proxy
 * (GEMINI_PROXY_BASE_URL) and the public Google endpoint — same wire
 * shape, same dual-header auth (gemini-central-docs.md sends both
 * Authorization: Bearer and x-goog-api-key for compatibility).
 */
async function callGemini(config, { messages, tools, generationConfig }, fetchImpl) {
  const fetchFn = resolveFetch(fetchImpl);
  const base = validateProviderBaseUrl("gemini", config.baseUrl, { source: config.source });
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
    // Status + provider only — the response body could echo request
    // material, and the key itself is never logged anywhere in this file.
    const err = new Error(`gemini generateContent failed with status ${res.status}`);
    err.status = res.status;
    err.provider = "gemini";
    throw err;
  }
  const data = await res.json();
  return { ...normalizeGeminiResponse(data), model, provider: "gemini" };
}

/** OpenAI-compatible Chat Completions call. */
async function callOpenAICompatible(config, { messages, tools }, fetchImpl) {
  const fetchFn = resolveFetch(fetchImpl);
  const base = validateProviderBaseUrl("openai-compatible", config.baseUrl, {
    source: config.source,
  });
  const model = config.model;
  const url = `${base}/chat/completions`;

  const body = {
    model,
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
  return { ...normalizeOpenAIResponse(data), model, provider: "openai-compatible" };
}

/**
 * Provider dispatch. `config` is the resolved provider config from
 * resolveProviderConfig(). Returns the normalised envelope + echoes the
 * model/provider actually used (needed for LlmCallLog rows).
 */
async function generateChatCompletion(config, payload, fetchImpl) {
  if (!config || !config.apiKey) {
    const err = new Error("AI provider not configured for this tenant.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  if (config.provider === "gemini") return callGemini(config, payload, fetchImpl);
  if (config.provider === "openai-compatible") return callOpenAICompatible(config, payload, fetchImpl);
  const err = new Error(`Unsupported AI provider: ${config.provider}`);
  err.code = "AI_PROVIDER_UNSUPPORTED";
  throw err;
}

// ─── Config resolution (BYOK → dev fallback) ──────────────────────────

const SUPPORTED_PROVIDERS = ["gemini", "openai-compatible"];

/**
 * resolveProviderConfig(tenantId) →
 *   { provider, apiKey, model, baseUrl, source: "byok" | "internal" } | null
 *
 * Lookup chain:
 *   1. TenantSetting row wellness.aiProviderConfig (JSON, apiKey encrypted
 *      at rest via lib/fieldEncryption — decrypt() is a no-op passthrough
 *      when WELLNESS_FIELD_KEY isn't set, so dev stacks still work).
 *   2. Non-production only: internal Gemini proxy env vars
 *      (GEMINI_PROXY_BASE_URL / GEMINI_PROXY_API_KEY), per the project
 *      convention that dev/staging tenants can ride the shared proxy.
 *   3. Production without BYOK → null (route layer turns this into a
 *      friendly "AI provider not configured" response).
 */
async function resolveProviderConfig(tenantId) {
  const raw = await getSetting(tenantId, KEYS.WELLNESS_AI_PROVIDER_CONFIG, {
    coerce: (v) => v,
    fallback: null,
  });
  if (raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && SUPPORTED_PROVIDERS.includes(parsed.provider) && parsed.apiKey) {
        const apiKey = decrypt(parsed.apiKey);
        return {
          provider: parsed.provider,
          apiKey,
          model: parsed.model || (parsed.provider === "gemini" ? DEFAULT_GEMINI_MODEL : null),
          baseUrl: parsed.baseUrl || null,
          source: "byok",
        };
      }
    } catch (_e) {
      // Corrupt JSON / undecryptable key — fall through to the env fallback
      // rather than hard-failing the whole chat surface.
    }
  }

  if (process.env.NODE_ENV !== "production" && process.env.GEMINI_PROXY_API_KEY) {
    return {
      provider: "gemini",
      apiKey: process.env.GEMINI_PROXY_API_KEY,
      model: process.env.GEMINI_PROXY_MODEL || DEFAULT_GEMINI_MODEL,
      baseUrl: process.env.GEMINI_PROXY_BASE_URL || null,
      source: "internal",
    };
  }
  return null;
}

/**
 * providerFamilyFor — label for LlmCallLog.provider. BYOK provider names
 * ("gemini", "openai-compatible") already line up with the pricing lib's
 * family tokens; model-based inference is the fallback.
 */
function providerFamilyFor(config) {
  if (!config) return "unknown";
  if (config.provider === "gemini") return "gemini";
  if (config.provider === "openai-compatible") return "openai";
  return inferProvider(config.model);
}

module.exports = {
  SUPPORTED_PROVIDERS,
  DEFAULT_GEMINI_MODEL,
  validateProviderBaseUrl,
  maskApiKey,
  normalizeGeminiResponse,
  normalizeOpenAIResponse,
  toGeminiContents,
  toOpenAIMessages,
  generateChatCompletion,
  resolveProviderConfig,
  providerFamilyFor,
};
