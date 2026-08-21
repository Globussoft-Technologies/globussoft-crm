/**
 * brochureEngineProviderEnv.js — map a resolved CRM AI provider config to the
 * environment variables the agentic brochure engine (agentic-orchcrm) expects.
 *
 * The engine is a separate TypeScript process that reads its own .env / inherited
 * environment. To make it obey the tenant's CRM AI Settings (BYOK or CRM-managed),
 * we blank out every provider key the engine understands and inject only the
 * active provider's credentials plus PROVIDER_OVERRIDE so the engine's priority
 * order does not silently switch to a different provider.
 */

const ENGINE_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "MOONSHOT_API_KEY",
  "XAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "PROVIDER_OVERRIDE",
];

const ENGINE_MODEL_KEYS = [
  "MODEL_REASONING",
  "MODEL_BALANCED",
  "MODEL_FAST",
  "MODEL_WRITING",
];

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Normalize a Gemini base URL to the OpenAI-compatible endpoint the engine uses.
 * The CRM stores the native Gemini endpoint (https://generativelanguage.googleapis.com)
 * for its own generateContent calls; the engine's OpenAI-compatible adapter needs
 * the /v1beta/openai path. If the URL already contains /openai, assume the user set
 * the correct endpoint and leave it unchanged.
 */
function geminiOpenAiBaseUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return GEMINI_OPENAI_BASE_URL;
  if (/\/openai/i.test(raw)) return raw.replace(/\/+$/, "");
  return raw.replace(/\/+$/, "") + "/v1beta/openai";
}

/**
 * Build an engine env map from a resolved provider config.
 *
 * @param {object|null} config  Result of aiProviderManagement.resolveProviderConfig()
 * @returns {object|null}       Env vars to merge into the engine subprocess env,
 *                               or null if no provider config is available.
 */
function buildEngineEnv(config) {
  if (!config || !config.apiKey) return null;

  const env = {};
  for (const key of ENGINE_PROVIDER_KEYS) {
    env[key] = "";
  }
  // Blank out the engine's .env model defaults so a forced provider is never
  // left pointing at a model id that belongs to a different host (e.g. an
  // OpenAI-only plan showing "openai/gpt-oss-120b" which is a Groq-hosted id).
  for (const key of ENGINE_MODEL_KEYS) {
    env[key] = "";
  }

  const { providerId, apiKey, baseUrl, model } = config;

  if (providerId === "openai") {
    env.OPENAI_API_KEY = apiKey;
    env.PROVIDER_OVERRIDE = "openai";
  } else if (providerId === "groq") {
    env.GROQ_API_KEY = apiKey;
    env.PROVIDER_OVERRIDE = "groq";
  } else if (providerId === "moonshot") {
    env.MOONSHOT_API_KEY = apiKey;
    if (baseUrl) env.MOONSHOT_BASE_URL = baseUrl;
    env.PROVIDER_OVERRIDE = "moonshot";
  } else if (providerId === "xai") {
    env.XAI_API_KEY = apiKey;
    if (baseUrl) env.XAI_BASE_URL = baseUrl;
    env.PROVIDER_OVERRIDE = "xai";
  } else if (providerId === "claude") {
    env.ANTHROPIC_API_KEY = apiKey;
    env.PROVIDER_OVERRIDE = "anthropic";
  } else if (providerId === "gemini") {
    // The engine has no native Gemini adapter; route it through the OpenAI-compatible slot.
    env.OPENAI_COMPATIBLE_API_KEY = apiKey;
    env.OPENAI_COMPATIBLE_BASE_URL = geminiOpenAiBaseUrl(baseUrl);
    env.PROVIDER_OVERRIDE = "openai-compatible";
  } else {
    // All other BYOK choices (deepseek, mistral, openrouter, cohere, azure-openai, other)
    // are OpenAI-compatible providers. The engine resolves the logical provider from the URL.
    env.OPENAI_COMPATIBLE_API_KEY = apiKey;
    if (baseUrl) env.OPENAI_COMPATIBLE_BASE_URL = baseUrl;
    env.PROVIDER_OVERRIDE = "openai-compatible";
  }

  // Force every tier to the model the CRM resolver chose (BYOK or CRM-managed).
  // The engine's own .env defaults are blanked above; this makes the brochure
  // engine fully follow the tenant's AI Settings instead of falling back to
  // whatever model ids happen to be in agentic-orchcrm/.env.
  const resolvedModel = model || "";
  if (resolvedModel) {
    for (const key of ENGINE_MODEL_KEYS) {
      env[key] = resolvedModel;
    }
  }

  return env;
}

module.exports = {
  buildEngineEnv,
  ENGINE_PROVIDER_KEYS,
  ENGINE_MODEL_KEYS,
  GEMINI_OPENAI_BASE_URL,
};
