/**
 * Qdrant vector-store client wrapper for the Travel CRM RAG knowledge base.
 *
 * Abstractions over @qdrant/js-client-rest with:
 *   - fail-soft init (returns no-op API when QDRANT_URL is unset or the
 *     client library is unavailable)
 *   - provider-scoped collections (one per embedding provider so switching
 *     providers does not corrupt an existing index)
 *   - typed helpers for upsert, search, delete, and count
 *
 * All operations are tenant-scoped + sub-brand-scoped via payload filters so
 * multiple tenants and the four travel sub-brands (tmc, rfu, travelstall,
 * visasure) share one provider collection without cross-leakage.
 */

let QdrantClient = null;
let qdrantClientLoadError = null;

try {
  ({ QdrantClient } = require("@qdrant/js-client-rest"));
} catch (err) {
  qdrantClientLoadError = err;
}

const { getVectorSize } = require("./embedClient");

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

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;
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
    cachedClient = new QdrantClient({ host, port, https, apiKey, checkCompatibility: false });
    console.log(`[qdrantClient] initialized for ${host}:${port} (https=${https})`);
    return cachedClient;
  } catch (e) {
    console.error("[qdrantClient] failed to create client:", e.message, e.cause);
    return null;
  }
}

/**
 * Collection name for a given embedding provider.
 *
 * Backward compatibility: the OpenAI collection keeps the original
 * `travel_knowledge` name so existing indexed data is not orphaned.
 * Other providers get a suffixed collection name.
 *
 * @param {string} [providerId='openai']
 * @returns {string}
 */
function collectionName(providerId = "openai") {
  const base = process.env.QDRANT_COLLECTION || "travel_knowledge";
  if (providerId === "openai") return base;
  return `${base}_${providerId}`;
}

/**
 * Vector dimension for a given embedding provider.
 *
 * @param {string} [providerId='openai']
 * @returns {number}
 */
function vectorSize(providerId = "openai") {
  return getVectorSize(providerId) || VECTOR_SIZE;
}

function isEnabled() {
  const hasUrl = Boolean(process.env.QDRANT_URL);
  if (hasUrl && !QdrantClient) {
    warnClientUnavailable();
    return false;
  }
  return hasUrl;
}

