/**
 * Qdrant vector-store client wrapper for the Travel CRM RAG knowledge base.
 *
 * Abstractions over @qdrant/js-client-rest with:
 *   - fail-soft init (returns no-op API when QDRANT_URL is unset or the
 *     client library is unavailable)
 *   - collection auto-creation (cosine, 1536-dim — matches OpenAI text-embedding-3-small)
 *   - typed helpers for upsert, search, delete, and count
 *
 * All operations are tenant-scoped + sub-brand-scoped via payload filters so
 * multiple tenants and the four travel sub-brands (tmc, rfu, travelstall,
 * visasure) share one collection without cross-leakage.
 */

let QdrantClient = null;
let qdrantClientLoadError = null;

try {
  ({ QdrantClient } = require("@qdrant/js-client-rest"));
} catch (err) {
  qdrantClientLoadError = err;
}

const VECTOR_SIZE = 1536;
const VECTOR_DISTANCE = "Cosine";
let missingClientWarningEmitted = false;

function warnClientUnavailable() {
  if (missingClientWarningEmitted) return;
  missingClientWarningEmitted = true;
  const reason = qdrantClientLoadError
    ? (qdrantClientLoadError.code === "MODULE_NOT_FOUND"
      ? "@qdrant/js-client-rest is not installed"
      : `failed to load @qdrant/js-client-rest: ${qdrantClientLoadError.message}`)
    : "Qdrant client library is unavailable";
  console.warn(`[qdrantClient] ${reason}; Qdrant features disabled`);
}

function getClient() {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !QdrantClient) {
    if (url && !QdrantClient) {
      warnClientUnavailable();
    }
    return null;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 6333;
    const https = parsed.protocol === "https:";
    const client = new QdrantClient({ host, port, https, apiKey, checkCompatibility: false });
    console.log(`[qdrantClient] initialized for ${host}:${port} (https=${https})`);
    return client;
  } catch (e) {
    console.error("[qdrantClient] failed to create client:", e.message, e.cause);
    return null;
  }
}

function collectionName() {
  return process.env.QDRANT_COLLECTION || "travel_knowledge";
}

function isEnabled() {
  const hasUrl = Boolean(process.env.QDRANT_URL);
  if (hasUrl && !QdrantClient) {
    warnClientUnavailable();
    return false;
  }
  return hasUrl;
}

async function ensureCollection(client = getClient()) {
  if (!client) return false;
  const name = collectionName();
  try {
    const exists = await client.collectionExists(name);
    if (exists?.exists) return true;
    await client.createCollection(name, {
      vectors: { size: VECTOR_SIZE, distance: VECTOR_DISTANCE },
    });
    console.log(`[qdrantClient] created collection ${name}`);
    return true;
  } catch (e) {
    console.error("[qdrantClient] ensureCollection failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Upsert points into the Qdrant collection.
 *
 * @param {Array<{id: string, vector: number[], payload: object}>} points
 * @returns {Promise<boolean>}
 */
async function upsertPoints(points) {
  const client = getClient();
  if (!client || points.length === 0) return false;
  await ensureCollection(client);
  const name = collectionName();
  try {
    await client.upsert(name, { points });
    return true;
  } catch (e) {
    console.error("[qdrantClient] upsertPoints failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Semantic search scoped to tenant + sub-brand.
 *
 * @param {object} opts
 * @param {number[]} opts.vector
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {number} [opts.limit=10]
 * @param {Array<{key:string, match?:object, range?:object}>} [opts.extraFilter=[]]
 * @returns {Promise<Array<{id:string, score:number, payload:object}>>}
 */
async function searchBySubBrand({ vector, tenantId, subBrand, limit = 10, extraFilter = [] }) {
  const client = getClient();
  if (!client) return [];
  await ensureCollection(client);
  const name = collectionName();
  const filter = {
    must: [
      { key: "tenantId", match: { value: Number(tenantId) } },
      { key: "subBrand", match: { value: String(subBrand) } },
      ...extraFilter,
    ],
  };
  try {
    const results = await client.search(name, {
      vector,
      limit: Number(limit) || 10,
      filter,
      with_payload: true,
    });
    return (results || []).map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload || {},
    }));
  } catch (e) {
    console.error("[qdrantClient] searchBySubBrand failed:", e.message, e.cause);
    return [];
  }
}

/**
 * Delete points by their Qdrant id(s). Used during re-sync of a changed PDF.
 *
 * @param {string|string[]} ids
 * @returns {Promise<boolean>}
 */
async function deletePoints(ids) {
  const client = getClient();
  if (!client) return false;
  const idList = Array.isArray(ids) ? ids : [ids];
  if (idList.length === 0) return true;
  await ensureCollection(client);
  const name = collectionName();
  try {
    await client.delete(name, { points: idList });
    return true;
  } catch (e) {
    console.error("[qdrantClient] deletePoints failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Delete all points for a given Drive file id + tenant + sub-brand.
 * Used before re-indexing a changed PDF.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} opts.driveFileId
 * @returns {Promise<boolean>}
 */
async function deleteByDriveFile({ tenantId, subBrand, driveFileId }) {
  const client = getClient();
  if (!client) return false;
  await ensureCollection(client);
  const name = collectionName();
  try {
    await client.delete(name, {
      filter: {
        must: [
          { key: "tenantId", match: { value: Number(tenantId) } },
          { key: "subBrand", match: { value: String(subBrand) } },
          { key: "driveFileId", match: { value: String(driveFileId) } },
        ],
      },
    });
    return true;
  } catch (e) {
    console.error("[qdrantClient] deleteByDriveFile failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Count points for a tenant + sub-brand (useful for sync status).
 *
 * @param {number} tenantId
 * @param {string} [subBrand]
 * @returns {Promise<number>}
 */
async function countPoints(tenantId, subBrand) {
  const client = getClient();
  if (!client) return 0;
  await ensureCollection(client);
  const name = collectionName();
  const must = [{ key: "tenantId", match: { value: Number(tenantId) } }];
  if (subBrand) must.push({ key: "subBrand", match: { value: String(subBrand) } });
  try {
    const result = await client.count(name, { filter: { must } });
    return result?.count || 0;
  } catch (e) {
    console.error("[qdrantClient] countPoints failed:", e.message, e.cause);
    return 0;
  }
}

module.exports = {
  isEnabled,
  ensureCollection,
  collectionName,
  upsertPoints,
  searchBySubBrand,
  deletePoints,
  deleteByDriveFile,
  countPoints,
  VECTOR_SIZE,
  VECTOR_DISTANCE,
};
