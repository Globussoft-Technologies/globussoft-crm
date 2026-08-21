/**
 * Provider-aware embedding dispatcher for the Travel RAG knowledge base.
 *
 * Reads the tenant's active AI provider configuration and routes embedding
 * requests to the appropriate provider-specific client:
 *   - Google Gemini  -> gemini-embedding-001  (3072 dims)
 *   - OpenAI         -> text-embedding-3-small (1536 dims)
 *
 * The embedding model is hard-coded per provider; the chat/generation model
 * selected in the AI Settings UI is handled separately by the LLM router.
 *
 * Qdrant storage is split by provider (see qdrantClient.collectionName) so that
 * switching providers does not corrupt an existing index and a tenant can
 * resync only the collection for the new provider.
 */

const openaiEmbedClient = require("./openAIEmbedClient");
const geminiEmbedClient = require("./geminiEmbedClient");
const aiProviderManagement = require("./aiProviderManagement");

const SUPPORTED_PROVIDERS = ["openai", "gemini"];

const PROVIDER_EMBEDDING_CONFIG = {
  openai: {
    client: openaiEmbedClient,
    model: openaiEmbedClient.DEFAULT_MODEL,
    vectorSize: openaiEmbedClient.VECTOR_SIZE,
    providerId: "openai",
  },
  gemini: {
    client: geminiEmbedClient,
    model: geminiEmbedClient.DEFAULT_MODEL,
    vectorSize: geminiEmbedClient.VECTOR_SIZE,
    providerId: "gemini",
  },
};

/**
 * Resolve the embedding configuration for a tenant.
 *
 * @param {number} tenantId
 * @returns {Promise<object|null>} { client, model, vectorSize, providerId, apiKey, baseUrl }
 */
async function resolveEmbedConfig(tenantId) {
  const config = await aiProviderManagement.resolveProviderConfig(tenantId);
  if (!config || !config.apiKey) return null;

  const meta = PROVIDER_EMBEDDING_CONFIG[config.providerId];
  if (!meta) return null;

  return {
    ...meta,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || null,
  };
}

/**
 * Check whether embeddings can be produced for this tenant.
 *
 * @param {number} tenantId
 * @returns {Promise<boolean>}
 */
async function isEnabled(tenantId) {
  const cfg = await resolveEmbedConfig(tenantId);
  return Boolean(cfg && cfg.client.isEnabled(cfg));
}

/**
 * Embed a single text string using the tenant's active provider. Returns null on
 * failure or if no supported provider is configured.
 *
 * @param {string} text
 * @param {number} tenantId
 * @returns {Promise<number[]|null>}
 */
async function embedText(text, tenantId) {
  const cfg = await resolveEmbedConfig(tenantId);
  if (!cfg) return null;
  return cfg.client.embedText(text, cfg);
}

/**
 * Embed many texts using the tenant's active provider.
 *
 * @param {string[]} texts
 * @param {number} tenantId
 * @returns {Promise<{embeddings: Map<number, number[]>, errors: Map<number, Error>}>}
 */
async function embedTexts(texts, tenantId) {
  const cfg = await resolveEmbedConfig(tenantId);
  if (!cfg) {
    const errors = new Map();
    if (Array.isArray(texts)) {
      for (let i = 0; i < texts.length; i += 1) {
        errors.set(i, new Error("no supported embedding provider configured"));
      }
    }
    return { embeddings: new Map(), errors };
  }
  return cfg.client.embedTexts(texts, cfg);
}

/**
 * Return the vector dimension for a supported embedding provider.
 *
 * @param {string} providerId
 * @returns {number|null}
 */
function getVectorSize(providerId) {
  return PROVIDER_EMBEDDING_CONFIG[providerId]?.vectorSize || null;
}

/**
 * Return the default embedding model name for a supported provider.
 *
 * @param {string} providerId
 * @returns {string|null}
 */
function getDefaultModel(providerId) {
  return PROVIDER_EMBEDDING_CONFIG[providerId]?.model || null;
}

/**
 * List provider IDs that support embeddings.
 *
 * @returns {string[]}
 */
function getSupportedProviders() {
  return [...SUPPORTED_PROVIDERS];
}

module.exports = {
  resolveEmbedConfig,
  isEnabled,
  embedText,
  embedTexts,
  getVectorSize,
  getDefaultModel,
  getSupportedProviders,
};
