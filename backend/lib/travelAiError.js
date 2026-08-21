"use strict";

const MODEL_ENV_KEYS = Object.freeze({
  "gemini-flash": ["GEMINI_API_KEY"],
  "gemini-2.5-flash": ["GEMINI_API_KEY"],
  "gpt-4": ["OPENAI_API_KEY"],
  "gpt-4o": ["OPENAI_API_KEY"],
  "gpt-4o-mini": ["OPENAI_API_KEY"],
  "gpt-4o-search": ["OPENAI_API_KEY"],
  "dall-e-3": ["OPENAI_API_KEY"],
  "gpt-image-1": ["OPENAI_API_KEY"],
  "stability-xl": ["STABILITY_API_KEY"],
  "claude-opus-4-7": ["ANTHROPIC_API_KEY"],
  "claude-haiku": ["ANTHROPIC_API_KEY"],
  "groq-llama": ["GROQ_API_KEY"],
  "perplexity-sonar": ["PERPLEXITY_API_KEY"],
});

function requiredKeysForModel(modelLabel) {
  return MODEL_ENV_KEYS[modelLabel] ? [...MODEL_ENV_KEYS[modelLabel]] : [];
}

function formatKeyList(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return "the required AI API key(s)";
  if (keys.length === 1) return keys[0];
  if (keys.length === 2) return `${keys[0]} or ${keys[1]}`;
  return `${keys.slice(0, -1).join(", ")}, or ${keys[keys.length - 1]}`;
}

function buildNotConfiguredMessage({ featureLabel, modelLabel, requiredKeys }) {
  const keys = Array.isArray(requiredKeys) && requiredKeys.length
    ? requiredKeys
    : requiredKeysForModel(modelLabel);
  const feature = featureLabel || "This travel AI feature";
  return `${feature} is unavailable because AI keys are not configured. Set ${formatKeyList(keys)} and try again.`;
}

function buildTravelAiErrorResponse(err, opts = {}) {
  if (!err || !err.code) return null;
  if (err.code === "AI_NOT_CONFIGURED") {
    const requiredKeys = Array.isArray(opts.requiredKeys) && opts.requiredKeys.length
      ? opts.requiredKeys
      : requiredKeysForModel(opts.modelLabel);
    return {
      status: opts.status || 403,
      body: {
        error: buildNotConfiguredMessage({
          featureLabel: opts.featureLabel,
          modelLabel: opts.modelLabel,
          requiredKeys,
        }),
        code: "AI_NOT_CONFIGURED",
        requiredKeys,
      },
    };
  }
  if (err.code === "AI_CREDITS_EXHAUSTED") {
    return {
      status: opts.status || 402,
      body: {
        error:
          err.message ||
          "AI credits are exhausted for this travel CRM tenant. Add credits or configure your own AI provider key to continue.",
        code: "AI_CREDITS_EXHAUSTED",
      },
    };
  }
  if (err.code === "AI_PROVIDER_RATE_LIMITED") {
    return {
      status: opts.status || 429,
      body: {
        error:
          err.message ||
          "The AI provider is temporarily rate-limited. Please try again in a few minutes.",
        code: "AI_PROVIDER_RATE_LIMITED",
      },
    };
  }
  return null;
}

module.exports = {
  requiredKeysForModel,
  buildNotConfiguredMessage,
  buildTravelAiErrorResponse,
};
