/**
 * Storage layer for AI curriculum-matching document uploads.
 *
 * Deliberately does NOT use a dedicated Prisma table/migration — it reuses
 * the existing generic TenantSetting key-value store (the same mechanism
 * backend/routes/travel_knowledge_base.js already uses for its Drive root
 * folder config), one row per uploaded curriculum PDF. This keeps the
 * feature fully additive with zero schema migrations against the live DB.
 *
 * Row shape: TenantSetting { tenantId, key: `travel.curriculum.doc.<id>`,
 * category: "travel-curriculum-document", value: JSON.stringify(document) }.
 */

const crypto = require("crypto");
const prisma = require("./prisma");

const CATEGORY = "travel-curriculum-document";
const KEY_PREFIX = "travel.curriculum.doc.";
const OBJECTIVES_CATEGORY = "travel-curriculum-objectives";
const OBJECTIVES_KEY_SUFFIX = ".objectives.";
// MySQL TEXT is limited to 64 KiB. Leave ample room below that limit for
// multi-byte characters and store large extracted-objective lists in chunks.
const OBJECTIVE_CHUNK_MAX_BYTES = 48 * 1024;

function generateDocumentId() {
  return crypto.randomBytes(8).toString("hex");
}

function keyFor(documentId) {
  return `${KEY_PREFIX}${documentId}`;
}

function objectiveKeyPrefix(documentId) {
  return `${keyFor(documentId)}${OBJECTIVES_KEY_SUFFIX}`;
}

function objectiveChunkKey(documentId, index) {
  return `${objectiveKeyPrefix(documentId)}${index}`;
}

function splitObjectiveChunks(objectives) {
  const chunks = [];
  let chunk = [];
  for (const objective of objectives) {
    const candidate = [...chunk, objective];
    if (chunk.length && Buffer.byteLength(JSON.stringify(candidate), "utf8") > OBJECTIVE_CHUNK_MAX_BYTES) {
      chunks.push(chunk);
      chunk = [objective];
    } else {
      chunk = candidate;
    }
    if (Buffer.byteLength(JSON.stringify(chunk), "utf8") > OBJECTIVE_CHUNK_MAX_BYTES) {
      throw new Error("A curriculum learning objective is too large to store.");
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function parseRow(row) {
  if (!row) return null;
  try {
    const doc = JSON.parse(row.value);
    return { ...doc, id: doc.id || row.key.slice(KEY_PREFIX.length) };
  } catch {
    return null;
  }
}

/**
 * List curriculum documents for a tenant, optionally narrowed by subBrand.
 * Newest first.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} [opts.subBrand]
 * @returns {Promise<object[]>}
 */
async function listCurriculumDocuments({ tenantId, subBrand }) {
  const rows = await prisma.tenantSetting.findMany({
    where: { tenantId, category: CATEGORY },
    orderBy: { updatedAt: "desc" },
  });
  const docs = rows.map(parseRow).filter(Boolean);
  if (subBrand) return docs.filter((d) => d.subBrand === subBrand);
  return docs;
}

/**
 * Fetch one curriculum document by id (tenant-scoped).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.documentId
 * @returns {Promise<object|null>}
 */
async function getCurriculumDocument({ tenantId, documentId }) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: keyFor(documentId) } },
  });
  const doc = parseRow(row);
  if (!doc || Array.isArray(doc.extractedObjectives)) return doc;

  const rows = await prisma.tenantSetting.findMany({
    where: {
      tenantId,
      category: OBJECTIVES_CATEGORY,
      key: { startsWith: objectiveKeyPrefix(documentId) },
    },
    orderBy: { key: "asc" },
  });
  const extractedObjectives = (rows || []).flatMap((objectiveRow) => {
    try {
      const chunk = JSON.parse(objectiveRow.value);
      return Array.isArray(chunk) ? chunk : [];
    } catch {
      return [];
    }
  });
  return { ...doc, extractedObjectives };
}

/**
 * Create or overwrite a curriculum document row.
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.documentId
 * @param {object} opts.data - full document object (will be stamped with id/tenantId)
 * @returns {Promise<object>}
 */
async function saveCurriculumDocument({ tenantId, documentId, data }) {
  const payload = { ...data, id: documentId, tenantId };
  const objectives = Array.isArray(payload.extractedObjectives) ? payload.extractedObjectives : [];
  const storedPayload = { ...payload };
  delete storedPayload.extractedObjectives;
  // Point ids are deterministic and are not read by any workflow. Keeping up
  // to 1,500 of them in the metadata would hit the same TEXT limit.
  delete storedPayload.qdrantPointIds;
  const value = JSON.stringify(storedPayload);
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: keyFor(documentId) } },
    create: { tenantId, key: keyFor(documentId), value, category: CATEGORY },
    update: { value, category: CATEGORY },
  });
  await prisma.tenantSetting.deleteMany({
    where: {
      tenantId,
      category: OBJECTIVES_CATEGORY,
      key: { startsWith: objectiveKeyPrefix(documentId) },
    },
  });
  const chunks = splitObjectiveChunks(objectives);
  await Promise.all(chunks.map((chunk, index) => prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: objectiveChunkKey(documentId, index) } },
    create: {
      tenantId,
      key: objectiveChunkKey(documentId, index),
      value: JSON.stringify(chunk),
      category: OBJECTIVES_CATEGORY,
    },
    update: { value: JSON.stringify(chunk), category: OBJECTIVES_CATEGORY },
  })));
  return payload;
}

/**
 * Permanently remove a curriculum document row (metadata only — caller is
 * responsible for cleaning up the S3 object and Qdrant points first).
 *
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.documentId
 * @returns {Promise<boolean>}
 */
async function deleteCurriculumDocument({ tenantId, documentId }) {
  try {
    await prisma.tenantSetting.deleteMany({
      where: {
        tenantId,
        category: OBJECTIVES_CATEGORY,
        key: { startsWith: objectiveKeyPrefix(documentId) },
      },
    });
    await prisma.tenantSetting.delete({
      where: { tenantId_key: { tenantId, key: keyFor(documentId) } },
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  generateDocumentId,
  listCurriculumDocuments,
  getCurriculumDocument,
  saveCurriculumDocument,
  deleteCurriculumDocument,
  CATEGORY,
  OBJECTIVES_CATEGORY,
  splitObjectiveChunks,
};
