/**
 * Gemini embedding client for the Travel RAG knowledge base.
 *
 * Uses Google's `gemini-embedding-001` model to produce 3072-dimensional
 * vectors. This client is invoked through the provider-aware `embedClient`
 * dispatcher, which supplies the active tenant's Gemini API key and base URL.
 *
 * Provides:
 *   - embedText(text, config) -> number[] | null
 *   - embedTexts(texts, config) -> Array<{index, embedding}|{index, error}>
 *
 * Fail-soft: when the API key is missing or the call fails, logs and returns
 * null / partial errors so the sync engine can retry individual PDFs without
 * killing the whole batch.
 */

const DEFAULT_MODEL = "models/gemini-embedding-001";
const VECTOR_SIZE = 3072;
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const BATCH_SIZE = 16;

function isEnabled(config) {
  return Boolean(config && config.apiKey);
}

async function fetchEmbeddings(inputs, config = {}) {
  const apiKey = config.apiKey;
  const model = config.model || DEFAULT_MODEL;
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");

  if (!apiKey) {
    throw new Error("Gemini API key is not set");
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("inputs must be a non-empty array");
  }

  // inputs are already cleaned non-empty strings.
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(
    model.replace(/^models\//, ""),
  )}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: inputs.map((text) => ({
      model,
      content: { parts: [{ text }] },
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = responseBody?.error?.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(`Gemini embeddings failed: ${msg}`);
  }

  const embeddings = Array.isArray(responseBody?.embeddings) ? responseBody.embeddings : [];
  return inputs.map((_, index) => ({
    index,
    embedding: Array.isArray(embeddings[index]?.values) ? embeddings[index].values : null,
  }));
}

/**
 * Embed a single text string. Returns null on failure.
 *
 * @param {string} text
 * @param {object} config
 * @returns {Promise<number[]|null>}
 */
async function embedText(text, config) {
  try {
    const results = await fetchEmbeddings([text], config);
    const embedding = results[0]?.embedding;
    if (!embedding || embedding.length !== VECTOR_SIZE) {
      console.error("[geminiEmbedClient] embedText failed: missing or malformed embedding");
      return null;
    }
    return embedding;
  } catch (e) {
    console.error("[geminiEmbedClient] embedText failed:", e.message);
    return null;
  }
}

/**
 * Embed many texts in one or more Gemini batch calls. Returns a map
 * index -> embedding or error.
 *
 * @param {string[]} texts
 * @param {object} config
 * @returns {Promise<{embeddings: Map<number, number[]>, errors: Map<number, Error>}>}
 */
async function embedTexts(texts, config) {
  const embeddings = new Map();
  const errors = new Map();

  if (!Array.isArray(texts) || texts.length === 0) {
    return { embeddings, errors };
  }

  // Track original indices because empty strings are skipped but still reported as errors.
  const validEntries = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = String(texts[i] == null ? "" : texts[i]).trim();
    if (text) {
      validEntries.push({ originalIndex: i, text });
    } else {
      errors.set(i, new Error("empty input"));
    }
  }

  const validTexts = validEntries.map((e) => e.text);
  for (let i = 0; i < validTexts.length; i += BATCH_SIZE) {
    const batch = validTexts.slice(i, i + BATCH_SIZE);
    const batchEntries = validEntries.slice(i, i + BATCH_SIZE);
    try {
      const results = await fetchEmbeddings(batch, config);
      for (let j = 0; j < batch.length; j += 1) {
        const { originalIndex } = batchEntries[j];
        const result = results[j];
        if (result && result.embedding && result.embedding.length === VECTOR_SIZE) {
          embeddings.set(originalIndex, result.embedding);
        } else {
          errors.set(originalIndex, new Error("missing or malformed embedding"));
        }
      }
    } catch (e) {
      console.error("[geminiEmbedClient] embedTexts batch failed:", e.message);
      for (let j = 0; j < batch.length; j += 1) {
        errors.set(batchEntries[j].originalIndex, e);
      }
    }
  }

  // Any index not returned is marked as missing.
  for (let i = 0; i < texts.length; i += 1) {
    if (!embeddings.has(i) && !errors.has(i)) {
      errors.set(i, new Error("embedding not returned by Gemini"));
    }
  }

  return { embeddings, errors };
}

module.exports = {
  isEnabled,
  embedText,
  embedTexts,
  fetchEmbeddings,
  VECTOR_SIZE,
  DEFAULT_MODEL,
};
