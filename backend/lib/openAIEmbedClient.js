/**
 * OpenAI embedding client for the Travel RAG knowledge base.
 *
 * Uses the OpenAI `text-embedding-3-small` model to turn text into 1536-dim
 * vectors. The same OPENAI_API_KEY env var used by lib/llmRouter.js is reused
 * here; no new credential surface is introduced.
 *
 * Provides:
 *   - embedText(text) -> number[] | null
 *   - embedTexts(texts[]) -> Array<{index, embedding}|{index, error}>
 *
 * Fail-soft: when OPENAI_API_KEY is missing or the call fails, logs and
 * returns null / partial errors so the sync engine can retry individual PDFs
 * without killing the whole batch.
 */

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
const VECTOR_SIZE = 1536;

function getApiKey(config) {
  return config?.apiKey || process.env.OPENAI_API_KEY || null;
}

function isEnabled(config) {
  return Boolean(getApiKey(config));
}

async function fetchEmbeddings(inputs, config = {}) {
  const apiKey = getApiKey(config);
  const model = config.model || DEFAULT_MODEL;
  const rawBase = (config.baseUrl || "https://api.openai.com").replace(/\/$/, "");
  // aiProviderManagement normalizes OpenAI base URLs to .../v1, while direct
  // callers may pass the raw https://api.openai.com. Build the embeddings path
  // without double-prefixing /v1.
  const baseUrl = rawBase.endsWith("/v1") ? rawBase : `${rawBase}/v1`;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("inputs must be a non-empty array");
  }

  const cleaned = inputs.map((t) => String(t == null ? "" : t).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error("all inputs are empty");
  }

  const body = {
    model,
    input: cleaned,
    dimensions: VECTOR_SIZE,
  };

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = responseBody?.error?.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(`OpenAI embeddings failed: ${msg}`);
  }

  const data = Array.isArray(responseBody?.data) ? responseBody.data : [];
  return data.map((d) => ({
    index: d.index,
    embedding: Array.isArray(d.embedding) ? d.embedding : null,
  }));
}

/**
 * Embed a single text string. Returns null on failure.
 *
 * @param {string} text
 * @param {object} [config]
 * @returns {Promise<number[]|null>}
 */
async function embedText(text, config = {}) {
  try {
    const results = await fetchEmbeddings([text], config);
    return results[0]?.embedding || null;
  } catch (e) {
    console.error("[openAIEmbedClient] embedText failed:", e.message);
    return null;
  }
}

/**
 * Embed many texts in one OpenAI call. Returns a map index -> embedding or error.
 * Empty inputs return an empty map. The caller can decide whether to retry.
 *
 * @param {string[]} texts
 * @param {object} [config]
 * @returns {Promise<{embeddings: Map<number, number[]>, errors: Map<number, Error>}>}
 */
async function embedTexts(texts, config = {}) {
  const embeddings = new Map();
  const errors = new Map();
  if (!Array.isArray(texts) || texts.length === 0) {
    return { embeddings, errors };
  }

  try {
    const results = await fetchEmbeddings(texts, config);
    for (const r of results) {
      if (r.embedding && r.embedding.length === VECTOR_SIZE) {
        embeddings.set(r.index, r.embedding);
      } else {
        errors.set(r.index, new Error("missing or malformed embedding"));
      }
    }
    // Any index not returned is marked as missing.
    for (let i = 0; i < texts.length; i += 1) {
      if (!embeddings.has(i) && !errors.has(i)) {
        errors.set(i, new Error("embedding not returned by OpenAI"));
      }
    }
  } catch (e) {
    console.error("[openAIEmbedClient] embedTexts failed:", e.message);
    for (let i = 0; i < texts.length; i += 1) {
      errors.set(i, e);
    }
  }

  return { embeddings, errors };
}

module.exports = {
  isEnabled,
  getApiKey,
  embedText,
  embedTexts,
  VECTOR_SIZE,
  DEFAULT_MODEL,
};