async function ensureCollection(client = getClient(), providerId = "openai") {
  if (!client) return false;
  const name = collectionName(providerId);
  const size = vectorSize(providerId);
  try {
    const exists = await client.collectionExists(name);
    if (exists?.exists) return true;
    await client.createCollection(name, {
      vectors: { size, distance: VECTOR_DISTANCE },
    });
    console.log(`[qdrantClient] created collection ${name} (${size} dims)`);
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
 * @param {string} [providerId='openai']
 * @returns {Promise<boolean>}
 */
async function upsertPoints(points, providerId = "openai") {
  const client = getClient();
  if (!client || points.length === 0) return false;
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
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
 * @param {string} [opts.providerId='openai']
 * @param {number} [opts.limit=10]
 * @param {Array<{key:string, match?:object, range?:object}>} [opts.extraFilter=[]]
 * @returns {Promise<Array<{id:string, score:number, payload:object}>>}
 */
async function searchBySubBrand({
  vector,
  tenantId,
  subBrand,
  providerId = "openai",
  limit = 10,
  extraFilter = [],
}) {
  const client = getClient();
  if (!client) return [];
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
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
 * @param {string} [providerId='openai']
 * @returns {Promise<boolean>}
 */
async function deletePoints(ids, providerId = "openai") {
  const client = getClient();
  if (!client) return false;
  const idList = Array.isArray(ids) ? ids : [ids];
  if (idList.length === 0) return true;
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
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
 * @param {string} [opts.providerId='openai']
 * @returns {Promise<boolean>}
 */
async function deleteByDriveFile({ tenantId, subBrand, driveFileId, providerId = "openai" }) {
  const client = getClient();
  if (!client) return false;
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
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
 * Delete all points for a tenant across a single provider collection.
 * Used for "wipe and resync" — clears the tenant's slice without dropping
 * the whole collection (other tenants may share it).
 *
 * @param {number} tenantId
 * @param {string} [providerId='openai']
 * @returns {Promise<boolean>}
 */
async function deleteByTenant(tenantId, providerId = "openai") {
  const client = getClient();
  if (!client) return false;
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
  try {
    await client.delete(name, {
      filter: {
        must: [{ key: "tenantId", match: { value: Number(tenantId) } }],
      },
    });
    return true;
  } catch (e) {
    console.error("[qdrantClient] deleteByTenant failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Count points for a tenant + sub-brand (useful for sync status).
 *
 * @param {number} tenantId
 * @param {string} [subBrand]
 * @param {string} [providerId='openai']
 * @returns {Promise<number>}
 */
async function countPoints(tenantId, subBrand, providerId = "openai") {
  const client = getClient();
  if (!client) return 0;
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
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

/**
 * Count points for a specific Drive file id + tenant + sub-brand.
 * Used to decide whether a file needs re-indexing after an embedding provider switch.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} opts.driveFileId
 * @param {string} [opts.providerId='openai']
 * @returns {Promise<number>}
 */
async function countPointsByDriveFile({ tenantId, subBrand, driveFileId, providerId = "openai" }) {
  const client = getClient();
  if (!client) return 0;
  await ensureCollection(client, providerId);
  const name = collectionName(providerId);
  try {
    const result = await client.count(name, {
      filter: {
        must: [
          { key: "tenantId", match: { value: Number(tenantId) } },
          { key: "subBrand", match: { value: String(subBrand) } },
          { key: "driveFileId", match: { value: String(driveFileId) } },
        ],
      },
    });
    return result?.count || 0;
  } catch (e) {
    console.error("[qdrantClient] countPointsByDriveFile failed:", e.message, e.cause);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Curriculum-matching collection (additive, 2026-08-24).
//
// AI curriculum-to-itinerary matching (see backend/lib/curriculumRag.js)
// stores extracted learning objectives here — ONE shared collection for
// every curriculum a tenant uploads (not one collection per curriculum),
// disambiguated via payload metadata (tenantId, subBrand, board, gradeBand,
// documentId). Same provider-scoped-collection-name pattern as the
// itinerary collection above, so switching embedding providers behaves
// identically for both: each provider gets its own untouched collection
// that is never deleted on switch, so returning to a previously-used
// provider is instant with zero re-index (see collectionName() doc above
// for the same guarantee on the itinerary side).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Collection name for curriculum learning objectives, scoped by embedding
 * provider exactly like collectionName() above.
 *
 * @param {string} [providerId='openai']
 * @returns {string}
 */
function curriculumCollectionName(providerId = "openai") {
  const base = process.env.QDRANT_CURRICULUM_COLLECTION || "curriculum_objectives";
  if (providerId === "openai") return base;
  return `${base}_${providerId}`;
}

async function ensureCurriculumCollection(client = getClient(), providerId = "openai") {
  if (!client) return false;
  const name = curriculumCollectionName(providerId);
  const size = vectorSize(providerId);
  try {
    const exists = await client.collectionExists(name);
    if (exists?.exists) return true;
    await client.createCollection(name, {
      vectors: { size, distance: VECTOR_DISTANCE },
    });
    console.log(`[qdrantClient] created collection ${name} (${size} dims)`);
    return true;
  } catch (e) {
    console.error("[qdrantClient] ensureCurriculumCollection failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Upsert curriculum-objective points.
 *
 * @param {Array<{id: string, vector: number[], payload: object}>} points
 * @param {string} [providerId='openai']
 * @returns {Promise<boolean>}
 */
async function upsertCurriculumPoints(points, providerId = "openai") {
  const client = getClient();
  if (!client || !points.length) return false;
  await ensureCurriculumCollection(client, providerId);
  const name = curriculumCollectionName(providerId);
  try {
    await client.upsert(name, { points });
    return true;
  } catch (e) {
    console.error("[qdrantClient] upsertCurriculumPoints failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Semantic search over curriculum objectives, scoped to tenant + subBrand,
 * with optional exact-match narrowing by board / gradeBand (normalized
 * uppercase at index+query time so casing never causes a silent miss — the
 * exact brittleness problem the old string-matching mapper had).
 *
 * @param {object} opts
 * @param {number[]} opts.vector
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} [opts.board]
 * @param {string} [opts.gradeBand]
 * @param {string} [opts.providerId='openai']
 * @param {number} [opts.limit=20]
 * @returns {Promise<Array<{id:string, score:number, payload:object}>>}
 */
async function searchCurriculum({
  vector,
  tenantId,
  subBrand,
  board,
  gradeBand,
  providerId = "openai",
  limit = 20,
}) {
  const client = getClient();
  if (!client) return [];
  await ensureCurriculumCollection(client, providerId);
  const name = curriculumCollectionName(providerId);
  const must = [
    { key: "tenantId", match: { value: Number(tenantId) } },
    { key: "subBrand", match: { value: String(subBrand) } },
  ];
  if (board) must.push({ key: "boardNormalized", match: { value: String(board).trim().toUpperCase() } });
  if (gradeBand) must.push({ key: "gradeBandNormalized", match: { value: String(gradeBand).trim().toUpperCase() } });
  try {
    const results = await client.search(name, {
      vector,
      limit: Number(limit) || 20,
      filter: { must },
      with_payload: true,
    });
    return (results || []).map((r) => ({ id: r.id, score: r.score, payload: r.payload || {} }));
  } catch (e) {
    console.error("[qdrantClient] searchCurriculum failed:", e.message, e.cause);
    return [];
  }
}

/**
 * Delete all curriculum-objective points for one uploaded document (used
 * before re-indexing after a PDF re-upload, or on document delete).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} opts.documentId
 * @param {string} [opts.providerId='openai']
 * @returns {Promise<boolean>}
 */
async function deleteCurriculumByDocument({ tenantId, subBrand, documentId, providerId = "openai" }) {
  const client = getClient();
  if (!client) return false;
  await ensureCurriculumCollection(client, providerId);
  const name = curriculumCollectionName(providerId);
  try {
    await client.delete(name, {
      filter: {
        must: [
          { key: "tenantId", match: { value: Number(tenantId) } },
          { key: "subBrand", match: { value: String(subBrand) } },
          { key: "documentId", match: { value: String(documentId) } },
        ],
      },
    });
    return true;
  } catch (e) {
    console.error("[qdrantClient] deleteCurriculumByDocument failed:", e.message, e.cause);
    return false;
  }
}

/**
 * Count indexed points for one document under the CURRENT provider's
 * collection — the provider-aware status check discussed for the admin UI
 * (a document can show "indexed" under openai's collection while gemini's
 * collection genuinely has zero points for it, and vice versa).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.subBrand
 * @param {string} opts.documentId
 * @param {string} [opts.providerId='openai']
 * @returns {Promise<number>}
 */
async function countCurriculumPointsByDocument({ tenantId, subBrand, documentId, providerId = "openai" }) {
  const client = getClient();
  if (!client) return 0;
  await ensureCurriculumCollection(client, providerId);
  const name = curriculumCollectionName(providerId);
  try {
    const result = await client.count(name, {
      filter: {
        must: [
          { key: "tenantId", match: { value: Number(tenantId) } },
          { key: "subBrand", match: { value: String(subBrand) } },
          { key: "documentId", match: { value: String(documentId) } },
        ],
      },
    });
    return result?.count || 0;
  } catch (e) {
    console.error("[qdrantClient] countCurriculumPointsByDocument failed:", e.message, e.cause);
    return 0;
  }
}

/**
 * Count all curriculum-objective points for a tenant+subBrand under the
 * CURRENT provider's collection. Used to decide whether the AI matching
 * path has anything to search before attempting it.
 *
 * @param {number} tenantId
 * @param {string} subBrand
 * @param {string} [providerId='openai']
 * @returns {Promise<number>}
 */
async function countCurriculumPoints(tenantId, subBrand, providerId = "openai") {
  const client = getClient();
  if (!client) return 0;
  await ensureCurriculumCollection(client, providerId);
  const name = curriculumCollectionName(providerId);
  try {
    const result = await client.count(name, {
      filter: {
        must: [
          { key: "tenantId", match: { value: Number(tenantId) } },
          { key: "subBrand", match: { value: String(subBrand) } },
        ],
      },
    });
    return result?.count || 0;
  } catch (e) {
    console.error("[qdrantClient] countCurriculumPoints failed:", e.message, e.cause);
    return 0;
  }
}

module.exports = {
  isEnabled,
  ensureCollection,
  collectionName,
  vectorSize,
  upsertPoints,
  searchBySubBrand,
  deletePoints,
  deleteByDriveFile,
  deleteByTenant,
  countPoints,
  countPointsByDriveFile,
  VECTOR_SIZE,
  VECTOR_DISTANCE,
  // Curriculum-matching collection (additive).
  curriculumCollectionName,
  ensureCurriculumCollection,
  upsertCurriculumPoints,
  searchCurriculum,
  deleteCurriculumByDocument,
  countCurriculumPointsByDocument,
  countCurriculumPoints,
};
